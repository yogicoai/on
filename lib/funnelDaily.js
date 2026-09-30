'use strict';

/**
 * 일일 퍼널 점검 — 데이터 계층.
 *
 *   화면(자사몰_스마트스토어_일일퍼널점검.html)이 쓰는 {mall, ss, cfg} 를 만들어 준다.
 *   원래 그 HTML 안에 값이 하드코딩돼 있어 MD가 매번 파일을 다시 만들어야 했다(8/26에서 33일 방치됨).
 *
 *   출처가 둘로 나뉜다 — 이게 이 모듈의 핵심이다.
 *     · 우리가 이미 매일 자동으로 갖는 것 → 그대로 쓴다. MD가 입력할 필요 없다.
 *         자사몰 방문시작·주문완료·순매출 = traffic_daily (Cafe24 통계 API, 매일 갱신)
 *         스토어 유입수 = on.bizInflow (비즈어드바이저)   스토어 매출 = on.orders
 *     · 이프두에만 있어 우리가 못 얻는 것 → MD가 엑셀로 올린다(funnel_mall_daily).
 *         상품조회 · 장바구니조회 · 주문서작성
 *
 *   ⚠️ 지표 정의가 출처마다 다르다. 섞으면 목표 대비 성과가 왜곡된다.
 *      이프두 '방문시작' vs 우리 traffic_daily.visits — 582일 실측 합계 0.894배(우리가 11% 많음),
 *      일별로 ±10% 안에 드는 날이 53%뿐이다. 그래서 MD가 올린 이프두 값을 저장해 두고
 *      화면·업로드에서 **대조만** 한다(계산은 한쪽 기준으로만).
 */

const store = require('./store');

const COLL = { mall: 'funnel_mall_daily', store: 'funnel_store_daily', cfg: 'funnel_config', ai: 'funnel_ai_daily' };
const PRODUCT_GROUPS = ['Care(케어)', 'Sofa(소파)', 'Kids(키즈)', 'Living(리빙)', 'Body Pillow(바디 필로우)'];
const R = (n) => Math.round(n || 0);
const ymd = (s) => String(s || '').slice(0, 10);

// MD 요청서의 벤치마크(성과가 가장 좋았던 기준월: 자사몰 2025-10 · 스토어 2025-11).
//   DB에 저장해 두고 필요할 때 바꾼다 — 바꾸면 퍼널 단계 목표가 통째로 달라지므로 기본값은 요청서 그대로.
const DEFAULT_BENCH = {
  mall: { viewRate: 63.4597, cartRate: 4.1919, orderRate: 3.8490, doneRate: 1.9228, aov: 225000, cancelPct: 10 },
  ss: { rate: 3.08, rateSrc: '2025-11', perOrder: 160661, perOrderSrc: '2025-11' },
};

async function coll(k) { return store.collection(COLL[k]); }

// ── 저장 — 파일에 있는 날짜만 덮어쓰고 나머지는 보존(전체 교체 아님) ──────────
//   MD가 이번 주치만 올려도 지난 데이터가 날아가지 않는다. 밀린 날짜 일괄 입력도 같은 경로.
async function saveRows(kind, rows, source) {
  if (!Array.isArray(rows) || !rows.length) return { saved: 0, dates: [] };
  const c = await coll(kind);
  try { await c.createIndex({ date: 1 }, { unique: true }); } catch (_) {}
  const at = new Date().toISOString();
  const ops = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(ymd(r.date))).map((r) => ({
    updateOne: {
      filter: { date: ymd(r.date) },
      update: { $set: { ...r, date: ymd(r.date), _src: source || 'excel', _at: at } },
      upsert: true,
    },
  }));
  if (!ops.length) return { saved: 0, dates: [] };
  await c.bulkWrite(ops, { ordered: false });
  return { saved: ops.length, dates: ops.map((o) => o.updateOne.filter.date).sort() };
}

async function rowsIn(kind, from, to) {
  const c = await coll(kind);
  const q = from && to ? { date: { $gte: ymd(from), $lte: ymd(to) } } : {};
  return c.find(q, { projection: { _id: 0 } }).sort({ date: 1 }).toArray();
}

