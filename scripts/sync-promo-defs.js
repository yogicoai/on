'use strict';

/**
 * 전사 프로모션 정의 적재 — MD 제출 자료(mcp_promotions.json) → DB. 성과 계산의 유일 기준.
 *   적재: promo_defs(프로모션×몰) · promo_product_map(품목맵) · promo_price_detail(가격) · promo_events(교란요인)
 *   전량 교체(deleteMany→insertMany) — 엑셀/JSON이 유일한 진실이라 DB는 그 거울. 지운 행이 유령으로 남지 않게.
 *   ※ 성과 수치는 저장하지 않는다(소급 변경됨). 정의·맥락만 저장하고 매출은 조회 시 on/off.orders에서 계산.
 *   ※ 기존 mall_promotions(에디터 CRUD)와 물리적으로 다른 컬렉션 — 충돌 없음.
 *
 *   사용법: node scripts/sync-promo-defs.js [JSON경로]
 */

const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const { ingest } = require('../lib/promoIngest');

// 기본 경로는 없앴다(2026-10-15). 예전 기본값(…_MCP 저장용_260917)으로 그냥 돌리면 10/15에 새로 넣은 온라인 행이 9월 자료로 되돌아간다.
//   또 이 스크립트는 전 몰 전량 교체라, 10/15 결정("온라인만 교체, 오프라인은 그대로")과 달리 오프라인 행까지 바꾼다 — 파일을 꼭 확인하고 돌린다.
(async () => {
  const src = process.argv[2];
  if (!src) { console.error('사용법: node scripts/sync-promo-defs.js <mcp_promotions.json 경로>\n   ⚠️ 전 몰(자사몰 · 스마트스토어 · 오프라인) 전량 교체입니다. 직전 상태는 promo_defs_backup 에 남습니다.'); process.exit(1); }
  let data;
  try { data = JSON.parse(fs.readFileSync(src, 'utf8')); }
  catch (e) { console.error('❌ 소스 읽기 실패:', e.message, '\n   경로:', src); process.exit(1); }

  const r = await ingest(data, { source: path.basename(src) });
  if (!r.ok) { console.error('❌ 검증 실패:'); r.errors.forEach((x) => console.error('   -', x)); process.exit(1); }

  console.log('✅ 프로모션 정의 적재 완료');
  console.log(`   프로모션 ${r.counts.promotions}행(고유 promo_id ${r.counts.promoIds}) · 품목맵 ${r.counts.products} · 가격 ${r.counts.priceDetail} · 이벤트 ${r.counts.events}`);
  console.log(`   몰별: ${Object.entries(r.counts.byMall).map(([m, n]) => `${m} ${n}`).join(' · ')}`);
  if (r.warnings.length) { console.log('   ⚠️ 경고:'); r.warnings.forEach((w) => console.log('      -', w)); }
  console.log(`   기준시각 ${r.syncedAt} · 소스 ${src}`);

  await store.close();
  setTimeout(() => process.exit(0), 100);
})().catch((e) => { console.error('💥', e.message); process.exit(1); });
