'use strict';
/** MD 일일매출보고 HTML의 ds-promo(할인율별)에서 과거(2026-06 이전 시작) 프로모션을 promo_history 로 import. */
require('../lib/env').loadEnv();
const fs = require('fs');
const path = require('path');
const ph = require('../lib/promoHistory');
(async () => {
  const file = process.argv[2] || 'Yogibo_온라인 일일매출보고_20260623.html';
  const html = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  const ds = JSON.parse(html.match(/<script id="ds-promo" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const pastPromos = (ds.promos || []).filter((p) => p.Start < ph.MD_CUTOFF);   // 6/1 이전 시작분만
  const pastNames = new Set(pastPromos.map((p) => p.Name));
  const pastProducts = (ds.products || []).filter((x) => pastNames.has(x.Promo));
  console.log(`import 대상: 프로모션 ${pastPromos.length}개 (제외 June ${ds.promos.length - pastPromos.length}개), 상품 ${pastProducts.length}행`);
  const r = await ph.importEntries(pastPromos, pastProducts);
  console.log('완료:', JSON.stringify(r));
  const saved = await ph.listPromos();
  console.log('\n저장된 과거 프로모션:');
  for (const p of saved) console.log(`  ${p.Name} [${p.Start}~${p.End}] ${p.Amount.toLocaleString()} (Ja ${p.JaAmount.toLocaleString()}/Ss ${p.SsAmount.toLocaleString()})`);
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => setTimeout(() => process.exit(0), 300));
