'use strict';

/**
 * 유입수 분석 — Cafe24 Analytics API (ca-api.cafe24data.com) 기준.
 * 프로빙으로 검증된 엔드포인트만 사용:
 *   /visitors/view     date, visit_count, first_visit_count, re_visit_count   (device_type: total|pc|mobile)
 *   /pages/view        url, count, visit_count, first_visit_count
 *   /visitpaths/keywords  keyword, visit_count
 *   /visitpaths/domains   domain, visit_count
 *   /visitpaths/adsales   ad, order_count, order_amount, join_count
 */

const c = require('./cafe24');
const store = require('./store');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const pad2 = (n) => String(n).padStart(2, '0');
function enumDays(start, end) { const out = []; let d = new Date(start + 'T00:00:00'); const last = new Date(end + 'T00:00:00'); while (d <= last) { out.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`); d = new Date(d.getTime() + 86400000); } return out; }
function enumMonths(start, end) { const out = []; let y = +start.slice(0, 4), m = +start.slice(5, 7); const ey = +end.slice(0, 4), em = +end.slice(5, 7); while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${pad2(m)}`); m++; if (m > 12) { m = 1; y++; } } return out; }
function lastDay(ym) { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return `${ym}-${pad2(new Date(y, m, 0).getDate())}`; }
// 오늘(로컬) YYYY-MM-DD. ⚠ c.ymd(new Date())는 로케일 문자열을 그대로 반환해 비교가 깨지므로 쓰지 말 것.
function todayLocal() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

async function dailyVisitors(start, end, device) {
  const rows = await c.caPaginate('/visitors/view',
    { start_date: start, end_date: end, device_type: device }, 'view');
  return rows.map((r) => ({
    date: String(r.date).slice(0, 10), // 'YYYY-MM-DD' (시각 제거)
    visits: N(r.visit_count),
    newVisits: N(r.first_visit_count),
    reVisits: N(r.re_visit_count),
  }));
}

// 유입 종합 리포트 — 전체 방문수만(신규/재방문·PC/모바일·일별). 도메인/검색어/광고/페이지 breakdown 제외.
async function inflowReport(start, end) {
  const s = c.ymd(start), e = c.ymd(end);

  const [total, pc, mobile] = await Promise.all([
    dailyVisitors(s, e, 'total'),
    dailyVisitors(s, e, 'pc').catch(() => []),
    dailyVisitors(s, e, 'mobile').catch(() => []),
  ]);

  // 일별 시계열 (pc/mobile 병합)
  const pcByDate = Object.fromEntries(pc.map((r) => [r.date, r.visits]));
  const moByDate = Object.fromEntries(mobile.map((r) => [r.date, r.visits]));
  const daily = total.map((r) => ({
    date: r.date,
    visits: r.visits,
    newVisits: r.newVisits,
    reVisits: r.reVisits,
    pc: pcByDate[r.date] || 0,
    mobile: moByDate[r.date] || 0,
  }));

  const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] || 0), 0);
  const totals = {
    visits: sum(daily, 'visits'),
    newVisits: sum(daily, 'newVisits'),
    reVisits: sum(daily, 'reVisits'),
    pcVisits: pc.reduce((a, r) => a + r.visits, 0),
    mobileVisits: mobile.reduce((a, r) => a + r.visits, 0),
    days: daily.length,
  };
  totals.avgDaily = totals.days ? Math.round(totals.visits / totals.days) : 0;
  totals.newRatio = totals.visits ? totals.newVisits / totals.visits : 0;
  totals.reRatio = totals.visits ? totals.reVisits / totals.visits : 0;

  return { start: s, end: e, totals, daily };
}

// ── 트래픽 전환 풀세트 (방문/PV/구매/가입) ──

// 기간 합계 PV (/pages/view url별 count 합산)
async function periodPV(start, end) {
  const rows = await c.caPaginate('/pages/view', { start_date: start, end_date: end }, 'view').catch(() => []);
  return rows.reduce((a, r) => a + N(r.count), 0);
}

