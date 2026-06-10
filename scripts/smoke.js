'use strict';
// 통합 스모크: 세 집계가 실데이터로 동작하는지 확인
const c = require('../lib/cafe24');
const analytics = require('../lib/analytics');
const ordersLib = require('../lib/orders');
const couponsLib = require('../lib/coupons');

function pad(n){return String(n).padStart(2,'0');}
function dstr(d){return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;}
const t=new Date(); const end=new Date(t); end.setDate(end.getDate()-1); const start=new Date(t); start.setDate(start.getDate()-7);
const START=dstr(start), END=dstr(end);
const won=(n)=>Number(n||0).toLocaleString('ko-KR');
const pct=(n)=>(n*100).toFixed(1)+'%';

(async()=>{
  console.log(`\n===== 스모크 테스트  ${START} ~ ${END} =====`);

  console.time('① 유입');
  const inflow = await analytics.inflowReport(START, END);
  console.timeEnd('① 유입');
  console.log(`  방문 ${won(inflow.totals.visits)} (신규 ${won(inflow.totals.newVisits)} / 재방문 ${won(inflow.totals.reVisits)}, 신규비중 ${pct(inflow.totals.newRatio)})`);
  console.log(`  PC ${won(inflow.totals.pcVisits)} / 모바일 ${won(inflow.totals.mobileVisits)} | 일평균 ${won(inflow.totals.avgDaily)} | 총PV ${won(inflow.totalPv)}`);
  console.log(`  유입도메인 top3: ${inflow.topDomains.slice(0,3).map(d=>`${d.domain}(${won(d.visits)})`).join(', ')}`);
  console.log(`  검색어 top3: ${inflow.topKeywords.slice(0,3).map(k=>`${k.keyword}(${won(k.visits)})`).join(', ')}`);

  console.time('② 주문수집');
  const orders = await ordersLib.fetchOrders(START, END);
  console.timeEnd('② 주문수집');
  console.log(`  주문 ${won(orders.length)}건 수집`);
  const mem = ordersLib.memberReport(orders, START, END);
  console.log(`  [회원]   주문 ${won(mem.member.orders)} / 결제 ${won(mem.member.paidOrders)} / 매출 ${won(mem.member.revenue)} / 객단가 ${won(mem.member.aov)} / 쿠폰할인 ${won(mem.member.couponDiscount)}`);
  console.log(`  [비회원] 주문 ${won(mem.guest.orders)} / 결제 ${won(mem.guest.paidOrders)} / 매출 ${won(mem.guest.revenue)} / 객단가 ${won(mem.guest.aov)} / 쿠폰할인 ${won(mem.guest.couponDiscount)}`);
  console.log(`  회원 매출비중 ${pct(mem.total.memberRevenueShare)} | 총매출 ${won(mem.total.revenue)}`);

  console.time('③-A 상품별 프로모션');
  const prodPromo = couponsLib.productPromotion(orders);
  console.timeEnd('③-A 상품별 프로모션');
  console.log(`  쿠폰적용 주문 ${won(prodPromo.couponOrders)}건 / 쿠폰매출 ${won(prodPromo.totalCouponSales)} / 쿠폰할인 ${won(prodPromo.totalCouponDiscount)} / 대상상품 ${prodPromo.productCount}종`);
  prodPromo.products.slice(0,5).forEach((p,i)=>console.log(`    ${i+1}. ${p.product_name} — 매출 ${won(p.sales)} / 할인 ${won(p.discount)} / 주문 ${p.orders} / 수량 ${p.quantity}`));

  const orderMap = new Map(orders.map(o=>[o.order_id, o]));
  console.time('③-B 쿠폰깔때기');
  const funnel = await couponsLib.couponFunnel(START, END, orderMap);
  console.timeEnd('③-B 쿠폰깔때기');
  console.log(`  스캔 ${funnel.scanned}개 중 기간발급 쿠폰 ${funnel.coupons.length}개 | 총발급 ${won(funnel.totals.issued)} → 사용 ${won(funnel.totals.used)} (${pct(funnel.totals.useRate)}) | 연결매출 ${won(funnel.totals.revenue)}`);
  funnel.coupons.slice(0,6).forEach((cp,i)=>console.log(`    ${i+1}. ${cp.coupon_name} [${cp.target.label}/${cp.benefit.text}] 발급 ${won(cp.issued)}→사용 ${won(cp.used)}(${pct(cp.useRate)}) 매출 ${won(cp.revenue)}`));

  await c.close();
  console.log('\n===== 완료 =====');
})().catch(e=>{console.error('오류:',e); process.exit(1);});
