'use strict';
// 2차 프로빙: 유입경로/디바이스 분해 + 매출/상품 통계 엔드포인트 확정
const c = require('../lib/cafe24');
function pad(n){return String(n).padStart(2,'0');}
function dstr(d){return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;}
const t=new Date(); const end=new Date(t); end.setDate(end.getDate()-1); const start=new Date(t); start.setDate(start.getDate()-8);
const START=dstr(start), END=dstr(end);
function keys(o){return o&&typeof o==='object'?Object.keys(o):[];}
function fr(j){ if(!j||typeof j!=='object')return null; for(const k of Object.keys(j)) if(Array.isArray(j[k])&&j[k].length) return {key:k,row:j[k][0],len:j[k].length}; return null;}
async function p(ep, params){
  try{ const j=await c.caGet(ep,{start_date:START,end_date:END,device_type:'total',limit:5,...(params||{})});
    const f=fr(j);
    if(f) console.log(`  ✅ ${ep} ${params?JSON.stringify(params):''} → [${f.key}] ${f.len}행: ${keys(f.row).join(', ')}`);
    else console.log(`  ⚠️ ${ep} → 200 no-array topKeys=${keys(j).join(',')} ${JSON.stringify(j).slice(0,120)}`);
  }catch(e){ console.log(`  ❌ ${ep} → ${e.status||''} ${String(e.message).slice(0,90)}`);}
}
(async()=>{
  console.log(`\n=== 2차 프로빙 ${START}~${END} ===\n`);
  console.log('── 디바이스 분해 (device_type) ──');
  await p('/visitors/view',{device_type:'pc'});
  await p('/visitors/view',{device_type:'mobile'});
  console.log('\n── 유입경로/유입 도메인 후보 ──');
  for(const ep of ['/visitpaths/inflows','/visitpaths/inflow','/visitpaths/domains','/visitpaths/searchkeywords',
    '/visitpaths/searches','/visitpaths/sns','/visitpaths/influx','/visitpaths/searchengine','/visitpaths/sites/view',
    '/visitpaths/external','/visitpaths/keywords/view']) await p(ep);
  console.log('\n── 매출/상품/장바구니 통계 후보 ──');
  for(const ep of ['/sales','/sales/view','/sales/orderbasic/view','/sales/productdetails','/sales/products',
    '/products/view','/products/best','/products/sales','/carts/view','/orders/view','/sales/categorysales']) await p(ep);
  await c.close();
  console.log('\n=== 완료 ===');
})().catch(e=>{console.error(e);process.exit(1);});
