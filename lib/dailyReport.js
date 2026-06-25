'use strict';

/**
 * 일일 매출 리포트(통합분석) 데이터 빌더 — 이카운트(on.orders, 출고일) 기준.
 *   리포트 HTML(Yogibo_온라인 일일매출보고)의 임베드 데이터(ds-main 등)와 동일 구조를 DB 라이브로 생성.
 *
 *   채널 4분류: 자사몰(홈페이지) · 스마트스토어 · 공동구매(〜공동구매/〜공구) · 외부채널(나머지 전부)
 *   ※ 월 목표·누적 KPI(TTL)는 3채널 합(자사몰+스마트스토어+외부채널), 공동구매 제외.
 */

const store = require('./store');
const target = require('./target');
const analytics = require('./analytics');
const promoPeriods = require('./promoPeriods');
const mallPromotions = require('./mallPromotions');
const promoTargets = require('./promoTargets');
const promoHistory = require('./promoHistory');
const productPrices = require('./productPrices');

function classifyChannel(storeName) {
  const s = String(storeName || '');
  if (s === '홈페이지') return '자사몰';
  if (s === '스마트스토어') return '스마트스토어';
  if (/공동구매|공구/.test(s)) return '공동구매';
  return '외부채널';
}
const CHANNELS = ['자사몰', '스마트스토어', '외부채널', '공동구매'];
const KPI_CHANNELS = ['자사몰', '스마트스토어', '외부채널']; // 목표/누적 TTL 대상(공동구매 제외)
// 카테고리 매핑 — group1(실제 카테고리) 기준. 리퍼 소파도 Sofa 로 잡힘(리포트와 동일).
const CAT_MAP = { 'Sofa(소파)': 'Sofa', 'Body Pillow(바디 필로우)': 'BodyPillow', 'Care(케어)': 'Care', 'Living(리빙)': 'Living', 'Kids(키즈)': 'Kids', 'Shipping(배송)': 'Shipping' };

function pad(n) { return String(n).padStart(2, '0'); }
function fmtD(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function shift(ds, { days = 0, months = 0, years = 0 }) {
  const d = new Date(ds + 'T00:00:00');
  if (years) d.setFullYear(d.getFullYear() + years);
  if (months) d.setMonth(d.getMonth() + months);
  if (days) d.setDate(d.getDate() + days);
  return fmtD(d);
}
function lastDayOfMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); }
function rate(cur, base) { return (base != null && base !== 0) ? (cur - base) / base : null; }

// ── 채널×일자 매출/주문/수량 시계열 (이카운트) — ds-main.daily ──
async function dailyChannelSeries(fromDate) {
  fromDate = fromDate || '2025-01-01';
  const on = await store.namedCollection('on', 'orders');
  const rows = await on.aggregate([
    { $match: { date: { $gte: fromDate } } },
    { $group: { _id: { date: '$date', store: '$store' }, amt: { $sum: '$amount' }, qty: { $sum: '$qty' }, orderSet: { $addToSet: '$orderNo' } } },
  ]).toArray();
  const byDate = {};
  for (const r of rows) {
    const date = String(r._id.date).slice(0, 10);
    const ch = classifyChannel(r._id.store);
    const d = byDate[date] || (byDate[date] = { Date: date, Year: +date.slice(0, 4), 자사몰: 0, 스마트스토어: 0, 외부채널: 0, 공동구매: 0, Total: 0, Qty: 0, _o: new Set() });
    d[ch] += r.amt; d.Total += r.amt; d.Qty += (r.qty || 0);
    for (const o of (r.orderSet || [])) d._o.add(o);
  }
  return Object.values(byDate)
    .map((d) => { d.Orders = d._o.size; delete d._o; for (const c of CHANNELS) d[c] = Math.round(d[c]); d.Total = Math.round(d.Total); return d; })
    .sort((a, b) => (a.Date < b.Date ? -1 : 1));
}