// 일별 PV — 과거일은 pv_daily 캐시 우선, 오늘은 항상 라이브
async function dailyPV(start, end) {
  const days = enumDays(start, end);
  const todayStr = todayLocal();
  // 최근 2일(오늘·어제)은 캐시가 있어도 라이브 재집계 → 미완성 시점 값이 영구 고정되는 것 방지(자가 치유).
  const liveFrom = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; })();
  let coll = null; try { coll = await store.collection('pv_daily'); } catch (_) {}
  let cached = {};
  if (coll) { const docs = await coll.find({ date: { $gte: start, $lte: end } }).toArray(); cached = Object.fromEntries(docs.map((d) => [d.date, d.pv])); }
  const out = {}; const ops = [];
  for (const day of days) {
    if (cached[day] != null && day < liveFrom) { out[day] = cached[day]; continue; } // 완성일만 캐시 사용
    out[day] = await periodPV(day, day);
    if (coll && day < todayStr) ops.push({ updateOne: { filter: { date: day }, update: { $set: { date: day, pv: out[day], _at: new Date().toISOString() } }, upsert: true } });
  }
  if (coll && ops.length) { try { await coll.bulkWrite(ops, { ordered: false }); } catch (_) {} }
  return out;
}

// 단일 구간 가입수 (/customersprivacy created_date) — offset 페이지네이션 미지원이라 limit 1000 단건.
//  반환 1000건이면 캡 가능성 → 호출측에서 더 잘게 쪼갬.
async function rangeSignupRows(start, end) {
  const j = await c.adminGet('/customersprivacy', { shop_no: 1, search_type: 'created_date', created_start_date: start, created_end_date: end, limit: 1000 }).catch(() => ({}));
  return (j && j.customersprivacy) || [];
}

// 일별 가입수 → {date: count}. created_end_date가 무시되므로(그 날짜 이후 ascending 반환) 해당 일자만 필터.
async function dailySignups(start, end) {
  const days = enumDays(start, end);
  const todayStr = todayLocal();
  // 최근 2일(오늘·어제)은 캐시가 있어도 항상 라이브 재집계 → 미완성 시점에 박힌 값(예: 당일 오전 가입 1건)이
  // 영구 고정되는 것을 방지(자가 치유). 그보다 과거(완성)일만 캐시 신뢰.
  const liveFrom = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; })();
  let coll = null; try { coll = await store.collection('signups_daily'); } catch (_) {}
  let cached = {};
  if (coll) { const docs = await coll.find({ date: { $gte: start, $lte: end } }).toArray(); cached = Object.fromEntries(docs.map((d) => [d.date, d.count])); }
  const out = {}; const ops = [];
  for (const day of days) {
    if (cached[day] != null && day < liveFrom) { out[day] = cached[day]; continue; } // 완성일만 캐시 사용
    const rows = await rangeSignupRows(day, day); // day 이후 ascending(최대 1000) → day 것만 카운트
    out[day] = rows.filter((r) => String(r.created_date || '').slice(0, 10) === day).length;
    if (coll && day < todayStr) ops.push({ updateOne: { filter: { date: day }, update: { $set: { date: day, count: out[day], _at: new Date().toISOString() } }, upsert: true } });
  }
  if (coll && ops.length) { try { await coll.bulkWrite(ops, { ordered: false }); } catch (_) {} }
  return out;
}

// 한 달 가입수 — 월초부터 ascending 1000건 받아 월 범위만 필터. 캡(1000)이면 일자별 합산으로 정확화.
async function monthSignups(ym, realEnd) {
  const lo = ym + '-01';
  const rows = await rangeSignupRows(lo, realEnd);
  const inRange = rows.filter((r) => { const d = String(r.created_date || '').slice(0, 10); return d >= lo && d <= realEnd; }).length;
  if (rows.length < 1000) return inRange; // 월초 이후 전부(미래 포함) <1000 → 월 집계 완전
  return Object.values(await dailySignups(lo, realEnd)).reduce((a, x) => a + x, 0);
}

// 일별 구매건수·매출 (orders_raw)
async function ordersByDate(start, end) {
  const coll = await store.collection('orders_raw');
  const r = await coll.aggregate([
    { $match: { order_date: { $gte: start, $lte: end }, paid: true, canceled: false } },
    { $group: { _id: '$order_date', orders: { $sum: 1 }, revenue: { $sum: '$payment_amount' } } },
  ]).toArray();
  const out = {}; for (const x of r) out[x._id] = { orders: x.orders, revenue: Math.round(x.revenue) }; return out;
}

const WD = ['일', '월', '화', '수', '목', '금', '토'];

