'use strict';

/**
 * 프로모션 성과 귀속 — MD 제출 정의(promo_defs)의 "대상 상품"이 그 "기간"에 실제로 얼마나 팔렸는지 집계.
 *   전 몰 동일 경로(이카운트 원장 상품매칭): 자사몰=on.orders{홈페이지} · 스마트스토어=on.orders{스마트스토어} · 오프라인=off.orders
 *
 *   ⚠️ 과거 자사몰만 "연결쿠폰 실사용" 기준이었는데, 2026-07부터 자사몰이 즉시할인으로 전환되며
 *      쿠폰 매칭 커버리지가 0%가 되어 자사몰 프로모션 매출이 전부 0원으로 집계됐다.
 *      → 쿠폰 경로를 폐기하고 전 몰을 대상상품 매칭으로 통일(이 파일의 핵심 수정).
 *   결과 = 프로모션별 {매출, 수량, 주문수}. 성과 수치는 저장하지 않고 조회 때마다 원장에서 계산한다.
 */

const store = require('./store');
const mallPromos = require('./mallPromotions');
const otherChannels = require('./otherChannels');
const promoDefs = require('./promoDefs');
const promoTarget = require('./promoTarget');

const PAID_SS = ['PAYED', 'DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED', 'EXCHANGED'];
const Z = { sales: 0, qty: 0, orders: 0 };

async function cafe24Matched(productNos, start, end) {
  if (!productNos.length) return { ...Z };
  const c = await store.collection('orders_raw');
  const r = await c.aggregate([
    { $match: { order_date: { $gte: start, $lte: end }, paid: true, canceled: false } },
    { $unwind: '$items' },
    { $match: { 'items.product_no': { $in: productNos } } },
    { $group: { _id: null, sales: { $sum: '$items.payment_amount' }, qty: { $sum: '$items.quantity' }, ord: { $addToSet: '$order_id' } } },
  ]).toArray();
  const t = r[0] || { sales: 0, qty: 0, ord: [] };
  return { sales: Math.round(t.sales || 0), qty: t.qty || 0, orders: (t.ord || []).length };
}

async function smartstoreMatched(names, start, end) {
  if (!names.length) return { ...Z };
  try {
    const c = await store.collection('smartstore_orders');
    const r = await c.aggregate([
      { $match: { order_date: { $gte: start, $lte: end }, canceled: { $ne: true }, status: { $in: PAID_SS }, product_name: { $in: names } } },
      { $group: { _id: null, sales: { $sum: '$payment_amount' }, qty: { $sum: '$quantity' }, ord: { $addToSet: '$order_id' } } },
    ]).toArray();
    const t = r[0] || { sales: 0, qty: 0, ord: [] };
    return { sales: Math.round(t.sales || 0), qty: t.qty || 0, orders: (t.ord || []).length };
  } catch (_) { return { ...Z }; }
}

async function groupMatched(group, names, start, end) {
  if (!names.length) return { ...Z };
  const c = await store.namedCollection('on', 'orders');
  const r = await c.aggregate([
    { $match: { date: { $gte: start, $lte: end }, productName: { $in: names } } },
    { $group: { _id: '$store', sales: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } },
  ]).toArray();
  let sales = 0, qty = 0; const ordSet = new Set();
  for (const x of r) {
    if (otherChannels.groupOf(x._id) !== group) continue;
    sales += x.sales; qty += x.qty;
    for (const o of (x.ord || [])) { if (o != null) ordSet.add(o); }
  }
  return { sales: Math.round(sales), qty, orders: ordSet.size };
}

// ── MD 정의 기준 상품매칭 (전 몰 공통) ───────────────────────────────────────
//   target(scope/include/exclude) → 대상 상품명 집합 → 해당 몰 원장에서 기간 매출 집계.
//   set 스펙이 있으면 "동일 주문에서 구성품 동시구매"한 주문만 인정.
async function matchByTarget(mall, def, start, end) {
  const s = String(start || def.start).slice(0, 10), e = String(end || def.end).slice(0, 10);
  const r = await promoTarget.resolveTarget(def.target, mall, e);
  const { db, store: st } = r.ctx.ledger;
  const c = await store.namedCollection(db, 'orders');

  const match = { date: { $gte: s, $lte: e }, group1: { $in: promoTarget.PRODUCT_GROUPS } };
  if (st) match.store = st;
  if (!r.allProducts) {
    if (!r.names.length) return { ...Z, note: '대상 상품이 원장에서 매칭되지 않음(단종·미판매)' };
    match.productName = { $in: r.names };
  }

  // 세트: 주문 단위로 구성품 동시구매 판정
  if (r.setSpecs.length) {
    const rows = await c.find(match, { projection: { _id: 0, orderNo: 1, productName: 1, qty: 1, amount: 1 } }).toArray();
    const byOrder = new Map();
    for (const x of rows) { if (!byOrder.has(x.orderNo)) byOrder.set(x.orderNo, []); byOrder.get(x.orderNo).push(x); }
    let sales = 0, qty = 0; const ord = new Set();
    for (const [no, items] of byOrder) {
      const names = new Set(items.map((x) => x.productName));
      const ok = r.setSpecs.some((spec) => spec.every((k) => [...names].some((n) => (r.ctx.nameToKey.get(n) === k))));
      if (!ok) continue;
      for (const x of items) { sales += x.amount || 0; qty += x.qty || 0; }
      ord.add(no);
    }
    return { sales: Math.round(sales), qty, orders: ord.size, 기준: '세트 동시구매' };
  }

  const agg = await c.aggregate([
    { $match: match },
    { $group: { _id: null, sales: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } },
  ]).toArray();
  const t = agg[0] || { sales: 0, qty: 0, ord: [] };
  return { sales: Math.round(t.sales || 0), qty: t.qty || 0, orders: (t.ord || []).length, 대상상품수: r.allProducts ? '전제품' : r.names.length };
}

