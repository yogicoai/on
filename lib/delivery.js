'use strict';

/**
 * 매장 택배 배송 조회 — OFFLINE_ORDER.deliveryShipments (매장 주문서 택배 발송 적재본).
 *   매장 직원/CS용: 주문번호·매장·기간으로 배송상태(택배사·송장·발송일) 조회.
 *   ⚠️ 고객 개인정보 보호: 이름은 마스킹(홍*동), 연락처·주소는 아예 반환하지 않음.
 */

const store = require('./store');

const mask = (name) => {
  const s = String(name || '').trim();
  if (s.length <= 1) return s ? s + '*' : '';
  if (s.length === 2) return s[0] + '*';
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
};
const fmtDate = (v) => { try { return v ? new Date(v).toISOString().slice(0, 10) : ''; } catch (_) { return ''; } };

// 조회: orderNo(부분일치) / storeName(부분일치) / start~end(발송일) — 최소 1개 필터 필요
async function shipments({ orderNo, storeName, start, end, status } = {}) {
  if (!orderNo && !storeName && !start) throw new Error('orderNo·store·기간 중 최소 1개 필터가 필요합니다');
  const c = await store.namedCollection('OFFLINE_ORDER', 'deliveryShipments');
  const q = {};
  if (orderNo) q.order_no = { $regex: String(orderNo).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  if (storeName) q.store_name = { $regex: String(storeName).trim(), $options: 'i' };
  if (start || end) { q.ship_date = {}; if (start) q.ship_date.$gte = new Date(start + 'T00:00:00Z'); if (end) q.ship_date.$lte = new Date(end + 'T23:59:59Z'); }
  if (status) q.ship_status = String(status).toUpperCase();
  const rows = await c.find(q, {
    projection: { store_name: 1, order_no: 1, courier: 1, tracking_no: 1, ship_date: 1, ship_status: 1, customer_name: 1, product_text: 1 },
  }).sort({ ship_date: -1 }).limit(120).toArray();

  const items = rows.map((r) => ({
    매장: r.store_name, 주문번호: r.order_no,
    상태: r.ship_status || '', 택배사: r.courier || '', 송장번호: r.tracking_no || '(미입력)',
    발송일: fmtDate(r.ship_date), 고객: mask(r.customer_name), 상품: String(r.product_text || '').slice(0, 80),
  }));

  // 상태 요약
  const byStatus = {};
  for (const r of items) byStatus[r.상태 || '(미상)'] = (byStatus[r.상태 || '(미상)'] || 0) + 1;

  return {
    필터: { orderNo: orderNo || null, store: storeName || null, start: start || null, end: end || null, status: status || null },
    건수: items.length, 상태요약: byStatus, 목록: items,
    주의: '고객명은 마스킹, 연락처·주소는 미제공(개인정보 보호). 송장 미입력 건은 매장에서 아직 등록 전.',
  };
}

module.exports = { shipments };
