'use strict';

/**
 * 오프라인 매장 판매 분석 — DB 'off'.orders (오프라인 주문서 시스템 적재본, 같은 클러스터).
 *   스키마: { orderNo, date(YYYY-MM-DD), month, week, store(매장), manager(판매사원),
 *            productName, color, category, beadType(충전재), group1/group2, qty, amount, isSet, isCover }
 *   매장: 신세계센텀시티몰·스타필드하남/고양·롯데동탄/안산/김포공항/대구·현대미아/무역센터·신세계본점/대전 등 백화점/몰 오프라인.
 *   ※ 이카운트(on.orders)의 온라인 채널과는 별개 원장 — 온·오프 비교는 onOffCompare 사용.
 *   ※ 고객 개인정보 없음(판매사원명은 내부 집계용).
 */

const store = require('./store');
const dailyReport = require('./dailyReport');

const DB = 'off', COLL = 'orders';
const R = (n) => Math.round(n || 0);
const N = (v) => (Number.isFinite(+v) ? +v : 0);

async function coll() { return store.namedCollection(DB, COLL); }

// [start,end] 가 걸치는 월들의 매장별 목표매출 합 — yogibo.jwasu_monthly_targets (매장당 동일값 복제 → 월별 max 후 합산)
async function storeTargets(start, end) {
  const months = [];
  let d = new Date(start.slice(0, 7) + '-01T00:00:00');
  const endYm = end.slice(0, 7);
  for (let g = 0; g < 24; g++) {
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push(ym);
    if (ym >= endYm) break;
    d.setMonth(d.getMonth() + 1);
  }
  const t = await store.namedCollection('yogibo', 'jwasu_monthly_targets');
  const rows = await t.aggregate([
    { $match: { month: { $in: months } } },
    { $group: { _id: { store: '$storeName', month: '$month' }, target: { $max: '$targetMonthlySales' } } },
  ]).toArray();
  const by = {};
  for (const r of rows) { const sn = r._id.store; by[sn] = (by[sn] || 0) + N(r.target); }
  return { months, by };
}

// 기간 오프라인 종합 — 합계 + 매장별 + 카테고리/충전재 + 상품TOP + 판매사원별. storeName 지정 시 그 매장만(부분일치).
async function analyze(start, end, { storeName } = {}) {
  const c = await coll();
  const match = { date: { $gte: start, $lte: end } };
  if (storeName) match.store = { $regex: String(storeName).trim(), $options: 'i' };
  const [tot, byStore, byCat, byBead, prodTop, byMgr, targets] = await Promise.all([
    c.aggregate([{ $match: match }, { $group: { _id: null, amount: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: '$store', amount: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } }, { $sort: { amount: -1 } }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: '$category', amount: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { amount: -1 } }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: '$beadType', amount: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { amount: -1 } }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: '$productName', amount: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { amount: -1 } }, { $limit: 30 }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: { store: '$store', manager: '$manager' }, amount: { $sum: '$amount' }, ord: { $addToSet: '$orderNo' } } }, { $sort: { amount: -1 } }, { $limit: 30 }]).toArray(),
    storeTargets(start, end).catch(() => ({ months: [], by: {} })),
  ]);
  const t = tot[0] || { amount: 0, qty: 0, ord: [] };
  const orders = (t.ord || []).length;
  const targetTotal = Object.values(targets.by).reduce((a, b) => a + b, 0);
  return {
    start, end,
    totals: {
      매출: R(t.amount), 수량: N(t.qty), 주문수: orders, 객단가: orders ? R(t.amount / orders) : 0, 매장수: byStore.length,
      목표매출합: R(targetTotal) || null,
      목표달성률_pct: targetTotal ? +((t.amount / targetTotal) * 100).toFixed(1) : null,
      목표기준월: targets.months.join(',') || null, // 기간이 월 일부여도 목표는 해당 월 전체 기준
    },
    매장별: byStore.map((s) => {
      const 매출 = R(s.amount); const 목표 = R(targets.by[s._id] || 0);
      return {
        매장: s._id || '(미지정)', 매출, 수량: N(s.qty), 주문수: (s.ord || []).length, 객단가: (s.ord || []).length ? R(s.amount / s.ord.length) : 0,
        목표매출: 목표 || null, 달성률_pct: 목표 ? +((매출 / 목표) * 100).toFixed(1) : null,
      };
    }),
    카테고리별: byCat.map((x) => ({ 카테고리: x._id || '(미상)', 매출: R(x.amount), 수량: N(x.qty) })),
    충전재별: byBead.map((x) => ({ 충전재: x._id || '(미상)', 매출: R(x.amount), 수량: N(x.qty) })),
    상품TOP: prodTop.slice(0, 12).map((x) => ({ 상품: x._id || '(미상)', 매출: R(x.amount), 수량: N(x.qty) })),
    판매사원TOP: byMgr.slice(0, 12).map((m) => ({ 매장: m._id.store || '', 사원: m._id.manager || '(미상)', 매출: R(m.amount), 주문수: (m.ord || []).length })),
  };
}