// 시계열에서 [s,e] 구간 채널 합 (메모리)
function sumRange(daily, s, e) {
  const out = { TTL: 0, 자사몰: 0, 스마트스토어: 0, 외부채널: 0, 공동구매: 0 };
  for (const r of daily) {
    if (r.Date < s || r.Date > e) continue;
    for (const c of CHANNELS) out[c] += r[c];
    out.TTL += KPI_CHANNELS.reduce((a, c) => a + r[c], 0); // TTL = 3채널(공구 제외)
  }
  return out;
}

// ── 월 KPI(목표/누적/달성률/MoM/YoY/트래픽기준) — ds-main.mayKPI ──
async function monthKPI(date, daily, traffic) {
  const d = String(date).slice(0, 10);
  const ym = d.slice(0, 7);
  const ms = ym + '-01';
  const cumulative = sumRange(daily, ms, d);
  const mom = sumRange(daily, shift(ms, { months: -1 }), shift(d, { months: -1 }));
  const yoy = sumRange(daily, shift(ms, { years: -1 }), shift(d, { years: -1 }));

  // 목표: cafe24/smartstore=targetStatus, 외부채널=매장별(byMall) 목표 중 외부채널 분류 합
  let tgC = 0, tgS = 0, tgE = 0;
  try { const ts = await target.targetStatus(ym); tgC = (ts.cafe24 || {}).target || 0; tgS = (ts.smartstore || {}).target || 0; } catch (_) {}
  try {
    const tc = await store.collection('targets');
    const doc = await tc.findOne({ month: ym });
    const byMall = (doc && doc.byMall) || {};
    for (const [m, v] of Object.entries(byMall)) if (classifyChannel(m) === '외부채널') tgE += (+v || 0);
  } catch (_) {}
  const ChannelTargets = { 자사몰: tgC, 스마트스토어: tgS, 외부채널: tgE, TTL: tgC + tgS + tgE };

  const totalDays = lastDayOfMonth(ym);
  const elapsed = +d.slice(8, 10);
  const remainingDays = totalDays - elapsed;
  const ChannelCumulative = { TTL: cumulative.TTL, 자사몰: cumulative.자사몰, 스마트스토어: cumulative.스마트스토어, 외부채널: cumulative.외부채널 };
  const mk = (k) => rate(cumulative[k], mom[k]);
  const yk = (k) => rate(cumulative[k], yoy[k]);

  // 트래픽 기준 평균(베이스 구간 ~ 전월말까지의 일평균)
  const baseEnd = shift(ms, { days: -1 }); // 전월 말일
  const baseRows = (traffic || []).filter((t) => t.Date <= baseEnd);
  const avg = (f) => (baseRows.length ? baseRows.reduce((a, t) => a + (t[f] || 0), 0) / baseRows.length : 0);
  const TrafficBaseAvg = {
    Visits: avg('Visits'), UniqueDaily: avg('UniqueVisits'), Unique: avg('Unique'), PVPerVisit: avg('PVPerVisit'),
    Purchases: avg('Purchases'), PurchaseAmount: avg('PurchaseAmount'), PurchaseRate: avg('PurchaseRate'), Signups: avg('Signups'),
    _BaseStart: baseRows.length ? baseRows[0].Date : null, _BaseEnd: baseEnd, _BaseDays: baseRows.length,
  };

  return {
    ChannelCumulative, CumulativeMonth: cumulative.TTL,
    ChannelTargets, TargetMonth: ChannelTargets.TTL,
    RemainingMonth: ChannelTargets.TTL - cumulative.TTL,
    RemainingAvgDaily: remainingDays > 0 ? (ChannelTargets.TTL - cumulative.TTL) / remainingDays : 0,
    Achievement: ChannelTargets.TTL ? cumulative.TTL / ChannelTargets.TTL : 0,
    AvgDaily: elapsed > 0 ? cumulative.TTL / elapsed : 0,
    ChannelMoMSheet: { TTL: mk('TTL'), 자사몰: mk('자사몰'), 스마트스토어: mk('스마트스토어'), 외부채널: mk('외부채널') },
    ChannelYoYSheet: { TTL: yk('TTL'), 자사몰: yk('자사몰'), 스마트스토어: yk('스마트스토어'), 외부채널: yk('외부채널') },
    TrafficBaseAvg,
  };
}

