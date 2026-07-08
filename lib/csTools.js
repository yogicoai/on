'use strict';

/**
 * CS 도구 — 고객 응대용 조회.
 *   · orderLookup(): 주문번호로 자사몰(Cafe24)+스마트스토어 통합 주문 상태 조회(+자사몰 송장).
 *   · unanswered(): Cafe24 게시판(Q&A·A/S·1:1·교환/반품) 미답변 글 체크 — 답글(depth1) 없는 원글.
 *   ⚠️ 구매자 이름/연락처는 반환하지 않음(작성자는 마스킹).
 */

const store = require('./store');
const c = require('./cafe24');

const R = (n) => Math.round(n || 0);
const mask = (s) => { const t = String(s || '').trim(); return t.length <= 1 ? t : t[0] + '*'.repeat(Math.min(t.length - 1, 3)); };
const strip = (t) => String(t || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const esc = (s) => String(s || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  const SS_STATUS = { PAYED: '결제완료', DELIVERING: '배송중', DELIVERED: '배송완료', PURCHASE_DECIDED: '구매확정', CANCELED: '취소', RETURNED: '반품', CANCELED_BY_NOPAYMENT: '미결제취소', EXCHANGED: '교환' };
  for (const o of ssRows) {
    results.push({
      채널: '스마트스토어', 주문번호: o.order_id, 상품주문번호: o.product_order_id, 주문일: o.order_date,
      상태: SS_STATUS[o.status] || o.status,
      결제금액: R(o.payment_amount),
      상품: [`${o.product_name}${o.option_value ? '(' + o.option_value + ')' : ''} x${o.quantity || 1}`],
      유입경로: o.inflow_path || null,
    });
  }
  return {
    검색어: q, 건수: results.length, 결과: results,
    ...(results.length ? {} : { 안내: '일치 주문 없음 — 자사몰은 YYYYMMDD-0000000 형식, 스토어는 주문번호/상품주문번호로 검색하세요.' }),
    주의: '구매자 개인정보 미제공. 자사몰 배송은 송장 기준(택배사코드는 Cafe24 코드).',
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

module.exports = { orderLookup, unanswered };
