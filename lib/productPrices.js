'use strict';

/**
 * 상품 기준가(정상판매가) 테이블 — product_prices 컬렉션.
 *   { item_code, code_type('cafe24'|'ecount'), product_name, normal_price, cost_price?, updated_at }
 *   키: {item_code, code_type} 유니크. (정상가 불변 전제 → 시점 이력 없이 현재가 1개)
 *
 *   목적: Cafe24 주문엔 "정상가"가 안 담겨서, 쿠폰 데이터가 없는 기간은 할인 여부를 알 수 없음.
 *         이 기준가로 "실판매단가 ÷ 정상가 = 할인율"을 계산 → 쿠폰 없이도 할인 깊이 분석.
 */

const store = require('./store');
const COLL = 'product_prices';
const N = (v) => (Number.isFinite(+v) ? +v : 0);

async function coll() {
  const c = await store.collection(COLL);
  try { await c.createIndex({ item_code: 1, code_type: 1 }, { unique: true }); } catch (_) {}
  return c;
}

// 적재(업서트) — rows: [{item_code, code_type?, product_name?, normal_price, cost_price?}]
async function upsert(rows) {
  const c = await coll();
  const now = new Date().toISOString();
  const ops = (rows || [])
    .filter((r) => r && r.item_code != null && String(r.item_code).trim())
    .map((r) => {
      const item_code = String(r.item_code).trim();
      const code_type = (r.code_type || 'cafe24').trim();
      const set = { item_code, code_type, product_name: r.product_name || '', normal_price: N(r.normal_price), updated_at: now };
      if (r.cost_price != null && String(r.cost_price).trim() !== '') set.cost_price = N(r.cost_price);
      return { updateOne: { filter: { item_code, code_type }, update: { $set: set }, upsert: true } };
    });
  if (!ops.length) return { upserted: 0 };
  const r = await c.bulkWrite(ops, { ordered: false });
  return { upserted: (r.upsertedCount || 0) + (r.modifiedCount || 0), total: ops.length };
}

async function list(codeType) {
  const c = await coll();
  const q = codeType ? { code_type: codeType } : {};
  return c.find(q, { projection: { _id: 0 } }).sort({ item_code: 1 }).toArray();
}

// code_type별 { item_code → {normal_price, cost_price, product_name} } 맵
async function priceMap(codeType) {
  const rows = await list(codeType);
  const m = {};
  for (const r of rows) m[String(r.item_code)] = r;
  return m;
}

// ── 현재 주문 데이터에서 정상가 자동 추출 — "할인 안 된 최고 실판매단가 ≈ 정상가" ──
//   정상가 불변 전제 → fromDate(기본 2024-01-01) 이후 Cafe24 주문에서 품목별 최고 단가를 정상가로 적재.
//   robust: 상위 단가들의 최빈/최댓값 사용. 이상치 방지를 위해 5건 미만 라인은 최댓값, 그 이상은 95퍼센타일 근사.
async function deriveFromOrders(fromDate) {
  fromDate = fromDate || '2024-01-01';
  const c = await store.collection('orders_raw');
  const rows = await c.aggregate([
    { $match: { paid: true, canceled: false, order_date: { $gte: fromDate } } },
    { $unwind: '$items' },
    { $match: { 'items.quantity': { $gt: 0 }, 'items.payment_amount': { $gt: 0 }, 'items.product_no': { $ne: null } } },
    { $project: { product_no: '$items.product_no', name: '$items.product_name', unit: { $divide: ['$items.payment_amount', '$items.quantity'] } } },
    { $group: { _id: '$product_no', name: { $first: '$name' }, units: { $push: '$unit' } } },
  ]).toArray();

  const priceRows = [];
  for (const r of rows) {
    const u = (r.units || []).filter((x) => x > 0).sort((a, b) => a - b);
    if (!u.length) continue;
    // 5건 이상이면 95퍼센타일(이상치 컷), 미만이면 최댓값
    const normal = u.length >= 5 ? u[Math.min(u.length - 1, Math.floor(u.length * 0.95))] : u[u.length - 1];
    priceRows.push({ item_code: String(r._id), code_type: 'cafe24', product_name: r.name || '', normal_price: Math.round(normal) });
  }
  const res = await upsert(priceRows);
  return { fromDate, 추출품목: priceRows.length, ...res };
}

// ── Cafe24 할인 분석 — orders_raw.items.product_no ↔ product_prices(cafe24) ─────
//   실판매단가 = payment_amount/quantity, 할인율 = 1 - 실단가/정상가. 정상가 미등록 품목은 따로 표시.
async function discountAnalysis(start, end) {
  const prices = await priceMap('cafe24');
  const c = await store.collection('orders_raw');
  const q = { paid: true, canceled: false };
  if (start || end) { q.order_date = {}; if (start) q.order_date.$gte = start; if (end) q.order_date.$lte = end; }
  const rows = await c.aggregate([
    { $match: q },
    { $unwind: '$items' },
    { $group: { _id: '$items.product_no', name: { $first: '$items.product_name' }, qty: { $sum: '$items.quantity' }, sales: { $sum: '$items.payment_amount' } } },
  ]).toArray();

  const products = []; let coveredSales = 0, normalValue = 0, uncoveredSales = 0, priced = 0;
  for (const r of rows) {
    const p = prices[String(r._id)];
    const unitActual = r.qty ? r.sales / r.qty : 0;
    if (p && p.normal_price > 0) {
      priced++;
      const discount = 1 - (unitActual / p.normal_price);
      coveredSales += r.sales; normalValue += p.normal_price * r.qty;
      products.push({ item_code: String(r._id), product_name: r.name || p.product_name, qty: r.qty, sales: Math.round(r.sales), 실판매단가: Math.round(unitActual), 정상가: p.normal_price, 할인율_퍼센트: +(discount * 100).toFixed(1) });
    } else {
      uncoveredSales += r.sales;
      products.push({ item_code: String(r._id), product_name: r.name, qty: r.qty, sales: Math.round(r.sales), 실판매단가: Math.round(unitActual), 정상가: null, 할인율_퍼센트: null, note: '정상가 미등록' });
    }
  }
  products.sort((a, b) => b.sales - a.sales);
  const avgDiscount = normalValue ? (1 - coveredSales / normalValue) : null;
  return {
    start: start || null, end: end || null,
    가중평균할인율_퍼센트: avgDiscount != null ? +(avgDiscount * 100).toFixed(1) : null,
    정상가등록_품목수: priced, 정상가커버매출: Math.round(coveredSales), 정상가미등록매출: Math.round(uncoveredSales),
    안내: priced === 0 ? 'product_prices(cafe24)에 정상가가 없습니다. 가격 임포트(scripts/import-prices.js) 후 분석됩니다.' : null,
    products: products.slice(0, 50),
  };
}

module.exports = { upsert, list, priceMap, deriveFromOrders, discountAnalysis, coll };