// ── 외부채널 사이트별 일별 — ds-main.vendorDaily { date: [{vendor, qty, amt}] } ──
async function vendorDailyMap(fromDate) {
  fromDate = fromDate || '2025-01-01';
  const on = await store.namedCollection('on', 'orders');
  const rows = await on.aggregate([
    { $match: { date: { $gte: fromDate } } },
    { $group: { _id: { date: '$date', store: '$store' }, amt: { $sum: '$amount' }, qty: { $sum: '$qty' } } },
    { $sort: { amt: -1 } },
  ]).toArray();
  const out = {};
  for (const r of rows) {
    const date = String(r._id.date).slice(0, 10);
    const name = r._id.store === '홈페이지' ? '자사몰' : r._id.store;
    (out[date] = out[date] || []).push({ vendor: name, qty: r.qty || 0, amt: Math.round(r.amt) });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => b.amt - a.amt);
  return out;
}

// ── 월 카테고리별 매출(전 채널, 이카운트) — ds-main.categories ──
async function monthCategories(date) {
  const d = String(date).slice(0, 10); const ms = d.slice(0, 7) + '-01';
  const on = await store.namedCollection('on', 'orders');
  const rows = await on.aggregate([
    { $match: { date: { $gte: ms, $lte: d } } },
    { $group: { _id: '$group1', amt: { $sum: '$amount' } } },
  ]).toArray();
  const out = { Care: 0, Living: 0, Kids: 0, ETC: 0, Shipping: 0, Sofa: 0, BodyPillow: 0 };
  for (const r of rows) { const k = CAT_MAP[r._id] || 'ETC'; out[k] += Math.round(r.amt); }
  return out;
}

// ── 당일 채널 프로모션 판매 성과(자사몰/스마트스토어) — ds-main.promo ──
async function dayPromo(date) {
  const d = String(date).slice(0, 10);
  const on = await store.namedCollection('on', 'orders');
  const mk = async (storeName) => {
    const r = await on.aggregate([
      { $match: { store: storeName, date: d } },
      { $group: { _id: null, amt: { $sum: '$amount' }, o: { $addToSet: '$orderNo' } } },
    ]).toArray();
    return r[0] ? { Amount: Math.round(r[0].amt), Count: r[0].o.length } : { Amount: 0, Count: 0 };
  };
  return { 자사몰: await mk('홈페이지'), 스마트스토어: await mk('스마트스토어') };
}

// ── 트래픽 일별(자사몰, Cafe24) — DB 캐시(traffic_daily) 기반 ──
const TRAFFIC_COLL = 'traffic_daily';

