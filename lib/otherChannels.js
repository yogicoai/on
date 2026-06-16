'use strict';

/**
 * 기타 채널(이카운트) 판매 분석 — DB 'on'.orders (엑셀 적재본을 직접 읽음, 같은 클러스터).
 *   홈페이지(=Cafe24)·스마트스토어는 API로 별도 수집하므로 제외(중복 방지).
 *   스키마: store(채널)·date(YYYY-MM-DD)·month·productName·category·beadType(충전재)·qty·amount·isSet·isCover.
 *   매출/수량 중심 — 고객·트래픽·쿠폰 정보는 없음.
 */

const store = require('./store');

const OTHER_DB = 'on';
const OTHER_COLL = 'orders';
const EXCLUDE = ['홈페이지', '스마트스토어']; // 자사몰·스마트스토어는 API로 별도 수집 → 기타 채널에서 제외

async function coll() { return store.namedCollection(OTHER_DB, OTHER_COLL); }

// ── 채널(store)명을 모회사/브랜드 "그룹"으로 묶는 규칙 ──
//   위에서부터 먼저 매칭되는 그룹으로 분류한다. (현대/롯데/신세계 처럼 한 브랜드에 입점몰이
//   여러 개인 경우 하나로 합산: 예) 신세계 = 신세계몰 + 신세계센텀시티몰…)
//   규칙에 안 걸리는 채널은 자기 이름이 곧 그룹(단독 채널: 쿠팡·삼성카드·SK스토아·공동구매 등).
//   위에서부터 먼저 매칭. (롯데: 온라인몰 입점은 묶고 홈쇼핑은 단독 / 현대: 더현대닷컴은 단독, 나머지는 현대)
const GROUP_RULES = [
  { group: '롯데(온라인몰)', test: (s) => s.includes('롯데') && s.includes('온라인몰') }, // 롯데동탄·안산·대구…
  { group: '롯데홈쇼핑',     test: (s) => s.includes('롯데홈쇼핑') },                    // 롯데홈쇼핑 단독
  { group: '더현대닷컴',     test: (s) => s.includes('더현대') },                        // 더현대닷컴 단독
  { group: '현대',           test: (s) => s.includes('현대') },                          // 현대이지웰 + 현대M포인트몰
  { group: '신세계',         test: (s) => s.includes('신세계') },                        // 신세계몰 + 신세계센텀시티몰
  { group: '오늘의집',       test: (s) => s.includes('오늘의집') },
  { group: '29CM',           test: (s) => /29\s*cm/i.test(s) },
  { group: '토스',           test: (s) => s.includes('토스') },
  { group: '공동구매',       test: (s) => s.includes('공동구매') || s.includes('공구') }, // 찬솜맘 공동구매 + 원미공구
];
// 그룹 탭/목록 순서: 아래 그룹은 항상 맨 끝(나머지는 매출순). 순서대로 뒤에 배치.
const PIN_LAST = ['공동구매', '토스'];
function groupOf(storeName) {
  const s = String(storeName || '').trim();
  for (const r of GROUP_RULES) { if (r.test(s)) return r.group; }
  return s || '(미지정)';
}
// 그룹 정렬 비교자: PIN_LAST 는 맨 끝(그 안에서는 PIN_LAST 순서), 나머지는 매출 내림차순
function groupSort(a, b) {
  const ap = PIN_LAST.indexOf(a.group), bp = PIN_LAST.indexOf(b.group);
  if (ap >= 0 && bp >= 0) return ap - bp;
  if (ap >= 0) return 1;
  if (bp >= 0) return -1;
  return b.sales - a.sales;
}

function rangeMatch(start, end) {
  const m = { store: { $nin: EXCLUDE } };
  if (start || end) { m.date = {}; if (start) m.date.$gte = start; if (end) m.date.$lte = end; }
  return m;
}

// 종합: 채널 랭킹 + 카테고리/충전재 분해 + 월별 추이 + 합계
// 데이터 실제 커버리지(min/max date) — 선택 구간과 안 맞을 때 안내용
async function coverage() {
  const c = await coll();
  const m = { store: { $nin: EXCLUDE }, date: { $nin: ['', '-', '날짜오류'] } };
  const [oldest, newest] = await Promise.all([
    c.find(m, { projection: { date: 1 } }).sort({ date: 1 }).limit(1).toArray(),
    c.find(m, { projection: { date: 1 } }).sort({ date: -1 }).limit(1).toArray(),
  ]);
  return { from: (oldest[0] || {}).date || null, to: (newest[0] || {}).date || null };
}

