'use strict';

/**
 * 프로모션 대상상품 해석기 — target(scope/include/exclude) + 품목맵 → 실제 주문 상품명 집합.
 *   전 몰 공통. 성과 계산(promoPerformance)이 이걸로 on/off.orders를 필터한다.
 *
 *   핵심 규칙(MD 자료 전수분석으로 검증됨)
 *     · scope='전제품' → include 비어도 "전 상품"(0원 처리 금지 — 과거 0원 버그 지점)
 *     · rule 결합식  → nameEquals ∪ (namePrefix ∩ nameContains ∩ group)   ※ 전부 AND도, 전부 OR도 틀림
 *     · item        → 정확매칭. '맥스'는 '맥스 커버'(별도 품목)를 포함하지 않는다
 *                     → 상품명→품목 배정은 "가장 긴 품목명이 이긴다"로 해결(규격만 흡수)
 *     · 12개월 판매이력 있는 상품만 대상(단종·오프라인전용 자동 배제)
 */

const store = require('./store');

// 실제 상품인 group1(나머지는 배송비·할인·패키지·원재료·소모품 등 비상품)
const PRODUCT_GROUPS = ['Care(케어)', 'Sofa(소파)', 'Kids(키즈)', 'Living(리빙)', 'Body Pillow(바디 필로우)'];

const _g = globalThis;
_g.__promoTarget = _g.__promoTarget || { map: null, ctx: {} };

// 규격 접미 정규화: (EPP)/(HRF) 제거 + 공백 정리
const norm = (s) => String(s || '').replace(/\((EPP|HRF)\)/gi, ' ').replace(/\s+/g, ' ').trim();

function ledgerFor(mall) {
  if (mall === '오프라인') return { db: 'off', store: null };
  if (mall === '스마트스토어') return { db: 'on', store: '스마트스토어' };
  return { db: 'on', store: '홈페이지' }; // 자사몰
}

async function loadMap() {
  const g = _g.__promoTarget;
  if (g.map) return g.map;
  const c = await store.collection('promo_product_map');
  const doc = await c.findOne({ _id: 'product_map' });
  const products = (doc && doc.products) || {};
  const aliases = (doc && doc.aliases) || {};
  const rules = (doc && doc.rules) || {};
  // 별칭 정규화 인덱스(기획표기 → ERP 품목명)
  const aliasIdx = {};
  for (const [k, v] of Object.entries(aliases)) aliasIdx[norm(k)] = norm(typeof v === 'string' ? v : (v && v.item) || '');
  g.map = { products, aliases: aliasIdx, rules, keys: Object.keys(products).map(norm) };
  return g.map;
}

const unalias = (name, map) => map.aliases[norm(name)] || norm(name);

// 몰별 "최근 12개월 판매이력 있는 상품명" + 상품명→품목 배정(가장 긴 품목명 우선)
async function context(mall, asof) {
  const key = `${mall}|${String(asof || '').slice(0, 10)}`;
  const g = _g.__promoTarget;
  if (g.ctx[key]) return g.ctx[key];

  const map = await loadMap();
  const { db, store: st } = ledgerFor(mall);
  const c = await store.namedCollection(db, 'orders');
  const from = new Date(new Date(asof || new Date()).getTime() - 365 * 86400000).toISOString().slice(0, 10);
  const m = { date: { $gte: from, $lte: String(asof || '').slice(0, 10) || undefined }, group1: { $in: PRODUCT_GROUPS }, amount: { $gt: 0 } };
  if (!m.date.$lte) delete m.date.$lte;
  if (st) m.store = st;
  const names = await c.distinct('productName', m);

  // 상품명 → 품목 배정: 정확일치 우선, 아니면 "가장 긴 품목명 + 공백" 접두
  const keys = map.keys.slice().sort((a, b) => b.length - a.length);
  const nameToKey = new Map();
  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    let hit = null;
    for (const k of keys) { if (n === k || n.startsWith(k + ' ')) { hit = k; break; } }
    if (hit) nameToKey.set(raw, hit);
  }
  const keyToNames = new Map();
  for (const [raw, k] of nameToKey) { if (!keyToNames.has(k)) keyToNames.set(k, []); keyToNames.get(k).push(raw); }

  const ctx = { mall, map, names, nameToKey, keyToNames, ledger: ledgerFor(mall) };
  g.ctx[key] = ctx;
  return ctx;
}

