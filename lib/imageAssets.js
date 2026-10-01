'use strict';

/**
 * 이미지 자료 조회 — 이미지 제작 앱(imgCreate) DB 를 읽어 전속 모델·제품 색상·드롭박스 실촬영의
 * 기준 정보와 이미지 링크(회사 서버 cafe24 FTP)를 돌려준다. MCP 도구 image_reference 가 쓴다.
 *   · 이미지를 만들지 않는다 — 등록된 정보와 링크만 준다.
 *   · 이 파일에는 조회(find·count·distinct)만 있다. 쓰기를 넣지 않는다.
 *   · 접속: IMGCREATE_MONGODB_URI(읽기 전용 계정) · IMGCREATE_MONGODB_DB(기본 imgcreate).
 *     비어 있으면 이 도구만 "미설정" 안내를 돌려주고 나머지 도구는 영향 없다.
 *   · 프롬프트 문장(영문 아이덴티티·형태 서술 등)은 내보내지 않는다 — 정보·링크까지만.
 */

const { loadEnv } = require('./env');
loadEnv();
const { MongoClient } = require('mongodb');

const URI = process.env.IMGCREATE_MONGODB_URI || '';
const DB_NAME = process.env.IMGCREATE_MONGODB_DB || 'imgcreate';

// 서버리스·상시 호스트 모두 커넥션 재사용 — store.js 와 같은 방식
const _g = globalThis;
_g.__imgcreate = _g.__imgcreate || { db: null, promise: null };

async function db() {
  const g = _g.__imgcreate;
  if (g.db) return g.db;
  if (!URI) {
    throw new Error('IMGCREATE_MONGODB_URI 미설정 — imgCreate DB 읽기 전용 계정 접속주소를 환경변수에 넣어야 이미지 자료를 조회할 수 있습니다.');
  }
  if (!g.promise) {
    g.promise = new MongoClient(URI, { maxPoolSize: 3 }).connect()
      .then((c) => { g.db = c.db(DB_NAME); return g.db; })
      .catch((e) => { g.promise = null; throw e; });
  }
  return g.promise;
}

