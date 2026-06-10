'use strict';
// 10차: 구매패턴 — 커버 동시구매(attach), 묶음/세트, 주문 구성
const store = require('../lib/store');
const catalog = require('../lib/catalog');
const won = (n) => Number(n || 0).toLocaleString('ko-KR');

(async () => {
  console.log('\n=== 구매패턴 데이터 확인 ===\n');
  const { productGroups } = await catalog.resolveGroupSets();
  const coll = await store.collection('orders_raw');

  const MAIN = new Set(['소파', '바디필로우', '메이트']);
  let total = 0, multi = 0, withSet = 0;
  let mainOrders = 0, mainWithCover = 0, coverOnlyOrders = 0;
  let setItems = 0;
  const cur = coll.find({ paid: true, canceled: false }, { projection: { items: 1, payment_amount: 1 } });
  for await (const o of cur) {
    total++;
    const items = o.items || [];
    const distinctProds = new Set(items.map((i) => String(i.product_no || '')));
    if (distinctProds.size >= 2) multi++;
    const groups = new Set();
    let hasSet = false, allCover = items.length > 0;
    for (const it of items) {
      for (const g of (productGroups[String(it.product_no || '')] || [])) groups.add(g);
      if (/세트|패키지|패키지|set|SET|번들/i.test(it.product_name || '')) { hasSet = true; setItems++; }
      if (!(productGroups[String(it.product_no || '')] || []).includes('커버')) allCover = false;
    }
    if (hasSet) withSet++;
    const hasCover = groups.has('커버');
    const hasMain = [...groups].some((g) => MAIN.has(g));
    if (hasMain) { mainOrders++; if (hasCover) mainWithCover++; }
    if (allCover && items.length) coverOnlyOrders++;
  }

  console.log(`전체 결제주문 ${won(total)}`);
  console.log(`복수상품 주문(2종+): ${won(multi)} (${(multi / total * 100).toFixed(1)}%)`);
  console.log(`'세트/패키지/번들' 상품 포함 주문: ${won(withSet)} (${(withSet / total * 100).toFixed(1)}%) · 해당 아이템 ${won(setItems)}`);
  console.log('');
  console.log(`본품(소파/바디필로우/메이트) 주문: ${won(mainOrders)}`);
  console.log(`  └ 커버 동시구매: ${won(mainWithCover)}  → 커버 attach율 ${(mainWithCover / mainOrders * 100).toFixed(1)}%`);
  console.log(`커버 단독구매 주문: ${won(coverOnlyOrders)}`);

  await store.close();
  console.log('\n=== 완료 ===');
})().catch((e) => { console.error(e); process.exit(1); });
