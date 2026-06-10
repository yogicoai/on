'use strict';
// 11차: EPP/충전재가 상품명 vs 옵션(option_value) 어디에 있나
const c = require('../lib/cafe24');
const store = require('../lib/store');

(async () => {
  console.log('\n=== EPP/충전재 위치 확인 ===\n');

  // (A) orders_raw 상품명에 EPP/프리미엄 분포
  const coll = await store.collection('orders_raw');
  const names = {};
  const cur = coll.find({ paid: true, canceled: false }, { projection: { items: 1 } });
  let eppName = 0, premName = 0;
  for await (const o of cur) for (const it of (o.items || [])) {
    const n = it.product_name || '';
    if (/EPP/i.test(n)) eppName++;
    if (/프리미엄/.test(n)) { premName++; names[n] = (names[n] || 0) + 1; }
  }
  console.log(`상품명에 'EPP' 포함 아이템: ${eppName} · '프리미엄' 포함: ${premName}`);
  console.log('프리미엄 상품명 샘플(상위 12):');
  Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([n, c]) => console.log(`  ${c}회  ${n}`));

  // (B) Cafe24 raw 주문 아이템 옵션에 충전재/EPP 있나
  console.log('\n── Cafe24 raw 아이템 옵션(option_value) ──');
  const pad = (x) => String(x).padStart(2, '0'); const t = new Date(); const e = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  const s = new Date(t); s.setDate(s.getDate() - 20); const sd = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
  const j = await c.adminGet('/orders', { shop_no: 1, start_date: sd, end_date: e, limit: 60, embed: 'items' });
  let shown = 0; const optSamples = {};
  for (const o of (j.orders || [])) for (const it of (o.items || [])) {
    const ov = it.option_value || ''; const av = it.additional_option_value || '';
    if (/프리미엄|EPP|비즈|충전/i.test(String(it.product_name) + ' ' + ov + ' ' + av)) {
      if (shown < 14) { console.log(`  "${String(it.product_name).slice(0, 30)}" | option_value="${ov}" | add_opt="${av}"`); shown++; }
    }
    if (ov) optSamples[ov] = (optSamples[ov] || 0) + 1;
  }
  console.log('\n option_value 분포(상위 12):');
  Object.entries(optSamples).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([v, c]) => console.log(`  ${c}회  "${v}"`));

  await c.close(); await store.close();
  console.log('\n=== 완료 ===');
})().catch((e) => { console.error(e); process.exit(1); });