async function overview(start, end) {
  const c = await coll();
  const match = rangeMatch(start, end);
  const [byStore, byCat, byBead, monthly, totals, cov] = await Promise.all([
    c.aggregate([{ $match: match }, { $group: { _id: '$store', sales: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } }, { $sort: { sales: -1 } }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: '$category', sales: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { sales: -1 } }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: '$beadType', sales: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { sales: -1 } }]).toArray(),
    c.aggregate([{ $match: { store: { $nin: EXCLUDE }, month: { $nin: ['', '-'] } } }, { $group: { _id: '$month', sales: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { _id: 1 } }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: null, sales: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } }]).toArray(),
    coverage(),
  ]);
  const t = totals[0] || { sales: 0, qty: 0, ord: [] };

  // 채널(입점몰) 평면 목록 — CSV/호환용
  const channels = byStore.map((r) => {
    const orders = (r.ord || []).filter((x) => x != null).length;
    return { store: r._id || '(미지정)', group: groupOf(r._id), sales: Math.round(r.sales), qty: r.qty, orders, aov: orders ? Math.round(r.sales / orders) : 0 };
  });

  // 모회사/브랜드 그룹별 합산 — 주문수는 그룹 내 orderNo 중복제거(Set)로 정확 집계.
  const gmap = new Map();
  for (const r of byStore) {
    const g = groupOf(r._id);
    let e = gmap.get(g);
    if (!e) { e = { group: g, sales: 0, qty: 0, ordSet: new Set(), subs: [] }; gmap.set(g, e); }
    e.sales += r.sales; e.qty += r.qty;
    for (const o of (r.ord || [])) { if (o != null) e.ordSet.add(o); }
    const so = (r.ord || []).filter((x) => x != null).length;
    e.subs.push({ store: r._id || '(미지정)', sales: Math.round(r.sales), qty: r.qty, orders: so, aov: so ? Math.round(r.sales / so) : 0 });
  }
  const groups = [...gmap.values()].map((e) => ({
    group: e.group, sales: Math.round(e.sales), qty: e.qty, orders: e.ordSet.size,
    channels: e.subs.length, aov: e.ordSet.size ? Math.round(e.sales / e.ordSet.size) : 0,
    subs: e.subs.sort((a, b) => b.sales - a.sales),
  })).sort(groupSort);

  return {
    start: start || null, end: end || null,
    coverage: cov,
    groups,
    channels,
    byCategory: byCat.map((r) => ({ category: r._id || '(미분류)', sales: Math.round(r.sales), qty: r.qty })),
    byBead: byBead.map((r) => ({ beadType: r._id || '기타', sales: Math.round(r.sales), qty: r.qty })),
    monthly: monthly.map((r) => ({ ym: r._id, sales: Math.round(r.sales), qty: r.qty })),
    totals: { sales: Math.round(t.sales), qty: t.qty, orders: (t.ord || []).length, channels: byStore.length, groups: groups.length, aov: (t.ord || []).length ? Math.round(t.sales / t.ord.length) : 0 },
  };
}

