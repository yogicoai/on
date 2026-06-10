'use strict';
// 4차: 쿠폰 issues 발급일 필터 정밀 디버깅
const c = require('../lib/cafe24');
function pad(n){return String(n).padStart(2,'0');}
function dstr(d){const x=new Date(d);return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())}`;}
const now=new Date();
const D = (days)=>{const x=new Date(now); x.setDate(x.getDate()-days); return dstr(x);};
const TODAY = dstr(now);

(async()=>{
  console.log(`\n=== 쿠폰 issues 필터 디버깅 (오늘=${TODAY}) ===\n`);
  const coupons = await c.adminPaginate('/coupons', { shop_no:1 }, 'coupons', { limit:100, maxPages:3 });
  const act = coupons.filter(x=>x.deleted!=='T' && +x.issued_count>0).sort((a,b)=>+b.issued_count-+a.issued_count);

  // 다운로드형(issue_type) 분포 확인
  const byType = {};
  for(const x of act){ const k=`${x.coupon_type}/${x.issue_type}/${x.issue_sub_type||''}`; byType[k]=(byType[k]||0)+1; }
  console.log('coupon_type/issue_type/sub 분포:', JSON.stringify(byType));

  const cp = act[0];
  console.log(`\n테스트 쿠폰: ${cp.coupon_no} "${cp.coupon_name}" issued_count=${cp.issued_count} created=${cp.created_date}`);

  // 1) 발급일 윈도우 넓혀가며 issued_start/end 필터 결과
  console.log('\n[issued_start_date/issued_end_date 윈도우별 1페이지 len]');
  for(const days of [7,30,90,180,365,1000]){
    try{ const j=await c.adminGet(`/coupons/${cp.coupon_no}/issues`,{shop_no:1,limit:10,issued_start_date:D(days),issued_end_date:TODAY});
      const a=j.issues||[]; console.log(`  최근 ${days}일 (${D(days)}~${TODAY}): len=${a.length} 첫issued=${a[0]?a[0].issued_date:'-'}`);
    }catch(e){ console.log(`  ${days}일: ❌ ${e.status} ${String(e.message).slice(0,80)}`); }
  }

  // 2) 필터 없이 offset 으로 마지막 페이지 근처(최신 발급일) 확인
  console.log('\n[필터없음 정렬/최신 발급일 확인]');
  const head = await c.adminGet(`/coupons/${cp.coupon_no}/issues`,{shop_no:1,limit:5,offset:0});
  console.log('  head(offset0):', (head.issues||[]).map(x=>x.issued_date).join(' | '));
  const cnt = +cp.issued_count;
  const tailOff = Math.max(0, cnt-5);
  try{ const tail = await c.adminGet(`/coupons/${cp.coupon_no}/issues`,{shop_no:1,limit:5,offset:tailOff});
    console.log(`  tail(offset${tailOff}):`, (tail.issues||[]).map(x=>x.issued_date).join(' | ')); }catch(e){ console.log('  tail err', e.status); }

  // 3) order_by desc 시도
  console.log('\n[order_by 최신순 시도]');
  for(const params of [{order_by:'issued_date',order:'desc'},{sort:'issued_date',order:'desc'},{embed:''}]){
    try{ const j=await c.adminGet(`/coupons/${cp.coupon_no}/issues`,{shop_no:1,limit:3,...params});
      console.log(`  ${JSON.stringify(params)} → ${(j.issues||[]).map(x=>x.issued_date).join(' | ')}`);
    }catch(e){ console.log(`  ${JSON.stringify(params)} ❌ ${e.status}`); }
  }

  // 4) 최근 만들어진 쿠폰(다운로드형 프로모션 후보) 중 created 최신 5개로 기간발급 테스트
  console.log('\n[최근 생성 쿠폰 5개의 최근30일 발급]');
  const recent = [...act].sort((a,b)=>new Date(b.created_date)-new Date(a.created_date)).slice(0,5);
  for(const r of recent){
    try{ const j=await c.adminGet(`/coupons/${r.coupon_no}/issues`,{shop_no:1,limit:5,issued_start_date:D(30),issued_end_date:TODAY});
      const a=j.issues||[]; console.log(`  "${r.coupon_name}" created=${dstr(r.created_date)} issued_count=${r.issued_count} → 최근30일 len=${a.length} 첫=${a[0]?a[0].issued_date:'-'}`);
    }catch(e){ console.log(`  "${r.coupon_name}" ❌ ${e.status} ${String(e.message).slice(0,70)}`); }
  }

  await c.close();
  console.log('\n=== 완료 ===');
})().catch(e=>{console.error(e);process.exit(1);});
