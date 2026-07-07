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

// 기간 오프라인 종합 — 합계 + 매장별 + 카테고리/충전재 + 상품TOP + 판매사원별
async function analyze(start, end) {
  const c = await coll();
  const match = { date: { $gte: start, $lte: end } };
  const [tot, byStore, byCat, byBead, prodTop, byMgr] = await Promise.all([
    c.aggregate([{ $match: match }, { $group: { _id: null, amount: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: '$store', amount: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } }, { $sort: { amount: -1 } }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: '$category', amount: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { amount: -1 } }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: '$beadType', amount: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { amount: -1 } }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: '$productName', amount: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { amount: -1 } }, { $limit: 30 }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: { store: '$store', manager: '$manager' }, amount: { $sum: '$amount' }, ord: { $addToSet: '$orderNo' } } }, { $sort: { amount: -1 } }, { $limit: 30 }]).toArray(),
  ]);
  const t = tot[0] || { amount: 0, qty: 0, ord: [] };
  const orders = (t.ord || []).length;
  return {
    start, end,
    totals: { 매출: R(t.amount), 수량: N(t.qty), 주문수: orders, 객단가: orders ? R(t.amount / orders) : 0, 매장수: byStore.length },
    매장별: byStore.map((s) => ({ 매장: s._id || '(미지정)', 매출: R(s.amount), 수량: N(s.qty), 주문수: (s.ord || []).length, 객단가: (s.ord || []).length ? R(s.amount / s.ord.length) : 0 })),
    카테고리별: byCat.map((x) => ({ 카테고리: x._id || '(미상)', 매출: R(x.amount), 수량: N(x.qty) })),
    충전재별: byBead.map((x) => ({ 충전재: x._id || '(미상)', 매출: R(x.amount), 수량: N(x.qty) })),
    상품TOP: prodTop.map((x) => ({ 상품: x._id || '(미상)', 매출: R(x.amount), 수량: N(x.qty) })),
    판매사원TOP: byMgr.map((m) => ({ 매장: m._id.store || '', 사원: m._id.manager || '(미상)', 매출: R(m.amount), 주문수: (m.ord || []).length })),
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

module.exports = { analyze, dailySeries, onOffCompare };
