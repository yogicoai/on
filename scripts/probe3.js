'use strict';
// 3차: 주문 볼륨/limit + 쿠폰 issues 날짜필터 지원여부
const c = require('../lib/cafe24');
function pad(n){return String(n).padStart(2,'0');}
function dstr(d){return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;}
const t=new Date(); const end=new Date(t); end.setDate(end.getDate()-1); const start=new Date(t); start.setDate(start.getDate()-8);
const START=dstr(start), END=dstr(end);

(async()=>{
  console.log(`\n=== 3차 프로빙 ${START}~${END} ===\n`);

  // 1) 주문 limit 500 + 볼륨
  console.log('── 주문 ──');
  try{
    const j = await c.adminGet('/orders', { shop_no:1, start_date:START, end_date:END, date_type:'order_date', limit:500, offset:0 });
    const os = j.orders||[];
    let mem=0,guest=0,paid=0;
    for(const o of os){ if(o.member_id && String(o.member_id).trim()) mem++; else guest++; if(o.paid==='T')paid++; }
    console.log(`  limit500 1페이지 주문수=${os.length} (회원 ${mem}/비회원 ${guest}/결제완료 ${paid})`);
    console.log(`  샘플 member_id 값들: ${os.slice(0,6).map(o=>JSON.stringify(o.member_id)).join(', ')}`);
    console.log(`  payment_amount 샘플: ${os.slice(0,3).map(o=>o.payment_amount).join(', ')}`);
  }catch(e){ console.log('  ❌ 주문 limit500:', e.status, String(e.message).slice(0,120)); }

  // 2) 쿠폰 중 issued_count 큰 것 찾기
  console.log('\n── 쿠폰 issues 날짜필터 테스트 ──');
  const coupons = await c.adminPaginate('/coupons', { shop_no:1 }, 'coupons', { limit:100, maxPages:3 });
  console.log(`  전체 쿠폰 ${coupons.length}개`);
  const withIssued = coupons.filter(c=>+c.issued_count>0).sort((a,b)=>(+b.issued_count)-(+a.issued_count));
  console.log(`  발급>0 쿠폰 ${withIssued.length}개. 상위5 issued_count: ${withIssued.slice(0,5).map(c=>c.issued_count).join(', ')}`);
  const sample = withIssued[0];
  if(sample){
    console.log(`  테스트 쿠폰: ${sample.coupon_no} "${sample.coupon_name}" issued_count=${sample.issued_count}`);
    console.log(`    available: ${sample.available_begin_datetime} ~ ${sample.available_end_datetime} | scope=${sample.available_scope} benefit_type=${sample.benefit_type}`);
    console.log(`    available_product_list=${JSON.stringify(sample.available_product_list)} available_category_list=${JSON.stringify(sample.available_category_list)}`);
    // (a) 필터 없이 1페이지
    const base = await c.adminGet(`/coupons/${sample.coupon_no}/issues`, { shop_no:1, limit:10 });
    console.log(`    [필터없음] issues 1p len=${(base.issues||[]).length}`);
    // (b) 날짜필터 후보들
    for(const params of [
      { issued_start_date:START, issued_end_date:END },
      { start_date:START, end_date:END },
      { used_coupon:'T' },
      { used_start_date:START, used_end_date:END },
    ]){
      try{
        const j = await c.adminGet(`/coupons/${sample.coupon_no}/issues`, { shop_no:1, limit:10, ...params });
        const arr=j.issues||[];
        console.log(`    [${JSON.stringify(params)}] len=${arr.length} 샘플: ${arr[0]?JSON.stringify({issued:arr[0].issued_date,used:arr[0].used_coupon,used_date:arr[0].used_date,oid:arr[0].related_order_id}):'-'}`);
      }catch(e){ console.log(`    [${JSON.stringify(params)}] ❌ ${e.status} ${String(e.message).slice(0,80)}`); }
    }
  }
  await c.close();
  console.log('\n=== 완료 ===');
})().catch(e=>{console.error(e);process.exit(1);});
