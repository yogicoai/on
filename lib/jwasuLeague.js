'use strict';

/**
 * Y리그 (오프라인 매장 리그) — deliveryOFF/Y리그현황.html 로직 재현.
 *   종목 3개:
 *     · 좌수왕(jwasu): 목표 인원(targetCount) 대비 판매 인원(count) 달성률 — realtime 백엔드가 rank/rate 계산해 줌(API 그대로 사용)
 *     · 캐스트(cast): 직영(매니저/부매니저/시니어/일급제) 개인별 매출 순위 — off.orders 집계
 *     · 스토어(store): 매장별 목표매출(targetMonthlySales) 대비 매출 달성률 — off.orders + jwasu 목표
 *   데이터 소스: realtime cloudtype API(/api/jwasu/dashboard) + off.orders(DB) + yogibo.jwasu_managers
 *   ※ 공식 Y리그 화면은 프론트에서 일부 노출 보정(특정 인원 화이트리스트·근무지 이동 분리)을 추가 적용 —
 *     여기 결과는 원천 집계라 화면과 소폭 다를 수 있음(분석용으로는 이 원천이 정확).
 */

const store = require('./store');

const REALTIME = process.env.REALTIME_API || 'https://port-0-realtime-lzgmwhc4d9883c97.sel4.cloudtype.app';
const R = (n) => Math.round(n || 0);
const N = (v) => (Number.isFinite(+v) ? +v : 0);
// 캐스트 = 직영 역할만 (Y리그현황.html 안내문과 동일)
const CAST_ROLES = ['매니저', '부매니저', '시니어', '일급제'];

// "서보름 부매니저" → { name:'서보름', role:'부매니저' }
function splitManager(full) {
  const s = String(full || '').trim();
  const m = s.match(/^(.+?)\s+(매니저|부매니저|시니어|일급제|서포터|중간관리|주니어)$/);
  return m ? { name: m[1].trim(), role: m[2] } : { name: s, role: '' };
}

// 좌수왕 — realtime API(서버 계산 rank/rate) 그대로
async function jwasu(start, end) {
  const url = `${REALTIME}/api/jwasu/dashboard?searchType=range&date=${end}&startDate=${start}&endDate=${end}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error('realtime jwasu API 실패: ' + JSON.stringify(j).slice(0, 120));
  return (j.data || []).map((x) => ({
    순위: x.rank, 매장: x.storeName, 매니저: x.managerName, 역할: x.role,
    실적_좌수: N(x.count), 목표_좌수: N(x.targetCount),
    달성률_pct: +(+x.rate || 0).toFixed(1),
  }));
}

// off.orders 기간 집계(캐스트/스토어 공용) + jwasu_managers 마스터
async function loadBase(start, end) {
  const [ordersColl, mgrColl] = await Promise.all([
    store.namedCollection('off', 'orders'),
    store.namedCollection('yogibo', 'jwasu_managers'),
  ]);
  const [rows, mgrs] = await Promise.all([
    ordersColl.aggregate([
      { $match: { date: { $gte: start, $lte: end } } },
      { $group: { _id: { manager: '$manager', store: '$store' }, sales: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } },
    ]).toArray(),
    mgrColl.find({}, { projection: { storeName: 1, managerName: 1, role: 1, isActive: 1, targetMonthlySales: 1 } }).toArray(),
  ]);
  const mgrMap = {}; // 'name' → master (매장 무관 조회용은 name+store 우선)
  for (const m of mgrs) { mgrMap[`${m.storeName}\t${m.managerName}`] = m; if (!mgrMap[m.managerName]) mgrMap[m.managerName] = m; }
  return { rows, mgrMap };
}

// 캐스트 — 직영 개인별 매출 순위 (마스터 role 우선, 없으면 주문 매니저명의 접미 role)
async function cast(start, end) {
  const { rows, mgrMap } = await loadBase(start, end);
  const agg = {};
  for (const r of rows) {
    const { name, role: orderRole } = splitManager(r._id.manager);
    const storeName = r._id.store || '';
    const master = mgrMap[`${storeName}\t${name}`] || mgrMap[name];
    if (master && master.isActive === false) continue;
    const role = (master && master.role) || orderRole;
    if (!CAST_ROLES.includes(role)) continue; // 직영만
    const key = `${storeName}\t${name}`;
    const a = (agg[key] = agg[key] || { 매장: storeName, 매니저: name, 역할: role, 매출: 0, 수량: 0, 주문수: 0 });
    a.매출 += N(r.sales); a.수량 += N(r.qty); a.주문수 += (r.ord || []).length;
  }
  return Object.values(agg).map((a) => ({ ...a, 매출: R(a.매출) }))
    .sort((a, b) => b.매출 - a.매출)
    .map((a, i) => ({ 순위: i + 1, ...a }));
}

// 스토어 — 매장별 매출 vs 매장 목표(realtime jwasu 행의 targetMonthlySales, 매장당 동일값 → max)
async function storeLeague(start, end) {
  const { rows } = await loadBase(start, end);
  const salesBy = {};
  for (const r of rows) { const sn = r._id.store || '(미지정)'; salesBy[sn] = (salesBy[sn] || 0) + N(r.sales); }
  // 매장 목표 = jwasu_monthly_targets(해당 월)의 매장별 targetMonthlySales (매장당 동일값 복제 → max)
  const targetBy = {};
  const tColl = await store.namedCollection('yogibo', 'jwasu_monthly_targets');
  const ym = String(start).slice(0, 7);
  const tRows = await tColl.find({ month: ym }).toArray();
  for (const t of tRows) { const sn = t.storeName; targetBy[sn] = Math.max(targetBy[sn] || 0, N(t.targetMonthlySales)); }
  const stores = [...new Set([...Object.keys(salesBy), ...Object.keys(targetBy)])];
  return stores.map((sn) => {
    const 매출 = R(salesBy[sn] || 0), 목표 = R(targetBy[sn] || 0);
    return { 매장: sn, 매출, 목표매출: 목표, 달성률_pct: 목표 ? +((매출 / 목표) * 100).toFixed(1) : null };
  }).sort((a, b) => (b.달성률_pct || 0) - (a.달성률_pct || 0) || b.매출 - a.매출)
    .map((s, i) => ({ 순위: i + 1, ...s }));
}

// 통합 — 3종목 한 번에
async function league(start, end) {
  const [jw, ca, st] = await Promise.all([
    jwasu(start, end).catch((e) => ({ error: e.message })),
    cast(start, end).catch((e) => ({ error: e.message })),
    storeLeague(start, end).catch((e) => ({ error: e.message })),
  ]);
  return {
    start, end,
    좌수왕: Array.isArray(jw) ? jw.slice(0, 15) : jw,   // 목표인원 대비 판매인원 달성률
    캐스트: Array.isArray(ca) ? ca.slice(0, 15) : ca,   // 직영 개인 매출 순위
    스토어: st,                                          // 매장 목표매출 대비 달성률
    주의: '공식 Y리그 화면은 일부 노출 보정(인원 화이트리스트·근무지 이동 분리)을 프론트에서 추가 적용 — 여기 수치는 원천 집계 기준.',
  };
}

module.exports = { league, jwasu, cast, storeLeague };
