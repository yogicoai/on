'use strict';

/**
 * 자사몰 프로모션 ↔ Cafe24 쿠폰 연결.
 *   listCoupons(start,end)   : 쿠폰 목록(혜택·대상상품·발급수) + 그 기간 사용 주문수(캐시) 마킹 → 편집기에서 선택.
 *   couponPerfFor(names,s,e)  : 저장된 쿠폰명들의 실제 사용 매출/고객/할인 (order_coupons 캐시 + coupon_discount).
 *   forMallCoupons(mall)      : 그 몰의 프로모션별 쿠폰기준 성과 (성과 화면용).
 *
 *   쿠폰은 삭제될 수 있어, 프로모션에 저장 시 mall_promotions.coupons 에 스냅샷(번호·이름·혜택·대상상품)을 박아둔다.
 */

const cafe24 = require('./cafe24');
const store = require('./store');
const { targetSummary, benefitSummary, couponNamesFor } = require('./coupons');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
// 쿠폰명 정규화(공백 차이로 인한 매칭 누락 방지): 연속 공백 1칸 + 트림
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// available_product_list 항목 → 상품번호 문자열 배열 (객체/숫자 모두 대응)
function productNos(cp) {
  const arr = Array.isArray(cp.available_product_list) ? cp.available_product_list : [];
  return arr.map((p) => String(p && p.product_no != null ? p.product_no : p)).filter((x) => x && x !== 'undefined');
}

// 기간 내 사용 쿠폰명(정규화 키) → {주문수, 대표 표기명} (캐시 기준, 빠름)
async function couponUsageInRange(start, end) {
  const usage = {}, display = {};
  if (!start || !end) return { usage, display };
  try {
    const coll = await store.collection('orders_raw');
    const orders = await coll.find({ order_date: { $gte: start, $lte: end }, paid: true, canceled: false, coupon_discount: { $gt: 0 } }, { projection: { order_id: 1 } }).toArray();
    const nameMap = await couponNamesFor(orders.map((o) => o.order_id));
    for (const o of orders) for (const nm of (nameMap[o.order_id] || [])) { const k = norm(nm); usage[k] = (usage[k] || 0) + 1; if (!display[k]) display[k] = nm; }
  } catch (_) {}
  return { usage, display };
}

// 쿠폰 목록 — 혜택/대상상품 + 그 기간 사용 주문수. 사용된 것 우선.
//   라이브 /coupons 에 없는(만료·발급불가·삭제) 쿠폰도, 그 기간 사용내역이 있으면 캐시 이름으로 추가 → 직접 입력 불필요.
async function listCoupons(start, end) {
  const all = await cafe24.adminPaginate('/coupons', { shop_no: 1 }, 'coupons', { limit: 100, maxPages: 5 });
  const { usage, display } = await couponUsageInRange(start, end);
  const coupons = all.filter((cp) => cp.coupon_no).map((cp) => {
    const t = targetSummary(cp), b = benefitSummary(cp);
    return {
      coupon_no: String(cp.coupon_no), coupon_name: cp.coupon_name || `쿠폰#${cp.coupon_no}`,
      benefitText: b.text, benefitKind: b.kind, benefitValue: b.value,
      targetType: t.type, targetLabel: t.label, productNos: productNos(cp), categories: t.categories || [],
      issued: N(cp.issued_count), createdDate: cp.created_date ? String(cp.created_date).slice(0, 10) : '',
      stopped: cp.is_stopped_issued_coupon === 'T', expired: false,
      usedOrders: usage[norm(cp.coupon_name)] || 0,
    };
  });
  // 라이브에 없는데 그 기간 사용된 쿠폰(만료/발급불가/삭제) → 캐시 이름으로 보강
  const liveNorm = new Set(coupons.map((c) => norm(c.coupon_name)));
  for (const k of Object.keys(usage)) {
    if (liveNorm.has(k)) continue;
    coupons.push({
      coupon_no: '', coupon_name: display[k] || k,
      benefitText: '', benefitKind: '', benefitValue: 0,
      targetType: '', targetLabel: '(만료·발급불가 — 사용내역으로 확인)', productNos: [], categories: [],
      issued: 0, createdDate: '', stopped: true, expired: true, usedOrders: usage[k],
    });
  }
  coupons.sort((a, b) => (b.usedOrders - a.usedOrders) || (b.issued - a.issued));
  return { start: start || null, end: end || null, count: coupons.length, used: coupons.filter((c) => c.usedOrders > 0).length, coupons };
}

// 저장된 쿠폰명들의 실제 사용 성과 (프로모션 기간 내) — 쿠폰별 분해 + 합계(중복주문 1회)
async function couponPerfFor(couponNames, start, end) {
  const names = new Set((couponNames || []).map(norm).filter(Boolean)); // 정규화 매칭(공백 차이 무시)
  if (!names.size || !start || !end) return { totals: { orders: 0, members: 0, revenue: 0, couponDiscount: 0 }, byCoupon: [] };
  const coll = await store.collection('orders_raw');
  const orders = await coll.find({ order_date: { $gte: start, $lte: end }, paid: true, canceled: false, coupon_discount: { $gt: 0 } }, { projection: { order_id: 1, member_id: 1, payment_amount: 1, coupon_discount: 1 } }).toArray();
  const nameMap = await couponNamesFor(orders.map((o) => o.order_id));
  const byCoupon = {}; const memAll = new Set(); const matched = new Set();
  for (const o of orders) {
    const used = (nameMap[o.order_id] || []).filter((nm) => names.has(norm(nm)));
    if (!used.length) continue;
    matched.add(o.order_id);
    for (const nm of used) {
      const g = (byCoupon[nm] = byCoupon[nm] || { coupon_name: nm, orders: 0, members: new Set(), revenue: 0, discount: 0 });
      g.orders += 1; if (o.member_id) g.members.add(o.member_id); g.revenue += N(o.payment_amount); g.discount += N(o.coupon_discount);
    }
  }
  let orders_ = 0, rev = 0, disc = 0;
  for (const o of orders) { if (!matched.has(o.order_id)) continue; orders_ += 1; if (o.member_id) memAll.add(o.member_id); rev += N(o.payment_amount); disc += N(o.coupon_discount); }
  return {
    totals: { orders: orders_, members: memAll.size, revenue: Math.round(rev), couponDiscount: Math.round(disc) },
    byCoupon: Object.values(byCoupon).map((g) => ({ coupon_name: g.coupon_name, orders: g.orders, members: g.members.size, revenue: Math.round(g.revenue), discount: Math.round(g.discount) })).sort((a, b) => b.revenue - a.revenue),
  };
}

// 몰의 프로모션별 쿠폰기준 성과
async function forMallCoupons(mall) {
  const mallPromos = require('./mallPromotions');
  const promos = await mallPromos.listPromotions(mall);
  const out = [];
  for (const p of promos) {
    const names = (p.coupons || []).map((cp) => cp.coupon_name).filter(Boolean);
    if (!names.length) { out.push({ id: p.id, name: p.name, start: p.start, end: p.end, hasCoupons: false, coupons: [], totals: { orders: 0, members: 0, revenue: 0, couponDiscount: 0 }, byCoupon: [] }); continue; }
    const perf = await couponPerfFor(names, p.start, p.end);
    out.push({ id: p.id, name: p.name, start: p.start, end: p.end, hasCoupons: true, coupons: p.coupons, ...perf });
  }
  return { mall, promotions: out };
}

module.exports = { listCoupons, couponPerfFor, forMallCoupons, productNos };