// 그룹(브랜드) 클릭 → 그 그룹 입점몰 목록 + 그룹 전체(채널 합산) 상품/카테고리
async function groupDetail(groupName, start, end) {
  const c = await coll();
  // 1) 구간 내 채널별 합산 후, 이 그룹에 속한 채널만 추림
  const byStore = await c.aggregate([{ $match: rangeMatch(start, end) }, { $group: { _id: '$store', sales: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } }, { $sort: { sales: -1 } }]).toArray();
  const subsRaw = byStore.filter((r) => groupOf(r._id) === groupName);
  const storeNames = subsRaw.map((r) => r._id);
  const subs = subsRaw.map((r) => { const o = (r.ord || []).filter((x) => x != null).length; return { store: r._id || '(미지정)', sales: Math.round(r.sales), qty: r.qty, orders: o, aov: o ? Math.round(r.sales / o) : 0 }; });

  // 2) 그룹 전체(입점몰 합산) 상품/카테고리 + 정확한 주문수(Set)
  const matchG = { store: { $in: storeNames } };
  if (start || end) { matchG.date = {}; if (start) matchG.date.$gte = start; if (end) matchG.date.$lte = end; }
  const [products, byCat, tot, monthly, byBead] = await Promise.all([
    storeNames.length ? c.aggregate([{ $match: matchG }, { $group: { _id: '$productName', sales: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } }, { $project: { productName: '$_id', sales: 1, qty: 1, orders: { $size: '$ord' } } }, { $sort: { sales: -1 } }, { $limit: 300 }]).toArray() : [],
    storeNames.length ? c.aggregate([{ $match: matchG }, { $group: { _id: '$category', sales: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { sales: -1 } }]).toArray() : [],
    storeNames.length ? c.aggregate([{ $match: matchG }, { $group: { _id: null, sales: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } }]).toArray() : [],
    storeNames.length ? c.aggregate([{ $match: { store: { $in: storeNames }, month: { $nin: ['', '-'] } } }, { $group: { _id: '$month', sales: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { _id: 1 } }]).toArray() : [], // 월별 추이는 구간 무관 전체
    storeNames.length ? c.aggregate([{ $match: matchG }, { $group: { _id: '$beadType', sales: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { sales: -1 } }]).toArray() : [],
  ]);
  const tt = (tot && tot[0]) || { sales: 0, qty: 0, ord: [] };
  return {
    group: groupName, start: start || null, end: end || null,
    subs,
    totals: { sales: Math.round(tt.sales), qty: tt.qty, orders: (tt.ord || []).length, channels: subs.length, aov: (tt.ord || []).length ? Math.round(tt.sales / tt.ord.length) : 0 },
    products: products.map((r) => ({ productName: r.productName || '(미상)', sales: Math.round(r.sales), qty: r.qty, orders: r.orders })),
    byCategory: byCat.map((r) => ({ category: r._id || '(미분류)', sales: Math.round(r.sales), qty: r.qty })),
    byBead: byBead.map((r) => ({ beadType: r._id || '기타', sales: Math.round(r.sales), qty: r.qty })),
    monthly: monthly.map((r) => ({ ym: r._id, sales: Math.round(r.sales), qty: r.qty })),
  };
}

// 채널 클릭 → 그 채널의 상품별/카테고리별 상세
async function channelDetail(storeName, start, end) {
  const c = await coll();
  const match = { store: storeName };
  if (start || end) { match.date = {}; if (start) match.date.$gte = start; if (end) match.date.$lte = end; }
  const [products, byCat] = await Promise.all([
    c.aggregate([{ $match: match }, { $group: { _id: '$productName', sales: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } }, { $project: { productName: '$_id', sales: 1, qty: 1, orders: { $size: '$ord' } } }, { $sort: { sales: -1 } }, { $limit: 300 }]).toArray(),
    c.aggregate([{ $match: match }, { $group: { _id: '$category', sales: { $sum: '$amount' }, qty: { $sum: '$qty' } } }, { $sort: { sales: -1 } }]).toArray(),
  ]);
  return {
    store: storeName, start: start || null, end: end || null,
    products: products.map((r) => ({ productName: r.productName || '(미상)', sales: Math.round(r.sales), qty: r.qty, orders: r.orders })),
    byCategory: byCat.map((r) => ({ category: r._id || '(미분류)', sales: Math.round(r.sales), qty: r.qty })),
  };
}

// 특정 그룹(브랜드)의 구간 매출/주문 합산 — 몰별 목표 달성률(실적)용
async function groupTotal(group, start, end) {
  const c = await coll();
  const byStore = await c.aggregate([{ $match: rangeMatch(start, end) }, { $group: { _id: '$store', sales: { $sum: '$amount' }, ord: { $addToSet: '$orderNo' } } }]).toArray();
  let sales = 0; const ordSet = new Set();
  for (const r of byStore) {
    if (groupOf(r._id) !== group) continue;
    sales += r.sales;
    for (const o of (r.ord || [])) { if (o != null) ordSet.add(o); }
  }
  return { sales: Math.round(sales), orders: ordSet.size };
}

// 통합비교 합산용 — 구간 기타 채널 총매출/주문수
async function totalForRange(start, end) {
  const c = await coll();
  const r = await c.aggregate([{ $match: rangeMatch(start, end) }, { $group: { _id: null, sales: { $sum: '$amount' }, ord: { $addToSet: '$orderNo' } } }]).toArray();
  const t = r[0] || { sales: 0, ord: [] };
  return { sales: Math.round(t.sales), orders: (t.ord || []).length };
}

module.exports = { overview, channelDetail, groupDetail, groupOf, groupTotal, totalForRange, EXCLUDE };