const esc = (s) => String(s || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ACTIVE = { active: { $ne: false } };

// 제품 라인 한글 이름 — imgCreate 화면과 같은 표. DB 의 line 은 영문 그대로(나머지 소품은 이미 한글)
const LINE_KR = {
  Max: '맥스', Slim: '슬림', Midi: '미디', Mini: '미니', Double: '더블',
  Drop: '드롭', Pod: '팟', Lounger: '라운저', Pyramid: '피라미드', Support: '서포트', Etc: '기타',
};
const kr = (line) => LINE_KR[line] || line;

// 링크 묶음의 영문 키 → 한글 이름 (표에 없는 키는 그대로)
const VIEW_KR = { front: '정면', side: '측면', back: '후면', a045: '45도', a135: '135도', a225: '225도', a270: '270도', a315: '315도' };
const USAGE_KR = { sitting_recliner: '리클라이너처럼 앉기', sitting_on_top: '위에 앉기', modes4: '4가지 모드', sleeping: '눕기' };
const EXPR_KR = {
  neutral: '무표정', soft_smile: '옅은 미소', bright_smile: '활짝 웃음', surprised: '놀람',
  sad: '슬픔', frown: '찡그림', serious: '진지함', side_glance: '곁눈질',
};
// _l = 얼굴이 화면 왼쪽을 향한 칸, _r = 오른쪽
const FACE_KR = {
  front: '정면', three_quarter_l: '3/4 (화면 왼쪽을 봄)', profile_l: '옆모습 (화면 왼쪽을 봄)',
  three_quarter_r: '3/4 (화면 오른쪽을 봄)', profile_r: '옆모습 (화면 오른쪽을 봄)',
};
const named = (obj, names) => Object.fromEntries(
  Object.entries(obj || {}).filter(([, url]) => typeof url === 'string' && url).map(([k, url]) => [names[k] || k, url]),
);

// ── 제품 ────────────────────────────────────────────────────────────────

async function products({ search } = {}) {
  const d = await db();
  const rows = await d.collection('products').find(ACTIVE).sort({ order: 1 })
    .project({ line: 1, category: 1, sizeText: 1, colors: 1 }).toArray();
  const rx = search ? new RegExp(esc(search), 'i') : null;
  const items = rows.map((p) => ({
    제품: kr(p.line),
    영문: LINE_KR[p.line] ? p.line : undefined,
    분류: p.category || '',
    치수: p.sizeText || '',
    색상: (p.colors || []).map((c) => c.name).filter(Boolean),
  })).filter((x) => !rx || rx.test(x.제품) || rx.test(x.영문 || '') || x.색상.some((c) => rx.test(c)));
  return {
    제품수: items.length,
    제품: items,
    안내: '제품 하나의 색상 hex·각도별 이미지는 mode=product (line=제품명, color=색상명).',
  };
}

// 이름으로 제품 하나 — 한글(맥스)·영문(Max, 대소문자 무시) 정확히 일치. 없으면 null
async function findProduct(d, line) {
  const want = String(line || '').trim();
  const en = Object.keys(LINE_KR).find((k) => LINE_KR[k] === want);
  return d.collection('products').findOne({
    ...ACTIVE,
    $or: [{ line: en || want }, { line: new RegExp(`^${esc(want)}$`, 'i') }],
  });
}

async function product({ line, color } = {}) {
  if (!line) throw new Error('line(제품명)이 필요합니다 — 예: 맥스, 팟, 서포트');
  const d = await db();
  const p = await findProduct(d, line);
  if (!p) {
    const rx = new RegExp(esc(line), 'i');
    const all = await d.collection('products').find(ACTIVE).sort({ order: 1 }).project({ line: 1 }).toArray();
    const cands = all.map((x) => kr(x.line)).filter((name, i) => rx.test(name) || rx.test(all[i].line));
    return { 매칭: 0, 후보: cands.slice(0, 15), 안내: `'${line}' 제품을 찾지 못했습니다 — 후보 중 하나로 다시 조회하세요.` };
  }
  const colors = p.colors || [];
  const base = {
    제품: kr(p.line),
    영문: p.line,
    분류: p.category || '',
    치수: p.sizeText || '',
    치수_cm: p.dims ? { 높이: p.dims.h ?? null, 폭: p.dims.w ?? null, 깊이: p.dims.d ?? null, 무게_kg: p.dims.weight ?? null } : null,
  };

  if (color) {
    const rx = new RegExp(esc(color), 'i');
    const hit = colors.filter((c) => rx.test(c.name || '') || rx.test(c.nameEn || '') || rx.test(c.key || ''));
    if (!hit.length) {
      return { ...base, 매칭: 0, 색상목록: colors.map((c) => c.name), 안내: `'${color}' 색상이 없습니다 — 색상목록에서 고르세요.` };
    }
    return {
      ...base,
      색상: hit.map((c) => ({
        이름: c.name, 영문: c.nameEn || '', hex: c.hex || '',
        회전360: c.sprite360 || undefined,
        각도별이미지: named(c.views, VIEW_KR),
      })),
    };
  }

  const sv = Array.isArray(p.shapeViews) ? p.shapeViews : p.shapeViews ? [p.shapeViews] : [];
  return {
    ...base,
    색상수: colors.length,
    색상: colors.map((c) => ({
      이름: c.name, 영문: c.nameEn || '', hex: c.hex || '', 대표색: c.isRep ? true : undefined,
      정면이미지: (c.views && c.views.front) || null,
    })),
    형태기준이미지: sv.map((v) => ({ 색: v.colorName || null, 각도별이미지: named(v.views, VIEW_KR) })),
    사용예시: named(p.usageShots, USAGE_KR),
    안내: '한 색의 각도별 이미지(정면·측면·후면·45도 등)는 color 에 색상명을 넣어 다시 조회.',
  };
}

// ── 전속 모델 ────────────────────────────────────────────────────────────

const CAT = { 여성: '여성', 여자: '여성', 남성: '남성', 남자: '남성', 아동: '아동', 아이: '아동', 키즈: '아동' };

// W_B · w-b · 여성B · 여자 모델 B → W_B
function normCode(code) {
  const x = String(code || '').trim().toUpperCase().replace(/\s+/g, '').replace('모델', '');
  const m = x.match(/^([WMK])[_-]?([A-Z])$/);
  if (m) return `${m[1]}_${m[2]}`;
  const k = x.match(/^(여성|여자|남성|남자|아동|아이|키즈)([A-Z])$/);
  if (k) return `${{ 여성: 'W', 남성: 'M', 아동: 'K' }[CAT[k[1]]]}_${k[2]}`;
  return x;
}

async function talents({ category, search } = {}) {
  const d = await db();
  const q = { ...ACTIVE };
  if (category) q.category = CAT[String(category).trim()] || String(category).trim();
  const rows = await d.collection('talents').find(q).sort({ order: 1 })
    .project({ code: 1, category: 1, name: 1, thumbDesc: 1, size: 1, status: 1, outfits: 1, rep: 1 }).toArray();
  const rx = search ? new RegExp(esc(search), 'i') : null;
  const items = rows
    .filter((t) => !rx || [t.code, t.name, t.thumbDesc].some((s) => rx.test(s || '')))
    .map((t) => ({
      코드: t.code, 분류: t.category, 설명: t.thumbDesc || t.name || '', 키_체형: t.size || '',
      등록상태: t.status || '', 의상수: (t.outfits || []).length, 대표컷: t.rep || null,
    }));
  const byCat = {};
  for (const m of items) byCat[m.분류] = (byCat[m.분류] || 0) + 1;
  return {
    인원: items.length,
    분류별: byCat,
    모델: items,
    안내: '한 명의 시트·표정·얼굴 각도·의상 이미지는 mode=talent (code=W_B 등). 코드 앞글자 W=여성 · M=남성 · K=아동.',
  };
}

async function talent({ code } = {}) {
  if (!code) throw new Error('code(모델 코드)가 필요합니다 — 예: W_B, M_A, K_C');
  const d = await db();
  const t = await d.collection('talents').findOne({ code: normCode(code), ...ACTIVE });
  if (!t) {
    const all = await d.collection('talents').find(ACTIVE).sort({ order: 1 }).project({ code: 1 }).toArray();
    return { 매칭: 0, 코드목록: all.map((x) => x.code), 안내: `'${code}' 모델을 찾지 못했습니다 — 코드목록에서 고르세요.` };
  }
  return {
    코드: t.code,
    분류: t.category,
    설명: t.thumbDesc || t.name || '',
    키_체형: t.size || '',
    등록상태: t.status || '',
    대표컷: t.rep || null,
    시트: {
      얼굴: (t.sheets && t.sheets.face) || null,
      표정: t.exprSheet || (t.sheets && t.sheets.expr) || null,
      바디: (t.sheets && t.sheets.body) || null,
    },
    표정: named(t.expressionCrops, EXPR_KR),
    얼굴각도: named(t.faceCrops, FACE_KR),
    의상: (t.outfits || []).map((o) => ({ 코드: o.code, 설명: o.desc || '', 이미지: o.imageUrl || null, 크롭: o.cropUrl || null })),
  };
}

// ── 드롭박스 실촬영 아카이브 ────────────────────────────────────────────────

async function photos({ product: label, keyword, limit, skip } = {}) {
  const d = await db();
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const from = Math.max(Number(skip) || 0, 0);
  const q = { active: true };
  if (label) q.products = LINE_KR[String(label).trim()] || String(label).trim(); // Max → 맥스
  if (keyword) {
    const rx = new RegExp(esc(keyword), 'i');
    q.$or = [{ sourcePath: rx }, { title: rx }];
  }
  const col = d.collection('dropbox_assets');
  const [total, rows] = await Promise.all([
    col.countDocuments(q),
    col.find(q).sort({ srcUploaded: -1, srcMtime: -1, sourcePath: 1 }).skip(from).limit(n)
      .project({ url: 1, title: 1, products: 1, width: 1, height: 1, sourcePath: 1 }).toArray(),
  ]);
  const out = {
    전체: total,
    보여준수: rows.length,
    결과: rows.map((r) => ({
      이미지: r.url,
      제목: r.title || '',
      제품: r.products || [],
      크기: r.width && r.height ? `${r.width}x${r.height}` : '',
      폴더: String(r.sourcePath || '').split('/').slice(0, -1).join('/'),
    })),
  };
  if (from + rows.length < total) out.다음 = `skip=${from + rows.length} 로 다음 ${n}장`;
  if (!total && label) out.제품라벨 = await col.distinct('products', { active: true });
  return out;
}

// ── 도구 진입점 ──────────────────────────────────────────────────────────

async function query(a = {}) {
  switch (a.mode) {
    case 'products': return products(a);
    case 'product': return product(a);
    case 'talents': return talents(a);
    case 'talent': return talent(a);
    case 'photos': return photos(a);
    default: throw new Error('mode 는 products | product | talents | talent | photos 중 하나입니다.');
  }
}

module.exports = { query, products, product, talents, talent, photos };
