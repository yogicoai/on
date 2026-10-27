'use strict';

/**
 * CS 도구 — 고객 응대용 조회.
 *   · orderLookup(): 주문번호로 자사몰(Cafe24)+스마트스토어 통합 주문 상태 조회(+송장).
 *   · orderSearch(): 이름·연락처(+기간)로 스마트스토어 주문 + 매장 택배 찾기(+송장). 자사몰은 Cafe24 실시간 조회 몫.
 *   · unanswered(): Cafe24 게시판(Q&A·A/S·1:1·교환/반품) 미답변 글 체크 — 답글(depth1) 없는 원글.
 *   ⚠️ 구매자 이름은 마스킹, 연락처는 끝 4자리만(본인 확인용) 반환.
 */

const store = require('./store');
const c = require('./cafe24');

const R = (n) => Math.round(n || 0);
const mask = (s) => { const t = String(s || '').trim(); return t.length <= 1 ? t : t[0] + '*'.repeat(Math.min(t.length - 1, 3)); };
const strip = (t) => String(t || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const esc = (s) => String(s || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const last4 = (tel) => { const d = String(tel || '').replace(/\D/g, ''); return d.length >= 4 ? d.slice(-4) : ''; };

const SS_STATUS = { PAYED: '결제완료', DELIVERING: '배송중', DELIVERED: '배송완료', PURCHASE_DECIDED: '구매확정', CANCELED: '취소', RETURNED: '반품', CANCELED_BY_NOPAYMENT: '미결제취소', EXCHANGED: '교환' };
// 네이버 택배사 코드 → 이름(목록에 없는 코드는 그대로 보여 준다). 롯데택배는 옛 현대택배 코드 HYUNDAI 로 온다(실제 응답 확인).
const SS_COURIER = { CJGLS: 'CJ대한통운', HANJIN: '한진택배', HYUNDAI: '롯데택배', LOTTE: '롯데택배', EPOST: '우체국택배', LOGEN: '로젠택배', KDEXP: '경동택배', DAESIN: '대신택배', ILYANG: '일양로지스', CHUNIL: '천일택배', CVSNET: 'GS편의점택배', CUPARCEL: 'CU편의점택배' };
const SHIP_STATUS = { SHIPPED: '발송완료', HOLD: '발송보류', OUT_OF_STOCK: '품절대기', EMPTY: '미입력', OTHER: '기타' };

function ssDelivery(o) {
  if (!o.tracking_no) return null;
  return {
    택배사: SS_COURIER[o.courier] || o.courier || '', 송장번호: o.tracking_no,
    발송일: o.send_date || '', 배송완료일: o.delivered_date || '',
  };
}

// 사본이 언제 기준인지 — 스마트스토어는 매시(또는 매일) 동기화본이라 실시간이 아니다.
//   저장값은 UTC(toISOString 문자열 또는 Date)라 KST 로 바꿔 'YYYY-MM-DD HH:mm' 으로 보여 준다.
const asOf = (v) => {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? new Date(t + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '';
};

// 주문번호(부분일치)로 자사몰+스토어 통합 조회
async function orderLookup(orderNo) {
  const q = String(orderNo || '').trim();
  if (q.length < 4) throw new Error('주문번호(최소 4자)가 필요합니다');
  const [caColl, ssColl] = await Promise.all([store.collection('orders_raw'), store.collection('smartstore_orders')]);
  const [ca, ssRows] = await Promise.all([
    caColl.find({ order_id: { $regex: esc(q), $options: 'i' } }).limit(5).toArray(),
    ssColl.find({ $or: [{ order_id: { $regex: esc(q), $options: 'i' } }, { product_order_id: { $regex: esc(q), $options: 'i' } }] }).limit(10).toArray(),
  ]);

  const results = [];
  for (const o of ca) {
    let 배송 = null;
    try {
      const j = await c.adminGet('/orders/' + o.order_id + '/shipments', { shop_no: 1 });
      const sh = (j.shipments || [])[0];
      if (sh) 배송 = { 송장번호: sh.tracking_no || '(미입력)', 택배사코드: sh.shipping_company_code || '', 송장등록일: String(sh.tracking_no_updated_date || '').slice(0, 10) };
    } catch (_) {}
    results.push({
      채널: '자사몰', 주문번호: o.order_id, 주문일: o.order_date,
      상태: o.canceled ? '취소/반품' : (o.paid ? '결제완료' : '미결제'),
      결제금액: R(o.payment_amount), 쿠폰할인: R(o.coupon_discount), 적립금사용: R(o.points_used),
      회원주문: !!o.member_id, 첫구매: o.first_order === 'T',
      상품: (o.items || []).map((i) => `${i.product_name}${i.option_value ? '(' + i.option_value + ')' : ''} x${i.quantity}`).slice(0, 8),
      배송,
    });
  }
  for (const o of ssRows) {
    results.push({
      채널: '스마트스토어', 주문번호: o.order_id, 상품주문번호: o.product_order_id, 주문일: o.order_date,
      상태: SS_STATUS[o.status] || o.status,
      결제금액: R(o.payment_amount),
      상품: [`${o.product_name}${o.option_value ? '(' + o.option_value + ')' : ''} x${o.quantity || 1}`],
      유입경로: o.inflow_path || null,
      배송: ssDelivery(o),
      기준: asOf(o.syncedAt),
    });
  }
  return {
    검색어: q, 건수: results.length, 결과: results,
    ...(results.length ? {} : { 안내: '일치 주문 없음 — 자사몰은 YYYYMMDD-0000000 형식, 스토어는 주문번호/상품주문번호로 검색하세요.' }),
    주의: '구매자 개인정보 미제공. 자사몰 배송은 송장 기준(택배사코드는 Cafe24 코드). 스마트스토어는 동기화 사본(기준 시각 참고).',
  };
}

// 조회 기간 — 기본 최근 30일, 최대 92일(YYYY-MM-DD). 서버가 UTC여도 오늘은 한국 날짜로 본다.
function searchRange(start, end) {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const shift = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  let to = DAY.test(end || '') ? end : today;
  let from = DAY.test(start || '') ? start : shift(to, -30);
  if (from > to) [from, to] = [to, from];
  if (from < shift(to, -92)) from = shift(to, -92);
  return { from, to };
}

// 가려진 이름(정*경)도 맞도록 — 이름 글자마다 '그 글자 또는 *' 로 비교한다.
function nameRegex(name) {
  return new RegExp('^' + [...name].map((ch) => `[${ch.replace(/[\\\]^-]/g, '\\$&')}*]`).join('') + '$');
}

// 이름·연락처(+기간)로 주문 찾기 — 스마트스토어(주문자) + 매장 택배(고객).
//   네이버는 이름·연락처를 가려서 줄 수 있어(정*경, 010-****-5678) 가려진 글자는 아무 글자로 본다.
//   동명이인은 상담원이 연락처 끝 4자리로 본인 확인해 가린다.
async function orderSearch({ name, phone, start, end } = {}) {
  const nm = String(name || '').replace(/\s/g, '');
  const digits = String(phone || '').replace(/\D/g, '');
  if (nm.length < 2 && digits.length < 4) throw new Error('이름(2자 이상)이나 연락처(끝 4자리 이상)가 필요합니다');
  const { from, to } = searchRange(start, end);
  const tail = digits.slice(-4);

  const ssQuery = { order_date: { $gte: from, $lte: to } };
  if (nm.length >= 2) ssQuery.orderer_name = { $regex: nameRegex(nm) };
  if (tail) ssQuery.orderer_tel = { $regex: `${tail}$` };
  const offQuery = { $or: [{ ship_date: { $gte: new Date(from + 'T00:00:00Z'), $lte: new Date(to + 'T23:59:59Z') } }, { ship_date: null }] };
  if (nm.length >= 2) offQuery.customer_name_norm = nm;
  if (tail) offQuery.customer_phone_norm = { $regex: digits.length >= 10 ? `^${digits}$` : `${tail}$` };

  const [ssColl, offColl] = await Promise.all([
    store.collection('smartstore_orders'),
    store.namedCollection('OFFLINE_ORDER', 'deliveryShipments'),
  ]);
  const [ssRows, offRows] = await Promise.all([
    ssColl.find(ssQuery).sort({ order_date: -1 }).limit(80).toArray(),
    offColl.find(offQuery, { projection: { store_name: 1, order_no: 1, courier: 1, tracking_no: 1, ship_date: 1, ship_status: 1, customer_name: 1, customer_phone_norm: 1, product_text: 1, uploaded_at: 1 } })
      .sort({ ship_date: -1 }).limit(40).toArray(),
  ]);

  // 연락처를 다 적었고 사본에 가려지지 않은 번호가 있으면 끝자리만이 아니라 전체가 같아야 한다.
  const sameTel = (tel) => digits.length < 10 || String(tel || '').replace(/\D/g, '').length < 10 || String(tel).replace(/\D/g, '') === digits;

  // 스마트스토어는 상품주문 단위로 저장돼 있어 주문번호로 묶는다.
  const byOrder = new Map();
  for (const o of ssRows) {
    if (!sameTel(o.orderer_tel)) continue;
    const key = o.order_id || o.product_order_id;
    const cur = byOrder.get(key) || {
      채널: '스마트스토어', 주문번호: o.order_id, 주문일: o.order_date, 상품: [], 상태: [], 배송: null,
      주문자: mask(o.orderer_name), 연락처끝4: last4(o.orderer_tel), 기준: asOf(o.syncedAt),
    };
    cur.상품.push(`${o.product_name}${o.option_value ? '(' + o.option_value + ')' : ''} x${o.quantity || 1}`);
    const st = SS_STATUS[o.status] || o.status;
    if (st && !cur.상태.includes(st)) cur.상태.push(st);
    cur.배송 = cur.배송 || ssDelivery(o);
    byOrder.set(key, cur);
  }
  const results = [...byOrder.values()].map((r) => ({ ...r, 상태: r.상태.join(' · ') }));
  for (const r of offRows) {
    if (!sameTel(r.customer_phone_norm)) continue;
    results.push({
      채널: '매장 택배', 매장: r.store_name, 주문번호: r.order_no, 발송일: r.ship_date ? new Date(r.ship_date).toISOString().slice(0, 10) : '',
      상품: [String(r.product_text || '').slice(0, 80)], 상태: SHIP_STATUS[r.ship_status] || r.ship_status || '',
      배송: r.tracking_no ? { 택배사: r.courier || '', 송장번호: r.tracking_no } : null,
      주문자: mask(r.customer_name), 연락처끝4: last4(r.customer_phone_norm), 기준: asOf(r.uploaded_at),
    });
  }

  return {
    조건: { 이름: nm ? mask(nm) : '', 연락처끝4: tail, 기간: `${from} ~ ${to}` },
    건수: results.length,
    결과: results.slice(0, 20),
    ...(results.length ? {} : { 안내: '일치 주문 없음 — 이름 표기·기간을 바꿔 보거나 주문번호로 찾아보세요. 자사몰 주문은 Cafe24에서 실시간으로 찾습니다.' }),
    주의: '스마트스토어·매장 택배는 동기화/업로드 사본이라 실시간이 아님(기준 시각 참고). 이름 마스킹·연락처 끝 4자리만. 동명이인은 끝 4자리로 본인 확인.',
  };
}

// Cafe24 게시판 미답변 체크 — Q&A(6)·A/S문의(31)·1:1맞춤상담(9)·교환/반품(101)
const CS_BOARDS = [{ no: 6, name: 'Q&A' }, { no: 31, name: 'A/S문의' }, { no: 9, name: '1:1 맞춤상담' }, { no: 101, name: '교환/반품' }];

async function unanswered(days = 7) {
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const end = fmt(new Date());
  const sd = new Date(); sd.setDate(sd.getDate() - Math.max(1, Math.min(60, days)));
  const start = fmt(sd);

  const out = [];
  for (const b of CS_BOARDS) {
    let arts = [];
    try { arts = await c.adminPaginate('/boards/' + b.no + '/articles', { shop_no: 1, start_date: start, end_date: end }, 'articles', { limit: 100, maxPages: 2 }); }
    catch (_) { continue; }
    const answeredParents = new Set(arts.filter((a) => a.reply_depth > 0 && a.parent_article_no).map((a) => a.parent_article_no));
    const roots = arts.filter((a) => !a.reply_depth);
    const un = roots.filter((a) => !answeredParents.has(a.article_no));
    out.push({
      게시판: b.name, 기간내원글: roots.length, 미답변: un.length,
      미답변목록: un.slice(0, 15).map((a) => ({
        작성일: String(a.created_date || '').slice(0, 10), 제목: strip(a.title).slice(0, 50),
        내용요약: strip(a.content).slice(0, 100), 작성자: mask(a.writer),
      })),
    });
  }
  const totalUn = out.reduce((a, b2) => a + b2.미답변, 0);
  return {
    기간: `${start} ~ ${end}`, 총미답변: totalUn, 게시판별: out,
    주의: '기간 내 원글 기준(답글=관리자 답변 depth1). 기간 경계의 답변은 누락될 수 있어 참고용. 작성자 마스킹.',
  };
}

module.exports = { orderLookup, orderSearch, unanswered, searchRange, nameRegex };
