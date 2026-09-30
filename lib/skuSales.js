'use strict';

/**
 * 품목코드(품번)별 판매 — 전 채널(온라인 on.orders + 오프라인 off.orders) 합산.
 *   상품명이 아니라 **품목코드**로 묶는다. 채널마다 상품명 표기가 달라도 같은 SKU는 같은 코드라 합산이 정확하다.
 *   · 오프라인 "(EPP)" 제품은 옛 제품과 **다른 품번(신규 SKU)** 이다 — 이름만 바꾼 게 아니다.
 *     2026-09-30 실측: 오프라인에서 (EPP) 이름이 붙은 품번 218개 중 옛 이름과 코드를 공유하는 것은 0개.
 *   · 기준: 이카운트 출고일, 반품은 음수로 차감된 순수량·순매출.
 *   · 품번이 비어 있는 행은 합산에서 빠진다 → 기간 내 누락 행을 항상 데이터경고로 같이 낸다
 *     (예: 오프라인 2026-09 는 품번 없이 재적재된 1,647행).
 *   재고 도구(forecast.salesForecast)의 월평균은 **온라인만·상품명 기준**이라 값이 다르다 — 전 채널 SKU 판매는 이 모듈.
 *
 *   ── 커버 소진 환산(family) ──
 *   품번 체계: 숫자 품번 = 커버 단품(200326 서포트 커버), 숫자+접미 = 같은 색 본품
 *   (200326S 스탠다드 · SPre 프리미엄 · SPre+ 프리미엄 플러스 · SHPre 프리미엄(EPP)). 본품 1개에 커버 1장이 들어간다.
 *   → 커버 재고가 얼마나 나가는지(ADS·소진)는 커버 단품만 보면 크게 작다. family=true 는 같은 숫자로 시작하는
 *     품번을 모두 합산한다. 실측(2025-09~2026-08 월평균): 200326 커버 단품 6.4 → 계열 합 41.5,
 *     200108 11.9 → 39.6 — 대시보드 소진 CSV(각 약 39·38/월)와 맞는 값은 계열 합이다.
 */

const store = require('./store');
const promoTarget = require('./promoTarget');

const PG = promoTarget.PRODUCT_GROUPS; // TOP 목록에서만 사용 — 배송비·쇼핑백 등 비상품 제외
const R = (n) => Math.round(n || 0);
const LEDGERS = ['on', 'off'];
const CHS = ['자사몰', '스마트스토어', '외부채널', '오프라인'];
const channelOf = (db, st) => (db === 'off' ? '오프라인' : st === '홈페이지' ? '자사몰' : st === '스마트스토어' ? '스마트스토어' : '외부채널');
const squash = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const dayCount = (s, e) => Math.round((new Date(e + 'T00:00:00Z') - new Date(s + 'T00:00:00Z')) / 86400000) + 1;
const HAS_CODE = { $nin: [null, ''] };
const NO_CODE = { $in: [null, ''] }; // 쿼리 조건 — 필드 없음·null·빈값 모두 포함
// 숫자로 시작하는 품번의 계열 키(200326S·200326SPre+ → 200326). 숫자로 시작하지 않으면(HFILL065 등) 자기 자신.
const baseOf = (code) => { const m = String(code).match(/^(\d+)/); return m ? m[1] : String(code); };