// ── 우리 DB 쪽(자동) ────────────────────────────────────────────────────────
async function trafficMap(from, to) {
  const c = await store.collection('traffic_daily');
  const r = await c.find({ date: { $gte: from, $lte: to } }, { projection: { _id: 0, date: 1, visits: 1, orders: 1, revenue: 1 } }).toArray();
  return new Map(r.map((x) => [x.date, x]));
}
async function storeInflowMap(from, to) {
  const c = await store.namedCollection('on', 'bizInflow');
  const r = await c.aggregate([{ $match: { date: { $gte: from, $lte: to } } },
    { $group: { _id: '$date', v: { $sum: '$inflow' } } }]).toArray();
  return new Map(r.map((x) => [x._id, x.v]));
}
// 스토어 매출·주문 — 이카운트 원장(상품매출만, 반품은 음수로 차감된 순매출)
async function storeSalesMap(from, to) {
  const c = await store.namedCollection('on', 'orders');
  const r = await c.aggregate([
    { $match: { date: { $gte: from, $lte: to }, store: '스마트스토어', group1: { $in: PRODUCT_GROUPS } } },
    { $group: { _id: '$date', a: { $sum: '$amount' }, ord: { $addToSet: '$orderNo' } } },
  ]).toArray();
  return new Map(r.map((x) => [x._id, { amt: R(x.a), orders: (x.ord || []).filter(Boolean).length }]));
}

async function getCfgDoc() {
  const c = await coll('cfg');
  const d = await c.findOne({ _id: 'bench' });
  return d && d.bench ? d.bench : DEFAULT_BENCH;
}
async function setBench(bench) {
  const c = await coll('cfg');
  await c.updateOne({ _id: 'bench' }, { $set: { bench, _at: new Date().toISOString() } }, { upsert: true });
  return bench;
}

// 월 목표 — 매출보고가 쓰는 targets 컬렉션을 그대로 쓴다(화면 두 개가 다른 목표를 보지 않게).
async function targetsMap() {
  const c = await store.collection('targets');
  const rows = await c.find({}, { projection: { _id: 0, month: 1, cafe24: 1, smartstore: 1 } }).toArray();
  const mall = {}, ss = {};
  for (const t of rows) {
    if (!t.month) continue;
    if (t.cafe24) mall[t.month] = { net: Number(t.cafe24) };
    if (t.smartstore) ss[t.month] = { net: Number(t.smartstore) };
  }
  return { mall, ss };
}

// 일 목표 — 화면 targetsFor(funnel_daily.html)와 같은 공식. 월 순매출 목표 → (취소율·객단가) → 목표 주문
//   → (구매전환율) → 목표 유입 → 단계 비율, 월 ÷ 일수. 목표가 없는 달은 null.
const daysInMonth = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
function targetsFor(cfg, ch, ym) {
  const t = cfg.targets[ch] && cfg.targets[ch][ym];
  if (!t) return null;
  const d = daysInMonth(ym);
  if (ch === 'mall') {
    const B = cfg.benchMall;
    const mGross = t.net / (1 - B.cancelPct / 100), mDone = mGross / B.aov, mVisit = mDone / (B.doneRate / 100);
    return { days: d, mNet: t.net, net: t.net / d, visit: mVisit / d, view: (mVisit * B.viewRate) / 100 / d, cart: (mVisit * B.cartRate) / 100 / d,
      order: (mVisit * B.orderRate) / 100 / d, done: mDone / d };
  }
  const B = cfg.benchSS;
  const mOrders = t.net / B.perOrder, mVisit = mOrders / (B.rate / 100);
  return { days: d, mNet: t.net, net: t.net / d, visit: mVisit / d, orders: mOrders / d };
}

// 저장된 AI 분석(funnelAi) → 화면 renderAI 형식 [{ch,date,level,headline,points,model,createdAt}] — 최근 14일
async function recentAnalyses(to) {
  try {
    const c = await coll('ai');
    const docs = await c.find(to ? { date: { $lte: to } } : {}, { projection: { _id: 0 } }).sort({ date: -1 }).limit(14).toArray();
    const out = [];
    for (const d of docs) for (const ch of ['mall', 'ss']) {
      const a = d[ch]; if (!a || !a.headline) continue;
      out.push({ ch, date: d.date, level: a.level, headline: a.headline, points: a.points || [], model: d.model, createdAt: d.createdAt });
    }
    return out;
  } catch (_) { return []; }
}

