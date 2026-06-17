'use strict';

/**
 * 프로모션 성과 귀속 — 등록된 몰별 프로모션의 "대상 상품"이 그 "기간"에 실제로 얼마나 팔렸는지 집계.
 *   · 자사몰      : orders_raw.items.product_no 가 프로모션 상품(productNo, source=cafe24)과 일치 (정확)
 *   · 스마트스토어 : smartstore_orders.product_name 이 프로모션 상품명과 일치 (이름 기준)
 *   · 기타 그룹    : on.orders.productName 이 프로모션 상품명과 일치 + 그 그룹 채널 (이름 기준, 베스트에포트)
 *   결과 = 프로모션별 {매출, 수량, 주문수}. "이건 프로모션 ○○" 로 따로 성과 표시.
 */

const store = require('./store');
const mallPromos = require('./mallPromotions');
const otherChannels = require('./otherChannels');

const PAID_SS = ['PAYED', 'DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED', 'EXCHANGED'];
const Z = { sales: 0, qty: 0, orders: 0 };

async function cafe24Matched(productNos, start, end) {
  if (!productNos.length) return { ...Z };
  const c = await store.collection('orders_raw');
  const r = await c.aggregate([
    { $match: { order_date: { $gte: start, $lte: end }, paid: true, canceled: false } },
    { $unwind: '$items' },
    { $match: { 'items.product_no': { $in: productNos } } },
    { $group: { _id: null, sales: { $sum: '$items.payment_amount' }, qty: { $sum: '$items.quantity' }, ord: { $addToSet: '$order_id' } } },
  ]).toArray();
  const t = r[0] || { sales: 0, qty: 0, ord: [] };
  return { sales: Math.round(t.sales || 0), qty: t.qty || 0, orders: (t.ord || []).length };
}

async function smartstoreMatched(names, start, end) {
  if (!names.length) return { ...Z };
  try {
    const c = await store.collection('smartstore_orders');
    const r = await c.aggregate([
      { $match: { order_date: { $gte: start, $lte: end }, canceled: { $ne: true }, status: { $in: PAID_SS }, product_name: { $in: names } } },
      { $group: { _id: null, sales: { $sum: '$payment_amount' }, qty: { $sum: '$quantity' }, ord: { $addToSet: '$order_id' } } },
    ]).toArray();
    const t = r[0] || { sales: 0, qty: 0, ord: [] };
    return { sales: Math.round(t.sales || 0), qty: t.qty || 0, orders: (t.ord || []).length };
  } catch (_) { return { ...Z }; }
}

async function groupMatched(group, names, start, end) {
  if (!names.length) return { ...Z };
  const c = await store.namedCollection('on', 'orders');
  const r = await c.aggregate([
    { $match: { date: { $gte: start, $lte: end }, productName: { $in: names } } },
    { $group: { _id: '$store', sales: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } },
  ]).toArray();
  let sales = 0, qty = 0; const ordSet = new Set();
  for (const x of r) {
    if (otherChannels.groupOf(x._id) !== group) continue;
    sales += x.sales; qty += x.qty;
    for (const o of (x.ord || [])) { if (o != null) ordSet.add(o); }
  }
  return { sales: Math.round(sales), qty, orders: ordSet.size };
}

async function matchedSales(mall, promo, start, end) {
  start = start || promo.start; end = end || promo.end; // 구간 지정 시 그 구간으로(통합분석)
  if (mall === '자사몰') {
    const nos = (promo.products || []).filter((p) => p.source !== 'smartstore').map((p) => String(p.productNo)).filter(Boolean);
    return cafe24Matched(nos, start, end);
  }
  const names = (promo.products || []).map((p) => p.productName).filter(Boolean);
  if (mall === '스마트스토어') return smartstoreMatched(names, start, end);
  return groupMatched(mall, names, start, end); // 기타 그룹
}

// 한 몰의 모든 프로모션 성과
async function forMall(mall) {
  if (!mall) return { mall: '', promotions: [] };
  const promos = await mallPromos.listPromotions(mall);
  const out = [];
  for (const p of promos) {
    const m = await matchedSales(mall, p);
    out.push({ id: p.id, name: p.name, start: p.start, end: p.end, products: (p.products || []).length, matchBy: mall === '자사몰' ? '상품번호' : '상품명', ...m });
  }
  return { mall, promotions: out };
}

// 통합분석용 — 그 기간(start~end)에 진행된 전 몰 프로모션 + 성과.
//   자사몰 = 연결 쿠폰 실사용(쿠폰 기준), 그 외 = 대상 상품 매칭. 매출/주문은 '프로모션 기간 ∩ 선택 구간' 기준.
async function allForPeriod(start, end) {
  const cafe24Coupons = require('./cafe24Coupons'); // 지연 require(순환 방지)
  const promos = await mallPromos.listPromotions(''); // 전 몰
  const ranged = !!(start && end);
  const rows = [];
  for (const p of promos) {
    if (ranged && (p.end < start || p.start > end)) continue; // 구간과 안 겹치면 제외
    const aStart = ranged ? (p.start > start ? p.start : start) : p.start;
    const aEnd = ranged ? (p.end < end ? p.end : end) : p.end;
    let perf, method;
    if (p.mall === '자사몰') {
      const names = (p.coupons || []).map((c) => c.coupon_name).filter(Boolean);
      const cp = names.length ? await cafe24Coupons.couponPerfFor(names, aStart, aEnd) : { totals: { orders: 0, revenue: 0 } };
      perf = { sales: cp.totals.revenue, orders: cp.totals.orders, qty: 0 };
      method = names.length ? '쿠폰' : '쿠폰 미연결';
    } else {
      perf = await matchedSales(p.mall, p, aStart, aEnd);
      method = '상품매칭';
    }
    rows.push({ id: p.id, mall: p.mall, name: p.name, start: p.start, end: p.end, periodStart: aStart, periodEnd: aEnd, method, ...perf });
  }
  rows.sort((a, b) => b.sales - a.sales);
  const totals = rows.reduce((t, r) => { t.sales += r.sales; t.orders += r.orders; return t; }, { sales: 0, orders: 0, count: rows.length });
  return { start: start || null, end: end || null, totals, promotions: rows };
}

module.exports = { forMall, allForPeriod };