async function ordersByDateRaw(s, e) {
  const c = await store.collection('orders_raw');
  const r = await c.aggregate([
    { $match: { order_date: { $gte: s, $lte: e }, paid: true, canceled: false } },
    { $group: { _id: '$order_date', orders: { $sum: 1 }, revenue: { $sum: '$payment_amount' } } },
  ]).toArray();
  const out = {}; for (const x of r) out[x._id] = { orders: x.orders, revenue: Math.round(x.revenue) }; return out;
}
// /visitors/view 는 1년 초과 400 → ≤360일 윈도우로 분할
async function dailyVisitorsChunked(start, end) {
  const out = []; let s = new Date(start + 'T00:00:00'); const last = new Date(end + 'T00:00:00');
  while (s <= last) {
    const e = new Date(Math.min(last.getTime(), s.getTime() + 360 * 86400000));
    out.push(...(await analytics.dailyVisitors(fmtD(s), fmtD(e), 'total').catch(() => [])));
    s = new Date(e.getTime() + 86400000);
  }
  return out;
}
// traffic_daily 적재(갱신) — 방문/PV/주문/가입을 DB에 캐시. 오늘 이전 날만 저장(오늘은 미완료).
async function refreshTrafficDaily(fromDate) {
  fromDate = fromDate || '2025-01-01';
  const today = fmtD(new Date());
  const [visitsArr, pvMap, signupMap, ordMap] = await Promise.all([
    dailyVisitorsChunked(fromDate, today),
    analytics.dailyPV(fromDate, today),
    analytics.dailySignups(fromDate, today),
    ordersByDateRaw(fromDate, today),
  ]);
  const vBy = Object.fromEntries(visitsArr.map((r) => [r.date, r.visits]));
  const c = await store.collection(TRAFFIC_COLL);
  try { await c.createIndex({ date: 1 }, { unique: true }); } catch (_) {}
  const dates = new Set([...Object.keys(vBy), ...Object.keys(pvMap), ...Object.keys(signupMap), ...Object.keys(ordMap)]);
  const ops = [];
  let visitsMissing = 0, pvMissing = 0;
  for (const d of dates) {
    if (d >= today) continue; // 오늘은 미완료
    const o = ordMap[d] || {};
    const set = { date: d, orders: o.orders || 0, revenue: o.revenue || 0, signups: signupMap[d] || 0, _at: new Date().toISOString() };
    const update = { $set: set };
    const onInsert = {};
    // 방문수: Cafe24 통계 API가 값을 준 경우에만 기록. 호출 실패/빈값(0)이면 기존 값을 덮어쓰지 않음(clobber 방지).
    // (방문 통계는 PV/주문/가입과 별도 API라, 방문만 일시 실패해도 0으로 덮여 사라지던 버그 차단)
    if (vBy[d] > 0) set.visits = vBy[d];
    else { onInsert.visits = 0; visitsMissing++; }
    // PV도 동일하게 no-clobber. /pages/view 통계가 일시적으로 0을 주면(미완성 시점) 기존 PV가 0으로 덮이던 버그 차단.
    if (pvMap[d] > 0) set.pv = pvMap[d];
    else { onInsert.pv = 0; pvMissing++; }
    if (Object.keys(onInsert).length) update.$setOnInsert = onInsert;
    ops.push({ updateOne: { filter: { date: d }, update, upsert: true } });
  }
  if (ops.length) await c.bulkWrite(ops, { ordered: false });
  if (visitsMissing) console.warn(`[refreshTrafficDaily] 방문수 미수집 ${visitsMissing}일 — 기존 값 보존(덮어쓰지 않음)`);
  if (pvMissing) console.warn(`[refreshTrafficDaily] PV 미수집 ${pvMissing}일 — 기존 값 보존(덮어쓰지 않음)`);
  return { from: fromDate, to: today, days: ops.length, visitsMissing, pvMissing };
}
// ds-main.traffic — traffic_daily(DB)에서 읽음. 거의 DB 기반이며, 최근 며칠 visits=0 만 라이브 보정.
async function trafficSeries(fromDate) {
  fromDate = fromDate || '2025-01-01';
  const c = await store.collection(TRAFFIC_COLL);
  const rows = await c.find({ date: { $gte: fromDate } }, { projection: { _id: 0 } }).sort({ date: 1 }).toArray();
  // 자가치유: 최근 5일(완성일) 중 visits=0 인 날은 라이브 Cafe24 방문수로 보정 + DB 갱신.
  //   야간 동기화(cloudtype 구버전)가 visits를 0으로 덮어써도, 리포트를 열면 스스로 복구된다.
  //   값이 채워지면 다음 호출부턴 0이 없어 라이브 호출도 안 함(자기제한적).
  try {
    const today = fmtD(new Date());
    const lo = fmtD(new Date(Date.now() - 5 * 86400000));
    // 최근 5일(완성일) 중 visits=0 또는 pv=0 인 날을 라이브 Cafe24 통계로 보정 + DB 갱신.
    //   야간 동기화가 visits/pv 를 0으로 덮어써도, 리포트를 열면 스스로 복구된다(자기제한적: 채워지면 다음부턴 호출 안 함).
    const visitZero = rows.filter((r) => r.date >= lo && r.date < today && !r.visits);
    const pvZero = rows.filter((r) => r.date >= lo && r.date < today && !r.pv);
    if (visitZero.length || pvZero.length) {
      const [live, pvMap] = await Promise.all([
        visitZero.length ? analytics.dailyVisitors(lo, today, 'total').catch(() => []) : Promise.resolve([]),
        pvZero.length ? analytics.dailyPV(lo, today).catch(() => ({})) : Promise.resolve({}),
      ]);
      const vBy = Object.fromEntries(live.map((x) => [x.date, x.visits]));
      const byDate = {}; // 날짜별 보정 필드 모으기
      for (const r of visitZero) { const v = vBy[r.date]; if (v > 0) { r.visits = v; (byDate[r.date] = byDate[r.date] || {}).visits = v; } }
      for (const r of pvZero) { const p = pvMap[r.date]; if (p > 0) { r.pv = p; (byDate[r.date] = byDate[r.date] || {}).pv = p; } }
      const ops = Object.entries(byDate).map(([date, fields]) => ({ updateOne: { filter: { date }, update: { $set: { ...fields, _at: new Date().toISOString() } } } }));
      if (ops.length) { await c.bulkWrite(ops, { ordered: false }); console.warn(`[trafficSeries] 방문/PV 자가치유 ${ops.length}일`); }
    }
  } catch (_) { /* 라이브 실패 시 DB값 그대로 사용 */ }
  return rows.map((r) => ({
    Date: r.date, Visits: r.visits, PageViews: r.pv, PVPerVisit: r.visits ? +(r.pv / r.visits).toFixed(1) : 0,
    UniqueVisits: r.visits, Unique: r.visits, // 유니크 별도 수집 전까지 방문수로 대체
    Purchases: r.orders, PurchaseAmount: r.revenue, PurchaseRate: r.visits ? +(r.orders / r.visits).toFixed(4) : 0,
    Signups: r.signups, SignupRate: r.visits ? r.signups / r.visits : 0,
  }));
}

