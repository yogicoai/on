'use strict';

/**
 * 회원/비회원 결제 분석 — Cafe24 Admin API /orders.
 * 검증된 필드: member_id(빈값=비회원), member_authentication, first_order,
 *   paid, canceled, payment_amount, order_date,
 *   actual_order_amount{ order_price_amount, coupon_discount_price, ... }
 *
 * items(embed) 는 회원분리·쿠폰매출조인에 불필요하므로 생략(응답 경량화).
 */

const c = require('./cafe24');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const dayOf = (s) => String(s || '').slice(0, 10);
const isMember = (o) => !!(o.member_id && String(o.member_id).trim() !== '');
const isPaid = (o) => o.paid === 'T';
const isCanceled = (o) => o.canceled === 'T';
const couponDiscountOf = (o) => N(o.actual_order_amount && o.actual_order_amount.coupon_discount_price);
const pointsUsedOf = (o) => N(o.actual_order_amount && o.actual_order_amount.points_spent_amount) + N(o.actual_order_amount && o.actual_order_amount.credits_spent_amount);

// 기간 내 주문 전량 수집 (쿠폰·상품 프로모션 모듈과 공유).
// items 포함 — 주문 볼륨이 작아(주 ~150건) 상품별 쿠폰성과를 실거래 기반으로 뽑기 위함.
async function fetchOrders(start, end) {
  const s = c.ymd(start), e = c.ymd(end);
  return c.adminPaginate('/orders',
    { shop_no: 1, start_date: s, end_date: e, date_type: 'order_date', embed: 'items' },
    'orders', { limit: 500, maxPages: 400 });
}

function blankGroup() {
  return { orders: 0, paidOrders: 0, revenue: 0, couponDiscount: 0, pointsUsed: 0, pointsOrders: 0, firstOrders: 0 };
}

function accumulate(g, o) {
  g.orders += 1;
  if (isPaid(o)) g.paidOrders += 1;
  if (isPaid(o) && !isCanceled(o)) g.revenue += N(o.payment_amount);
  g.couponDiscount += couponDiscountOf(o);
  const pts = pointsUsedOf(o);
  if (pts > 0) { g.pointsUsed += pts; g.pointsOrders += 1; }
  if (o.first_order === 'T') g.firstOrders += 1;
}

function finalize(g) {
  g.aov = g.paidOrders ? Math.round(g.revenue / g.paidOrders) : 0;
  g.revenue = Math.round(g.revenue);
  g.couponDiscount = Math.round(g.couponDiscount);
  g.pointsUsed = Math.round(g.pointsUsed);
  return g;
}

// 회원/비회원 결제 리포트
function memberReport(orders, start, end) {
  const member = blankGroup();
  const guest = blankGroup();
  const dailyMap = {}; // date → { date, memberRevenue, guestRevenue, memberOrders, guestOrders }

  for (const o of orders) {
    const g = isMember(o) ? member : guest;
    accumulate(g, o);

    const d = dayOf(o.order_date);
    const row = (dailyMap[d] = dailyMap[d] || { date: d, memberRevenue: 0, guestRevenue: 0, memberOrders: 0, guestOrders: 0 });
    const paidNet = isPaid(o) && !isCanceled(o) ? N(o.payment_amount) : 0;
    if (isMember(o)) { row.memberRevenue += paidNet; row.memberOrders += 1; }
    else { row.guestRevenue += paidNet; row.guestOrders += 1; }
  }

  finalize(member); finalize(guest);

  const total = {
    orders: member.orders + guest.orders,
    paidOrders: member.paidOrders + guest.paidOrders,
    revenue: member.revenue + guest.revenue,
    couponDiscount: member.couponDiscount + guest.couponDiscount,
    pointsUsed: member.pointsUsed + guest.pointsUsed,
    pointsOrders: member.pointsOrders + guest.pointsOrders,
  };
  total.aov = total.paidOrders ? Math.round(total.revenue / total.paidOrders) : 0;
  total.memberRevenueShare = total.revenue ? member.revenue / total.revenue : 0;
  total.memberOrderShare = total.orders ? member.orders / total.orders : 0;

  const daily = Object.values(dailyMap)
    .map((r) => ({ ...r, memberRevenue: Math.round(r.memberRevenue), guestRevenue: Math.round(r.guestRevenue) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { start: c.ymd(start), end: c.ymd(end), member, guest, total, daily };
}

module.exports = { fetchOrders, memberReport, isMember, isPaid, isCanceled, N };