// rule 결합식 — nameEquals ∪ (namePrefix ∩ nameContains ∩ group)
function ruleMatchesKey(key, product, match, map) {
  const eq = (match.nameEquals || []).some((v) => unalias(v, map) === key);
  if (eq) return true;
  const P = match.namePrefix || [], C = match.nameContains || [], G = match.group || [];
  if (!P.length && !C.length && !G.length) return false;
  if (P.length && !P.some((v) => key.startsWith(unalias(v, map)))) return false;
  if (C.length && !C.some((v) => key.includes(norm(v)))) return false;
  if (G.length && !(product.groups || []).some((g) => G.includes(g))) return false;
  return true;
}

// note에 적힌 숨은 제약(match엔 없음) — 예: 허거는 '이너/반제품' 제외
function applyNote(keys, note) {
  const t = String(note || '');
  if (!t) return keys;
  if (/이너|반제품/.test(t) && /제외/.test(t)) return keys.filter((k) => !/이너|반제품/.test(k));
  return keys;
}

// include/exclude 엔트리 1개 → 품목 키 집합
function resolveEntry(entry, ctx) {
  const map = ctx.map;
  const out = new Set();
  if (!entry) return out;

  if (entry.mode === 'item') {
    const k = unalias(entry.item, map);
    if (map.products[k] || ctx.keyToNames.has(k)) out.add(k);
    return out;
  }
  if (entry.mode === 'set') {
    for (const comp of (entry.components || [])) { const k = unalias(comp, map); if (k) out.add(k); }
    return out;
  }
  // rule
  const match = entry.match || (map.rules[entry.raw] && map.rules[entry.raw].match) || {};
  const note = entry.note || (map.rules[entry.raw] && map.rules[entry.raw].note) || '';
  let keys = [];
  for (const [k, p] of Object.entries(map.products)) { if (ruleMatchesKey(norm(k), p, match, map)) keys.push(norm(k)); }
  keys = applyNote(keys, note);
  for (const k of keys) out.add(k);
  return out;
}

/**
 * target 해석 → { allProducts, names[], setSpecs[] }
 *   allProducts=true 면 해당 몰의 12개월 판매상품 전체가 대상(names 무시).
 *   setSpecs 는 "동일 주문에서 구성품 동시구매" 판정용.
 */
async function resolveTarget(target, mall, asof) {
  const ctx = await context(mall, asof);
  const t = target || {};
  const setSpecs = [];

  if (t.scope === '전제품') {
    // include/exclude 비어도 전 상품 — 0원 처리 금지
    const ex = new Set();
    for (const e of (t.exclude || [])) for (const k of resolveEntry(e, ctx)) ex.add(k);
    if (!ex.size) return { allProducts: true, names: [], setSpecs, ctx };
    const names = ctx.names.filter((n) => { const k = ctx.nameToKey.get(n); return !(k && ex.has(k)); });
    return { allProducts: false, names, setSpecs, ctx, excluded: ex.size };
  }

  const inc = new Set(), ex = new Set();
  for (const e of (t.include || [])) {
    if (e && e.mode === 'set') setSpecs.push([...resolveEntry(e, ctx)]);
    for (const k of resolveEntry(e, ctx)) inc.add(k);
  }
  for (const e of (t.exclude || [])) for (const k of resolveEntry(e, ctx)) ex.add(k);

  const keys = [...inc].filter((k) => !ex.has(k));
  const names = [];
  for (const k of keys) for (const n of (ctx.keyToNames.get(k) || [])) names.push(n);
  return { allProducts: false, names, setSpecs, ctx, keys };
}

// 품목맵만으로 규칙 해석(원장 무관) — 회귀 테스트용
async function resolveRuleKeys(match, note) {
  const map = await loadMap();
  let keys = [];
  for (const [k, p] of Object.entries(map.products)) { if (ruleMatchesKey(norm(k), p, match || {}, map)) keys.push(norm(k)); }
  return applyNote(keys, note);
}

module.exports = { resolveTarget, resolveRuleKeys, context, loadMap, ledgerFor, PRODUCT_GROUPS, norm };