async function matchedSales(mall, promo, start, end) {
  start = start || promo.start; end = end || promo.end; // 구간 지정 시 그 구간으로(통합분석)
  if (mall === '자사몰') {
    const nos = (promo.products || []).filter((p) => p.source !== 'smartstore').map((p) => String(p.productNo)).filter(Boolean);
    return cafe24Matched(nos, start, end);
  }
  const names = (promo.products || []).map((p) => p.productName).filter(Boolean);
  if (mall === '스마트스토어') return smartstoreMatched(names, start, end);
  return groupMatched(mall, names, start, end); // 기타 그룹
}

// 한 몰의 모든 프로모션 성과
async function forMall(mall) {
  if (!mall) return { mall: '', promotions: [] };
  const promos = await mallPromos.listPromotions(mall);
  const out = [];
  for (const p of promos) {
    const m = await matchedSales(mall, p);
    out.push({ id: p.id, name: p.name, start: p.start, end: p.end, products: (p.products || []).length, matchBy: mall === '자사몰' ? '상품번호' : '상품명', ...m });
  }
  return { mall, promotions: out };
}

// 통합분석용 — 그 기간(start~end)에 진행된 전 몰 프로모션 + 성과.
//   MD 정의(promo_defs) 기준. 전 몰 대상상품 매칭(쿠폰 기준 폐기). 매출/주문은 '프로모션 기간 ∩ 선택 구간'.
async function allForPeriod(start, end) {
  const defs = await promoDefs.listDefs(start && end ? { start, end } : {});
  const ranged = !!(start && end);
  const rows = [];
  for (const d of defs) {
    const aStart = ranged && d.start < start ? start : d.start;
    const aEnd = ranged && d.end > end ? end : d.end;
    let perf;
    try { perf = await matchByTarget(d.mall, d, aStart, aEnd); }
    catch (e) { perf = { ...Z, error: String(e.message).slice(0, 80) }; }
    rows.push({
      promo_id: d.promo_id, mall: d.mall, name: d.name, 유형: d.promo_type || '',
      start: d.start, end: d.end, periodStart: aStart, periodEnd: aEnd,
      범위: (d.target && d.target.scope) || '', 목표매출: d.target_sales != null ? d.target_sales : null,
      ...perf,
      ...(d.target_sales > 0 && perf.sales != null ? { 달성률_pct: +((perf.sales / d.target_sales) * 100).toFixed(1) } : {}),
    });
  }
  rows.sort((a, b) => b.sales - a.sales);
  const totals = rows.reduce((t, r) => { t.sales += r.sales; t.orders += r.orders; return t; }, { sales: 0, orders: 0, count: rows.length });

  // 같은 몰에서 기간이 겹치는 프로모션이 있으면 합계가 이중계상된다(예: 전제품 프로모션 + 그 안의 품목특가).
  //   프로모션별 수치는 각각 맞지만 totals 합산은 중복 — 오해하지 않도록 명시한다.
  const overlaps = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      if (a.mall !== b.mall) continue;
      if (a.periodStart <= b.periodEnd && b.periodStart <= a.periodEnd) overlaps.push(`${a.mall}: "${a.name}" ↔ "${b.name}"`);
    }
  }

  const out = { start: start || null, end: end || null, 기준: '대상상품 매칭(MD 제출 정의) · 이카운트 원장(자사몰=홈페이지)', totals, promotions: rows };
  if (overlaps.length) out.합계주의 = `기간이 겹치는 프로모션 ${overlaps.length}쌍 — totals는 중복 합산됨(프로모션별 수치는 정확). ${overlaps.slice(0, 3).join(' / ')}`;
  // 빈 결과는 "조회 실패"가 아니라 "등록된 프로모션 없음"임을 명시 — LLM이 오해하지 않도록.
  if (!rows.length) {
    const st = await promoDefs.status();
    out.note = st.적재 ? (ranged ? '이 기간에 등록된(겹치는) 프로모션이 없습니다 — 성과가 아니라 등록 자체가 없음.' : '등록된 프로모션이 없습니다.')
      : '프로모션 정의가 적재되지 않았습니다 — 대시보드에서 엑셀을 업로드하세요.';
  }
  return out;
}

module.exports = { forMall, allForPeriod };
