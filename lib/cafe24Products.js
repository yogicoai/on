'use strict';

/**
 * Cafe24 상품 검색 — Admin API /products (읽기전용 토큰).
 *   몰별 프로모션의 대상 상품 선택용. 상품명 부분검색(미입력 시 전체 상위 N).
 */

const cafe24 = require('./cafe24');

// q: 상품명 부분검색어, limit: 최대 100
async function search(q, limit, offset) {
  if (!cafe24.enabled()) throw new Error('Cafe24 토큰 미설정 — 상품 검색 불가');
  const params = {
    limit: Math.min(Number(limit) || 50, 100),
    offset: Math.max(0, Number(offset) || 0),
    fields: 'product_no,product_name,price,selling,display',
  };
  const term = (q || '').trim();
  if (term) params.product_name = term; // Cafe24 부분일치 검색
  const j = await cafe24.adminGet('/products', params);
  const arr = (j && j.products) || [];
  return arr.map((p) => ({
    productNo: String(p.product_no),
    productName: p.product_name || '(이름없음)',
    price: Math.round(Number(p.price) || 0),
  }));
}

module.exports = { search };