// 일별 오프라인 매출 시계열 (매장 합계 · 매장별 옵션)
async function dailySeries(start, end) {
  const c = await coll();
  const rows = await c.aggregate([
    { $match: { date: { $gte: start, $lte: end } } },
    { $group: { _id: '$date', amount: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  return rows.map((r) => ({ date: r._id, 매출: R(r.amount), 수량: N(r.qty), 주문수: (r.ord || []).length }));
}

// 온라인(이카운트: 자사몰+스마트스토어+외부채널) vs 오프라인(off.orders) 비교 — 합계·비중·일별
async function onOffCompare(start, end) {
  const [offDaily, onSeries] = await Promise.all([
    dailySeries(start, end),
    dailyReport.dailyChannelSeries('2025-01-01').catch(() => []),
  ]);
  const onRange = onSeries.filter((d) => d.Date >= start && d.Date <= end);
  const on = onRange.reduce((a, d) => { a.자사몰 += d.자사몰 || 0; a.스마트스토어 += d.스마트스토어 || 0; a.외부채널 += d.외부채널 || 0; return a; }, { 자사몰: 0, 스마트스토어: 0, 외부채널: 0 });
  const 온라인 = R(on.자사몰 + on.스마트스토어 + on.외부채널);
  const 오프라인 = offDaily.reduce((a, d) => a + d.매출, 0);
  const 전체 = 온라인 + 오프라인;
  const onBy = {}; for (const d of onRange) onBy[d.Date] = R((d.자사몰 || 0) + (d.스마트스토어 || 0) + (d.외부채널 || 0));
  const offBy = {}; for (const d of offDaily) offBy[d.date] = d.매출;
  const dates = [...new Set([...Object.keys(onBy), ...Object.keys(offBy)])].sort();
  return {
    start, end,
    합계: {
      온라인: { 매출: 온라인, 자사몰: R(on.자사몰), 스마트스토어: R(on.스마트스토어), 외부채널: R(on.외부채널), 비중_pct: 전체 ? +((온라인 / 전체) * 100).toFixed(1) : null },
      오프라인: { 매출: R(오프라인), 비중_pct: 전체 ? +((오프라인 / 전체) * 100).toFixed(1) : null },
      전체: R(전체),
    },
    일별: dates.map((d) => ({ date: d, 온라인: onBy[d] || 0, 오프라인: offBy[d] || 0 })),
    주의: '온라인=이카운트 출고 기준(자사몰+스마트스토어+외부채널, 공동구매 제외), 오프라인=매장 주문서 시스템(off.orders) — 서로 다른 원장이라 합산은 근사치.',
  };
}

// 월 주차별 목표 대비 실적 — off.orders.week("1주차"…) × jwasu_monthly_targets.targetWeeklySales(w1~w6)
//   "7월 1주차 목표매출 달성률" 같은 질문용. week 필드는 주문서 시스템의 주차 구분을 그대로 사용.
async function weeklyStatus(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('month는 YYYY-MM 형식이어야 합니다');
  const [c, tColl] = await Promise.all([coll(), store.namedCollection('yogibo', 'jwasu_monthly_targets')]);
  const [actuals, tRows] = await Promise.all([
    c.aggregate([
      { $match: { month } },
      { $group: { _id: { store: '$store', week: '$week' }, amount: { $sum: '$amount' }, ord: { $addToSet: '$orderNo' } } },
    ]).toArray(),
    tColl.find({ month }).toArray(),
  ]);
  // 매장별 주차 목표 (매장당 동일값 복제 → max)
  const targetBy = {}; // store → {w1..w6}
  for (const t of tRows) {
    const sn = t.storeName; const tw = t.targetWeeklySales || {};
    const cur = (targetBy[sn] = targetBy[sn] || {});
    for (const k of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']) cur[k] = Math.max(cur[k] || 0, N(tw[k]));
  }
  const wkNum = (w) => { const m = String(w || '').match(/(\d+)\s*주차/); return m ? +m[1] : null; };
  const salesBy = {}; // store → {1: amt, ...}
  for (const a of actuals) { const sn = a._id.store || '(미지정)'; const n = wkNum(a._id.week); if (!n) continue; (salesBy[sn] = salesBy[sn] || {})[n] = (salesBy[sn][n] || 0) + N(a.amount); }

  const stores = [...new Set([...Object.keys(salesBy), ...Object.keys(targetBy)])].sort();
  const 매장별 = stores.map((sn) => {
    const weeks = [];
    for (let w = 1; w <= 6; w++) {
      const 목표 = R((targetBy[sn] || {})['w' + w] || 0);
      const 실적 = R((salesBy[sn] || {})[w] || 0);
      if (!목표 && !실적) continue;
      weeks.push({ 주차: w + '주차', 목표, 실적, 달성률_pct: 목표 ? +((실적 / 목표) * 100).toFixed(1) : null });
    }
    const 목표합 = weeks.reduce((s, x) => s + x.목표, 0), 실적합 = weeks.reduce((s, x) => s + x.실적, 0);
    return { 매장: sn, 월목표: 목표합 || null, 월실적: 실적합, 월달성률_pct: 목표합 ? +((실적합 / 목표합) * 100).toFixed(1) : null, 주차별: weeks };
  }).sort((a, b) => (b.월달성률_pct || 0) - (a.월달성률_pct || 0));

  // 주차별 전체 합계
  const 주차합계 = [];
  for (let w = 1; w <= 6; w++) {
    let 목표 = 0, 실적 = 0;
    for (const sn of stores) { 목표 += R((targetBy[sn] || {})['w' + w] || 0); 실적 += R((salesBy[sn] || {})[w] || 0); }
    if (!목표 && !실적) continue;
    주차합계.push({ 주차: w + '주차', 목표, 실적, 달성률_pct: 목표 ? +((실적 / 목표) * 100).toFixed(1) : null });
  }
  return { month, 주차합계, 매장별, 주의: '주차 = 오프라인 주문서 시스템의 주차 구분(off.orders.week). 진행 중 주차는 실적이 미완성.' };
}

// 세트구매 · 커버 동시구매 분석 — 매장별판매데이터분석자료.html 과 동일 정의:
//   주문(orderNo) 단위로 orderHasSet/orderHasCover 플래그 → 구매율 = 해당 주문수 ÷ 전체 주문수.
//   라인 단위 isSet/isCover 로 세트/커버 자체의 매출·수량·인기상품도 집계.
async function setCoverAnalysis(start, end) {
  const c = await coll();
  const match = { date: { $gte: start, $lte: end } };
  const [orders, setLines, coverLines] = await Promise.all([
    c.aggregate([
      { $match: match },
      { $group: { _id: '$orderNo', store: { $first: '$store' }, amount: { $sum: '$amount' }, hasSet: { $max: { $cond: ['$orderHasSet', 1, 0] } }, hasCover: { $max: { $cond: ['$orderHasCover', 1, 0] } } } },
    ]).toArray(),
    c.aggregate([{ $match: { ...match, isSet: true } }, { $group: { _id: '$productName', amount: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { amount: -1 } }, { $limit: 15 }]).toArray(),
    c.aggregate([{ $match: { ...match, isCover: true } }, { $group: { _id: '$productName', amount: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { amount: -1 } }, { $limit: 15 }]).toArray(),
  ]);

  const mk = () => ({ 주문수: 0, 세트주문: 0, 커버주문: 0, 세트주문매출: 0, 커버주문매출: 0 });
  const total = mk(); const byStore = {};
  for (const o of orders) {
    const s = (byStore[o.store || '(미지정)'] = byStore[o.store || '(미지정)'] || mk());
    for (const g of [total, s]) {
      g.주문수++;
      if (o.hasSet) { g.세트주문++; g.세트주문매출 += N(o.amount); }
      if (o.hasCover) { g.커버주문++; g.커버주문매출 += N(o.amount); }
    }
  }
  const rate = (a, b) => (b ? +((a / b) * 100).toFixed(1) : 0);
  const fin = (g) => ({
    주문수: g.주문수,
    세트구매: { 주문수: g.세트주문, 구매율_pct: rate(g.세트주문, g.주문수), 주문매출: R(g.세트주문매출) },
    커버동시구매: { 주문수: g.커버주문, 구매율_pct: rate(g.커버주문, g.주문수), 주문매출: R(g.커버주문매출) },
  });
  return {
    start, end,
    전체: fin(total),
    매장별: Object.entries(byStore).map(([매장, g]) => ({ 매장, ...fin(g) }))
      .sort((a, b) => b.커버동시구매.구매율_pct - a.커버동시구매.구매율_pct),
    세트_인기상품: setLines.map((x) => ({ 상품: x._id || '(미상)', 매출: R(x.amount), 수량: N(x.qty) })),
    커버_인기상품: coverLines.map((x) => ({ 상품: x._id || '(미상)', 매출: R(x.amount), 수량: N(x.qty) })),
    주의: '구매율 = 세트/커버 포함 주문수 ÷ 전체 주문수(주문 단위, 매장 분석화면과 동일 정의). 주문매출 = 해당 주문의 전체 금액(세트/커버 라인만이 아님).',
  };
}

module.exports = { analyze, dailySeries, onOffCompare, weeklyStatus, setCoverAnalysis };
