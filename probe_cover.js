'use strict';
const { loadEnv } = require('./lib/env');
loadEnv();
const store = require('./lib/store');
const forecast = require('./lib/forecast');
const https = require('https');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function getJson(host, path) { return new Promise((res, rej) => { https.get('https://' + host + path, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej); }); }

// 커버 기준명: 등급(프리미엄/플러스/스탠다드)·'커버' 토큰 제거 → 기본 제품명
const TIER = new Set(['프리미엄', '플러스', '프리미엄플러스', '스탠다드', '커버', 'premium', 'plus', 'standard']);
const baseName = (name) => norm(name).split(' ').filter((t) => t && !TIER.has(t.toLowerCase())).join(' ');

(async () => {
  try {
    // 1) 코드-브리지 매칭률 검증
    const r = await forecast.reorderPlan({ months: 3, targetMonths: 1 });
    console.log('=== reorderPlan (품목코드 브리지) ===');
    console.log('재고 SKU:', r.count, '| 판매매칭:', r.matchedCount, '(' + (r.matchedCount / r.count * 100).toFixed(1) + '%) | 발주필요:', r.needOrderCount, '| mappingUsed:', r.mappingUsed);

    // 2) 맥스 / 아쿠아 블루 — 등급별 판매 + 커버기준 합산
    const ec = await store.namedCollection('on', 'orders');
    const rows = await ec.aggregate([
      { $match: { date: { $gte: '2026-03-01', $lte: '2026-05-31' }, productName: /맥스/, color: /아쿠아/ } },
      { $group: { _id: { n: '$productName', c: '$color' }, qty: { $sum: '$qty' } } },
    ]).toArray();
    console.log('\n=== "맥스" × "아쿠아" 판매 (3개월 합, 전체몰) ===');
    const coverAgg = {};
    rows.forEach((x) => {
      const bk = baseName(x._id.n) + ' / ' + norm(x._id.c);
      coverAgg[bk] = (coverAgg[bk] || 0) + x.qty;
      console.log('  ' + (x._id.n + ' / ' + x._id.c).padEnd(34) + ' qty=' + x.qty + '  → 커버기준[' + bk + ']');
    });
    console.log('\n커버 기준 합산:');
    Object.entries(coverAgg).forEach(([k, v]) => console.log('  ' + k.padEnd(24) + ' 3개월 ' + v + '개 · 월평균 ' + (v / 3).toFixed(1)));

    // 3) 재고에 있는 '맥스 커버' 색상들
    let stock = await getJson('port-0-realtime-lzgmwhc4d9883c97.sel4.cloudtype.app', '/api/stock/' + encodeURIComponent('커버'));
    const maxCovers = (Array.isArray(stock) ? stock : []).filter((s) => /맥스/.test(s.name) && !/줄라|롤/.test(s.name));
    console.log('\n=== 재고 "맥스 커버" (커버 카테고리) ===');
    maxCovers.slice(0, 12).forEach((s) => console.log('  ' + s.code + ' | ' + s.name + ' / ' + s.spec + ' 재고' + s.qty + '  → 기준[' + baseName(s.name) + ' / ' + norm(s.spec) + ']'));
  } catch (e) { console.error('ERR', e.message); }
  setTimeout(() => process.exit(0), 200);
})();
