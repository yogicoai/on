'use strict';

/**
 * 통합 상품 검색 — 프로모션 대상 상품 선택용.
 *   몰에 따라 Cafe24(/products) 또는 스마트스토어(Naver Commerce /products/search)에서 검색하고,
 *   결과를 onlinedata.product_catalog 에 upsert 로 "누적 적재"한다(다음부터 빠르게/오프라인 검색 가능).
 *   라이브 실패 시 누적된 카탈로그에서 대체 검색.
 */

const store = require('./store');
const cafe24Products = require('./cafe24Products');
const smartstore = require('./smartstore');

const CAT = 'product_catalog';

// 스마트스토어(네이버 커머스) 상품 검색 — 응답 스키마가 버전에 따라 달라 방어적으로 추출
async function searchSmartstore(q, limit, offset) {
  if (!smartstore.enabled()) throw new Error('스마트스토어 토큰 미설정');
  const size = Math.min(Number(limit) || 50, 100);
  const page = Math.floor((Number(offset) || 0) / size) + 1; // 네이버는 1-based page
  const body = { searchKeyword: (q || '').trim(), productStatusTypes: ['SALE'], page, size };
  const j = await smartstore.apiPost('/external/v1/products/search', { body });
  const contents = (j && (j.contents || j.list || j.products)) || [];
  const out = [];
  for (const it of contents) {
    const chs = it.channelProducts || (it.channelProduct ? [it.channelProduct] : []);
    if (chs.length) {
      for (const ch of chs) out.push({
        productNo: String(ch.channelProductNo || ch.originProductNo || it.originProductNo || ''),
        productName: ch.name || it.name || '(이름없음)',
        price: Math.round(Number(ch.salePrice ?? ch.discountedSalePrice ?? it.salePrice) || 0),
      });
    } else {
      out.push({
        productNo: String(it.originProductNo || it.productNo || it.id || ''),
        productName: it.name || it.productName || '(이름없음)',
        price: Math.round(Number(it.salePrice || it.price) || 0),
      });
    }
  }
  return out;
}

async function accumulate(products, source) {
  if (!store.configured() || !products.length) return;
  try {
    const c = await store.collection(CAT);
    const now = new Date().toISOString();
    const ops = products.filter((p) => p.productNo).map((p) => ({
      updateOne: { filter: { source, productNo: p.productNo }, update: { $set: { source, productNo: p.productNo, productName: p.productName, price: p.price, updatedAt: now } }, upsert: true },
    }));
    if (ops.length) await c.bulkWrite(ops, { ordered: false });
  } catch (_) { /* 누적 실패는 검색 자체엔 영향 없음 */ }
}

async function searchCatalog(q, source, limit, offset) {
  if (!store.configured()) return [];
  try {
    const c = await store.collection(CAT);
    const m = { source };
    if (q && q.trim()) m.productName = { $regex: q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const arr = await c.find(m).sort({ updatedAt: -1 }).skip(Math.max(0, Number(offset) || 0)).limit(Math.min(Number(limit) || 50, 100)).toArray();
    return arr.map((p) => ({ productNo: p.productNo, productName: p.productName, price: p.price, source }));
  } catch (_) { return []; }
}

async function search(q, mall, limit, offset) {
  const source = (mall === '스마트스토어' || mall === 'smartstore') ? 'smartstore' : 'cafe24';
  try {
    let live = source === 'smartstore' ? await searchSmartstore(q, limit, offset) : await cafe24Products.search(q, limit, offset);
    live = live.map((p) => ({ ...p, source }));
    await accumulate(live, source);
    return { source, items: live };
  } catch (e) {
    const cat = await searchCatalog(q, source, limit, offset);
    return { source: `${source}(누적)`, items: cat, note: String(e.message) };
  }
}

module.exports = { search, searchCatalog };
