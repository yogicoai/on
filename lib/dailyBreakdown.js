'use strict';

/**
 * 일별 온·오프라인 요약 + 각 날짜별 최다판매 상품 — 한 번의 호출로 기간 전체를 반환.
 *   소스: on.orders(이카운트 온라인 출고) · off.orders(오프라인 매장). 둘 다 date/productName/qty/amount 보유.
 *   "8월 1~11일 일별로 온·오프 나눠서, 각 날 제일 많이 팔린 상품" 류 질문을 도구 1개로 처리(11번 호출 방지).
 */

const store = require('./store');

const ymd = (s) => String(s || '').slice(0, 10);
const N = (v) => (Number.isFinite(+v) ? +v : 0);

// 한 채널(on/off)의 [start,end] 일별 집계 + 일별 최다판매(수량 기준, 동률이면 금액)
async function channelDaily(db, start, end) {
  const c = await store.namedCollection(db, 'orders');
  const rows = await c.aggregate([
    { $match: { date: { $gte: ymd(start), $lte: ymd(end) } } },
    { $group: {
      _id: { date: '$date', product: '$productName' },
      qty: { $sum: '$qty' }, amount: { $sum: '$amount' }, orders: { $addToSet: '$orderNo' },
    } },
  ]).toArray();

  const byDate = new Map();
  for (const r of rows) {
    const d = r._id.date;
    if (!byDate.has(d)) byDate.set(d, { date: d, 매출: 0, 수량: 0, 주문: new Set(), _prods: [] });
    const o = byDate.get(d);
    o.매출 += N(r.amount); o.수량 += N(r.qty);
    for (const on of (r.orders || [])) o.주문.add(on);
    o._prods.push({ 상품: r._id.product, 수량: N(r.qty), 매출: N(r.amount) });
  }
  const out = {};
  for (const [d, o] of byDate) {
    o._prods.sort((a, b) => (b.수량 - a.수량) || (b.매출 - a.매출));
    out[d] = {
      매출: Math.round(o.매출), 수량: o.수량, 주문수: o.주문.size,
      최다판매: o._prods[0] || null,
      상위3: o._prods.slice(0, 3),
    };
  }
  return out;
}

// 기간 내 날짜 목록(로컬 기준, KST 밀림 방지)
function enumDays(start, end) {
  const days = [];
  const s = new Date(ymd(start) + 'T00:00:00'); const e = new Date(ymd(end) + 'T00:00:00');
  for (let d = s; d <= e; d = new Date(d.getTime() + 86400000)) {
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return days;
}

async function dailyBreakdown(start, end) {
  const [on, off] = await Promise.all([channelDaily('on', start, end), channelDaily('off', start, end)]);
  const days = enumDays(start, end);
  const 일별 = days.map((d) => ({
    날짜: d,
    온라인: on[d] || { 매출: 0, 수량: 0, 주문수: 0, 최다판매: null },
    오프라인: off[d] || { 매출: 0, 수량: 0, 주문수: 0, 최다판매: null },
  }));
  const sum = (arr, ch) => arr.reduce((t, x) => t + (x[ch].매출 || 0), 0);
  return {
    start: ymd(start), end: ymd(end), 일수: days.length,
    합계: { 온라인매출: sum(일별, '온라인'), 오프라인매출: sum(일별, '오프라인') },
    일별,
    주의: '온라인=이카운트 출고 기준(자사몰+스토어+외부채널 합), 오프라인=매장 주문서. 최다판매=그날 수량 1위 상품(동률이면 금액).',
  };
}

module.exports = { dailyBreakdown };
