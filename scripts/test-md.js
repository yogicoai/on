'use strict';
// MD 데이터 통합 테스트: 백필 → 카탈로그 → 프로모션 구매고객 → 세그먼트
const c = require('../lib/cafe24');
const store = require('../lib/store');
const ingest = require('../lib/ingest');
const catalog = require('../lib/catalog');
const promotions = require('../lib/promotions');
const segments = require('../lib/segments');

const MONTHS = Number(process.argv[2] || 3);
const won = (n) => Number(n || 0).toLocaleString('ko-KR');
const pct = (n) => (n * 100).toFixed(1) + '%';
function pad(n){return String(n).padStart(2,'0');}
function dstr(d){return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;}
const today = new Date(); const yest = new Date(today); yest.setDate(yest.getDate()-1);
const promoStart = new Date(today); promoStart.setDate(promoStart.getDate()-30);
const PSTART = dstr(promoStart), PEND = dstr(yest);

function maskPhone(p){ if(!p)return''; const s=String(p); return s.length<6?'***':s.slice(0,3)+'****'+s.slice(-2); }
function maskName(n){ if(!n)return''; const s=String(n); return s.length<=1?s+'*':s[0]+'*'+(s.length>2?s.slice(-1):''); }

(async () => {
  console.log(`\n===== MD 데이터 테스트 (백필 ${MONTHS}개월) =====`);

  console.time('① 주문 백필');
  const meta = await ingest.syncOrders(MONTHS, { onProgress: (p) => process.stdout.write(`\r  적재 ${p.chunk}/${p.chunks} (${p.range[0]}~${p.range[1]}) 누적 ${won(p.total)}건   `) });
  console.log('');
  console.timeEnd('① 주문 백필');
  console.log(`  → orders_raw ${won(meta.count)}건 (${meta.from}~${meta.to})`);

  console.time('② 카탈로그(상품그룹)');
  const groups = await catalog.resolveGroupSets({ force: true });
  console.timeEnd('② 카탈로그(상품그룹)');
  console.log('  그룹 상품수:', JSON.stringify(groups.counts));

  console.time('③ 프로모션 구매고객');
  const perf = await promotions.couponPerformance(PSTART, PEND);
  console.timeEnd('③ 프로모션 구매고객');
  console.log(`  기간 ${PSTART}~${PEND} | 활성쿠폰 ${perf.coupons.length}개 | 다운로드 ${won(perf.totals.downloaded)}명 → 구매 ${won(perf.totals.purchased)}명 (${pct(perf.totals.purchaseRate)}) | 매출 ${won(perf.totals.revenue)} | 신규 ${perf.totals.newBuyers}/기존 ${perf.totals.returningBuyers}`);
  perf.coupons.slice(0, 6).forEach((cp, i) => console.log(`    ${i+1}. ${cp.coupon_name.slice(0,34)} [${cp.target.label}/${cp.benefit.text}]  다운 ${won(cp.downloaded)}→구매 ${won(cp.purchased)}(${pct(cp.purchaseRate)}) 매출 ${won(cp.revenue)} 신규${cp.newBuyers} 상품${cp.productCount}종`));

  // ④ 상위 쿠폰의 구매 고객 명단(PII)
  const top = perf.coupons.find((cp) => cp.purchased > 0);
  if (top) {
    console.time('④ 구매고객 명단(PII)');
    const buyers = await promotions.couponBuyers(top.coupon_no, PSTART, PEND);
    console.timeEnd('④ 구매고객 명단(PII)');
    console.log(`  "${top.coupon_name.slice(0,30)}" 구매고객 ${buyers.count}명 (PII 마스킹 샘플):`);
    buyers.rows.slice(0, 5).forEach((r) => console.log(`    · ${maskName(r.name)} ${maskPhone(r.cellphone)} 가입 ${r.created_date}(${r.tenureMonths}개월) 등급${r.group_no} [${r.segment}] ${won(r.amount)} 상품:${(r.products[0]||'')}`));
  }

  // ⑤ 커버 세그먼트
  console.time('⑤ 커버 세그먼트');
  const coverAll = await segments.segmentByGroup('커버', { mode: 'bought', withPII: false });
  const coverOnly = await segments.segmentByGroup('커버', { mode: 'only', withPII: false });
  const cover3m = await segments.segmentByGroup('커버', { mode: 'bought', tenureMonths: 3, withPII: true });
  console.timeEnd('⑤ 커버 세그먼트');
  console.log(`  커버 구매 고객: ${won(coverAll.count)}명 | 커버만 구매: ${won(coverOnly.count)}명 | 커버구매+가입3개월↑: ${won(cover3m.count)}명`);
  cover3m.rows.slice(0, 5).forEach((r) => console.log(`    · ${maskName(r.name)} ${maskPhone(r.cellphone)} 가입 ${r.created_date}(${r.tenureMonths}개월) 주문${r.orders} ${won(r.spend)} 상품:${(r.products[0]||'')}`));

  await c.close(); await store.close();
  console.log('\n===== 완료 =====');
})().catch((e) => { console.error('오류:', e); process.exit(1); });
