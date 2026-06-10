'use strict';
// 7차: 상품→카테고리 매핑 방법 확정
const c = require('../lib/cafe24');
const keys=(o)=>o&&typeof o==='object'?Object.keys(o):[];

(async()=>{
  console.log('\n=== 상품→카테고리 매핑 프로빙 ===\n');

  // 1) /products 가 category 를 포함하나?
  const p = await c.adminGet('/products', { shop_no:1, limit:2 });
  const prod = p.products?.[0];
  console.log('상품 필드에 category 포함?', 'category' in (prod||{}), '| price?', 'price' in (prod||{}));
  if (prod && prod.category) console.log('  category 샘플:', JSON.stringify(prod.category).slice(0,200));
  console.log('  상품 필드:', keys(prod).slice(0,30).join(', '));

  // 2) embed=category 로 더 풍부?
  try{
    const p2 = await c.adminGet('/products', { shop_no:1, limit:2, embed:'categories' });
    const pr2 = p2.products?.[0];
    if (pr2 && pr2.categories) console.log('\nembed=categories →', JSON.stringify(pr2.categories).slice(0,250));
    else console.log('\nembed=categories: categories 키 없음. 키:', keys(pr2).filter(k=>/cat/i.test(k)).join(','));
  }catch(e){ console.log('embed=categories ❌', e.status, String(e.message).slice(0,80)); }

  // 3) /products?category=NN 필터
  for(const cat of [668,670,671,530]){
    try{ const j=await c.adminGet('/products',{shop_no:1,limit:5,category:cat});
      const a=j.products||[]; console.log(`  /products?category=${cat} → ${a.length}행 샘플: ${a.slice(0,5).map(x=>x.product_no+':'+(x.product_name||'').slice(0,12)).join(' | ')}`);
    }catch(e){ console.log(`  /products?category=${cat} ❌ ${e.status} ${String(e.message).slice(0,70)}`); }
  }

  // 4) /categories/{no}/products 다른 카테고리로 재시도
  for(const cat of [668,670,671]){
    try{ const j=await c.adminGet(`/categories/${cat}/products`,{shop_no:1,limit:5});
      const a=j.products||[]; console.log(`  /categories/${cat}/products → ${a.length}행, 필드 ${keys(a[0]).slice(0,8).join(',')}`);
    }catch(e){ console.log(`  /categories/${cat}/products ❌ ${e.status} ${String(e.message).slice(0,70)}`); }
  }

  await c.close();
  console.log('\n=== 완료 ===');
})().catch(e=>{console.error(e);process.exit(1);});
