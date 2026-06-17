'use strict';
// 어제(2026-06-16) 스마트스토어 매출 비교: 이카운트(on.orders) vs 네이버 직수집(smartstore_orders)
//   왜 다른지 — 매출정의/날짜기준/상태필터/적재시점 차이를 드러낸다.
const { loadEnv } = require('./lib/env');
loadEnv();
const store = require('./lib/store');
const DAY = '2026-06-16';
const PAID = ['PAYED', 'DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED', 'EXCHANGED'];
const won = (n) => '₩' + Math.round(n || 0).toLocaleString('en-US');

(async () => {
  try {
    const ec = await store.namedCollection('on', 'orders');
    const ss = await store.collection('smartstore_orders');

    // 0) 이카운트 스키마/스토어명/적재 커버리지
    const sample = await ec.findOne({ store: /스마트|스토어/ });
    console.log('=== 이카운트(on.orders) 샘플 필드 ===');
    console.log(sample ? Object.keys(sample).join(', ') : '(스마트 관련 문서 없음)');
    if (sample) console.log('sample:', JSON.stringify({ store: sample.store, date: sample.date, productName: sample.productName, qty: sample.qty, amount: sample.amount, supplyAmount: sample.supplyAmount, vat: sample.vat }));
    const stores = await ec.distinct('store', { store: /스마트|스토어|네이버/ });
    console.log('스마트 관련 store명:', JSON.stringify(stores));
    const ecMax = await ec.find({ date: { $nin: ['', '-', '날짜오류'] } }).sort({ date: -1 }).limit(1).toArray();
    console.log('이카운트 최신 적재일:', (ecMax[0] || {}).date || '(없음)');

    // 1) 이카운트 어제 스마트스토어 합계
    const ecAgg = await ec.aggregate([
      { $match: { store: '스마트스토어', date: DAY } },
      { $group: { _id: null, amount: { $sum: '$amount' }, qty: { $sum: '$qty' }, lines: { $sum: 1 } } },
    ]).toArray();
    const E = ecAgg[0] || { amount: 0, qty: 0, lines: 0 };

    // 2) 네이버 직수집 어제 — 상태별 + PAID합 + 전체합
    const ssRows = await ss.find({ order_date: DAY }, { projection: { status: 1, payment_amount: 1, quantity: 1, canceled: 1, order_id: 1 } }).toArray();
    const byStatus = {}; let paidAmt = 0, paidQty = 0, paidLines = 0, allAmt = 0; const paidOrders = new Set();
    for (const o of ssRows) {
      const st = o.status || '(none)';
      const g = (byStatus[st] = byStatus[st] || { lines: 0, amt: 0 });
      g.lines++; g.amt += +o.payment_amount || 0; allAmt += +o.payment_amount || 0;
      if (PAID.includes(st) && o.canceled !== true) { paidAmt += +o.payment_amount || 0; paidQty += +o.quantity || 0; paidLines++; paidOrders.add(o.order_id); }
    }

    console.log('\n=== 어제(' + DAY + ') 스마트스토어 매출 비교 ===');
    console.log('이카운트  store=스마트스토어 : ' + won(E.amount) + '  (수량 ' + E.qty + ', 라인 ' + E.lines + ')');
    console.log('네이버직수집 PAID합        : ' + won(paidAmt) + '  (수량 ' + paidQty + ', 라인 ' + paidLines + ', 주문 ' + paidOrders.size + ')');
    console.log('네이버직수집 전체(상태무관) : ' + won(allAmt) + '  (라인 ' + ssRows.length + ')');
    console.log('차이(이카운트 - 네이버PAID): ' + won(E.amount - paidAmt));
    console.log('\n네이버 상태별 분해:');
    Object.entries(byStatus).sort((a, b) => b[1].amt - a[1].amt).forEach(([st, g]) => console.log('  ' + st.padEnd(18) + ' ' + won(g.amt).padStart(14) + '  (라인 ' + g.lines + ')'));
  } catch (e) { console.error('ERR', e.message); }
  setTimeout(() => process.exit(0), 150);
})();
