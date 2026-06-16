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

async function matchedSales(mall, promo) {
  const start = promo.start, end = promo.end;
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

module.exports = { forMall };
