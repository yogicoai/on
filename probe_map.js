'use strict';
// 매핑 다리 검증: MAPPING(Cafe24↔이카운트) 의 ecount_code/name/spec 이
//   ① 재고(realtime) 품목코드와 일치하는가  ② on.orders(이카운트 판매) productName/color와 일치하는가
const { loadEnv } = require('./lib/env');
loadEnv();
const store = require('./lib/store');
const https = require('https');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function getJson(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://' + host + path, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('parse ' + r.statusCode + ' ' + b.slice(0, 80))); } }); });
    req.on('error', reject); req.setTimeout(25000, () => req.destroy(new Error('timeout')));
  });
}
const OFF = 'port-0-offorder-lzgmwhc4d9883c97.sel4.cloudtype.app';
const RT = 'port-0-realtime-lzgmwhc4d9883c97.sel4.cloudtype.app';

(async () => {
  try {
    const m = await getJson(OFF, '/api/admin/mapping-check?t=1');
    const rows = (m && m.data) || [];
    console.log('매핑 success=' + (m && m.success) + ' rows=' + rows.length + ' summary=' + JSON.stringify(m && m.summary));
    console.log('\n샘플 5행:');
    rows.slice(0, 5).forEach((r) => console.log('  ' + JSON.stringify({ c24: r.cafe24_name, c24opt: r.cafe24_spec, code: r.ecount_code, ecn: r.ecount_name, ecs: r.ecount_spec, st: r.status })));

    // 재고
    const stock = await getJson(RT, '/api/stock/' + encodeURIComponent('전체'));
    const stockCodes = new Set((Array.isArray(stock) ? stock : []).map((s) => String(s.code || '').trim()).filter(Boolean));
    console.log('\n재고 품목코드 수:', stockCodes.size, '| 예시:', [...stockCodes].slice(0, 4));

    // ① ecount_code ∩ 재고 code
    const mapCodes = [...new Set(rows.map((r) => String(r.ecount_code || '').trim()).filter(Boolean))];
    const codeHit = mapCodes.filter((c) => stockCodes.has(c)).length;
    console.log('\n① 매핑 ecount_code 종류:', mapCodes.length, '| 재고코드와 일치:', codeHit, '(' + (codeHit / mapCodes.length * 100).toFixed(1) + '%)');
    console.log('   매핑 코드 예시:', mapCodes.slice(0, 4));

    // on.orders 판매 (productName,color) 키 집합 (최근 3개월)
    const ec = await store.namedCollection('on', 'orders');
    const oRows = await ec.aggregate([
      { $match: { date: { $gte: '2026-03-01', $lte: '2026-05-31' }, productName: { $nin: [null, ''] } } },
      { $group: { _id: { n: '$productName', c: '$color' }, qty: { $sum: '$qty' } } },
    ]).toArray();
    const ordKeys = new Set(oRows.map((r) => norm(r._id.n) + '|' + norm(r._id.c)));
    console.log('\non.orders 판매 SKU(name|color):', ordKeys.size);

    // ★ parseProduct 와 동일하게 ' / English' 잘라내기
    const strip = (s) => String(s || '').split('/')[0].trim();
    // ② (정규화) 매핑 strip(ecount_name|spec) ∩ on.orders
    const mapByName = {};
    rows.forEach((r) => { const k = norm(strip(r.ecount_name)) + '|' + norm(strip(r.ecount_spec)); if (r.ecount_code) mapByName[k] = String(r.ecount_code).trim(); });
    const mapNameKeys = Object.keys(mapByName);
    const nameHit = mapNameKeys.filter((k) => ordKeys.has(k)).length;
    console.log('② (slash-strip 정규화) 매핑 키:', mapNameKeys.length, '| on.orders와 일치:', nameHit, '(' + (nameHit / mapNameKeys.length * 100).toFixed(1) + '%)');

    // ★ 핵심: on.orders 판매 SKU → 품목코드 태깅률 + 재고 연결률 (판매량 가중)
    let taggable = 0, taggableAndInStock = 0;
    let qTot = 0, qTagged = 0, qInStock = 0;
    for (const r of oRows) {
      const k = norm(r._id.n) + '|' + norm(r._id.c);
      const q = Math.max(0, r.qty || 0); qTot += q;
      if (mapByName[k]) { taggable++; qTagged += q; if (stockCodes.has(mapByName[k])) { taggableAndInStock++; qInStock += q; } }
    }
    console.log('\n★ on.orders SKU → 품목코드 태깅:', taggable, '/', ordKeys.size, '(' + (taggable / ordKeys.size * 100).toFixed(1) + '%)');
    console.log('★ 판매수량 가중 태깅률:', (qTagged / qTot * 100).toFixed(1) + '% · 재고까지 연결:', (qInStock / qTot * 100).toFixed(1) + '%');
    // 미태깅 상위(판매 많은데 코드 못붙인 것)
    const untagged = oRows.filter((r) => !mapByName[norm(r._id.n) + '|' + norm(r._id.c)]).sort((a, b) => b.qty - a.qty).slice(0, 12);
    console.log('\n미태깅 상위(판매량순):'); untagged.forEach((r) => console.log('  ' + r._id.n + ' / ' + r._id.c + '  qty=' + r.qty));
  } catch (e) { console.error('ERR', e.message); }
  setTimeout(() => process.exit(0), 200);
})();