// ── ds-main 조립 ──
async function buildMain(date) {
  const fromDate = '2025-01-01';
  const d10 = String(date).slice(0, 10);
  const promoFrom = fmtD(new Date(new Date(d10 + 'T00:00:00').getTime() - 40 * 86400000)); // 당일 KPI(전일비 포함)용 최근 ~40일
  const [daily, traffic, vendorDaily, categories, promo, promoDaily] = await Promise.all([
    dailyChannelSeries(fromDate),
    trafficSeries(fromDate),
    vendorDailyMap(fromDate),
    monthCategories(date),
    dayPromo(date),
    productPrices.promoDiscountDaily(promoFrom, d10).catch(() => ({})),
  ]);
  const mayKPI = await monthKPI(date, daily, traffic);
  return { latestDate: d10, daily, traffic, mayKPI, promo, may06Detail: [], categories, vendorDaily, promoDaily };
}

// ── ds-products (상품 컬럼인코딩) — 베스트상품·판매량·충전재 탭용 ──
//   r 컬럼: [year, dIdx, chIdx, catIdx(group1), itIdx, pIdx(promo), amt, qty, orders, beadIdx, cat2Idx, srcIdx]
const BEAD_MAP = { Standard: 'S', Premium: 'SPre', 'Premium Plus': 'SPre+' };
async function buildProducts(fromDate) {
  fromDate = fromDate || '2025-01-01';
  const on = await store.namedCollection('on', 'orders');
  const rows = await on.aggregate([
    { $match: { date: { $gte: fromDate } } },
    { $group: {
      _id: { date: '$date', store: '$store', g1: '$group1', item: '$productName', bead: '$beadType', cat: '$category' },
      amt: { $sum: '$amount' }, qty: { $sum: '$qty' }, oset: { $addToSet: '$orderNo' },
    } },
  ]).toArray();

  const promos = (await promoPeriods.listPromos().catch(() => [])) || [];
  const promoFor = (date) => { for (const p of promos) if (p.start && p.end && date >= p.start && date <= p.end) return p.name; return ''; };

  const d = [], ch = [], cat = [], it = [], p = [''], b = [''], s = [], cat2 = [''];
  const mD = new Map(), mCh = new Map(), mCat = new Map(), mIt = new Map(), mP = new Map([['', 0]]), mB = new Map([['', 0]]), mS = new Map(), mC2 = new Map([['', 0]]);
  const idx = (arr, v, m) => { const k = v == null ? '' : String(v); let i = m.get(k); if (i == null) { i = arr.length; arr.push(k); m.set(k, i); } return i; };

  const r = [];
  for (const row of rows) {
    const date = String(row._id.date).slice(0, 10);
    const channel = classifyChannel(row._id.store);
    const beadName = BEAD_MAP[row._id.bead] || '';
    const src = row._id.cat === '리퍼' ? '리퍼' : channel;
    r.push([
      +date.slice(0, 4),
      idx(d, date, mD), idx(ch, channel, mCh), idx(cat, row._id.g1 || 'ETC', mCat),
      idx(it, (row._id.item || '').trim(), mIt), idx(p, promoFor(date), mP),
      Math.round(row.amt), row.qty || 0, (row.oset || []).length,
      idx(b, beadName, mB), idx(cat2, row._id.cat || '', mC2), idx(s, src, mS),
    ]);
  }
  return { d, ch, cat, it, p, b, s, cat2, r };
}