/**
 * 화면이 먹는 형태로 조립 — { mall, ss, cfg }.
 *   mall: [일자, 방문시작, 상품조회, 장바구니조회, 주문서작성, 주문완료]
 *   ss  : [일자, 유입수, 주문건수, 구매율%, 매출]
 */
async function buildDb({ from = '2025-01-01', to } = {}) {
  to = to || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const [mallIn, storeIn, traffic, inflow, ssSales, bench, targets, analyses] = await Promise.all([
    rowsIn('mall', from, to), rowsIn('store', from, to),
    trafficMap(from, to), storeInflowMap(from, to), storeSalesMap(from, to),
    getCfgDoc(), targetsMap(), recentAnalyses(to),
  ]);
  const mIn = new Map(mallIn.map((x) => [x.date, x]));
  const sIn = new Map(storeIn.map((x) => [x.date, x]));

  const mall = [];
  const netDaily = [];
  for (const [date, t] of [...traffic.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const i = mIn.get(date) || {};
    // 방문시작·주문완료는 우리 값을 기준으로 쓴다(매일 자동). MD 입력분은 대조용으로만 보관.
    mall.push([date, R(t.visits), R(i.상품조회), R(i.장바구니조회), R(i.주문서작성), R(t.orders)]);
    const ss = ssSales.get(date);
    netDaily.push([date, R(t.revenue), ss ? ss.amt : null]);
  }

  const ss = [];
  for (const [date, v] of [...inflow.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sale = ssSales.get(date);
    const i = sIn.get(date) || {};
    // 주문건수는 MD가 올린 파일 기준이 있으면 그것을(벤치마크가 파일 기준으로 산출됨), 없으면 원장 고유주문
    const ord = i.주문건수 != null ? R(i.주문건수) : (sale ? sale.orders : 0);
    const rate = v ? +((ord / v) * 100).toFixed(2) : 0;
    ss.push([date, R(v), ord, rate, sale ? sale.amt : 0]);
  }

  return {
    mall, ss,
    cfg: {
      targets, benchMall: bench.mall, benchSS: bench.ss,
      netDaily, analyses, // analyses = 버튼으로 만든 날짜별 AI 분석(DB 저장본) — 화면 ④ 에 표시
      기준: {
        방문시작: 'Cafe24 통계 API(traffic_daily) — 이프두 값과 다를 수 있어 업로드 시 대조',
        순매출: '자사몰=traffic_daily.revenue · 스토어=이카운트 원장(상품매출·반품차감). 공동구매는 외부채널로 분류되어 제외',
        입력필요: '상품조회 · 장바구니조회 · 주문서작성 (이프두 전용 — 엑셀 업로드)',
      },
    },
  };
}

// 적재 현황 — 업로드 화면·진단용
async function status() {
  const [m, s] = await Promise.all([coll('mall'), coll('store')]);
  const cnt = async (c) => {
    const n = await c.countDocuments();
    if (!n) return { 적재: 0 };
    const r = await c.aggregate([{ $group: { _id: null, mn: { $min: '$date' }, mx: { $max: '$date' } } }]).toArray();
    const one = await c.findOne({}, { sort: { _at: -1 }, projection: { _at: 1, _src: 1 } });
    return { 적재: n, 기간: r[0] ? `${r[0].mn} ~ ${r[0].mx}` : null, 갱신: one && one._at, 출처: one && one._src };
  };
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const mall = await cnt(m);
  // 최근 7일 중 입력이 빠진 날 — "며칠째 안 올렸는지" 바로 보이게
  const recent = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.parse(today + 'T00:00:00Z') - i * 86400000).toISOString().slice(0, 10);
    const has = await m.countDocuments({ date: d });
    if (!has) recent.push(d);
  }
  return { 자사몰퍼널: mall, 스마트스토어: await cnt(s), 최근7일_미입력: recent };
}

module.exports = { buildDb, saveRows, rowsIn, status, setBench, getCfgDoc, targetsFor, daysInMonth, COLL, DEFAULT_BENCH, PRODUCT_GROUPS };
