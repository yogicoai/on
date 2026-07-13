'use strict';

/**
 * 자사몰(Cafe24) 옵션별 재고/품절 — /products/{no}/variants (진열 기준 재고).
 *   재고 3종 구분: 창고 실물재고=inventory · 스토어 등록재고=smartstore_ops · 자사몰 진열재고=여기.
 *   "자사몰에서 ○○ 품절 옵션 뭐야?", "자사몰 재고 얼마로 떠 있어?" 질문용.
 *   상품번호는 product_catalog(DB)에서 상품명 부분일치로 찾고, 상위 4개 상품까지 옵션 조회.
 */

const store = require('./store');
const c = require('./cafe24');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const esc = (s) => String(s || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function productStock(search) {
  const q = String(search || '').trim();
  if (!q) throw new Error('상품명 검색어가 필요합니다 — 예: "맥스"');
  const cat = await store.collection('product_catalog');
  const prods = await cat.find({ source: 'cafe24', productName: { $regex: esc(q), $options: 'i' } })
    .limit(4).toArray();
  if (!prods.length) return { 검색어: q, 매칭상품: 0, 안내: '자사몰 상품명 매칭 없음 — 더 짧은 키워드로 재검색' };

  const out = [];
  for (const p of prods) {
    try {
      const j = await c.adminGet('/products/' + p.productNo + '/variants', { shop_no: 1 });
      const vs = (j.variants || []).map((v) => ({
        옵션: (v.options || []).map((o) => o.value).join('/') || '(단일)',
        재고: N(v.quantity),
        품절표시: v.display_soldout === 'T',
        판매중: v.selling === 'T',
      }));
      const soldout = vs.filter((v) => v.재고 <= 0 || v.품절표시);
      out.push({
        상품: p.productName, 상품번호: p.productNo, 판매가: p.price,
        옵션수: vs.length, 품절옵션: soldout.length,
        총재고: vs.reduce((a, v) => a + Math.max(0, v.재고), 0),
        옵션목록: vs.sort((a, b) => a.재고 - b.재고).slice(0, 25),
      });
    } catch (e) { out.push({ 상품: p.productName, 상품번호: p.productNo, error: String(e.message).slice(0, 80) }); }
  }
  return {
    검색어: q, 매칭상품: out.length, 상품별: out,
    주의: '자사몰 진열 기준 재고(쇼핑몰에 표시되는 값) — 창고 실물재고(inventory)·스토어 등록재고(smartstore_ops)와 다를 수 있음.',
  };
}

module.exports = { productStock };