// ── ds-promo (프로모션 성과 리뷰) — 할인율별 ──
//   과거(2026-06 이전, 이전 작업분) = MD 정본(promo_history, 어드민 수기 분류). 고정값.
//   우리 운영분(2026-06~) = 정상가 대비 할인율 역산으로 "할인 발생분"을 자동 집계(promoDiscountBreakdown).
//     · 자사몰: product_prices(역산 정상가) · 스토어: SmartStore product_amount(정상가) 대비 실판매.
//     · 정가(≈0%)·이상치 제외. 즉 "프로모션 기간 중 할인율이 발생한 매출"만 프로모션 성과로 잡는다.
async function buildPromo(date) {
  date = String(date || fmtD(new Date())).slice(0, 10);
  const [mdPromos, mdProducts, tgts] = await Promise.all([promoHistory.listPromos(), promoHistory.listProducts(), promoTargets.listTargets().catch(() => [])]);
  const CUT = promoHistory.MD_CUTOFF; // '2026-06-01'
  // 1) 과거 = MD 정본(2026-06 이전 시작분만)
  const pastPromos = mdPromos.filter((p) => p.Start < CUT);
  const pastNames = new Set(pastPromos.map((p) => p.Name));
  const promos = pastPromos.map((p) => ({ ...p, src: 'md' }));
  const products = mdProducts.filter((x) => pastNames.has(x.Promo)).map((x) => ({ ...x }));
  // 2) 우리 운영분(2026-06~) — 전사프로모션(자사몰+스토어)별 할인율 자동 집계.
  //    scope='외부몰'(롯데홈쇼핑 앵콜 등)은 이카운트라 할인율 역산 불가 → 제외.
  const live = (tgts || []).filter((t) => t.start && t.end && t.start >= CUT && t.start <= date && (t.scope || '전사') === '전사');
  for (const pr of live) {
    const me = pr.end < date ? pr.end : date;
    if (me < pr.start) continue;
    let bd; try { bd = await productPrices.promoDiscountBreakdown(pr.start, me); } catch (_) { continue; }
    for (const t of bd.tiers) {
      if (!t.Amount) continue;
      promos.push({ Name: `${pr.name} - ${t.rate}%`, Start: pr.start, End: pr.end,
        Amount: t.Amount, Qty: (t.JaQty || 0) + (t.SsQty || 0), Orders: t.Orders,
        JaAmount: t.JaAmount, SsAmount: t.SsAmount, JaOrders: t.JaOrders, SsOrders: t.SsOrders, JaQty: t.JaQty, SsQty: t.SsQty, src: 'auto', rate: t.rate, promoName: pr.name });
    }
  }
  promos.sort((a, b) => (a.Start < b.Start ? -1 : a.Start > b.Start ? 1 : 0));
  return { promos, products, autoFrom: CUT };
}

