'use strict';
// 8차: 프로모션 페이지 접근 고객수 측정 가능성 — yogiChat 이벤트추적 + Cafe24 /pages/view + coupon_direct_url
const c = require('../lib/cafe24');
const { loadEnv } = require('../lib/env');
loadEnv();
const { MongoClient } = require('mongodb');

function pad(n){return String(n).padStart(2,'0');}
function dstr(d){return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;}
const now=new Date(); const end=dstr(now); const s30=new Date(now); s30.setDate(s30.getDate()-30); const START=dstr(s30);
const keys=(o)=>o&&typeof o==='object'?Object.keys(o):[];

(async()=>{
  console.log('\n=== 프로모션 페이지 접근 측정 가능성 ===\n');

  // (A) yogiChat 이벤트페이지 추적 컬렉션 (yogibo DB, 같은 클러스터)
  console.log('── (A) yogiChat 이벤트추적 (yogibo DB) ──');
  const URI = process.env.CAFE24_TOKEN_URI || process.env.MONGODB_URI;
  const DBN = process.env.CAFE24_TOKEN_DB || 'yogibo';
  const cli = new MongoClient(URI, { serverSelectionTimeoutMS: 8000 });
  try{
    await cli.connect();
    const db = cli.db(DBN);
    const colls = (await db.listCollections().toArray()).map(x=>x.name);
    const track = colls.filter(n=>/^(visits|clicks|prdClick|view|event)/i.test(n) || /visit|click|event/i.test(n));
    console.log('  추적 후보 컬렉션:', track.join(', ') || '(없음)');
    for(const name of track.slice(0,8)){
      const co = db.collection(name);
      const cnt = await co.estimatedDocumentCount();
      const sample = await co.findOne({}, { sort:{ _id:-1 } });
      console.log(`  · ${name}: ~${cnt}건 | 필드: ${keys(sample).join(', ')}`);
      if (sample){
        const red={}; for(const k of ['pageId','visitorId','memberId','member_id','couponNo','pageUrl','url','referrer','device','type','element','dateKey','timestamp']) if(k in sample) red[k]=sample[k];
        console.log(`     샘플: ${JSON.stringify(red).slice(0,260)}`);
      }
    }
    // pageId 분포(최근) — 어떤 프로모션 페이지들이 추적되나
    const vCol = colls.find(n=>/^visits_/.test(n));
    if (vCol){
      const agg = await db.collection(vCol).aggregate([
        { $group: { _id: '$pageId', visits: { $sum: 1 }, visitors: { $addToSet: '$visitorId' } } },
        { $project: { pageId:'$_id', visits:1, uniq:{ $size:'$visitors' } } },
        { $sort: { visits:-1 } }, { $limit: 8 }
      ]).toArray();
      console.log(`\n  ${vCol} pageId TOP (방문/유니크방문자):`);
      agg.forEach(r=>console.log(`     pageId=${r.pageId} visits=${r.visits} uniq=${r.uniq}`));
    }
  }catch(e){ console.log('  ❌ yogibo DB 접근:', String(e.message).slice(0,120)); }
  finally{ await cli.close(); }

  // (B) Cafe24 통계 /pages/view — 프로모션 URL 방문수 (익명)
  console.log('\n── (B) Cafe24 /pages/view 프로모션 URL (최근30일) ──');
  try{
    const rows = await c.caPaginate('/pages/view', { start_date:START, end_date:end, device_type:'total' }, 'view', { limit:1000, maxPages:5 });
    const promo = rows.filter(r=>/event|promotion|exhibition|benefit|coupon|/.test(String(r.url))).slice(0,0);
    const top = rows.sort((a,b)=>(+b.visit_count)-(+a.visit_count)).slice(0,12);
    console.log(`  전체 URL ${rows.length}개. 방문 상위:`);
    top.forEach(r=>console.log(`     ${String(r.url).slice(0,55)}  방문 ${r.visit_count} PV ${r.count}`));
    const ev = rows.filter(r=>/event|promotion|exhibition|benefit/i.test(String(r.url)));
    console.log(`  event/promotion URL 매칭: ${ev.length}개 ${ev.slice(0,5).map(r=>String(r.url).slice(0,40)+'('+r.visit_count+')').join(' | ')}`);
  }catch(e){ console.log('  ❌ /pages/view:', e.status, String(e.message).slice(0,90)); }

  // (C) 최근 프로모션 쿠폰의 coupon_direct_url (페이지 매핑 단서)
  console.log('\n── (C) 최근 쿠폰 coupon_direct_url ──');
  const coupons = await c.adminPaginate('/coupons', { shop_no:1 }, 'coupons', { limit:100, maxPages:2 });
  const recent = coupons.filter(x=>x.deleted!=='T').sort((a,b)=>new Date(b.created_date)-new Date(a.created_date)).slice(0,6);
  recent.forEach(x=>console.log(`  "${(x.coupon_name||'').slice(0,30)}" direct_url=${x.coupon_direct_url||'(없음)'}`));

  await c.close();
  console.log('\n=== 완료 ===');
})().catch(e=>{console.error(e);process.exit(1);});
