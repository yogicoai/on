'use strict';

/**
 * 과거 프로모션 성과 "정본" — MD가 채널 어드민(쿠폰·할인이벤트)에서 수기 취합한 할인율별 실적.
 *   이카운트(on.orders)엔 할인율/쿠폰 식별값이 없어 재계산이 불가능하므로, MD 작성본을 그대로 보관한다.
 *   경계: 2026-06 이전(이전 작업분) = 이 정본 / 2026-06~(우리 운영 시작) = 목표기반 라이브(buildPromo).
 *
 *   promo_history          : { Name, Start, End, Amount, Qty, Orders, JaAmount, SsAmount, JaOrders, SsOrders, JaQty, SsQty, _src }
 *   promo_history_products : { Promo, Item, Cat, Channels, Amount, Qty, Orders }
 */

const store = require('./store');
const COLL = 'promo_history';
const PCOLL = 'promo_history_products';

// 이 날짜(포함) 이전에 "시작"한 프로모션은 MD 정본을 사용한다. 6/1부터는 우리 목표기반 라이브.
const MD_CUTOFF = '2026-06-01';

async function listPromos() {
  if (!store.configured()) return [];
  try { const c = await store.collection(COLL); return await c.find({}, { projection: { _id: 0 } }).sort({ Start: 1, Name: 1 }).toArray(); }
  catch (_) { return []; }
}
async function listProducts() {
  if (!store.configured()) return [];
  try { const c = await store.collection(PCOLL); return await c.find({}, { projection: { _id: 0 } }).toArray(); }
  catch (_) { return []; }
}

// MD 작성본 적재(upsert). promos/products 배열을 받아 Name+Start+End 기준으로 덮어쓴다.
async function importEntries(promos, products) {
  const c = await store.collection(COLL);
  try { await c.createIndex({ Name: 1, Start: 1, End: 1 }, { unique: true }); } catch (_) {}
  const ops = (promos || []).map((p) => ({
    updateOne: { filter: { Name: p.Name, Start: p.Start, End: p.End }, update: { $set: { ...p, _src: 'md' } }, upsert: true },
  }));
  if (ops.length) await c.bulkWrite(ops, { ordered: false });
  // 상품은 프로모션명 단위로 통째 교체(import 대상 프로모션만)
  const pc = await store.collection(PCOLL);
  const names = [...new Set((promos || []).map((p) => p.Name))];
  if (names.length) { await pc.deleteMany({ Promo: { $in: names } }); if ((products || []).length) await pc.insertMany(products.map((x) => ({ ...x }))); }
  return { promos: ops.length, products: (products || []).length };
}

module.exports = { listPromos, listProducts, importEntries, MD_CUTOFF, COLL, PCOLL };
