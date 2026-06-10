'use strict';
// 6차: 카테고리 트리(커버 식별) + 카테고리별 상품 + customersprivacy 회원ID 필터
const c = require('../lib/cafe24');
const keys=(o)=>o&&typeof o==='object'?Object.keys(o):[];

(async()=>{
  console.log('\n=== 카테고리/상품/개인정보 프로빙 ===\n');

  // 1) 카테고리 트리
  const cats = await c.adminPaginate('/categories', { shop_no:1 }, 'categories', { limit:100, maxPages:10 });
  console.log(`전체 카테고리 ${cats.length}개. 필드: ${keys(cats[0]).join(', ')}\n`);
  // '커버/리필/비즈/세트' 등 관심 키워드 매칭
  const kw = /커버|리필|비즈|세트|소파|바디필로우|메이트|롤|쿠션|서포트/;
  const hits = cats.filter(x=> kw.test(x.category_name||'') || kw.test(x.full_category_name||''));
  console.log('관심 카테고리:');
  for(const x of hits.slice(0,40)){
    console.log(`  no=${x.category_no} depth=${x.category_depth||x.depth||'?'} "${x.category_name}"  full="${x.full_category_name||''}"`);
  }

  // 2) '커버' 카테고리의 상품 목록
  const cover = cats.find(x=>/커버/.test(x.category_name||''));
  if (cover){
    console.log(`\n커버 카테고리 후보: no=${cover.category_no} "${cover.category_name}"`);
    try{
      const j = await c.adminGet(`/categories/${cover.category_no}/products`, { shop_no:1, limit:10 });
      const arr = j.products||[];
      console.log(`  /categories/${cover.category_no}/products → ${arr.length}행, 필드: ${keys(arr[0]).join(', ')}`);
      console.log(`  product_no 샘플: ${arr.slice(0,8).map(p=>p.product_no).join(', ')}`);
    }catch(e){ console.log('  ❌ 카테고리 상품:', e.status, String(e.message).slice(0,90)); }
  } else {
    console.log('\n커버 카테고리 자동 매칭 실패 — 트리 확인 필요');
  }

  // 3) customersprivacy 회원ID 필터 (특정 회원 PII 조회용)
  console.log('\n── customersprivacy member_id 필터 ──');
  // 먼저 한 명의 member_id 확보
  const one = await c.adminGet('/customersprivacy', { shop_no:1, limit:1 });
  const mid = one.customersprivacy?.[0]?.member_id;
  console.log('  샘플 member_id:', mid);
  if (mid){
    for(const params of [{member_id:mid},{'member_id':mid, limit:1}]){
      try{ const j=await c.adminGet('/customersprivacy',{shop_no:1,...params});
        const a=j.customersprivacy||[]; console.log(`  [${JSON.stringify(params)}] len=${a.length} 일치=${a[0]?.member_id===mid}`);
      }catch(e){ console.log(`  [${JSON.stringify(params)}] ❌ ${e.status} ${String(e.message).slice(0,70)}`); }
    }
  }
  // 가입일 범위 필터
  try{ const j=await c.adminGet('/customersprivacy',{shop_no:1,limit:2,created_start_date:'2020-01-01',created_end_date:'2025-12-31'});
    console.log('  created 범위필터 len=', (j.customersprivacy||[]).length);
  }catch(e){ console.log('  created 범위필터 ❌', e.status, String(e.message).slice(0,70)); }

  await c.close();
  console.log('\n=== 완료 ===');
})().catch(e=>{console.error(e);process.exit(1);});
