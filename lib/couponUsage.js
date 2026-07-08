'use strict';

/**
 * 쿠폰 사용 현황 — 다운로드 쿠폰 프로모션 운영용.
 *   ① 기간 내 "사용된 쿠폰별" 집계(주문수·매출·할인액) — orders_raw(쿠폰할인>0) × order_coupons(주문→쿠폰명 매핑)
 *   ② 특정 쿠폰(부분일치) 지정 시 → 그 쿠폰으로 구매한 주문 리스트(주문번호·일자·금액·할인·상품·회원/신규)
 *   ※ 쿠폰명 매핑(order_coupons)은 적재 배치로 채워짐 — 커버리지(%)를 함께 반환, 낮으면 대시보드 '쿠폰 적재'로 보강.
 *   ※ 고객 개인정보 미포함(주문번호·금액·상품만).
 */

const store = require('./store');
const { couponNamesFor } = require('./coupons');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const R = (n) => Math.round(n || 0);

async function usage(start, end, { coupon } = {}) {
  const o = await store.collection('orders_raw');
  const orders = await o.find(
    { order_date: { $gte: start, $lte: end }, coupon_discount: { $gt: 0 }, paid: true, canceled: false },
    { projection: { order_id: 1, order_date: 1, payment_amount: 1, coupon_discount: 1, member_id: 1, first_order: 1, items: 1 } },
  ).sort({ order_date: -1 }).toArray();

  const nameMap = await couponNamesFor(orders.map((x) => x.order_id)); // order_id → [쿠폰명]
  const mapped = orders.filter((x) => (nameMap[x.order_id] || []).length);
  const coverage = orders.length ? +((mapped.length / orders.length) * 100).toFixed(1) : 100;

  const base = {
    start, end,
    쿠폰사용주문: orders.length,
    쿠폰명매핑: mapped.length,
    매핑커버리지_pct: coverage,
    ...(coverage < 90 ? { 보강안내: '쿠폰명 미매핑 주문이 있음 — 대시보드 프로모션 편집의 "만료 쿠폰 포함 갱신"(쿠폰 적재) 실행 후 다시 조회하면 커버리지가 올라갑니다.' } : {}),
  };

  const rowOf = (x) => ({
    주문번호: x.order_id, 일자: x.order_date,
    결제금액: R(x.payment_amount), 쿠폰할인: R(x.coupon_discount),
    회원: !!x.member_id, 첫구매: x.first_order === 'T',
    사용쿠폰: nameMap[x.order_id] || [],
    상품: (x.items || []).map((i) => i.product_name).filter(Boolean).slice(0, 5),
  });

  if (coupon) {
    const q = String(coupon).trim();
    const hit = mapped.filter((x) => (nameMap[x.order_id] || []).some((n) => n.includes(q)));
    const t = hit.reduce((a, x) => { a.매출 += N(x.payment_amount); a.할인 += N(x.coupon_discount); return a; }, { 매출: 0, 할인: 0 });
    return {
      ...base, 쿠폰검색: q,
      집계: { 주문수: hit.length, 매출: R(t.매출), 쿠폰할인: R(t.할인), 회원주문: hit.filter((x) => x.member_id).length, 첫구매주문: hit.filter((x) => x.first_order === 'T').length },
      주문리스트: hit.slice(0, 25).map(rowOf),
      주의: '쿠폰할인은 주문 단위 총액(한 주문에 쿠폰 여러 장이면 합산액). 부분일치 매칭.',
    };
  }

  // 쿠폰별 집계
  const agg = {};
  for (const x of mapped) {
    for (const nm of (nameMap[x.order_id] || [])) {
      const a = (agg[nm] = agg[nm] || { 쿠폰명: nm, 주문수: 0, 매출: 0, 쿠폰할인: 0, 첫구매: 0 });
      a.주문수++; a.매출 += N(x.payment_amount); a.쿠폰할인 += N(x.coupon_discount);
      if (x.first_order === 'T') a.첫구매++;
    }
  }
  const 쿠폰별 = Object.values(agg).map((a) => ({ ...a, 매출: R(a.매출), 쿠폰할인: R(a.쿠폰할인) }))
    .sort((a, b) => b.매출 - a.매출).slice(0, 25);
  return {
    ...base, 쿠폰별,
    주의: '한 주문에 쿠폰 여러 장 사용 시 각 쿠폰 행에 주문 매출이 중복 계상됨(쿠폰별 기여 비교용). 특정 쿠폰 구매 리스트는 coupon 파라미터로 조회.',
  };
}

module.exports = { usage };
