'use strict';

/**
 * Cafe24 상품 검색 — Admin API /products (읽기전용 토큰).
 *   몰별 프로모션의 대상 상품 선택용. 상품명 부분검색(미입력 시 전체 상위 N).
 */

const cafe24 = require('./cafe24');

// q: 상품명 부분검색어, limit: 최대 100
// Cafe24 /products 기본 정렬은 product_no 내림차순(최신 등록순)이라,
// "오래전 등록순(product_no 오름차순)"으로 보여주기 위해 전체 개수로 역(逆)오프셋을 계산해 끌어온다.
async function search(q, limit, offset) {
  if (!cafe24.enabled()) throw new Error('Cafe24 토큰 미설정 — 상품 검색 불가');
  const lim = Math.min(Number(limit) || 50, 100);
  const off = Math.max(0, Number(offset) || 0);
  const term = (q || '').trim();
  const base = { fields: 'product_no,product_name,price,selling,display' };
  if (term) base.product_name = term; // Cafe24 부분일치 검색

  // 전체 개수(필터 동일) — 실패 시 기존(최신순) 동작으로 폴백
  let total = 0;
  try { const cj = await cafe24.adminGet('/products/count', term ? { product_name: term } : {}); total = Number(cj && cj.count) || 0; }
  catch (_) { total = 0; }

  let apiOffset, apiLimit, reverse;
  if (total > 0) {
    if (off >= total) return [];                 // 요청 오프셋이 전체를 넘음
    apiOffset = Math.max(0, total - off - lim);   // 내림차순 리스트에서 '오래된 쪽' 페이지 위치
    apiLimit = Math.min(lim, total - off);
    reverse = true;
  } else {
    apiOffset = off; apiLimit = lim; reverse = false;
  }

  const j = await cafe24.adminGet('/products', { ...base, limit: apiLimit, offset: apiOffset });
  let arr = (j && j.products) || [];
  // 내림차순으로 받은 페이지를 뒤집어 오름차순(오래된 등록순)으로. 폴백 시엔 페이지 내 정렬만 보정.
  arr = reverse ? arr.slice().reverse() : arr.slice().sort((a, b) => Number(a.product_no) - Number(b.product_no));
  return arr.map((p) => ({
    productNo: String(p.product_no),
    productName: p.product_name || '(이름없음)',
    price: Math.round(Number(p.price) || 0),
  }));
}

module.exports = { search };