function monthsBetween(start, end) {
  const out = []; let [y, m] = start.slice(0, 7).split('-').map(Number);
  const [ey, em] = end.slice(0, 7).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
function daysBetween(start, end) {
  const out = [];
  for (let d = new Date(start + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10));
  return out;
}

// 검색어 → 품번: 상품명+색상을 공백 없이 이어 붙인 문자열에 검색어 토큰이 모두 들어 있으면 해당
async function findCodes(start, end, q) {
  const toks = String(q).split(/\s+/).map(squash).filter(Boolean);
  const hit = new Set();
  for (const db of LEDGERS) {
    const c = await store.namedCollection(db, 'orders');
    const r = await c.aggregate([
      { $match: { date: { $gte: start, $lte: end }, itemCode: HAS_CODE } },
      { $group: { _id: { code: '$itemCode', name: '$productName', color: '$color' } } },
    ]).toArray();
    for (const { _id: k } of r) if (toks.every((t) => squash(`${k.name}${k.color}`).includes(t))) hit.add(k.code);
  }
  return [...hit];
}

// 기간 내 판매수량 TOP(상품군만) — family 면 계열 합으로 순위
async function topCodes(start, end, limit, family) {
  const m = new Map();
  for (const db of LEDGERS) {
    const c = await store.namedCollection(db, 'orders');
    const r = await c.aggregate([
      { $match: { date: { $gte: start, $lte: end }, itemCode: HAS_CODE, group1: { $in: PG } } },
      { $group: { _id: '$itemCode', qty: { $sum: '$qty' } } },
    ]).toArray();
    for (const x of r) { const k = family ? baseOf(x._id) : x._id; m.set(k, (m.get(k) || 0) + (x.qty || 0)); }
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
}

// 계열 키 → 그 계열의 모든 품번(두 원장). 200326 은 200326·200326S… 를 잡되 2003261 같은 다른 번호는 제외.
async function familyCodes(bases) {
  const out = new Set(bases.filter((b) => !/^\d+$/.test(b)));
  const rx = bases.filter((b) => /^\d+$/.test(b)).map((b) => new RegExp(`^${b}(?!\\d)`));
  if (rx.length) {
    for (const db of LEDGERS) {
      const c = await store.namedCollection(db, 'orders');
      (await c.distinct('itemCode', { itemCode: { $in: rx } })).forEach((x) => out.add(x));
    }
  }
  return [...out];
}

// 품번별 최근 표기(두 원장 중 더 최근 판매 행의 상품명·색상·제품군)
async function latestNames(codes) {
  const best = new Map();
  for (const db of LEDGERS) {
    const c = await store.namedCollection(db, 'orders');
    const r = await c.aggregate([
      { $match: { itemCode: { $in: codes } } },
      { $sort: { date: -1 } },
      { $group: { _id: '$itemCode', name: { $first: '$productName' }, color: { $first: '$color' }, g1: { $first: '$group1' }, date: { $first: '$date' } } },
    ]).toArray();
    for (const x of r) { const b = best.get(x._id); if (!b || x.date > b.date) best.set(x._id, x); }
  }
  return best;
}

// 기간 내 품번 없는 행(원장·월별) — 이 행들은 SKU 합산에서 빠진다
async function missingCodes(start, end) {
  const out = [];
  for (const db of LEDGERS) {
    const c = await store.namedCollection(db, 'orders');
    const r = await c.aggregate([
      { $match: { date: { $gte: start, $lte: end }, itemCode: NO_CODE } },
      { $group: { _id: { $substrCP: ['$date', 0, 7] }, n: { $sum: 1 }, amt: { $sum: '$amount' } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    for (const x of r) out.push({ 원장: db === 'off' ? '오프라인' : '온라인', 월: x._id, 행수: x.n, 금액: R(x.amt) });
  }
  return out;
}

const blank = (k) => ({ key: k, qty: 0, amt: 0, ch: Object.fromEntries(CHS.map((c) => [c, { 수량: 0, 매출: 0 }])), t: {}, parts: new Map() });
function addInto(o, db, st, t, qty, amt) {
  const ch = o.ch[channelOf(db, st)];
  o.qty += qty; o.amt += amt; ch.수량 += qty; ch.매출 += amt;
  if (t != null) o.t[t] = (o.t[t] || 0) + qty;
}

/**
 * @param {object} o
 *   start, end : YYYY-MM-DD
 *   codes      : 품번 배열 또는 "200326, 200108" 문자열
 *   q          : 상품명·색상 검색어(예: "서포트 커버 아보카도")
 *   family     : true 면 커버 소진 환산 — 같은 숫자로 시작하는 품번(커버 단품 + 같은 색 본품)을 한 줄로 합산
 *   by         : 'month' | 'day' | 'none' — 품번·검색어 조회는 기본 month, TOP 목록은 기본 none
 *   limit      : 표시 줄 수(기본 20, 최대 50)
 */
async function sales({ start, end, codes, q, family = false, by, limit } = {}) {
  if (!start || !end) throw new Error('기간(start·end)이 필요합니다');
  const fam = !!family;
  const lim = Math.min(Math.max(Math.round(+limit) || 20, 1), 50);
  let list = (Array.isArray(codes) ? codes : String(codes || '').split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean);
  const mode = (list.length ? '품번 지정' : q ? `검색어 "${q}"` : `판매수량 TOP ${lim}`) + (fam ? ' · 커버 소진 환산(계열 합산)' : '');
  if (!list.length && q) list = await findCodes(start, end, q);
  else if (!list.length) list = await topCodes(start, end, lim, fam);
  if (fam && list.length) list = await familyCodes([...new Set(list.map(baseOf))]);

  const nDays = dayCount(start, end);
  const 기준 = '이카운트 출고일 · 온라인(on.orders: 자사몰=홈페이지·스마트스토어·외부채널=그 외 입점몰) + 오프라인(off.orders) 합산 · 품목코드 단위 · 반품 음수 차감(순수량·순매출) · 월평균 = 일평균 × 30.4'
    + (fam ? ' · 커버 소진 환산 = 같은 숫자 품번으로 시작하는 커버 단품 + 같은 색 본품(S·SPre·SPre+·SHPre 등) 수량 합(본품 1개에 커버 1장). 매출은 본품 매출까지 포함된 값이라 수량만 보라.'
      : ' · 품번 그대로(커버 단품 품번엔 본품 판매가 안 들어간다 — 커버 재고 소진은 family=true)');
  const warn = [];
  const miss = await missingCodes(start, end);
  if (miss.length) {
    warn.push('품번이 비어 있는 행은 합산에서 빠졌다 — ' + miss.map((x) => `${x.원장} ${x.월} ${x.행수.toLocaleString()}행(${x.금액.toLocaleString()}원)`).join(', ')
      + '. 이 달·이 원장의 SKU 수치는 실제보다 작다(품번 포함 재적재 필요).');
  }
  if (!list.length) return { 기간: `${start}~${end} (${nDays}일)`, 조회: mode, 결과: '해당하는 품번이 없습니다 — 검색어를 줄이거나 품번으로 조회하세요.', 기준, 데이터경고: warn.length ? warn : ['없음'] };

  let series = by === 'day' ? 'day' : by === 'none' ? null : by === 'month' ? 'month' : (mode.startsWith('판매수량') ? null : 'month');
  if (series === 'day' && nDays > 92) { series = 'month'; warn.push('일별은 92일 이하 기간만 — 월별로 표시했다.'); }

  // 품번 단위로 모은 뒤, family 면 계열 키로 한 번 더 묶는다(구성 품번별 수량은 parts 에 보존)
  const rows = new Map();
  for (const db of LEDGERS) {
    const c = await store.namedCollection(db, 'orders');
    const t = series === 'day' ? '$date' : series === 'month' ? { $substrCP: ['$date', 0, 7] } : null;
    const r = await c.aggregate([
      { $match: { date: { $gte: start, $lte: end }, itemCode: { $in: list } } },
      { $group: { _id: { code: '$itemCode', st: db === 'off' ? null : '$store', t }, qty: { $sum: '$qty' }, amt: { $sum: '$amount' } } },
    ]).toArray();
    for (const x of r) {
      const code = x._id.code, key = fam ? baseOf(code) : code;
      const o = rows.get(key) || blank(key); rows.set(key, o);
      addInto(o, db, x._id.st, series ? x._id.t : null, x.qty || 0, x.amt || 0);
      o.parts.set(code, (o.parts.get(code) || 0) + (x.qty || 0));
    }
  }
  if (!fam) for (const k of list) if (!rows.has(k)) rows.set(k, blank(k)); // 기간 내 판매 0 인 지정 품번도 표시

  const all = [...rows.values()].sort((a, b) => b.qty - a.qty);
  const shown = all.slice(0, lim);
  if (all.length > shown.length) warn.push(`해당 ${fam ? '계열' : '품번'}이 ${all.length}개라 판매수량 상위 ${shown.length}개만 표시했다.`);
  const names = await latestNames([...new Set(shown.flatMap((r) => [r.key, ...r.parts.keys()]))]);
  const axis = series === 'day' ? daysBetween(start, end) : series === 'month' ? monthsBetween(start, end) : [];
  const label = (code) => { const n = names.get(code) || {}; return { 상품명: n.name || '', 색상: n.color || '', 제품군: n.g1 || '' }; };

  const 품목 = shown.map((r) => {
    const 채널별 = {};
    for (const c of CHS) if (r.ch[c].수량 || r.ch[c].매출) 채널별[c] = { 수량: r.ch[c].수량, 매출: R(r.ch[c].매출) };
    // 계열 대표 표기: 커버 단품(숫자 품번) 이름이 있으면 그것, 없으면 가장 많이 팔린 구성 품번
    const rep = fam ? (names.has(r.key) ? r.key : [...r.parts.entries()].sort((a, b) => b[1] - a[1])[0][0]) : r.key;
    const row = {
      품목코드: r.key, ...(fam ? { 묶음: '커버 단품 + 같은 색 본품' } : {}), ...label(rep),
      수량: r.qty, 매출: R(r.amt),
      일평균: +(r.qty / nDays).toFixed(2), 월평균: +((r.qty / nDays) * 30.4).toFixed(1),
      오프라인비중_pct: r.qty ? +((r.ch['오프라인'].수량 / r.qty) * 100).toFixed(1) : null,
      채널별,
    };
    if (fam) row.구성 = [...r.parts.entries()].sort((a, b) => b[1] - a[1]).map(([code, qty]) => ({ 품목코드: code, 상품명: label(code).상품명, 수량: qty }));
    if (series) row[series === 'day' ? '일별수량' : '월별수량'] = Object.fromEntries(axis.map((k) => [k, r.t[k] || 0]));
    return row;
  });
  const out = { 기간: `${start}~${end} (${nDays}일)`, 조회: mode, [fam ? '계열수' : '품번수']: all.length, 기준, 품목 };
  if (shown.length > 1) out.합계 = { 수량: shown.reduce((s, r) => s + r.qty, 0), 매출: R(shown.reduce((s, r) => s + r.amt, 0)) };
  out.데이터경고 = warn.length ? warn : ['없음'];
  return out;
}

module.exports = { sales, findCodes, missingCodes, baseOf };