// 선택 기간 일별 트래픽 전환 + 요일평균 + Top10
async function trafficDaily(start, end) {
  const s = c.ymd(start), e = c.ymd(end);
  const [visitsArr, pvMap, signupMap, ordMap] = await Promise.all([
    dailyVisitors(s, e, 'total').catch(() => []), dailyPV(s, e), dailySignups(s, e), ordersByDate(s, e),
  ]);
  const vBy = Object.fromEntries(visitsArr.map((r) => [r.date, r.visits]));
  const daily = enumDays(s, e).map((d) => {
    const v = vBy[d] || 0, pv = pvMap[d] || 0, o = ordMap[d] || {}, su = signupMap[d] || 0;
    return { date: d, dow: new Date(d + 'T00:00:00').getDay(), visits: v, pv, pvPerVisit: v ? pv / v : 0, orders: o.orders || 0, revenue: o.revenue || 0, cvr: v ? (o.orders || 0) / v : 0, signups: su, signupRate: v ? su / v : 0 };
  });
  const wd = {}; daily.forEach((r) => { const w = (wd[r.dow] = wd[r.dow] || { days: 0, visits: 0, signups: 0 }); w.days++; w.visits += r.visits; w.signups += r.signups; });
  const weekday = Array.from({ length: 7 }, (_, i) => { const w = wd[i] || { days: 0, visits: 0, signups: 0 }; return { dow: i, label: WD[i], avgVisits: w.days ? Math.round(w.visits / w.days) : 0, avgSignups: w.days ? Math.round(w.signups / w.days * 10) / 10 : 0 }; });
  const sum = (k) => daily.reduce((a, r) => a + r[k], 0);
  const tv = sum('visits'), tpv = sum('pv'), to = sum('orders'), tr = sum('revenue'), ts = sum('signups');
  const totals = { visits: tv, pv: tpv, orders: to, revenue: tr, signups: ts, cvr: tv ? to / tv : 0, signupRate: tv ? ts / tv : 0, pvPerVisit: tv ? tpv / tv : 0, days: daily.length };
  const top = [...daily].sort((a, b) => b.visits - a.visits).slice(0, 10);
  return { start: s, end: e, totals, daily, weekday, top };
}

