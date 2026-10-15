'use strict';

/**
 * 전사 프로모션 정의 — 검증·미리보기·적재 공통 레이어.
 *   CLI 로더(scripts/sync-promo-defs.js)와 대시보드 엑셀 업로드가 **같은 함수**를 쓴다.
 *   흐름: validate(형식검사) → diff(신규/수정/삭제 미리보기) → ingest(스냅샷 후 전량교체)
 *
 *   전량 교체인 이유: 엑셀이 유일한 진실이라 DB는 그 거울. 건별 upsert만 하면 엑셀에서 지운 행이 유령으로 남는다.
 *   안전장치: ① 검증 실패 시 적재 안 함 ② diff로 확인 후 적용 ③ promo_defs_backup에 직전 버전 보관(롤백)
 */

const store = require('./store');

const COLL = { defs: 'promo_defs', map: 'promo_product_map', price: 'promo_price_detail', events: 'promo_events', backup: 'promo_defs_backup' };
const MALLS = ['자사몰', '스마트스토어', '오프라인'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const keyOf = (p) => `${p.promo_id}|${p.mall}`;

// 변경 감지용 지문 — 성과에 영향 주는 값만, 표현 차이(엑셀/JSON 구조·띄어쓰기·키 순서)는 정규화해서 무시.
//   같은 내용을 다시 올렸을 때 "전부 수정됨"으로 뜨지 않도록.
const nospace = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
const ymd = (s) => String(s == null ? '' : s).slice(0, 10);
function fingerprint(p) {
  const t = p.target || {};
  const rawList = (arr) => (arr || []).map((e) => nospace(e && (e.raw != null ? e.raw : e.item))).filter(Boolean).sort().join('|');
  const d = p.discount || {};
  const disc = Object.entries(d).filter(([k, v]) => k !== 'raw' && v != null && v !== '').map(([k, v]) => `${k}:${v}`).sort().join(',');
  return JSON.stringify({
    name: nospace(p.name), start: ymd(p.start), end: ymd(p.end), mall: p.mall,
    method: nospace(p.method), scope: nospace(t.scope),
    inc: rawList(t.include), exc: rawList(t.exclude),
    disc, target_sales: p.target_sales == null ? null : Number(p.target_sales),
    // 비교창(전년·직전)도 성과 해석을 바꾸므로 지문에 포함 — 창만 고쳐 올린 것도 "수정"으로 잡혀야 한다.
    cmp: cmpKey(p.campaign), conf: ((p.tags || {}).confounder || []).map(nospace).sort().join('|'),
    band: nospace((p.tags || {}).discount_band), maxd: (p.tags || {}).max_discount == null ? null : Number((p.tags || {}).max_discount),
  });
}
function cmpKey(c) {
  if (!c) return '';
  const k = ['yoy_start', 'yoy_end', 'baseline_start', 'baseline_end'].map((x) => ymd(c[x])).join('~');
  const parts = [k];
  if (c.baseline_clean_pct != null) parts.push(`c${Number(c.baseline_clean_pct)}`);
  if (c.rep_promo) parts.push(`r${nospace(c.rep_promo)}`); // 대표가 바뀌면 캠페인 합계가 바뀐다
  return parts.join('#');
}

// ── 1) 검증 ────────────────────────────────────────────────────────────────
function validate(data) {
  const errors = [], warnings = [];
  const promos = Array.isArray(data && data.promotions) ? data.promotions : null;
  if (!promos) { errors.push('promotions 배열이 없습니다 (엑셀 프로모션 시트를 확인하세요)'); return { ok: false, errors, warnings, counts: {} }; }
  if (!promos.length) errors.push('프로모션이 0건입니다');

  const seen = new Set();
  promos.forEach((p, i) => {
    const row = i + 2; // 엑셀 행(헤더 1행 가정)
    if (!p.promo_id) errors.push(`${row}행: 프로모션ID(promo_id) 없음`);
    if (!p.mall) errors.push(`${row}행: 몰 없음`);
    else if (!MALLS.includes(p.mall)) errors.push(`${row}행: 몰 값 오류 "${p.mall}" (허용: ${MALLS.join('/')})`);
    if (!p.name) errors.push(`${row}행: 프로모션명 없음`);
    if (!isDate(p.start)) errors.push(`${row}행: 시작일 형식 오류 "${p.start}" (YYYY-MM-DD)`);
    if (!isDate(p.end)) errors.push(`${row}행: 종료일 형식 오류 "${p.end}" (YYYY-MM-DD)`);
    if (isDate(p.start) && isDate(p.end) && p.start > p.end) errors.push(`${row}행: 시작일이 종료일보다 뒤`);
    if (p.promo_id && p.mall) {
      const k = keyOf(p);
      if (seen.has(k)) errors.push(`${row}행: 중복 (프로모션ID ${p.promo_id} × ${p.mall})`);
      seen.add(k);
    }
    // 대상상품 — scope=전제품이면 include 비어도 정상(전 상품). 그 외 비어있으면 경고.
    const t = p.target || {};
    if (t.scope && t.scope !== '전제품' && !(t.include || []).length) warnings.push(`${row}행: 대상상품이 비어 있음(범위=${t.scope}) — 매출 0으로 집계됩니다`);
    if (p.target_sales != null && !(Number(p.target_sales) >= 0)) errors.push(`${row}행: 목표매출이 숫자가 아님 "${p.target_sales}"`);
  });

  const byMall = {};
  for (const p of promos) byMall[p.mall] = (byMall[p.mall] || 0) + 1;
  const pm = (data && data.product_map) || {};
  const counts = {
    promotions: promos.length,
    promoIds: new Set(promos.map((p) => p.promo_id)).size,
    byMall,
    products: Object.keys((pm.products) || {}).length,
    aliases: Object.keys(pm.aliases || {}).length,
    rules: Object.keys(pm.rules || {}).length,
    priceDetail: (data && data.price_detail || []).length,
    events: (data && data.events || []).length,
    withTarget: promos.filter((p) => Number(p.target_sales) > 0).length,
  };
  if (!counts.products) warnings.push('품목맵(product_map)이 비어 있음 — 상품 규칙 해석이 제한됩니다');
  return { ok: !errors.length, errors, warnings, counts };
}

// ── 2) 미리보기(diff) — 현재 DB 대비 신규/수정/삭제 ─────────────────────────
async function diff(data) {
  const c = await store.collection(COLL.defs);
  const cur = await c.find({}, { projection: { _id: 0 } }).toArray();
  const curMap = new Map(cur.map((p) => [keyOf(p), p]));
  const next = (data && data.promotions) || [];
  const nextKeys = new Set(next.map(keyOf));

  const added = [], changed = [], unchanged = [];
  for (const p of next) {
    const old = curMap.get(keyOf(p));
    if (!old) added.push({ promo_id: p.promo_id, mall: p.mall, name: p.name, start: p.start, end: p.end });
    else if (fingerprint(old) !== fingerprint(p)) changed.push({ promo_id: p.promo_id, mall: p.mall, name: p.name, 이전: `${old.start}~${old.end}`, 변경: `${p.start}~${p.end}` });
    else unchanged.push(keyOf(p));
  }
  const removed = cur.filter((p) => !nextKeys.has(keyOf(p))).map((p) => ({ promo_id: p.promo_id, mall: p.mall, name: p.name }));
  return { 신규: added.length, 수정: changed.length, 삭제: removed.length, 변동없음: unchanged.length, added, changed, removed };
}

// ── 엑셀 업로드 보정 — 17열 양식에 없는 칸은 지금 등록된 같은 행(promo_id × 몰)의 값을 이어받는다 ──
//   대시보드 양식(내려받기 = 지금 등록분)을 고쳐 다시 올려도 MD 원본(JSON)에서 온 비교창 · 조건 태그 · 기입 근거 · 가격표 · 교란요인이
//   지워지지 않게 한다(예전엔 전량 교체라 업로드 한 번에 이 값들이 빠졌다 — 2026-09-21 메모의 위험 1 · 2번).
//   엑셀에 그 칸이 있으면(헤더 이름으로 판정) 엑셀 값이 이긴다. JSON 적재(sync-promo-defs)는 이 보정을 거치지 않는다.
async function withCurrent(data) {
  const cols = new Set((data && data._meta && data._meta.columns) || []);
  const has = (...k) => k.some((x) => cols.has(x));
  const c = await store.collection(COLL.defs);
  const cur = new Map((await c.find({}, { projection: { _id: 0, _syncedAt: 0, _source: 0 } }).toArray()).map((p) => [keyOf(p), p]));
  const rawKey = (arr) => (arr || []).map((e) => nospace(e && (e.raw != null ? e.raw : e.item))).filter(Boolean).sort().join('|');
  const nums = (d) => JSON.stringify(['S', 'P', 'PP', 'cover', 'bead', 'accessory'].map((k) => (d && d[k] != null && d[k] !== '' ? Number(d[k]) : null)));
  let carried = 0;
  const promotions = ((data && data.promotions) || []).map((p) => {
    // 내려받기 양식이 비고 앞에 붙인 [빈칸 사유]는 떼고 저장 — 내려받을 때 기입 근거로 다시 붙는다
    const note = p.note ? (String(p.note).replace(/^\[[^\]]*\]\s*/, '').trim() || null) : p.note;
    const old = cur.get(keyOf(p));
    if (!old) return { ...p, note };
    carried++;
    const out = { ...old, ...p, note };
    if (!has('campaign_id')) out.campaign_id = old.campaign_id ?? null;
    if (!has('original_end')) out.original_end = old.original_end ?? null;
    if (!has('method')) out.method = old.method || p.method;
    if (!has('discount_apply_mode')) out.discount_apply_mode = old.discount_apply_mode ?? null;
    if (!has('special_price')) out.special_price = old.special_price ?? null;
    if (!has('mcp_existing_name')) out.mcp_existing_name = old.mcp_existing_name ?? null;
    out.campaign = has('yoy_start', 'yoy_end', 'baseline_start', 'baseline_end', 'baseline_clean_pct', 'rep_promo') ? { ...(old.campaign || {}), ...(p.campaign || {}) } : old.campaign;
    out.tags = { ...(old.tags || {}), ...(p.tags || {}) };
    // 대상상품 — 적은 글이 같으면 지금 해석(MD가 다듬은 규칙 · 세트 구성)을 그대로 쓴다
    const t = { ...(p.target || {}) }, ot = old.target || {};
    if (rawKey(t.include) === rawKey(ot.include)) t.include = ot.include;
    if (rawKey(t.exclude) === rawKey(ot.exclude)) t.exclude = ot.exclude;
    out.target = t;
    // 할인율 — 숫자가 그대로면 원본 구조(raw)와 기입 근거를 살리고, 바뀌었으면 둘 다 버린다(옛 근거가 남지 않게)
    if (nums(p.discount) === nums(old.discount)) out.discount = old.discount;
    else { out.discount = p.discount ? { ...p.discount } : null; delete out.discount_fill; }
    if (out.start !== old.start || out.end !== old.end) out.days = Math.round((Date.parse(out.end + 'T00:00:00Z') - Date.parse(out.start + 'T00:00:00Z')) / 86400000) + 1;
    return out;
  });
  const res = { ...data, promotions, _meta: { ...((data && data._meta) || {}), carried } };
  // 이 양식에는 가격표 · 교란요인 시트가 없다 — 비어 오면 지우지 않고 지금 것을 그대로 둔다
  if (Array.isArray(res.price_detail) && !res.price_detail.length) delete res.price_detail;
  if (Array.isArray(res.events) && !res.events.length) delete res.events;
  return res;
}

