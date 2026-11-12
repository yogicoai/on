'use strict';

/**
 * 리뷰 분석 조회 — MCP 리뷰 도구(review_knowledge · review_copy_bank · reviews)가 쓴다.
 *   적재는 lib/reviewIngest.js · scripts/import-reviews.js (마케팅팀 리뷰 분석 자료, 2026-11).
 *   knowledge  : 리뷰 분석 지식 문서 조각(review_docs) — 목차·검색·본문
 *   copyBank   : 카피 은행 고객 문장(review_copybank)
 *   search     : 리뷰 원문 찾기(reviews)
 *   stats      : 리뷰 수·별점·사진 비율·키워드 언급 집계(reviews) — 채널은 항상 나눠서 센다(문서 K-1-08 5번)
 *
 *   ⚠️ 회의 녹음 원문(A-M-*) 본문은 REVIEW_MEETING_TOKENS(쉼표로 토큰 이름)에 든 토큰만 본다. 로컬 stdio 는 허용.
 *      같은 회의 정리본(7장 M-*)은 누구나 본다.
 *   ⚠️ 평균 별점은 주지 않는다 — 5점이 86~89%라 차이가 안 보인다(문서 K-1-08 3번). 5점·1~2점 비율로 본다.
 */

const store = require('./store');

const PAGE = 12000; // 긴 조각(회의 원문 5~8만 자)은 이 글자 수씩 나눠 준다
const MAX_LIST = 50;
const TTL = 10 * 60 * 1000;

const _g = globalThis;
_g.__reviews = _g.__reviews || { docs: null, at: 0 };

async function loadDocs() {
  const g = _g.__reviews;
  if (g.docs && Date.now() - g.at < TTL) return g.docs;
  const c = await store.collection('review_docs');
  g.docs = await c.find({}, { projection: { _id: 0 } }).sort({ order: 1 }).toArray();
  g.at = Date.now();
  return g.docs;
}

async function basis() {
  const m = await (await store.collection('review_meta')).findOne({ key: 'last' }, { projection: { _id: 0, syncedAt: 1, source: 1 } });
  if (!m) throw new Error('리뷰 분석 자료가 아직 적재되지 않았습니다(scripts/import-reviews.js)');
  return `마케팅팀 리뷰 분석 자료(${m.source}) · 적재 ${String(m.syncedAt).slice(0, 10)}`;
}

