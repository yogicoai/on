'use strict';
// 스마트스토어(네이버 커머스) 연결 점검 — 자격증명(.env) 입력 후 실행
//   node scripts/probe-smartstore.js
const ss = require('../lib/smartstore');
const ingest = require('../lib/smartstoreIngest');
const store = require('../lib/store');

function pad(n){return String(n).padStart(2,'0');}
function iso(d){return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00.000+09:00`;}

(async () => {
  console.log('\n=== 스마트스토어(네이버 커머스) 연결 점검 ===\n');
  if (!ss.enabled()) {
    console.log('⚠️  자격증명 미설정. .env에 NAVER_COMMERCE_CLIENT_ID / NAVER_COMMERCE_CLIENT_SECRET 입력 후 다시 실행하세요.');
    console.log('   (커머스 API 센터 https://apicenter.commerce.naver.com → 애플리케이션 등록 → 발급)');
    process.exit(0);
  }

  // 1) 토큰
  try { const t = await ss.getToken(); console.log('✅ 토큰 발급 OK (len=' + t.length + ')'); }
  catch (e) { console.log('❌ 토큰 실패:', e.message); process.exit(1); }

  // 2) 최근 2시간 변경상품주문 (소량)
  const now = new Date(); const from = new Date(now.getTime() - 2 * 3600 * 1000);
  try {
    const j = await ss.apiGet('/external/v1/pay-order/seller/product-orders/last-changed-statuses',
      { lastChangedFrom: iso(from), lastChangedTo: iso(now) });
    const data = j.data || j;
    const list = data.lastChangeStatuses || data.lastChangedStatuses || [];
    console.log(`✅ 변경상품주문(최근2h): ${list.length}건`);
    if (list[0]) console.log('   샘플 키:', Object.keys(list[0]).join(', '));
    const ids = list.slice(0, 3).map((x) => x.productOrderId).filter(Boolean);

    // 3) 상세 조회
    if (ids.length) {
      const d = await ss.apiPost('/external/v1/pay-order/seller/product-orders/query', { productOrderIds: ids });
      const arr = (d.data && (Array.isArray(d.data) ? d.data : d.data.productOrders)) || [];
      console.log(`✅ 상세 조회: ${arr.length}건`);
      if (arr[0]) {
        console.log('   상세 최상위 키:', Object.keys(arr[0]).join(', '));
        console.log('   productOrder 키:', Object.keys(arr[0].productOrder || {}).join(', '));
        console.log('   정규화 결과:', JSON.stringify(ingest.normalize(arr[0])).replace(/"raw":\{.*?\}\},/, '"raw":<omit>,').slice(0, 400));
      }
    } else {
      console.log('   (최근 2시간 주문 없음 — 기간을 늘려 syncMonth로 수집 테스트하세요)');
    }
  } catch (e) { console.log('❌ 주문 조회 실패:', e.status || '', e.message); }

  await store.close();
  console.log('\n=== 완료 ===');
})().catch((e) => { console.error(e); process.exit(1); });
