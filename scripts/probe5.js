'use strict';
// 5차: 회원(고객) API 접근 가능 필드 검증 — 세그먼트/가입일/개인정보 스코프 확인
// PII 값은 마스킹해서 출력(키/존재여부만 확인).
const c = require('../lib/cafe24');

function keys(o){return o&&typeof o==='object'?Object.keys(o):[];}
function mask(v){ if(v==null)return v; const s=String(v); return s.length<=2?'**':s[0]+'***'+s.slice(-1); }

async function tryGet(label, ep, params){
  try{
    const j = await c.adminGet(ep, params);
    const arr = j && (j.customers||j.customersprivacy||j.privacy||j.count!=null?j:null);
    if (j.count!=null && Object.keys(j).length===1){ console.log(`  ✅ ${label} (${ep}) → count=${j.count}`); return j; }
    const list = j.customers||j.customersprivacy||j.privacy||[];
    if (Array.isArray(list)) { console.log(`  ✅ ${label} (${ep}) → ${list.length}행, 필드: ${keys(list[0]).join(', ')}`); return list[0]; }
    console.log(`  ⚠️ ${label} (${ep}) → topKeys: ${keys(j).join(', ')}`);
    return j;
  }catch(e){ console.log(`  ❌ ${label} (${ep}) → ${e.status||''} ${String(e.message).slice(0,120)}`); return null; }
}

(async()=>{
  console.log('\n=== 회원/고객 API 프로빙 ===\n');

  console.log('── 회원 목록(비PII) /customers ──');
  const cust = await tryGet('회원목록', '/customers', { shop_no:1, limit:3 });
  if (cust && typeof cust==='object'){
    const interesting={};
    for(const k of ['member_id','group_no','group_name','created_date','last_login_date','member_authentication','sex','birthday','total_points','available_points','use_blacklist','member_type']) if(k in cust) interesting[k]=cust[k];
    console.log('    관심필드:', JSON.stringify(interesting).slice(0,400));
  }
  await tryGet('회원수', '/customers/count', { shop_no:1 });

  console.log('\n── 개인정보 /customersprivacy (PII 스코프 확인) ──');
  const priv = await tryGet('개인정보', '/customersprivacy', { shop_no:1, limit:2 });
  if (priv && typeof priv==='object'){
    const red={};
    for(const k of keys(priv)) red[k] = /name|phone|cellphone|email|mobile|address/i.test(k) ? mask(priv[k]) : priv[k];
    console.log('    (PII 마스킹):', JSON.stringify(red).slice(0,500));
  }

  console.log('\n── 가입일 필터/정렬 지원 확인 (3개월+ 세그먼트용) ──');
  // 가입일 범위 필터 테스트
  await tryGet('가입일범위', '/customers', { shop_no:1, limit:2, created_start_date:'2020-01-01', created_end_date:'2025-01-01' });

  await c.close();
  console.log('\n=== 완료 ===');
})().catch(e=>{console.error(e);process.exit(1);});
