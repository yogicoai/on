'use strict';
// 9차: 상품명 [브래킷] 프로모션 태그 + 기간할인(additional_discount_price) 캡처 가능성
const c = require('../lib/cafe24');
const store = require('../lib/store');

const won = (n) => Number(n || 0).toLocaleString('ko-KR');

(async () => {
  console.log('\n=== [브래킷] 프로모션 태그 + 기간할인 ===\n');

  // (A) orders_raw 상품명에서 선두 [태그] 추출·집계
  const coll = await store.collection('orders_raw');
  const tagMap = {}; let withTag = 0, totalItems = 0;
  const cursor = coll.find({ paid: true, canceled: false }, { projection: { items: 1, member_id: 1 } });
  for await (const o of cursor) {
    for (const it of (o.items || [])) {
      totalItems++;
      const m = String(it.product_name || '').match(/^\s*\[([^\]]+)\]/);
      if (m) {
        withTag++;
        const tag = m[1].trim();
        const t = (tagMap[tag] = tagMap[tag] || { tag, items: 0, qty: 0, sales: 0, buyers: new Set() });
        t.items++; t.qty += +it.quantity || 0; t.sales += +it.payment_amount || 0; t.buyers.add(o.member_id);
      }
    }
  }
  const tags = Object.values(tagMap).map((t) => ({ ...t, buyers: t.buyers.size })).sort((a, b) => b.sales - a.sales);
  console.log(`전체 아이템 ${won(totalItems)} 중 [태그] 보유 ${won(withTag)} (${(withTag / totalItems * 100).toFixed(1)}%) · distinct 태그 ${tags.length}개`);
  console.log('\n[태그]별 매출 TOP 20:');
  tags.slice(0, 20).forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. [${t.tag}]  매출 ${won(t.sales)}  수량 ${won(t.qty)}  고객 ${t.buyers}  (아이템 ${t.items})`));

  // (B) Cafe24 raw 주문 아이템의 할인 필드 (기간할인 = additional_discount_price?)
  console.log('\n── Cafe24 raw 주문 아이템 할인 필드 (최근 주문 샘플) ──');
  const pad = (n) => String(n).padStart(2, '0');
  const t = new Date(); const e = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  const s = new Date(t); s.setDate(s.getDate() - 7);
  const sd = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
  const j = await c.adminGet('/orders', { shop_no: 1, start_date: sd, end_date: e, limit: 30, embed: 'items' });
  let shown = 0;
  for (const o of (j.orders || [])) {
    for (const it of (o.items || [])) {
      const add = +it.additional_discount_price || 0;
      const cpn = +it.coupon_discount_price || 0;
      const app = +it.app_item_discount_amount || 0;
      if (add > 0 || cpn > 0) {
        console.log(`  "${String(it.product_name).slice(0, 34)}" 정가 ${won(it.product_price)} | 기간할인(add) ${won(add)} | 쿠폰 ${won(cpn)} | 앱 ${won(app)} | 결제 ${won(it.payment_amount)}`);
        if (++shown >= 12) break;
      }
    }
    if (shown >= 12) break;
  }

  await c.close(); await store.close();
  console.log('\n=== 완료 ===');
})().catch((e) => { console.error(e); process.exit(1); });
