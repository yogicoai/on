'use strict';

/**
 * 정상가 추출 — Cafe24 주문 이력에서 품목별 "정상가(할인 안 된 최고 단가)"를 뽑아 product_prices 에 적재.
 *   정상가 불변 전제. 신상품이 생기면 가끔 다시 돌리면 됨.
 *
 *   사용: node scripts/derive-prices.js [시작일(기본 2024-01-01)]
 *   예:   node scripts/derive-prices.js 2024-01-01
 */

const pp = require('../lib/productPrices');
const store = require('../lib/store');

(async () => {
  const from = process.argv[2] || '2024-01-01';
  console.log(`\n정상가 추출: ${from} 이후 Cafe24 주문 기준 (품목별 최고 실판매단가 ≈ 정상가)\n`);
  const r = await pp.deriveFromOrders(from);
  console.log(`✅ ${r.추출품목}개 품목 정상가 추출 → product_prices 적재 ${r.upserted}건`);
  console.log('   → 이제 MCP discount_analysis 도구로 "정상가 대비 할인율"이 분석됩니다.');
  console.log('   ※ 특정 품목 정상가가 틀리면 product_prices 에서 그 항목만 수정/덮어쓰면 됨.\n');
  await store.close();
  setTimeout(() => process.exit(0), 150);
})().catch((e) => { console.error('💥', e.message); process.exit(1); });
