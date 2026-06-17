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
const { targetSummary, benefitSummary, couponNamesFor, fetchIssuesInRange } = require('./coupons');

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
//   라이브 /coupons 에 없는(만료·발급불가·삭제) 쿠폰도 캐시 이름으로 보강.
//   opts.all=true 면 기간 무관하게 캐시(order_coupons)에 적재된 '모든' 쿠폰명(삭제 포함)을 다 띄움.
async function listCoupons(start, end, opts) {
  opts = opts || {};
  const all = await cafe24.adminPaginate('/coupons', { shop_no: 1 }, 'coupons', { limit: 100, maxPages: 5 });
  const { usage, display } = await couponUsageInRange(start, end); // 선택 기간 사용수(표시용)
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
  const liveNorm = new Set(coupons.map((c) => norm(c.coupon_name)));
  // 보강 대상: all 모드면 캐시 전체 쿠폰명, 아니면 그 기간 사용된 것만
  let extra; // [{k, nm}]
  if (opts.all) {
    let names = [];
    try { const coll = await store.collection('order_coupons'); names = await coll.distinct('coupons'); } catch (_) {}
    extra = names.map((nm) => ({ k: norm(nm), nm }));
  } else {
    extra = Object.keys(usage).map((k) => ({ k, nm: display[k] || k }));
  }
  const seen = new Set();
  for (const { k, nm } of extra) {
    if (!k || liveNorm.has(k) || seen.has(k)) continue;
    seen.add(k);
    coupons.push({
      coupon_no: '', coupon_name: nm,
      benefitText: '', benefitKind: '', benefitValue: 0,
      targetType: '', targetLabel: opts.all ? '(삭제/만료 — 적재된 쿠폰)' : '(만료·발급불가 — 사용내역)', productNos: [], categories: [],
      issued: 0, createdDate: '', stopped: true, expired: true, usedOrders: usage[k] || 0,
    });
  }
  coupons.sort((a, b) => (b.usedOrders - a.usedOrders) || (b.issued - a.issued));
  return { start: start || null, end: end || null, all: !!opts.all, count: coupons.length, used: coupons.filter((c) => c.usedOrders > 0).length, coupons };
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

// 단일 쿠폰 — 그 쿠폰 사용 주문의 '상품 순위' + '전체기간(선택구간) 매출 대비 비중'.
//   products: 쿠폰 사용 주문에 담긴 상품을 수량 많은 순 (수량·매출·주문수)
//   share  : 쿠폰 매출 / 그 구간 전체 매출 × 100 (%)
async function couponProductBreakdown(couponName, start, end) {
  const key = norm(couponName);
  const empty = { coupon_name: couponName, start: start || null, end: end || null, products: [], totals: { orders: 0, revenue: 0, qty: 0 }, period: { revenue: 0, orders: 0 }, share: 0 };
  if (!key || !start || !end) return empty;
  const coll = await store.collection('orders_raw');
  // 분모: 선택 구간 전체 매출(결제·미취소)
  const allOrders = await coll.find({ order_date: { $gte: start, $lte: end }, paid: true, canceled: false }, { projection: { payment_amount: 1 } }).toArray();
  const periodRevenue = allOrders.reduce((s, o) => s + N(o.payment_amount), 0);
  // 분자: 쿠폰 사용 주문(쿠폰할인>0) 중 이 쿠폰명 매칭
  const cOrders = await coll.find({ order_date: { $gte: start, $lte: end }, paid: true, canceled: false, coupon_discount: { $gt: 0 } }, { projection: { order_id: 1, payment_amount: 1, items: 1 } }).toArray();
  const nameMap = await couponNamesFor(cOrders.map((o) => o.order_id));
  const prod = {}; let revenue = 0, qty = 0, orders = 0;
  for (const o of cOrders) {
    if (!(nameMap[o.order_id] || []).some((nm) => norm(nm) === key)) continue;
    orders += 1; revenue += N(o.payment_amount);
    for (const it of (o.items || [])) {
      const nm = it.product_name || `상품#${it.product_no}`;
      const p = (prod[nm] = prod[nm] || { product_name: nm, product_no: String(it.product_no || ''), qty: 0, sales: 0, orders: new Set() });
      p.qty += N(it.quantity); p.sales += N(it.payment_amount); p.orders.add(o.order_id); qty += N(it.quantity);
    }
  }
  const products = Object.values(prod)
    .map((p) => ({ product_name: p.product_name, product_no: p.product_no, qty: p.qty, sales: Math.round(p.sales), orders: p.orders.size }))
    .sort((a, b) => (b.qty - a.qty) || (b.sales - a.sales));
  return {
    coupon_name: couponName, start, end,
    products, totals: { orders, revenue: Math.round(revenue), qty },
    period: { revenue: Math.round(periodRevenue), orders: allOrders.length },
    share: periodRevenue > 0 ? Math.round((revenue / periodRevenue) * 1000) / 10 : 0,
  };
}

// 몰의 프로모션별 쿠폰기준 성과.
//   분석구간(start,end)을 주면 "프로모션 기간 ∩ 분석구간"으로 성과를 집계(구간과 안 겹치는 프로모션 제외).
//   안 주면 프로모션 전체 기간으로 집계(월 브라우즈 등).
async function forMallCoupons(mall, start, end) {
  const mallPromos = require('./mallPromotions');
  const promos = await mallPromos.listPromotions(mall);
  const ranged = !!(start && end);
  const out = [];
  for (const p of promos) {
    if (ranged && (p.end < start || p.start > end)) continue; // 분석구간과 안 겹치면 제외
    const aStart = ranged ? (p.start > start ? p.start : start) : p.start; // 분석 대상 구간(겹침)
    const aEnd = ranged ? (p.end < end ? p.end : end) : p.end;
    const names = (p.coupons || []).map((cp) => cp.coupon_name).filter(Boolean);
    const base = { id: p.id, name: p.name, start: p.start, end: p.end, periodStart: aStart, periodEnd: aEnd, coupons: p.coupons || [] };
    if (!names.length) { out.push({ ...base, hasCoupons: false, totals: { orders: 0, members: 0, revenue: 0, couponDiscount: 0 }, byCoupon: [] }); continue; }
    const perf = await couponPerfFor(names, aStart, aEnd);
    out.push({ ...base, hasCoupons: true, ...perf });
  }
  return { mall, start: start || null, end: end || null, promotions: out };
}

// 단일 프로모션 — 그 프로모션 전체기간(또는 지정구간) 쿠폰기준 성과 ('프로모션 기간 매출 확인' 버튼용)
async function couponPerfForPromo(promoId, start, end) {
  const mallPromos = require('./mallPromotions');
  const all = await mallPromos.listPromotions(''); // 전 몰
  const p = all.find((x) => x.id === promoId);
  if (!p) throw new Error('프로모션을 찾을 수 없습니다');
  const names = (p.coupons || []).map((cp) => cp.coupon_name).filter(Boolean);
  const s = start || p.start, e = end || p.end;
  const perf = names.length ? await couponPerfFor(names, s, e) : { totals: { orders: 0, members: 0, revenue: 0, couponDiscount: 0 }, byCoupon: [] };
  return { id: p.id, name: p.name, mall: p.mall, start: p.start, end: p.end, periodStart: s, periodEnd: e, hasCoupons: !!names.length, coupons: p.coupons || [], ...perf };
}

// 쿠폰번호로 발급내역(issues) 조회 → 사용 주문을 order_coupons 캐시에 그 쿠폰명으로 적재.
//   /coupons API가 안 주는 '삭제 쿠폰'도 번호만 있으면 issues는 조회되므로, 이걸로 성과를 살린다.
//   start/end 는 '발급일' 범위(넉넉히 잡아 전체 사용분 포함). 성과 집계는 couponPerfFor 가 주문일로 다시 거른다.
async function syncCouponByNo(no, name, start, end) {
  no = String(no || '').trim();
  const label = String(name || '').trim() || `쿠폰#${no}`;
  if (!no) throw new Error('쿠폰번호가 필요합니다');
  // 발급일 범위: 지정 구간 시작 2개월 전 ~ 종료(발급은 보통 사용 이전). 미지정 시 넓게.
  const back = (ds) => { try { const d = new Date(ds + 'T00:00:00'); d.setMonth(d.getMonth() - 2); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; } catch (_) { return ds; } };
  const s = start ? back(start) : '2024-01-01';
  const e = end || '2027-12-31';
  const issues = await fetchIssuesInRange(no, s, e);
  const used = issues.filter((i) => i.used_coupon === 'T' && i.related_order_id);
  if (used.length) {
    const coll = await store.collection('order_coupons');
    const now = new Date().toISOString();
    const ops = used.map((i) => ({ updateOne: { filter: { order_id: i.related_order_id }, update: { $addToSet: { coupons: label }, $setOnInsert: { order_id: i.related_order_id }, $set: { _syncedAt: now } }, upsert: true } }));
    for (let k = 0; k < ops.length; k += 500) { try { await coll.bulkWrite(ops.slice(k, k + 500), { ordered: false }); } catch (_) {} }
  }
  return { coupon_no: no, coupon_name: label, issues: issues.length, used: used.length };
}

module.exports = { listCoupons, couponPerfFor, couponProductBreakdown, forMallCoupons, couponPerfForPromo, syncCouponByNo, productNos };
