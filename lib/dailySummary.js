'use strict';

/**
 * 자사몰 일일요약 + 일일점검 데이터 — 대시보드 상단 카드용.
 *   ※ 지표별 출처가 다름(요청 기준):
 *     - 일일매출(전일비)        : Cafe24 주문일 기준 (analytics.dailyHealth → orders_raw)
 *     - 누적매출·주문수·객단가  : 이카운트 '홈페이지'(=자사몰) 출고일 기준 (on.orders) — MD/회계 기준과 일치
 *     - 방문수/가입수/구매율    : Cafe24 analytics (방문=analytics, 주문=orders_raw)
 *
 *   - 일일요약: ① 일일매출(전일비) ② 누적매출(전년/전월/전주 동기간) ③ 주문수·객단가(동기간) ④ 프로모션성과(프론트 별도)
 *   - 일일점검: ① 방문수(같은요일 평균=목표·달성률) ② 가입수(가입전환율) ③ 구매율(목표 1.5%)
 */

const analytics = require('./analytics');
const store = require('./store');

const PURCHASE_RATE_TARGET = 0.015; // 구매율 목표 1.5% (요청 기준 고정값)
const WEEKS = 4; // 같은요일 평균 표본(최근 4주)
const ECOUNT_STORE = '홈페이지'; // 이카운트에서 자사몰 채널명

function monthStartOf(date) { return String(date).slice(0, 8) + '01'; }
function rate(cur, base) { return (base != null && base !== 0) ? (cur - base) / base : null; }
function pad(n) { return String(n).padStart(2, '0'); }
function fmtD(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function shift(dateStr, { days = 0, months = 0, years = 0 }) {
  const d = new Date(dateStr + 'T00:00:00');
  if (years) d.setFullYear(d.getFullYear() + years);
  if (months) d.setMonth(d.getMonth() + months);
  if (days) d.setDate(d.getDate() + days);
  return fmtD(d);
}
const aov = (g) => (g.orders ? Math.round(g.revenue / g.orders) : 0);

// 이카운트(storeName) 출고일 기준 매출·주문수 — on.orders 는 품목 단위라 주문번호(orderNo) distinct 로 주문수 집계.
async function ecountStoreSum(storeName, s, e) {
  const on = await store.namedCollection('on', 'orders');
  const r = await on.aggregate([
    { $match: { store: storeName, date: { $gte: s, $lte: e } } },
    { $group: { _id: null, revenue: { $sum: '$amount' }, orderSet: { $addToSet: '$orderNo' } } },
    { $project: { revenue: 1, orders: { $size: '$orderSet' } } },
  ]).toArray();
  return r[0] ? { revenue: Math.round(r[0].revenue), orders: r[0].orders } : { revenue: 0, orders: 0 };
}

// 전년/전월/전주 동기간 비교 (이카운트 출고 기준) — periodCompare 와 동일한 시프트 규칙(구간을 통째로 이동).
async function ecountStoreCompare(storeName, start, end) {
  const ranges = {
    cur: [start, end],
    wow: [shift(start, { days: -7 }), shift(end, { days: -7 })],
    mom: [shift(start, { months: -1 }), shift(end, { months: -1 })],
    yoy: [shift(start, { years: -1 }), shift(end, { years: -1 })],
  };
  const d = {};
  for (const [k, [s, e]] of Object.entries(ranges)) d[k] = await ecountStoreSum(storeName, s, e);
  const cur = d.cur;
  const period = (p) => ({
    revenue: d[p].revenue, rate: rate(cur.revenue, d[p].revenue),
    orders: d[p].orders, ordersRate: rate(cur.orders, d[p].orders),
    aov: aov(d[p]),
  });
  return {
    ranges,
    cur: { revenue: cur.revenue, orders: cur.orders, aov: aov(cur) },
    yoy: period('yoy'), mom: period('mom'), wow: period('wow'),
  };
}

// 스토어별 '이달 누적' 동기간 요약 (이카운트) — 스마트스토어 등 다른 채널 카드용.
async function storeMtdSummary(storeName, date) {
  const d = String(date).slice(0, 10);
  const ms = monthStartOf(d);
  const ec = await ecountStoreCompare(storeName, ms, d);
  return {
    store: storeName, date: d, monthStart: ms,
    mtd: { basis: '이카운트', revenue: ec.cur.revenue, orders: ec.cur.orders, aov: ec.cur.aov, ranges: ec.ranges, yoy: ec.yoy, mom: ec.mom, wow: ec.wow },
  };
}

async function dailySummary(date) {
  const d = String(date).slice(0, 10);
  const ms = monthStartOf(d);
  const [dh, ec] = await Promise.all([
    analytics.dailyHealth(d, WEEKS, { signups: true }),
    ecountStoreCompare(ECOUNT_STORE, ms, d),
  ]);

  const visits = dh.visits || { day: 0, avg: 0 };
  const signups = dh.signups || { day: 0, avg: 0 };
  const dayOrders = (dh.orders || {}).day || 0;
  const prevSales = (dh.prev || {}).sales || 0;

  return {
    date: d, monthStart: ms, weekdayLabel: dh.label, samples: dh.samples,
    // ── 일일요약 ──
    daily: { // 일일매출 = Cafe24 주문일 기준
      revenue: dh.sales.day,
      prevRevenue: prevSales,
      rate: rate(dh.sales.day, prevSales), // 전일비
    },
    mtd: { // 누적매출·주문수·객단가 = 이카운트(홈페이지·출고일) 기준
      basis: '이카운트',
      revenue: ec.cur.revenue, orders: ec.cur.orders, aov: ec.cur.aov,
      ranges: ec.ranges,
      yoy: ec.yoy, mom: ec.mom, wow: ec.wow,
    },
    // ── 일일점검 ──
    check: {
      visits: {
        today: visits.day, target: visits.avg,
        achieveRate: visits.avg ? visits.day / visits.avg : null,
        gap: visits.day - visits.avg,
      },
      signups: {
        today: signups.day, target: signups.avg,
        conversionRate: visits.day ? signups.day / visits.day : 0, // 방문수 대비 가입전환율
        gap: signups.day - signups.avg,
      },
      purchaseRate: {
        today: visits.day ? dayOrders / visits.day : 0, // 결제완료 주문수 ÷ 방문수
        target: PURCHASE_RATE_TARGET,
        orders: dayOrders, visits: visits.day,
      },
    },
  };
}

module.exports = { dailySummary, storeMtdSummary, ecountStoreCompare, PURCHASE_RATE_TARGET };
