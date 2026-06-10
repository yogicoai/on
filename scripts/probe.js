'use strict';

/**
 * 라이브 Cafe24 API 프로빙 — 빌드 전에 실제 엔드포인트/필드를 검증.
 * 토큰/프로덕션에 영향 없음(읽기 전용, refresh 안 함).
 *
 * 실행: npm run probe
 */

const c = require('../lib/cafe24');

function pad(n) { return String(n).padStart(2, '0'); }
function dstr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

const today = new Date();
const end = new Date(today); end.setDate(end.getDate() - 1);          // 어제
const start = new Date(today); start.setDate(start.getDate() - 8);    // 8일 전
const START = dstr(start), END = dstr(end);

function keysOf(obj) { return obj && typeof obj === 'object' ? Object.keys(obj) : []; }
function firstRow(j) {
  if (!j || typeof j !== 'object') return null;
  for (const k of Object.keys(j)) {
    if (Array.isArray(j[k]) && j[k].length) return { key: k, row: j[k][0], len: j[k].length };
  }
  return null;
}

async function probeCA(endpoint, params) {
  try {
    const j = await c.caGet(endpoint, { start_date: START, end_date: END, device_type: 'total', limit: 5, ...(params || {}) });
    const fr = firstRow(j);
    const topKeys = keysOf(j);
    if (fr) {
      console.log(`  ✅ ${endpoint}  →  [${fr.key}] ${fr.len}행, 필드: ${keysOf(fr.row).join(', ')}`);
    } else {
      console.log(`  ⚠️  ${endpoint}  →  200 but no array. topKeys: ${topKeys.join(', ')} | ${JSON.stringify(j).slice(0, 160)}`);
    }
  } catch (e) {
    console.log(`  ❌ ${endpoint}  →  ${e.status || ''} ${e.message.slice(0, 120)}`);
  }
}

async function probeAdmin(label, endpoint, params) {
  try {
    const j = await c.adminGet(endpoint, params);
    const fr = firstRow(j);
    if (fr) {
      console.log(`  ✅ ${label} (${endpoint}) → [${fr.key}] ${fr.len}행, 필드: ${keysOf(fr.row).join(', ')}`);
      return fr.row;
    }
    console.log(`  ⚠️  ${label} (${endpoint}) → 200, topKeys: ${keysOf(j).join(', ')} | ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  } catch (e) {
    console.log(`  ❌ ${label} (${endpoint}) → ${e.status || ''} ${e.message.slice(0, 140)}`);
    return null;
  }
}

(async () => {
  console.log(`\n=== Cafe24 프로빙 | mall=${c.MALL} | 기간 ${START} ~ ${END} ===\n`);

  // 0) 토큰 확인
  try { const t = await c.readToken(); console.log(`토큰 OK (len=${t.length})\n`); }
  catch (e) { console.log(`토큰 실패: ${e.message}`); process.exit(1); }

  // 1) Analytics API — 전체 방문/유입 후보 엔드포인트
  console.log('── [1] Analytics(통계) API: 전체 방문/유입 엔드포인트 탐색 ──');
  const caCandidates = [
    '/visitors',
    '/visitors/view',
    '/visitors/hourly',
    '/visitors/page',
    '/pages/view',
    '/pages',
    '/visitpaths',
    '/visitpaths/view',
    '/visitpaths/inflow',
    '/visitpaths/searchengines',
    '/visitpaths/keywords',
    '/visitpaths/sites',
    '/visitpaths/adsales',          // mkboard 검증됨
    '/devices',
    '/times/hourly',
    '/sales/orderdetails',          // mkboard 검증됨
    '/sales/orderbasic',
    '/members/visitors',
  ];
  for (const ep of caCandidates) await probeCA(ep);

  // 2) Admin API — 쿠폰 (발급/사용 통계 필드 확인)
  console.log('\n── [2] Admin API: 쿠폰 ──');
  const coupon = await probeAdmin('쿠폰 목록', '/coupons', { shop_no: 1, limit: 3 });
  if (coupon && coupon.coupon_no) {
    console.log(`     첫 쿠폰 전체 필드값 샘플:`);
    console.log('     ' + JSON.stringify(coupon).slice(0, 600));
    // 쿠폰 발급 내역(다운로드/사용)
    await probeAdmin('쿠폰 발급내역', `/coupons/${coupon.coupon_no}/issues`, { shop_no: 1, limit: 3 });
    await probeAdmin('쿠폰 카운트', '/coupons/count', { shop_no: 1 });
  }

  // 3) Admin API — 주문 (회원/비회원 + 쿠폰적용 필드 확인)
  console.log('\n── [3] Admin API: 주문 (회원/비회원·쿠폰적용 필드) ──');
  const order = await probeAdmin('주문 목록', '/orders', {
    shop_no: 1, start_date: START, end_date: END, limit: 3, embed: 'items',
  });
  if (order) {
    const interesting = {};
    for (const k of ['order_id', 'member_id', 'member_authentication', 'membership', 'group_no',
      'payment_amount', 'actual_order_amount', 'order_price_amount', 'coupon_discount_price',
      'members_only', 'first_order', 'coupon']) {
      if (k in order) interesting[k] = order[k];
    }
    console.log('     주문 주요필드: ' + JSON.stringify(interesting).slice(0, 400));
    if (order.items && order.items[0]) {
      console.log('     아이템 필드: ' + keysOf(order.items[0]).join(', '));
    }
  }

  await c.close();
  console.log('\n=== 프로빙 완료 ===');
})().catch((e) => { console.error('치명적 오류:', e); process.exit(1); });