function meetingAllowed(who) {
  if (!who) return true;
  const names = String(process.env.REVIEW_MEETING_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return names.includes(who.name);
}

const lower = (s) => String(s || '').toLowerCase();
const terms = (q) => lower(q).split(/[\s,]+/).filter((t) => t.length >= 1);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scoreDoc(d, ts, whole) {
  const title = lower(`${d.id} ${d.title} ${d.chapter}`), body = lower(d.body);
  let s = 0;
  if (whole && (title.includes(whole) || body.includes(whole))) s += title.includes(whole) ? 30 : 10;
  for (const t of ts) {
    if (title.includes(t)) s += 8;
    const hits = body.split(t).length - 1;
    s += Math.min(hits, 10);
  }
  return s;
}
function preview(body, ts) {
  const b = String(body || '').replace(/\s+/g, ' ');
  const at = ts.map((t) => lower(b).indexOf(t)).filter((i) => i >= 0).sort((x, y) => x - y)[0];
  const from = Math.max(0, (at == null ? 0 : at) - 60);
  return (from > 0 ? '…' : '') + b.slice(from, from + 220) + (b.length > from + 220 ? '…' : '');
}

// ── 지식 문서 ─────────────────────────────────────────────────────────────
async function knowledge({ query, id, part } = {}, who) {
  const docs = await loadDocs();
  const 기준 = await basis();
  const allowed = meetingAllowed(who);

  if (id) {
    const want = String(id).trim().replace(/^\[|\]$/g, '');
    const d = docs.find((x) => x.id === want) || docs.find((x) => lower(x.id) === lower(want));
    if (!d) return { 기준, error: `조각 ${want} 이 없습니다 — query 로 찾거나 id 없이 불러 목차를 보세요.` };
    if (d.restricted && !allowed) {
      const sum = docs.find((x) => x.id === d.id.replace(/^A-/, ''));
      return { 기준, id: d.id, title: d.title, 제한: '회의 녹음 원문은 지정된 토큰만 볼 수 있습니다. 같은 회의의 정리본을 보세요.', 정리본: sum ? `${sum.id} ${sum.title}` : null };
    }
    const parts = Math.max(1, Math.ceil(d.body.length / PAGE));
    const p = Math.min(Math.max(1, Number(part) || 1), parts);
    return {
      기준, id: d.id, title: d.title, 장: d.chapter, 부분: `${p}/${parts}`,
      본문: d.body.slice((p - 1) * PAGE, p * PAGE),
      ...(p < parts ? { 다음: `같은 id 로 part=${p + 1}` } : {}),
    };
  }

  if (query) {
    const ts = terms(query), whole = lower(query).trim();
    const ranked = docs.map((d) => ({ d, s: scoreDoc(d, ts, whole) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 12);
    return {
      기준, 검색어: query, 건수: ranked.length,
      결과: ranked.map(({ d }) => ({
        id: d.id, title: d.title, 장: d.chapter, 글자수: d.chars,
        미리보기: d.restricted && !allowed ? '(회의 녹음 원문 — 지정된 토큰만)' : preview(d.body, ts),
      })),
      안내: '본문은 id 로 다시 부르세요. 숫자를 쓸 때는 조각 ID를 근거로 달고, 그 조각에 적힌 기준(기간·채널·분모)을 함께 적으세요.',
    };
  }

  const chapters = [];
  for (const d of docs) {
    let ch = chapters[chapters.length - 1];
    if (!ch || ch.장 !== d.chapter) { ch = { 장: d.chapter, 조각: [] }; chapters.push(ch); }
    ch.조각.push(`${d.id} ${d.title}${d.restricted && !allowed ? ' (지정 토큰만)' : ''}`);
  }
  return { 기준, 안내: '리뷰 기반 개선안은 P-9-01~04(절차·출력 형식) → K-1(용어·숫자 규칙) → K-2(임원진 방향성) 순서로 읽고 시작하세요.', 목차: chapters };
}

// ── 카피 은행 ─────────────────────────────────────────────────────────────
async function copyBank({ query, fam, model, ch, year, code, minScore, limit } = {}) {
  const c = await store.collection('review_copybank');
  const f = { qs: { $gte: Number(minScore) || 2 } };
  if (fam) f.fam = fam;
  if (model) f.model = model;
  if (ch) f.ch = ch;
  if (year) f.yr = Number(year);
  if (code) f.codes = { $elemMatch: { $regex: escapeRe(code) } };
  if (query) f.q = { $regex: terms(query).map(escapeRe).join('|') };
  const n = Math.min(MAX_LIST, Math.max(1, Number(limit) || 20));
  const [total, rows] = await Promise.all([
    c.countDocuments(f),
    c.find(f, { projection: { _id: 0, syncedAt: 0 } }).sort({ qs: -1, yr: -1 }).limit(n).toArray(),
  ]);
  const out = {
    기준: `${await basis()} · 카피 은행 = AI가 카피 가치 2점 이상으로 본 고객 원문(3점 = 헤드라인감)`,
    건수: total, 표시: rows.length,
    목록: rows.map((r) => ({ id: r.id, 문장: r.q, 점수: r.qs, 상품군: r.fam, 모델: r.model, 채널: r.ch, 종류: r.kind, 연도: r.yr, 별점: r.rating, 사진: r.photo, 코드: r.codes, 쓰임: r.item })),
    주의: '광고·상세페이지에 쓸 때는 원문 그대로, 사전 동의와 "구매 고객 리뷰" 표시(문서 K-1-08 10번).',
  };
  if (!query && !code && !fam && !model) {
    const top = await c.aggregate([{ $unwind: '$codes' }, { $group: { _id: '$codes', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 40 }]).toArray();
    out.코드목록 = top.map((t) => `${t._id} ${t.n}`);
  }
  return out;
}

// ── 리뷰 원문 ─────────────────────────────────────────────────────────────
function reviewFilter(a) {
  const f = {};
  if (a.start || a.end) { f.date = {}; if (a.start) f.date.$gte = a.start; if (a.end) f.date.$lte = a.end; }
  if (a.ch) f.ch = a.ch;
  if (a.fam) f.fam = a.fam;
  if (a.model) f.model = a.model;
  if (a.kind) f.kind = a.kind;
  if (a.buyer) f.buyer = a.buyer;
  if (a.rating != null && a.rating !== '') {
    const m = String(a.rating).match(/^(\d)\s*[-~]\s*(\d)$/);
    f.rating = m ? { $gte: Number(m[1]), $lte: Number(m[2]) } : Number(a.rating);
  }
  if (a.media === true) f.hasMedia = true;
  if (a.keyword) f.body = { $regex: terms(a.keyword).map(escapeRe).join('|'), $options: 'i' };
  return f;
}

async function search(a = {}) {
  const c = await store.collection('reviews');
  const f = reviewFilter(a);
  if (!a.includeRepeats) f.repeat = { $ne: true };
  f.hidden = { $ne: true };
  if (a.minLen) f.len = { $gte: Number(a.minLen) };
  const sort = { old: { date: 1 }, long: { len: -1 }, helpful: { helpful: -1, date: -1 } }[a.sort] || { date: -1 };
  const n = Math.min(MAX_LIST, Math.max(1, Number(a.limit) || 20));
  const [total, rows] = await Promise.all([
    c.countDocuments(f),
    c.find(f, { projection: { _id: 0 } }).sort(sort).limit(n).toArray(),
  ]);
  return {
    기준: `${await basis()} · 리뷰 원문(2024-01부터 적재분, 반복 등록·블라인드 제외)`,
    건수: total, 표시: rows.length,
    목록: rows.map((r) => ({
      id: r.key, 날짜: r.date, 채널: r.ch, 상품: r.product, 상품군: r.fam, 모델: r.model || null, 별점: r.rating,
      종류: r.ch === '스마트스토어' ? r.kind : `${r.buyer}${r.chatbot ? ' · 크리마 리뷰 챗봇' : ''}`,
      사진영상: r.hasMedia, 본문: r.body.length > 400 ? `${r.body.slice(0, 400)}…` : r.body,
      ...(r.copy ? { 카피코드: r.copy.codes } : {}),
    })),
  };
}

const pct = (a, b) => (b ? +((a / b) * 100).toFixed(1) : null);

async function stats(a = {}) {
  const c = await store.collection('reviews');
  const { keyword, ...rest } = a;
  const f = reviewFilter(rest);
  const rows = await c.find(f, { projection: { _id: 0, date: 1, ch: 1, fam: 1, model: 1, rating: 1, hasMedia: 1, len: 1, repeat: 1, hidden: 1, ...(keyword ? { body: 1 } : {}) } }).toArray();
  const by = a.by || 'month';
  const groupOf = { month: (r) => (r.date || '').slice(0, 7), year: (r) => (r.date || '').slice(0, 4), fam: (r) => r.fam, model: (r) => r.model || '(모델 없음)' }[by] || ((r) => (r.date || '').slice(0, 7));
  const re = keyword ? new RegExp(terms(keyword).map(escapeRe).join('|'), 'i') : null;
  const acc = new Map();
  for (const r of rows) {
    const k = `${groupOf(r)}\t${r.ch}`;
    const o = acc.get(k) || { 그룹: groupOf(r), 채널: r.ch, 게시: 0, n: 0, five: 0, low: 0, media: 0, len: 0, short: 0, info: 0, hit: 0 };
    o.게시++;
    if (!r.repeat && !r.hidden) {
      o.n++;
      if (r.rating === 5) o.five++;
      if (r.rating && r.rating <= 2) o.low++;
      if (r.hasMedia) o.media++;
      o.len += r.len || 0;
      if ((r.len || 0) <= 10) o.short++;
      else { o.info++; if (re && re.test(r.body || '')) o.hit++; }
    }
    acc.set(k, o);
  }
  const list = [...acc.values()].sort((x, y) => String(x.그룹).localeCompare(String(y.그룹)) || x.채널.localeCompare(y.채널)).map((o) => ({
    그룹: o.그룹, 채널: o.채널,
    리뷰수_게시판기준: o.게시, 리뷰수_분석기준: o.n,
    '5점_비율%': pct(o.five, o.n), '1~2점_비율%': pct(o.low, o.n), '사진·영상_포함_비율%': pct(o.media, o.n),
    평균_글자수: o.n ? Math.round(o.len / o.n) : null, '10자_이하_비율%': pct(o.short, o.n),
    ...(re ? { 키워드_언급수: o.hit, '키워드_언급률%': pct(o.hit, o.info), ...(o.info < 10 ? { 주의: '10건 미만 — 결론 내지 말 것' } : {}) } : {}),
  }));
  return {
    기준: `${await basis()} · 리뷰 원문 2024-01부터 적재분`,
    정의: '게시판기준 = 반복 등록·블라인드 포함(작성 수량용) · 분석기준 = 같은 작성자 같은 글 반복과 블라인드 제외(내용 분석용). 비율은 분석기준 분모. ' +
      (re ? '키워드 언급률 = 분석기준 중 10자 초과 리뷰에서 키워드가 나온 비율(단어 일치라 AI 분류 언급률과 다르다). ' : '') +
      '평균 별점은 쓰지 않는다(5점이 대부분). 채널은 섞지 않고 따로 센다.',
    ...(keyword ? { 키워드: keyword } : {}),
    목록: list,
  };
}

module.exports = { knowledge, copyBank, search, stats, meetingAllowed };
