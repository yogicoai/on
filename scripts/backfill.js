'use strict';

/**
 * 과거 구간 백필 — 월 단위로 주문 적재(재실행 안전: order_id upsert).
 *   사용:
 *     node scripts/backfill.js 2024 cafe24
 *     node scripts/backfill.js 2024 smartstore
 *     node scripts/backfill.js 2024 both
 *   끝 연도(여러 해)도 가능: node scripts/backfill.js 2024-2024 both
 *
 *   채널별로 "월 순차" 적재(같은 API 동시호출 줄여 레이트리밋 회피). 두 채널을 병렬로 돌리려면
 *   cafe24 / smartstore 를 각각 별도 프로세스로 실행.
 */

const ingest = require('../lib/ingest');
const ssi = require('../lib/smartstoreIngest');

function pad(n) { return String(n).padStart(2, '0'); }

function monthsOf(yearFrom, yearTo) {
  const out = [];
  for (let y = yearFrom; y <= yearTo; y++) {
    for (let m = 1; m <= 12; m++) {
      const start = `${y}-${pad(m)}-01`;
      const last = new Date(y, m, 0).getDate();
      out.push([start, `${y}-${pad(m)}-${pad(last)}`]);
    }
  }
  return out;
}

(async () => {
  const yearArg = String(process.argv[2] || '2024');
  const channel = String(process.argv[3] || 'both');
  const [yf, yt] = yearArg.includes('-') ? yearArg.split('-').map(Number) : [Number(yearArg), Number(yearArg)];
  const months = monthsOf(yf, yt);

  let cafeTotal = 0, ssTotal = 0, fails = 0;
  console.log(`[backfill] ${yf}~${yt} · channel=${channel} · ${months.length}개월 시작`);
  for (const [s, e] of months) {
    if (channel === 'cafe24' || channel === 'both') {
      const t = Date.now();
      try { const r = await ingest.syncRange(s, e); const n = (r && (r.upserts != null ? r.upserts : r.count)) || 0; cafeTotal += Number(n) || 0; console.log(`  ✓ CAFE24 ${s}~${e} ${((Date.now() - t) / 1000).toFixed(1)}s · ${n}건`); }
      catch (err) { fails++; console.log(`  ✗ CAFE24 ${s}~${e} 실패: ${err.message}`); }
    }
    if (channel === 'smartstore' || channel === 'both') {
      const t = Date.now();
      try { const r = await ssi.syncRange(s, e); const n = (r && (r.stored != null ? r.stored : r.changed)) || 0; ssTotal += Number(n) || 0; console.log(`  ✓ SMARTSTORE ${s}~${e} ${((Date.now() - t) / 1000).toFixed(1)}s · ${n}건`); }
      catch (err) { fails++; console.log(`  ✗ SMARTSTORE ${s}~${e} 실패: ${err.message}`); }
    }
  }
  console.log(`[backfill] 완료 — Cafe24 ${cafeTotal}건, SmartStore ${ssTotal}건, 실패 ${fails}개월`);
  process.exit(fails && !(cafeTotal || ssTotal) ? 1 : 0);
})();
