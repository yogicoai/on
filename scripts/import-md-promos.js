'use strict';
/** MD 일일매출보고 HTML의 ds-promo(할인율별) 성과를 promo_history 로 import (6월 포함 전체).
 *  할인율(10/15/20%) 분류는 Cafe24 어드민 수기 작업이라 우리 데이터로 자동 재현 불가 → MD 정본을 그대로 사용. */
require('../lib/env').loadEnv();
const fs = require('fs');
const path = require('path');
const ph = require('../lib/promoHistory');
(async () => {
  const file = process.argv[2] || 'Yogibo_온라인 일일매출보고_20260623.html';
  const html = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  const ds = JSON.parse(html.match(/<script id="ds-promo" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const allPromos = (ds.promos || []);   // 6월 포함 전체 (MD 정본)
  const names = new Set(allPromos.map((p) => p.Name));
  const allProducts = (ds.products || []).filter((x) => names.has(x.Promo));
  console.log(`import 대상: 프로모션 ${allPromos.length}개 (6월 포함), 상품 ${allProducts.length}행`);
  const r = await ph.importEntries(allPromos, allProducts);
  console.log('완료:', JSON.stringify(r));
  const saved = await ph.listPromos();
  console.log('\n저장된 프로모션:');
  for (const p of saved) console.log(`  ${p.Name} [${p.Start}~${p.End}] ${p.Amount.toLocaleString()} (Ja ${p.JaAmount.toLocaleString()}/Ss ${p.SsAmount.toLocaleString()})`);
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => setTimeout(() => process.exit(0), 300));
