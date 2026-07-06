'use strict';

/**
 * 반품/취소 분석 — 순매출(반품·취소 제외)·취소율·반품률.
 *   자사몰(Cafe24): DB(orders_raw)엔 취소/반품 구분이 없어 라이브 /orders 로 분류
 *       (canceled=T & return_confirmed_date 있음 → 반품 / canceled=T & 반품일 없음 → 취소 / 그 외 정상)
 *   스마트스토어: DB(smartstore_orders)의 status 로 분류 (RETURNED=반품, CANCELED=취소, PURCHASE_DECIDED/PAYED/DELIVERED=정상)
 */

const c = require('./cafe24');
const store = require('./store');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const pct = (a, b) => (b ? +((a / b) * 100).toFixed(1) : 0);

// 자사몰 — 라이브 /orders 분류
async function cafe24Returns(start, end) {
  const rows = await c.adminPaginate('/orders',
    { shop_no: 1, start_date: start, end_date: end, date_type: 'order_date' }, 'orders').catch(() => []);
  const normal = { n: 0, amt: 0 }, cancel = { n: 0, amt: 0 }, ret = { n: 0, amt: 0 };
  for (const o of rows) {
    const amt = N(o.payment_amount);
    const returned = !!(o.return_confirmed_date && String(o.return_confirmed_date).trim());
    const canceled = o.canceled === 'T';
    if (returned) { ret.n++; ret.amt += amt; }
    else if (canceled) { cancel.n++; cancel.amt += amt; }
    else { normal.n++; normal.amt += amt; }
  }
  const total = normal.n + cancel.n + ret.n;
  const valid = normal.n + ret.n; // 실판매 모수(취소 제외)
  return {
    channel: '자사몰', start, end, orders: total,
    순매출: Math.round(normal.amt),
    취소: { 건수: cancel.n, 금액: Math.round(cancel.amt), 비율_pct: pct(cancel.n, total) },
    반품: { 건수: ret.n, 금액: Math.round(ret.amt), 반품률_pct: pct(ret.n, valid) },
  };
}

// 스마트스토어 — DB status 분류
async function smartstoreReturns(start, end) {
  const coll = await store.collection('smartstore_orders');
  const rows = await coll.find({ order_date: { $gte: c.ymd(start), $lte: c.ymd(end) } },
    { projection: { status: 1, payment_amount: 1 } }).toArray();
  const normal = { n: 0, amt: 0 }, cancel = { n: 0, amt: 0 }, ret = { n: 0, amt: 0 };
  let nopay = 0;
  for (const o of rows) {
    const amt = N(o.payment_amount); const s = o.status;
    if (s === 'RETURNED') { ret.n++; ret.amt += amt; }
    else if (s === 'CANCELED') { cancel.n++; cancel.amt += amt; }
    else if (s === 'CANCELED_BY_NOPAYMENT') { nopay++; } // 미결제취소 = 실주문 아님 → 제외
    else { normal.n++; normal.amt += amt; }
  }
  const total = normal.n + cancel.n + ret.n;
  const valid = normal.n + ret.n;
  return {
    channel: '스마트스토어', start, end, orders: total,
    순매출: Math.round(normal.amt),
    취소: { 건수: cancel.n, 금액: Math.round(cancel.amt), 비율_pct: pct(cancel.n, total) },
    반품: { 건수: ret.n, 금액: Math.round(ret.amt), 반품률_pct: pct(ret.n, valid) },
    미결제취소_제외: nopay,
  };
}

async function returnsReport(start, end) {
  const [cafe, ss] = await Promise.all([
    cafe24Returns(start, end).catch((e) => ({ channel: '자사몰', error: e.message })),
    smartstoreReturns(start, end).catch((e) => ({ channel: '스마트스토어', error: e.message })),
  ]);
  return {
    start, end, 자사몰: cafe, 스마트스토어: ss,
    주의: '자사몰은 라이브 /orders(주문일 기준): 주문단위 canceled=T 가 사실상 반품확정과 일치(사전취소는 주문목록 미포함) → 자사몰 "취소"는 대개 0, 반품에 수렴. 부분반품 시 금액은 잔액 반영이라 근사. 스토어는 DB status 기준(정확).',
  };
}

module.exports = { returnsReport, cafe24Returns, smartstoreReturns };
