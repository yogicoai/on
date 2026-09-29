'use strict';

/**
 * [일회성] MD가 전달한 퍼널 HTML 안의 하드코딩 데이터를 DB로 옮긴다.
 *   자사몰_스마트스토어_일일퍼널점검.html 의 <script id="db"> 안에
 *   mall 603일(2025-01-01~2026-08-26) · ss 235일 이 들어 있다. 버리면 과거 퍼널이 통째로 사라진다.
 *
 *   저장 대상은 **우리가 못 얻는 것만**이다.
 *     mall → 상품조회 · 장바구니조회 · 주문서작성 (+ 이프두 방문시작·주문완료는 대조용으로 보관)
 *     ss   → 주문건수 (+ 유입수·매출은 대조용)
 *   방문시작·주문완료·순매출·스토어 유입/매출은 우리 DB가 매일 자동으로 갖고 있으므로 그쪽을 쓴다.
 *
 *   사용법: node scripts/seed-funnel-from-html.js [HTML경로]
 */

const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const funnel = require('../lib/funnelDaily');

const DEFAULT = path.join(__dirname, '..', '자사몰_스마트스토어_일일퍼널점검.html');

(async () => {
  const src = process.argv[2] || DEFAULT;
  if (!fs.existsSync(src)) { console.error('❌ 파일 없음:', src); process.exit(1); }
  const html = fs.readFileSync(src, 'utf8');
  const m = html.match(/<script[^>]*id=["']db["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m) { console.error('❌ <script id="db"> 블록을 찾지 못했습니다.'); process.exit(1); }
  const DB = JSON.parse(m[1]);

  // mall: [일자, 방문시작, 상품조회, 장바구니조회, 주문서작성, 주문완료]
  const mallRows = (DB.mall || []).map((r) => ({
    date: r[0],
    상품조회: Number(r[2]) || 0,
    장바구니조회: Number(r[3]) || 0,
    주문서작성: Number(r[4]) || 0,
    이프두_방문시작: Number(r[1]) || 0,   // 대조용 — 계산에는 쓰지 않는다
    이프두_주문완료: Number(r[5]) || 0,
  }));
  // ss: [일자, 유입수, 주문건수, 구매율, 매출]
  const ssRows = (DB.ss || []).map((r) => ({
    date: r[0],
    주문건수: Number(r[2]) || 0,
    파일_유입수: Number(r[1]) || 0,
    파일_매출: Number(r[4]) || 0,
  }));

  console.log(`소스: ${path.basename(src)}`);
  console.log(`  자사몰 퍼널 ${mallRows.length}일 (${mallRows[0] && mallRows[0].date} ~ ${mallRows[mallRows.length - 1] && mallRows[mallRows.length - 1].date})`);
  console.log(`  스마트스토어 ${ssRows.length}일 (${ssRows[0] && ssRows[0].date} ~ ${ssRows[ssRows.length - 1] && ssRows[ssRows.length - 1].date})`);

  const a = await funnel.saveRows('mall', mallRows, 'MD 전달 HTML(초기 적재)');
  const b = await funnel.saveRows('store', ssRows, 'MD 전달 HTML(초기 적재)');
  console.log(`\n✅ 적재 — 자사몰 ${a.saved}일 · 스토어 ${b.saved}일`);

  // 이프두 방문시작 vs 우리 traffic_daily 대조 요약(정의 차이를 처음부터 드러낸다)
  const td = await store.collection('traffic_daily');
  const t = await td.find({}, { projection: { _id: 0, date: 1, visits: 1 } }).toArray();
  const T = new Map(t.map((x) => [x.date, x.visits]));
  let si = 0, so = 0, n = 0;
  for (const r of mallRows) { const v = T.get(r.date); if (v > 0 && r.이프두_방문시작 > 0) { si += r.이프두_방문시작; so += v; n++; } }
  if (n) console.log(`\n대조 — 이프두 방문시작 vs traffic_daily.visits: ${n}일 · 합계 ${si.toLocaleString()} vs ${so.toLocaleString()} (${(si / so).toFixed(3)}배)`);

  console.log('\n현황:', JSON.stringify(await funnel.status(), null, 1));
  await store.close();
  setTimeout(() => process.exit(0), 150);
})().catch((e) => { console.error('💥', e.message); process.exit(1); });