// ── 3) 적재 — 스냅샷 후 전량 교체 ──────────────────────────────────────────
async function ingest(data, { source = 'manual' } = {}) {
  const v = validate(data);
  if (!v.ok) return { ok: false, ...v };

  const syncedAt = new Date().toISOString();
  const [defs, map, price, events, backup] = await Promise.all(
    [COLL.defs, COLL.map, COLL.price, COLL.events, COLL.backup].map((n) => store.collection(n)));

  // 직전 버전 스냅샷(롤백용) — 최근 5개만 보관
  const prev = await defs.find({}, { projection: { _id: 0 } }).toArray();
  if (prev.length) {
    await backup.insertOne({ at: syncedAt, source, count: prev.length, promotions: prev });
    const old = await backup.find({}, { projection: { _id: 1, at: 1 } }).sort({ at: -1 }).skip(5).toArray();
    if (old.length) await backup.deleteMany({ _id: { $in: old.map((x) => x._id) } });
  }

  const stamp = (o) => ({ ...o, _syncedAt: syncedAt, _source: source });
  await defs.deleteMany({});
  await defs.insertMany(data.promotions.map(stamp));
  try { await defs.createIndex({ promo_id: 1, mall: 1 }, { unique: true }); await defs.createIndex({ start: 1, end: 1 }); } catch (_) {}

  if (data.product_map) { await map.deleteMany({}); await map.insertOne(stamp({ _id: 'product_map', ...data.product_map })); }
  if (Array.isArray(data.price_detail)) { await price.deleteMany({}); if (data.price_detail.length) await price.insertMany(data.price_detail.map(stamp)); }
  if (Array.isArray(data.events)) { await events.deleteMany({}); if (data.events.length) await events.insertMany(data.events.map(stamp)); }

  return { ok: true, counts: v.counts, warnings: v.warnings, errors: [], syncedAt, backedUp: prev.length };
}

// 롤백 — 직전 스냅샷으로 되돌림
async function rollback() {
  const [defs, backup] = await Promise.all([store.collection(COLL.defs), store.collection(COLL.backup)]);
  const last = await backup.find({}).sort({ at: -1 }).limit(1).toArray();
  if (!last.length) return { ok: false, error: '복원할 스냅샷이 없습니다' };
  await defs.deleteMany({});
  if (last[0].promotions.length) await defs.insertMany(last[0].promotions);
  await backup.deleteOne({ _id: last[0]._id });
  return { ok: true, restored: last[0].promotions.length, at: last[0].at };
}

module.exports = { validate, diff, ingest, rollback, withCurrent, COLL, MALLS };