// ── TARGET_CONFIG (목표 설정) — 전부 DB에서 생성(하드코딩 제거) ──
//   monthly: 월별 채널 목표(lib/target) · promotions: mall_promotions 를 name+기간으로 묶은 전사 프로모션 목표
async function externalTargetSum(ym) {
  let tgE = 0;
  try {
    const tc = await store.collection('targets');
    const doc = await tc.findOne({ month: ym });
    const byMall = (doc && doc.byMall) || {};
    for (const [m, v] of Object.entries(byMall)) if (classifyChannel(m) === '외부채널') tgE += (+v || 0);
  } catch (_) {}
  return tgE;
}
async function buildTargetConfig() {
  const monthly = {};
  let tlist = [];
  try { tlist = await target.listTargets(); } catch (_) {}
  for (const t of (tlist || [])) {
    const ym = t.month; if (!ym) continue;
    const ca = +t.cafe24 || 0, ss = +t.smartstore || 0, ext = await externalTargetSum(ym);
    monthly[ym] = { total: ca + ss + ext, channels: { 자사몰: ca, 스마트스토어: ss, 외부채널: ext } };
  }
  // 프로모션: promo_targets (전사 프로모션 목표 — 채널별 목표 + 트래픽, 한 폼에서 입력)
  let pts = [];
  try { pts = await promoTargets.listTargets(); } catch (_) {}
  const promotions = (pts || []).map((p) => {
    const tt = p.trafficTargets || {};
    const hasTraffic = tt.visits || tt.signups || tt.purchaseRate;
    const ch = p.channels || {};
    return {
      id: p.id, name: p.name, start: p.start, end: p.end, promoNameMatch: p.name,
      trafficTargets: hasTraffic ? { scope: '자사몰', avgVisitsPerDay: tt.visits || 0, avgSignupsPerDay: tt.signups || 0, purchaseRate: tt.purchaseRate || 0, signupRate: tt.signupRate || 0 } : null,
      channels: { 자사몰: { target: ch.자사몰 || 0 }, 스마트스토어: { target: ch.스마트스토어 || 0 }, 외부채널: { target: ch.외부채널 || 0 } },
    };
  });
  return { monthly, promotions };
}

// 외부채널 사이트별 목표(EXT_CHANNELS) — byMall(매장별 목표)에서. cum/mom/yoy 는 리포트가 vendorDaily(DB)로 계산하므로 target 만 채움.
async function buildExtChannels(date) {
  const ym = String(date).slice(0, 7);
  let byMall = {};
  try { const c = await store.collection('targets'); const doc = await c.findOne({ month: ym }); byMall = (doc && doc.byMall) || {}; } catch (_) {}
  return Object.entries(byMall)
    .filter(([m]) => classifyChannel(m) === '외부채널')
    .map(([name, target]) => ({ name, target: +target || 0, cum: 0, mom: null, yoy: null }))
    .sort((a, b) => b.target - a.target);
}

// ── 리포트 데이터(ds-main/products/promo/traffic + TARGET_CONFIG + EXT_CHANNELS) 조립 — 전부 DB ──
async function buildReport(date) {
  const [main, products, promo, targetConfig, extChannels] = await Promise.all([
    buildMain(date),
    buildProducts('2025-01-01'),
    buildPromo(date),
    buildTargetConfig(),
    buildExtChannels(date),
  ]);
  return { main, traffic: main.traffic, products, promo, targetConfig, extChannels };
}

module.exports = { classifyChannel, CHANNELS, dailyChannelSeries, buildMain, buildReport, buildProducts, buildPromo, buildTargetConfig, buildExtChannels, monthKPI, vendorDailyMap, monthCategories, dayPromo, trafficSeries, refreshTrafficDaily };
