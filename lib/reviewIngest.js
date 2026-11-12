'use strict';

/**
 * 리뷰 분석 자료 적재 — 마케팅팀이 넘긴 "리뷰 분석 지식 문서(txt)" + 리뷰 원본 엑셀(자사몰·스마트스토어) → DB.
 *   MCP 리뷰 도구(lib/reviews.js)가 읽는다. 사용법: node scripts/import-reviews.js <폴더> [--replace]
 *
 *   review_docs     : 지식 문서 조각 — "### [ID] 제목" 하나가 한 줄(문서 K-0-02 안내대로). 장 머리글은 intro:<장> 으로 따로.
 *                     카피 은행 조각은 93만 자라 본문 대신 안내만 두고 review_copybank 로 나눠 넣는다.
 *   review_copybank : 카피 은행 고객 문장 한 줄 = 한 문서(id 는 리뷰와 같은 own:리뷰ID / ss:리뷰글번호)
 *   reviews         : 리뷰 원문 — 문서 DD-8-04 정리 규칙 · DD-8-05 v2 상품군 규칙
 *   review_meta     : 마지막 적재 시각·건수·기간
 *
 *   엑셀 맨 뒤 [분석] 열 9개(문서 DD-8-11, 2026-11-12부터)가 있으면 그 값을 기준으로 쓴다 — 마케팅팀이 리뷰마다 붙인 AI 분류.
 *     리뷰키 · 분석 포함(Y / N-반복 등록(대표 키) / N-스마트스토어 연동 리뷰 / N-관리자 글) · 상품군 · 모델 · 전체 감정 ·
 *     칭찬한 점 · 아쉬운 점 · 불만 유형 · 세부 코드. 없으면(예전 형식) 반복 등록·상품군을 이 파일의 규칙으로 직접 판단한다.
 *
 *   문서·카피 은행은 전량 교체(자료가 유일한 기준). 리뷰는 채널:리뷰번호로 덮어써서, 월간 갱신 때 지난달 파일만 넣어도 쌓인다.
 *   파일을 통째로 다시 받았을 때는 --replace 로 리뷰를 모두 지우고 새로 넣는다.
 *   ⚠️ 개인정보(문서 K-1-11): 회원명·회원ID·주문번호·상품주문번호·등록자·사진/동영상 링크·답글 내용은 저장하지 않는다.
 *      (2026-11-12 파일부터 이 열들은 익명 코드지만 그래도 넣지 않는다.) 본문 속 전화번호·이메일도 가린다.
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const store = require('./store');

// ── 지식 문서 ─────────────────────────────────────────────────────────────
const COPYBANK_ID = 'A-D2-copybank';
const COPY_COLS = ['id', 'q', 'qs', 'fam', 'model', 'ch', 'kind', 'yr', 'rating', 'photo', 'codes', 'item'];
// 회의 녹음 받아쓰기 원문(부록 C) — 지정한 토큰만 본문을 본다(lib/reviews.js)
const isRestricted = (id) => /^A-M-/.test(id);

function parseDoc(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const chunks = [];
  let chapter = '', chapterKey = '', cur = null, intro = null, order = 0;
  const close = () => {
    if (cur) chunks.push({ ...cur, body: cur.lines.join('\n').trim() });
    if (intro && intro.lines.join('').trim()) chunks.push({ ...intro, body: intro.lines.join('\n').trim() });
    cur = null; intro = null;
  };
  for (const line of lines) {
    const ch = line.match(/^## (.+)$/);
    if (ch) {
      close();
      chapter = ch[1].trim();
      chapterKey = (chapter.match(/^(부록 [A-Z]|\d+)\./) || [, chapter])[1];
      intro = { id: `intro:${chapterKey}`, title: `${chapter} · 머리글`, chapter, order: order++, lines: [] };
      continue;
    }
    const h = line.match(/^### \[([^\]]+)\]\s*(.*)$/);
    if (h) {
      if (cur) chunks.push({ ...cur, body: cur.lines.join('\n').trim() });
      if (intro) { if (intro.lines.join('').trim()) chunks.push({ ...intro, body: intro.lines.join('\n').trim() }); intro = null; }
      cur = { id: h[1].trim(), title: h[2].trim(), chapter, order: order++, lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line); else if (intro) intro.lines.push(line);
  }
  close();
  return chunks.map(({ lines: _l, ...c }) => ({ ...c, chars: c.body.length, restricted: isRestricted(c.id) }));
}

function parseCopyBank(body) {
  const rows = [];
  for (const line of body.split('\n')) {
    const cells = line.split('\t');
    if (cells.length !== COPY_COLS.length || cells[0] === 'id') continue;
    const r = Object.fromEntries(COPY_COLS.map((k, i) => [k, cells[i].trim()]));
    rows.push({
      id: r.id, q: r.q, qs: Number(r.qs) || 0, fam: r.fam, model: r.model, ch: r.ch, kind: r.kind,
      yr: Number(r.yr) || null, rating: Number(r.rating) || null, photo: r.photo === '1',
      codes: r.codes ? r.codes.split(' · ').map((s) => s.trim()).filter(Boolean) : [],
      item: r.item ? r.item.split(',').map((s) => s.trim()).filter(Boolean) : [],
    });
  }
  return rows;
}

// ── 상품군·모델(문서 DD-8-05 v2, 위에서부터 먼저 맞는 것) — [분석] 열이 없는 파일에만 쓴다 ─────
//   v2: 스마트스토어 상품명에 "빈백 소파 … 쿠션"처럼 검색용 단어가 붙어, "빈백"이 있으면 필로우보다 먼저 빈백으로 본다.
//       모델명(미니 등)만 있는 "미니 쿠션"은 필로우로 남도록 모델명 확인은 필로우 뒤에 한다.
function family(name) {
  const n = String(name || '');
  if (/커버/.test(n)) return '커버';
  if (/비즈|충전/.test(n)) return '비즈';
  if (/스퀴지보/.test(n) || (/메이트/.test(n) && !/롤/.test(n))) return '인형';
  if (/서포트/.test(n)) return '서포트';
  if (/롤|바디필로우/.test(n)) return '롤';
  if (/트레이보/.test(n)) return '트레이보';
  if (/빈백/.test(n)) return '빈백';
  if (/필로우|베개|냅|안대|쿠션/.test(n)) return '필로우';
  if (/맥스|미디|미니|슬림|피라미드|드롭|팟|라운저|프라임|쇼티|더블/.test(n)) return '빈백';
  if (/슬리피보|코지보|허기보|샤이니보|보 도우|스퀴지|메이트|디즈니/.test(n)) return '인형';
  return '기타';
}
const MODELS = [['맥스', /맥스/], ['미디', /미디/], ['미니', /미니/], ['슬림', /슬림/], ['피라미드', /피라미드/], ['드롭', /드롭/],
  ['팟', /팟/], ['라운저', /라운저/], ['프라임', /프라임/], ['쇼티', /쇼티/], ['더블', /더블/], ['맥스', /줄라/], ['트레이보', /트레이보/],
  ['서포트', /서포트/], ['카터필러 롤', /카터필러/], ['롤', /롤/], ['메가 문 필로우', /메가 ?문 ?필로우/], ['문 필로우', /문 ?필로우/],
  ['냅', /냅/], ['스퀴지보', /스퀴지보/], ['메이트', /메이트/], ['라운드 필로우', /라운드 ?필로우/]];
const model = (name) => { const m = MODELS.find(([, re]) => re.test(String(name || ''))); return m ? m[0] : ''; };

// ── 엑셀 읽기 ────────────────────────────────────────────────────────────
function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.text != null) return typeof v.text === 'object' ? cellValue(v.text) : v.text;
    if (v.result != null) return cellValue(v.result);
    if (v.hyperlink) return v.hyperlink;
    return '';
  }
  return v;
}
async function readSheets(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets.map((ws) => {
    const header = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { header[i] = String(cellValue(c.value)).trim(); });
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const o = {};
      header.forEach((h, i) => { if (h) o[h] = cellValue(row.getCell(i).value); });
      rows.push(o);
    });
    return { name: ws.name, rows };
  });
}

const pad = (n) => String(n).padStart(2, '0');
function ymd(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10); // 엑셀 날짜는 시각대 없이 UTC로 읽힌다 — 그대로가 한국 날짜
  const m = String(v || '').match(/(\d{4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/);
  return m ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
}
const str = (v) => (v instanceof Date ? ymd(v) : String(v == null ? '' : v)).trim();
const num = (v) => { const n = Number(String(v).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const compact = (s) => String(s || '').replace(/\s+/g, '');
const list = (v) => str(v).split(',').map((s) => s.trim()).filter(Boolean);
// 개별 결제용 상품명에 고객 이름이 들어 있다("고객결제(이○리 님)") — 이름 부분을 지운다
const productName = (v) => str(v).replace(/\(\s*[가-힣A-Za-z○*]{1,5}\s*님\s*\)/g, '(고객)');

// 본문 정리 — 네이버페이 구매평 꼬리표(DD-8-04 5번) 제거, 전화번호·이메일 가림
const NPAY_TAIL = /\s*\(\s*\d{4}-\d{2}-\d{2}[^()]*네이버\s?페이\s?구매평\s*\)\s*$/;
function cleanBody(s) {
  return String(s || '')
    .replace(NPAY_TAIL, '')
    .replace(/01[016789][-. ]?\d{3,4}[-. ]?\d{4}/g, '[전화번호]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[이메일]')
    .trim();
}
const mediaCount = (v) => (String(v || '').match(/https?:\/\//g) || []).length;

// [분석] 열(DD-8-11) — 없는 파일이면 null
function analysisOf(r) {
  if (!('[분석] 리뷰키' in r)) return null;
  const inc = str(r['[분석] 포함']);
  return {
    key: str(r['[분석] 리뷰키']) || null,
    status: /^Y/.test(inc) ? 'Y' : /반복/.test(inc) ? 'repeat' : /연동/.test(inc) ? 'sync' : /관리자/.test(inc) ? 'admin' : 'other',
    repeatOf: (inc.match(/대표\s*((?:own|ss):\d+)/) || [])[1] || null,
    fam: str(r['[분석] 상품군']) || null,
    model: str(r['[분석] 모델']),
    sentiment: str(r['[분석] 전체 감정']) || null,
    praise: list(r['[분석] 칭찬한 점']), regret: list(r['[분석] 아쉬운 점']),
    complaint: list(r['[분석] 불만 유형']), codes: list(r['[분석] 세부 코드']),
  };
}

// ── 리뷰 정리(DD-8-04) ──────────────────────────────────────────────────────
// synced 에는 스마트스토어 연동분을 모은다 — 스마트스토어 파일에 없는 것만 스마트스토어 리뷰로 보충(DD-8-04 2번)
function ownReviews(sheets, stat, synced) {
  const byId = new Map();
  for (const sh of sheets) {
    const chatbotSheet = /챗봇/.test(sh.name);
    for (const r of sh.rows) {
      const id = str(r['리뷰ID']);
      if (!id) continue;
      const a = analysisOf(r);
      const code = str(r['리뷰code']), member = str(r['회원명']), via = str(r['리뷰작성경로']), product = productName(r['상품명']);
      stat.own.read++;
      if (a ? a.status === 'sync' : (/^SS/i.test(code) || member === '네이버 스마트스토어 구매자' || via === '기타')) {
        stat.own.synced++;
        const ssId = code.replace(/^SS[_-]?/i, '');
        if (/^\d+$/.test(ssId)) {
          synced.push({
            key: `ss:${ssId}`, ch: '스마트스토어', id: ssId, date: ymd(r['리뷰작성일']), product, productNo: '',
            rating: num(r['리뷰별점']) || null, kind: null, relatedId: null,
            media: num(r['포토개수']) + num(r['동영상개수']), helpful: 0, best: false, reward: null, replied: false, hidden: false,
            body: cleanBody(r['리뷰본문']), fromSync: true, repeat: false, _a: null, _author: '',
          });
        }
        continue;
      }
      if (a ? a.status === 'admin' : (member === '요기보' || str(r['상품명']) === '상품 없음')) { stat.own.admin++; continue; }
      const prev = byId.get(id);
      byId.set(id, {
        key: (a && a.key) || `own:${id}`, ch: '자사몰', id,
        date: ymd(r['리뷰작성일']), buyDate: ymd(r['상품구매일']), deliveredDate: ymd(r['배송완료일']),
        product, productNo: str(r['상품번호']), option: str(r['상품옵션']), price: num(r['상품가격']) || null,
        rating: num(r['리뷰별점']) || null,
        buyer: member === '네이버 페이 구매자' ? '네이버페이 결제 고객' : '자사몰 회원',
        // 크리마 리뷰 챗봇은 2026-03-10 시작(문서 용어 사전) — 그 전 '문자메시지' 경로는 챗봇이 아니다
        path: via, chatbot: chatbotSheet || (/문자메시지/.test(via) && ymd(r['리뷰작성일']) >= '2026-03-10') || (prev && prev.chatbot) || false,
        reward: num(r['적립금']), photos: num(r['포토개수']), videos: num(r['동영상개수']),
        tags: list(r['태그']),
        replied: num(r['댓글개수']) > 0,
        body: cleanBody(r['리뷰본문']),
        ...(a ? { repeat: a.status === 'repeat', repeatOf: a.repeatOf } : {}),
        _a: a, _author: str(r['회원ID']) || member,
      });
    }
  }
  return [...byId.values()];
}

function ssReviews(sheets, stat) {
  const byId = new Map();
  for (const sh of sheets) {
    for (const r of sh.rows) {
      const id = str(r['리뷰글번호']);
      if (!id) continue;
      stat.ss.read++;
      if (byId.has(id)) { stat.ss.dupId++; continue; }
      const a = analysisOf(r);
      const kind = str(r['리뷰구분']);
      byId.set(id, {
        key: (a && a.key) || `ss:${id}`, ch: '스마트스토어', id,
        date: ymd(r['리뷰등록일']), product: productName(r['상품명']), productNo: str(r['상품번호']),
        rating: num(r['구매자평점']) || null,
        kind: kind === '한달사용' ? '한 달 사용 후기' : kind === '일반' ? '구매 후 리뷰' : kind,
        relatedId: str(r['관련리뷰글번호']) || null,
        media: mediaCount(r['포토/영상']),
        helpful: num(r['리뷰도움수']), best: str(r['베스트리뷰']) === 'Y',
        reward: str(r['혜택지급']) || null, replied: str(r['답글여부']) === 'Y',
        hidden: str(r['전시상태']) !== '' && str(r['전시상태']) !== '정상',
        body: cleanBody(r['리뷰상세내용']),
        ...(a ? { repeat: a.status === 'repeat', repeatOf: a.repeatOf } : {}),
        _a: a, _author: str(r['등록자']),
      });
    }
  }
  return [...byId.values()];
}

// [분석] 열이 없는 리뷰만 — 같은 채널·같은 작성자·같은 본문(공백 제거 6자 이상)은 1건(DD-8-04 6번).
//   지우지 않고 repeat 표시만 한다. 작성 수량(대시보드 1)은 게시판 그대로 세고, 내용 분석(대시보드 2)은 반복을 빼고 세기 때문.
function markRepeats(list, stat) {
  const seen = new Set();
  return [...list].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id))).map((r) => {
    if (r.repeat !== undefined) { if (r.repeat) stat.repeats++; return r; }
    const c = compact(r.body);
    const k = `${r.ch}|${r._author}|${c}`;
    const repeat = !!(r._author && c.length >= 6 && seen.has(k));
    if (repeat) stat.repeats++;
    seen.add(k);
    return { ...r, repeat };
  });
}

function finish(r, copy) {
  const { _author, _a: a, ...rest } = r;
  const c = copy.get(r.key);
  return {
    ...rest,
    month: r.date ? r.date.slice(0, 7) : null,
    fam: (a && a.fam) || family(r.product),
    model: a ? a.model : model(r.product),
    // 분석 포함 = 대시보드 2와 같은 분석 대상. [분석] 열이 있으면 그 값, 없으면 반복 등록이 아닌 것
    //   스마트스토어 파일에 없어 보충한 연동분은 대시보드 2가 스마트스토어 리뷰로 셌으므로 포함(분류값은 없음)
    included: a ? a.status === 'Y' : !r.repeat,
    ...(a && a.sentiment ? { sentiment: a.sentiment } : {}),
    ...(a ? { praise: a.praise, regret: a.regret, complaint: a.complaint, codes: a.codes } : {}),
    len: r.body.length,
    hasMedia: (r.photos || 0) + (r.videos || 0) + (r.media || 0) > 0,
    ...(c ? { copy: { q: c.q, qs: c.qs, codes: c.codes, item: c.item } } : {}),
  };
}

// ── 폴더 읽기 → 적재 ───────────────────────────────────────────────────────
function findFiles(dir) {
  const names = fs.readdirSync(dir);
  const pick = (re) => names.filter((n) => re.test(n) && !/^~\$/.test(n)).map((n) => path.join(dir, n));
  return { doc: pick(/\.txt$/i), own: pick(/자사몰.*\.xlsx$/i), ss: pick(/스마트스토어.*\.xlsx$/i) };
}

async function build(dir) {
  const files = findFiles(dir);
  const warnings = [];
  if (files.doc.length > 1) throw new Error(`지식 문서(txt)가 ${files.doc.length}개입니다 — 하나만 두세요`);
  if (!files.doc.length && !files.own.length && !files.ss.length) throw new Error('폴더에 지식 문서(txt)도 리뷰 엑셀도 없습니다');

  let docs = null, copybank = null;
  if (files.doc.length) {
    docs = parseDoc(fs.readFileSync(files.doc[0], 'utf8'));
    const cb = docs.find((d) => d.id === COPYBANK_ID);
    copybank = cb ? parseCopyBank(cb.body) : [];
    if (cb) cb.body = `카피 은행 ${copybank.length.toLocaleString()}문장은 review_copy_bank 도구로 조회합니다(상품군·모델·채널·연도·코드·점수로 고르기).\n\n` + cb.body.split('\n').slice(0, 3).join('\n');
    if (cb) cb.chars = cb.body.length;
    const ids = new Set();
    docs.forEach((d) => { if (ids.has(d.id)) warnings.push(`조각 ID 중복: ${d.id}`); ids.add(d.id); });
  }
  const copy = new Map((copybank || []).map((c) => [c.id, c]));

  const stat = { own: { read: 0, synced: 0, admin: 0 }, ss: { read: 0, dupId: 0, fromSync: 0 }, repeats: 0 };
  const own = [], synced = [];
  for (const f of files.own) own.push(...ownReviews(await readSheets(f), stat, synced));
  const ss = [];
  for (const f of files.ss) ss.push(...ssReviews(await readSheets(f), stat));
  // 스마트스토어 파일을 같이 넣을 때만 보충한다 — 자사몰 파일만 넣는 달에 연동분 전부가 "없는 것"으로 잘못 들어가지 않게
  if (files.ss.length) {
    const have = new Set(ss.map((r) => r.id));
    for (const s of synced) if (!have.has(s.id)) { have.add(s.id); ss.push(s); stat.ss.fromSync++; }
  }
  const reviews = markRepeats([...own, ...ss], stat).map((r) => finish(r, copy));
  const noDate = reviews.filter((r) => !r.date).length;
  if (noDate) warnings.push(`날짜를 못 읽은 리뷰 ${noDate}건`);
  const noAnalysis = [...own, ...ss].filter((r) => !r._a && !r.fromSync).length;
  if (noAnalysis) warnings.push(`[분석] 열이 없는 리뷰 ${noAnalysis}건 — 반복 등록·상품군은 이 코드의 규칙으로 판단, 감정·코드 없음`);

  return { files, docs, copybank, reviews, stat, warnings };
}

async function apply(built, source, { replace = false } = {}) {
  const now = new Date().toISOString();
  const out = {};
  if (built.docs) {
    const c = await store.collection('review_docs');
    await c.deleteMany({});
    await c.insertMany(built.docs.map((d) => ({ ...d, source, syncedAt: now })));
    try { await c.createIndex({ id: 1 }, { unique: true }); } catch (_) {}
    out.docs = built.docs.length;

    const cb = await store.collection('review_copybank');
    await cb.deleteMany({});
    if (built.copybank.length) await cb.insertMany(built.copybank.map((r) => ({ ...r, syncedAt: now })));
    try { await cb.createIndex({ fam: 1, qs: -1 }); } catch (_) {}
    out.copybank = built.copybank.length;
  }
  if (built.reviews.length) {
    const rc = await store.collection('reviews');
    if (replace) out.reviewsDeleted = (await rc.deleteMany({})).deletedCount;
    for (let i = 0; i < built.reviews.length; i += 1000) {
      await rc.bulkWrite(built.reviews.slice(i, i + 1000).map((r) => ({
        replaceOne: { filter: { key: r.key }, replacement: { ...r, source, syncedAt: now }, upsert: true },
      })), { ordered: false });
    }
    try {
      await rc.createIndex({ key: 1 }, { unique: true });
      await rc.createIndex({ ch: 1, date: 1 });
      await rc.createIndex({ fam: 1, date: 1 });
    } catch (_) {}
    out.reviews = built.reviews.length;
    out.reviewsTotal = await rc.countDocuments();
    const range = await rc.aggregate([{ $group: { _id: '$ch', from: { $min: '$date' }, to: { $max: '$date' } } }]).toArray();
    out.range = Object.fromEntries(range.map((x) => [x._id, `${x.from}~${x.to}`]));
  }
  const meta = await store.collection('review_meta');
  await meta.updateOne({ key: 'last' }, { $set: { key: 'last', syncedAt: now, source, counts: out, stat: built.stat } }, { upsert: true });
  return { syncedAt: now, ...out };
}

module.exports = { build, apply, parseDoc, parseCopyBank, family, model, cleanBody };