// 선택일의 '같은 요일 평균' 대비 방문수·일일매출 점검 (평균보다 낮으면 경고용).
//   target 직전 N개(기본 8)의 같은 요일을 평균내어 비교. 방문=Cafe24 analytics, 매출=orders_raw.
function shiftDays(ds, n) { const x = new Date(ds + 'T00:00:00'); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`; }
async function dailyHealth(targetDate, weeks, opts = {}) {
  const N = Math.max(1, Math.min(Number(weeks) || 8, 26));
  const d = c.ymd(targetDate);
  const tDow = new Date(d + 'T00:00:00').getDay();
  const startD = shiftDays(d, -N * 7);
  const tasks = [
    dailyVisitors(startD, d, 'total').catch(() => []),
    ordersByDate(startD, d),
  ];
  if (opts.signups) tasks.push(dailySignups(startD, d).catch(() => ({}))); // 가입수는 옵션(추가 API 호출)
  const [visitsArr, ordMap, signupMap = {}] = await Promise.all(tasks);
  const vBy = Object.fromEntries(visitsArr.map((r) => [r.date, r.visits]));
  const sameWd = []; for (let k = 1; k <= N; k++) sameWd.push(shiftDays(d, -7 * k));
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, x) => a + x, 0) / arr.length) : 0);
  const avg1 = (arr) => (arr.length ? Math.round(arr.reduce((a, x) => a + x, 0) / arr.length * 10) / 10 : 0);
  const vSamples = sameWd.map((x) => vBy[x] || 0);
  const sSamples = sameWd.map((x) => (ordMap[x] || {}).revenue || 0);
  // 타깃일 방문수/매출의 '표시값'은 프론트(loadDailyHealth)에서 메인 KPI(overview=lastData.inflow)와
  //   동일 출처로 덮어써 일관성을 맞춘다. 여기서는 같은요일 평균(완료일=범위무관, 검증됨) 비교만 담당.
  const dayVisits = vBy[d] || 0, daySales = (ordMap[d] || {}).revenue || 0, dayOrders = (ordMap[d] || {}).orders || 0;
  const avgVisits = avg(vSamples), avgSales = avg(sSamples);
  const result = {
    date: d, dow: tDow, label: WD[tDow], weeks: N, samples: sameWd.length,
    visits: { day: dayVisits, avg: avgVisits, diff: dayVisits - avgVisits, below: dayVisits < avgVisits },
    sales: { day: daySales, avg: avgSales, diff: daySales - avgSales, below: daySales < avgSales },
    orders: { day: dayOrders }, // 구매율(주문수÷방문수) 계산용
    prev: { sales: (ordMap[shiftDays(d, -1)] || {}).revenue || 0, orders: (ordMap[shiftDays(d, -1)] || {}).orders || 0 }, // 전일비용
  };
  if (opts.signups) {
    const gSamples = sameWd.map((x) => signupMap[x] || 0);
    const daySignups = signupMap[d] || 0, avgSignups = avg1(gSamples);
    result.signups = { day: daySignups, avg: avgSignups, diff: daySignups - avgSignups, below: daySignups < avgSignups };
  }
  return result;
}

// /visitors/view 는 1년 초과 범위에서 400 → ≤365일 윈도우로 분할 조회
async function dailyVisitorsChunked(start, end, device) {
  const out = []; let s = new Date(start + 'T00:00:00'); const last = new Date(end + 'T00:00:00');
  while (s <= last) {
    const e = new Date(Math.min(last.getTime(), s.getTime() + 364 * 86400000));
    const ws = `${s.getFullYear()}-${pad2(s.getMonth() + 1)}-${pad2(s.getDate())}`;
    const we = `${e.getFullYear()}-${pad2(e.getMonth() + 1)}-${pad2(e.getDate())}`;
    out.push(...(await dailyVisitors(ws, we, device).catch(() => [])));
    s = new Date(e.getTime() + 86400000);
  }
  return out;
}

// 월별 방문/가입/PV (2025-01~현재) — 전년 동월 비교. pv/signups는 traffic_monthly 캐시
async function trafficMonthly(start, end) {
  const s = c.ymd(start || '2025-01-01'), e = c.ymd(end || new Date());
  const visitsArr = await dailyVisitorsChunked(s, e, 'total');
  const vMonth = {}; visitsArr.forEach((r) => { const m = r.date.slice(0, 7); vMonth[m] = (vMonth[m] || 0) + r.visits; });
  const months = enumMonths(s, e);
  const curMonth = e.slice(0, 7);
  let coll = null; try { coll = await store.collection('traffic_monthly'); } catch (_) {}
  let cached = {};
  if (coll) { const docs = await coll.find({ ym: { $in: months } }).toArray(); cached = Object.fromEntries(docs.map((d) => [d.ym, d])); }
  const ops = []; const rows = [];
  for (const m of months) {
    const mEnd = lastDay(m); const realEnd = mEnd > e ? e : mEnd;
    let pv, su; const cu = cached[m];
    if (cu && m < curMonth) { pv = cu.pv; su = cu.signups; }
    else {
      pv = await periodPV(m + '-01', realEnd);
      su = await monthSignups(m, realEnd);
      if (coll && m < curMonth) ops.push({ updateOne: { filter: { ym: m }, update: { $set: { ym: m, pv, signups: su, _at: new Date().toISOString() } }, upsert: true } });
    }
    rows.push({ ym: m, visits: vMonth[m] || 0, pv, signups: su });
  }
  if (coll && ops.length) { try { await coll.bulkWrite(ops, { ordered: false }); } catch (_) {} }
  return { start: s, end: e, rows };
}

// 유입경로 상세 — Cafe24 통계 API(방문/PV 외 미사용이던 3종): 광고소스별 주문·매출·가입 + 유입 검색어 + 유입 도메인.
//   adsales = Cafe24 자체 측정 "광고 소스 → 실제 주문/매출/가입"(자사몰 마케팅 귀속의 실마리).
async function inflowPaths(start, end) {
  const s = c.ymd(start), e = c.ymd(end);
  const [ads, kws, doms] = await Promise.all([
    c.caPaginate('/visitpaths/adsales', { start_date: s, end_date: e }, 'adsales').catch(() => []),
    c.caPaginate('/visitpaths/keywords', { start_date: s, end_date: e }, 'keywords').catch(() => []),
    c.caPaginate('/visitpaths/domains', { start_date: s, end_date: e }, 'domains').catch(() => []),
  ]);
  const adMap = {};
  for (const r of ads) { const k = r.ad || '(미상)'; const a = (adMap[k] = adMap[k] || { ad: k, orders: 0, amount: 0, joins: 0 }); a.orders += N(r.order_count); a.amount += N(r.order_amount); a.joins += N(r.join_count); }
  const adsales = Object.values(adMap).map((a) => ({ ...a, amount: Math.round(a.amount), aov: a.orders ? Math.round(a.amount / a.orders) : 0 })).sort((a, b) => b.amount - a.amount);
  const adTotal = adsales.reduce((t, r) => { t.orders += r.orders; t.amount += r.amount; t.joins += r.joins; return t; }, { orders: 0, amount: 0, joins: 0 });

  const agg = (rows, keyName) => {
    const m = {};
    for (const r of rows) { const k = r[keyName] || '(미상)'; m[k] = (m[k] || 0) + N(r.visit_count); }
    return Object.entries(m).map(([k, visits]) => ({ [keyName]: k, visits })).sort((a, b) => b.visits - a.visits).slice(0, 50);
  };
  return { start: s, end: e, adsales, adTotal, keywords: agg(kws, 'keyword'), domains: agg(doms, 'domain') };
}

// 행동 통계 — Cafe24 통계 API 미사용 4종: 페이지별 뷰 · 상품별 조회수 · 장바구니 담기(+담기율) · 시간대별 구매 · 순방문자.
//   상품 조회수와 장바구니를 product_no 로 조인 → 상품별 "조회→담기" 퍼널까지 제공.
async function behaviorStats(start, end) {
  const s = c.ymd(start), e = c.ymd(end);
  const P = { start_date: s, end_date: e };
  const [pages, pViews, carts, times, uniq, pSales] = await Promise.all([
    c.caPaginate('/pages/view', P, 'view').catch(() => []),
    c.caPaginate('/products/view', P, 'view').catch(() => []),
    c.caPaginate('/carts/action', P, 'action').catch(() => []),
    c.caPaginate('/sales/times', P, 'times').catch(() => []),
    c.caPaginate('/visitors/unique', P, 'unique').catch(() => []),
    c.caPaginate('/products/sales', P, 'sales').catch(() => []),
  ]);
  // 페이지별 뷰 TOP (URL 단위 합산)
  const pgMap = {};
  for (const r of pages) { const k = r.url || '(미상)'; const a = (pgMap[k] = pgMap[k] || { url: k, views: 0, visits: 0 }); a.views += N(r.count); a.visits += N(r.visit_count); }
  const 페이지별뷰 = Object.values(pgMap).sort((a, b) => b.views - a.views).slice(0, 30);
  // 상품 조회수 × 장바구니 조인 → 퍼널
  const cartBy = {};
  for (const r of carts) { const k = String(r.product_no || ''); const a = (cartBy[k] = cartBy[k] || { adds: 0 }); a.adds += N(r.add_cart_count); }
  const pvMap = {};
  for (const r of pViews) { const k = String(r.product_no || ''); const a = (pvMap[k] = pvMap[k] || { product_no: k, 상품: r.product_name || '', 조회수: 0 }); a.조회수 += N(r.count); }
  const salesBy = {};
  for (const r of pSales) { const k = String(r.product_no || ''); const a = (salesBy[k] = salesBy[k] || { orders: 0, amount: 0 }); a.orders += N(r.order_count); a.amount += N(r.order_amount); }
  const 상품퍼널 = Object.values(pvMap).map((x) => {
    const adds = (cartBy[x.product_no] || {}).adds || 0;
    const sl = salesBy[x.product_no] || { orders: 0, amount: 0 };
    return {
      ...x, 장바구니담기: adds, 담기율_pct: x.조회수 ? +((adds / x.조회수) * 100).toFixed(1) : null,
      구매주문: sl.orders, 구매액: Math.round(sl.amount),
      구매전환율_pct: x.조회수 ? +((sl.orders / x.조회수) * 100).toFixed(1) : null, // 조회→구매
    };
  }).sort((a, b) => b.조회수 - a.조회수).slice(0, 30);
  // 시간대별 구매 (0~23시 합산)
  const hrMap = {};
  for (const r of times) { const h = N(r.hour); const a = (hrMap[h] = hrMap[h] || { 시간대: h, 구매자: 0, 주문: 0, 매출: 0 }); a.구매자 += N(r.buyers_count); a.주문 += N(r.order_count); a.매출 += N(r.order_amount); }
  const 시간대별구매 = Object.values(hrMap).sort((a, b) => a.시간대 - b.시간대).map((x) => ({ ...x, 매출: Math.round(x.매출) }));
  // 순방문자 일별
  const 순방문자 = uniq.map((r) => ({ date: String(r.date || '').slice(0, 10), unique: N(r.unique_visit_count) }));
  return {
    start: s, end: e,
    페이지별뷰, 상품퍼널, 시간대별구매,
    순방문자합: 순방문자.reduce((a, r) => a + r.unique, 0), 순방문자일별: 순방문자,
    주의: '자사몰(Cafe24) 통계 기준. 담기율=장바구니담기÷상품조회수. 페이지 뷰는 URL 단위.',
  };
}

// 특정 페이지(URL) 일별 뷰 추이 — /pages/view 를 하루 단위로 호출해 URL(부분일치) 필터.
//   "이 이벤트 페이지 뷰 기간별로" 질문용. 최대 31일.
async function pageViewsByUrl(urlQuery, start, end) {
  let q = String(urlQuery || '').trim();
  // 전체 URL(https://yogibo.kr/event/...)을 줘도 되게 정규화 — 통계 API는 도메인 없는 경로만 반환하므로 경로만 추출
  try { if (/^https?:\/\//i.test(q)) q = new URL(q).pathname; } catch (_) {}
  q = decodeURIComponent(q).replace(/\?.*$/, '');
  // 월별 프로모션 URL 규칙: /event/yogibo/{연도}/{월}_promotion.html — "7월 프로모션", "2026년 2월" 식 입력을 자동 변환
  const mKo = q.match(/^(?:(\d{4})\s*년?\s*)?(\d{1,2})\s*월(?:\s*프로모션)?$/);
  if (mKo) {
    const yr = mKo[1] || String(start || '').slice(0, 4) || String(new Date().getFullYear());
    q = `/event/yogibo/${yr}/${+mKo[2]}_promotion`;
  }
  if (!q) throw new Error('url(부분일치 문자열)이 필요합니다 — 예: "7_promotion", "7월 프로모션", 또는 전체 URL');
  const s = c.ymd(start), e = c.ymd(end);
  const days = enumDays(s, e);
  if (days.length > 31) throw new Error('최대 31일까지 조회 가능합니다');
  const daily = [];
  const totals = {}; // url → {views, visits}
  for (const day of days) {
    const rows = await c.caPaginate('/pages/view', { start_date: day, end_date: day }, 'view').catch(() => []);
    const hit = rows.filter((r) => String(r.url || '').includes(q));
    const views = hit.reduce((a, r) => a + N(r.count), 0);
    const visits = hit.reduce((a, r) => a + N(r.visit_count), 0);
    daily.push({ date: day, views, visits });
    for (const r of hit) { const t = (totals[r.url] = totals[r.url] || { views: 0, visits: 0 }); t.views += N(r.count); t.visits += N(r.visit_count); }
  }
  const matched = Object.entries(totals).map(([url, t]) => ({ url, ...t })).sort((a, b) => b.views - a.views).slice(0, 10);
  const out = {
    urlQuery: q, start: s, end: e,
    합계: { views: daily.reduce((a, d) => a + d.views, 0), visits: daily.reduce((a, d) => a + d.visits, 0) },
    일별: daily, 매칭URL: matched,
    주의: 'URL 부분일치로 매칭된 모든 페이지 합산. 특정 페이지만 원하면 더 구체적인 URL 조각으로 검색.',
  };
  // 매칭 실패 시 — 그 기간 이벤트/프로모션성 페이지 후보를 제안(Claude가 재시도할 수 있게)
  if (!matched.length) {
    const all = await c.caPaginate('/pages/view', { start_date: s, end_date: e }, 'view').catch(() => []);
    const agg = {};
    for (const r of all) { const u = r.url || ''; agg[u] = (agg[u] || 0) + N(r.count); }
    const cands = Object.entries(agg)
      .filter(([u]) => /event|promo|기획|플랜/i.test(u))
      .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([url, views]) => ({ url, views }));
    out.후보URL = cands.length ? cands : Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([url, views]) => ({ url, views }));
    out.안내 = '매칭된 페이지 없음 — 아래 후보URL 중 맞는 경로로 다시 조회하세요.';
  }
  return out;
}

module.exports = { inflowReport, dailyVisitors, trafficDaily, trafficMonthly, dailyPV, dailySignups, dailyHealth, inflowPaths, behaviorStats, pageViewsByUrl };
