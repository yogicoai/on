'use strict';

/**
 * 고객 리텐션/재구매/LTV — 자사몰(Cafe24) orders_raw 기반(회원 member_id).
 *   조회 윈도우(최근 N개월) 내에서:
 *     · 구매회원수 / 재구매회원수(2회+) / 재구매율
 *     · 회원 평균 주문수 · 평균 구매액(윈도우 LTV 프록시)
 *     · 평균 재구매 주기(재구매 회원의 연속주문 간격 평균, 일)
 *     · 신규(first_order) vs 재구매 주문·매출 비중 · 비회원 비중
 *   ※ LTV/주기는 "윈도우 내" 값(전 생애 아님). 정확한 전생애 LTV는 전기간 스캔 필요.
 */

const store = require('./store');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const pct = (a, b) => (b ? +((a / b) * 100).toFixed(1) : 0);
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function retention(months = 6) {
  const mo = Math.max(1, Math.min(24, Number(months) || 6));
  const now = new Date();
  const start = fmt(new Date(now.getFullYear(), now.getMonth() - mo + 1, 1));
  const end = fmt(now);
  const coll = await store.collection('orders_raw');
  const rows = await coll.find(
    { order_date: { $gte: start, $lte: end }, paid: true, canceled: false },
    { projection: { member_id: 1, order_date: 1, payment_amount: 1, first_order: 1 } },
  ).toArray();

  const byMember = {};
  let guestOrders = 0, guestRev = 0, newOrders = 0, newRev = 0, repeatOrders = 0, repeatRev = 0, totalRev = 0, totalOrders = 0;
  for (const o of rows) {
    const amt = N(o.payment_amount); totalRev += amt; totalOrders++;
    const isNew = o.first_order === 'T' || o.first_order === true;
    if (isNew) { newOrders++; newRev += amt; } else { repeatOrders++; repeatRev += amt; }
    if (o.member_id) {
      const m = (byMember[o.member_id] = byMember[o.member_id] || { n: 0, amt: 0, dates: [] });
      m.n++; m.amt += amt; m.dates.push(o.order_date);
    } else { guestOrders++; guestRev += amt; }
  }

  const members = Object.values(byMember);
  const buyers = members.length;
  const repeaters = members.filter((m) => m.n >= 2).length;

  const gaps = [];
  for (const m of members) {
    if (m.n < 2) continue;
    const ds = m.dates.map((d) => new Date(d + 'T00:00:00')).sort((a, b) => a - b);
    for (let i = 1; i < ds.length; i++) gaps.push((ds[i] - ds[i - 1]) / 86400000);
  }
  const avgGap = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;

  return {
    window: { start, end, months: mo },
    구매회원수: buyers,
    재구매회원수: repeaters,
    재구매율_pct: pct(repeaters, buyers),
    회원평균주문수: buyers ? +(members.reduce((a, m) => a + m.n, 0) / buyers).toFixed(2) : 0,
    회원평균구매액_LTV: buyers ? Math.round(members.reduce((a, m) => a + m.amt, 0) / buyers) : 0,
    평균재구매주기_일: avgGap,
    신규주문: { 건수: newOrders, 매출: Math.round(newRev), 매출비중_pct: pct(newRev, totalRev) },
    재구매주문: { 건수: repeatOrders, 매출: Math.round(repeatRev), 매출비중_pct: pct(repeatRev, totalRev) },
    비회원주문: { 건수: guestOrders, 매출: Math.round(guestRev), 매출비중_pct: pct(guestRev, totalRev) },
    총주문: totalOrders, 총매출: Math.round(totalRev),
    주의: '자사몰(Cafe24) 회원 기준. LTV·재구매주기는 조회 윈도우 내 값(전 생애 아님). first_order=Cafe24 신규주문 플래그.',
  };
}

module.exports = { retention };
