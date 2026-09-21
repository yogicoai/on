'use strict';

/**
 * 기간 대 기간 성과 비교(전사) — "2025년 8월 vs 2026년 8월" 을 한 번에 답하기 위한 도구.
 *   기존엔 sales_trend(자사몰+스토어) · online_offline_compare · marketing_period_compare 를
 *   따로 불러 손으로 합쳐야 했고, 원장이 섞여 같은 질문에 부호가 반대로 나왔다.
 *
 *   ⚠️ 원장이 둘이고 기준이 다르다 — 섞으면 안 된다.
 *     · 이카운트 on.orders / off.orders = **출고일** 기준. 4채널 전부 커버. → 이 모듈의 주 기준.
 *     · Cafe24 orders_raw = **주문일** 기준. 자사몰만. → 참고로만 병기(차이를 금액으로 설명).
 *   실제 사례: 2026-08 자사몰이 출고 기준 -20.4% / 주문 기준 +1.4%. 8월 주문 중 2,151만원이
 *   9월 출고로 밀렸기 때문. 둘 다 계산은 맞고 기준이 다르다 — 그래서 항상 기준을 같이 낸다.
 *
 *   매출 방향만 보면 오독한다. 수량·주문수·객단가로 분해해 "왜" 까지 답한다.
 */

const store = require('./store');
const period = require('./period');
const promoTarget = require('./promoTarget');
const promoDefs = require('./promoDefs');

const PG = promoTarget.PRODUCT_GROUPS; // 상품 group1 화이트리스트(배송비·할인 등 비상품 제외)
const R = (n) => Math.round(n || 0);
const pct = (a, b) => (a ? +(((b - a) / a) * 100).toFixed(1) : null);
const days = (p) => Math.round((new Date(p.end + 'T00:00:00Z') - new Date(p.start + 'T00:00:00Z')) / 86400000) + 1;

// 채널 → 원장/필터. 외부채널은 on.orders 의 나머지 전부.
const CH = [
  { ch: '자사몰', db: 'on', q: { store: '홈페이지' } },
  { ch: '스마트스토어', db: 'on', q: { store: '스마트스토어' } },
  { ch: '외부채널', db: 'on', q: { store: { $nin: ['홈페이지', '스마트스토어'] } } },
  { ch: '오프라인', db: 'off', q: {} },
];

async function one(db, p, q) {
  const c = await store.namedCollection(db, 'orders');
  const r = await c.aggregate([
    { $match: { date: { $gte: p.start, $lte: p.end }, group1: { $in: PG }, ...q } },
    { $group: { _id: null, sales: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } },
  ]).toArray();
  const t = r[0] || { sales: 0, qty: 0, ord: [] };
  return { sales: R(t.sales), qty: t.qty || 0, orders: (t.ord || []).filter((x) => x != null).length };
}

// 채널별 A/B + 증감. 매출·수량·주문·객단가를 같이 내야 "매출 -20%인데 객단가 +23%" 같은 구조가 보인다.
async function channels(a, b) {
  const out = [];
  for (const { ch, db, q } of CH) {
    const [x, y] = await Promise.all([one(db, a, q), one(db, b, q)]);
    const aov = (v) => (v.orders ? R(v.sales / v.orders) : 0);
    out.push({
      채널: ch,
      A매출: x.sales, B매출: y.sales, 매출증감_pct: pct(x.sales, y.sales),
      A수량: x.qty, B수량: y.qty, 수량증감_pct: pct(x.qty, y.qty),
      A주문: x.orders, B주문: y.orders, 주문증감_pct: pct(x.orders, y.orders),
      A객단가: aov(x), B객단가: aov(y), 객단가증감_pct: pct(aov(x), aov(y)),
    });
  }
  return out;
}

// 외부채널 입점몰별 신규/소멸 — YoY 왜곡의 최대 원인. (예: 민에듀 공동구매 2,173만원은 전년에 없던 채널)
async function extShift(a, b) {
  const c = await store.namedCollection('on', 'orders');
  const grab = async (p) => {
    const r = await c.aggregate([
      { $match: { date: { $gte: p.start, $lte: p.end }, group1: { $in: PG }, store: { $nin: ['홈페이지', '스마트스토어'] } } },
      { $group: { _id: '$store', sales: { $sum: '$amount' } } },
    ]).toArray();
    return new Map(r.map((x) => [x._id, R(x.sales)]));
  };
  const [ma, mb] = await Promise.all([grab(a), grab(b)]);
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  const rows = [...keys].map((k) => ({ 입점몰: k, A: ma.get(k) || 0, B: mb.get(k) || 0, 증감: (mb.get(k) || 0) - (ma.get(k) || 0) }));
  rows.sort((x, y) => y.증감 - x.증감);
  const 신규 = rows.filter((r) => !r.A && r.B), 소멸 = rows.filter((r) => r.A && !r.B);
  return {
    신규채널: 신규.map((r) => ({ 입점몰: r.입점몰, 매출: r.B })),
    소멸채널: 소멸.map((r) => ({ 입점몰: r.입점몰, 전년매출: r.A })),
    신규합계: 신규.reduce((s, r) => s + r.B, 0),
    소멸합계: 소멸.reduce((s, r) => s + r.A, 0),
    증감TOP: rows.slice(0, 5),
    증감BOTTOM: rows.slice(-5).reverse(),
  };
}

/**
 * 오프라인 매장 변동 — 동일매장(like-for-like) YoY. **오프라인 YoY 오독의 최대 원인**이다.
 *   2025-08 → 2026-08 실측: 전체 -16.6% 인데 감소액의 91.8%가 폐점 4곳 - 신규 4곳 교체분이고
 *   양년 공통 7매장만 보면 -1.8%(거의 평탄). 전체 증감만 말하면 "오프라인 영업 붕괴"로 잘못 읽힌다.
 */
async function storeShift(a, b) {
  const c = await store.namedCollection('off', 'orders');
  const grab = async (p) => {
    const r = await c.aggregate([
      { $match: { date: { $gte: p.start, $lte: p.end }, group1: { $in: PG } } },
      { $group: { _id: '$store', sales: { $sum: '$amount' }, qty: { $sum: '$qty' }, ord: { $addToSet: '$orderNo' } } },
    ]).toArray();
    return new Map(r.map((x) => [x._id, { sales: R(x.sales), qty: x.qty || 0, orders: (x.ord || []).length }]));
  };
  const [ma, mb] = await Promise.all([grab(a), grab(b)]);
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  const comp = [], closed = [], opened = [];
  for (const k of keys) {
    const x = ma.get(k), y = mb.get(k);
    if (x && y) comp.push({ 매장: k, A: x.sales, B: y.sales, 증감: y.sales - x.sales, 증감_pct: pct(x.sales, y.sales) });
    else if (x) closed.push({ 매장: k, 전년매출: x.sales });
    else if (y) opened.push({ 매장: k, 매출: y.sales });
  }
  comp.sort((x, y) => y.증감 - x.증감);
  closed.sort((x, y) => y.전년매출 - x.전년매출);
  opened.sort((x, y) => y.매출 - x.매출);
  const cA = comp.reduce((s, r) => s + r.A, 0), cB = comp.reduce((s, r) => s + r.B, 0);
  const closedSum = closed.reduce((s, r) => s + r.전년매출, 0), openedSum = opened.reduce((s, r) => s + r.매출, 0);
  const total = (mb.size ? [...mb.values()].reduce((s, v) => s + v.sales, 0) : 0) - (ma.size ? [...ma.values()].reduce((s, v) => s + v.sales, 0) : 0);
  return {
    동일매장수: comp.length,
    동일매장_A: cA, 동일매장_B: cB, 동일매장증감_pct: pct(cA, cB),
    폐점: closed, 폐점합계: closedSum,
    신규: opened, 신규합계: openedSum,
    매장교체_순효과: openedSum - closedSum,
    전체증감액: R(total),
    교체설명: total ? `전체 증감 ${R(total).toLocaleString()}원 중 매장 교체분 ${R(openedSum - closedSum).toLocaleString()}원 (${Math.abs(total) ? Math.round(Math.abs(openedSum - closedSum) / Math.abs(total) * 100) : 0}%). 나머지가 동일매장 실적 변화다.` : null,
    증감TOP: comp.slice(0, 5), 증감BOTTOM: comp.slice(-5).reverse(),
  };
}

// 상품별 증감 기여 — "무엇이 팔려서/안 팔려서" 에 답한다.
async function products(a, b, { limit = 10, db = 'on', q = {} } = {}) {
  const c = await store.namedCollection(db, 'orders');
  const grab = async (p) => {
    const r = await c.aggregate([
      { $match: { date: { $gte: p.start, $lte: p.end }, group1: { $in: PG }, ...q } },
      { $group: { _id: '$productName', sales: { $sum: '$amount' }, qty: { $sum: '$qty' } } },
    ]).toArray();
    return new Map(r.map((x) => [x._id, { sales: R(x.sales), qty: x.qty || 0 }]));
  };
  const [ma, mb] = await Promise.all([grab(a), grab(b)]);
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  const rows = [...keys].map((k) => {
    const x = ma.get(k) || { sales: 0, qty: 0 }, y = mb.get(k) || { sales: 0, qty: 0 };
    return { 상품: k, A: x.sales, B: y.sales, 증감: y.sales - x.sales, A수량: x.qty, B수량: y.qty };
  });
  rows.sort((x, y) => y.증감 - x.증감);
  return {
    증가기여TOP: rows.slice(0, limit),
    감소기여TOP: rows.slice(-limit).reverse(),
    올해만판매: rows.filter((r) => !r.A && r.B).sort((x, y) => y.B - x.B).slice(0, limit).map((r) => ({ 상품: r.상품, 매출: r.B })),
    전년만판매: rows.filter((r) => r.A && !r.B).sort((x, y) => y.A - x.A).slice(0, limit).map((r) => ({ 상품: r.상품, 전년매출: r.A })),
  };
}

// 카테고리(group1) 믹스
async function categories(a, b) {
  const grab = async (p, db, q) => {
    const c = await store.namedCollection(db, 'orders');
    const r = await c.aggregate([
      { $match: { date: { $gte: p.start, $lte: p.end }, group1: { $in: PG }, ...q } },
      { $group: { _id: '$group1', sales: { $sum: '$amount' }, qty: { $sum: '$qty' } } },
    ]).toArray();
    return new Map(r.map((x) => [x._id, R(x.sales)]));
  };
  const [oa, ob, fa, fb] = await Promise.all([grab(a, 'on', {}), grab(b, 'on', {}), grab(a, 'off', {}), grab(b, 'off', {})]);
  const sum = (m1, m2, k) => (m1.get(k) || 0) + (m2.get(k) || 0);
  return PG.map((g) => {
    const A = sum(oa, fa, g), B = sum(ob, fb, g);
    return { 제품군: g, A, B, 증감_pct: pct(A, B) };
  }).sort((x, y) => y.B - x.B);
}

// 결손일 탐지 — 이카운트가 안 되는 날은 그 날 매출이 통째로 빈다. 그걸 "매출 0"으로 읽으면 안 된다.
async function gaps(p) {
  const on = await store.namedCollection('on', 'orders');
  const off = await store.namedCollection('off', 'orders');
  const out = [];
  const list = [
    { label: '자사몰', c: on, q: { store: '홈페이지' } },
    { label: '스마트스토어', c: on, q: { store: '스마트스토어' } },
    { label: '오프라인', c: off, q: {} },
  ];
  const all = [];
  for (let d = new Date(p.start + 'T00:00:00Z'); ; d = new Date(d.getTime() + 86400000)) {
    const ds = d.toISOString().slice(0, 10);
    if (ds > p.end) break;
    all.push(ds);
  }
  for (const { label, c, q } of list) {
    const r = await c.aggregate([
      { $match: { date: { $gte: p.start, $lte: p.end }, ...q } },
      { $group: { _id: '$date', sales: { $sum: '$amount' } } },
    ]).toArray();
    const have = new Map(r.map((x) => [x._id, R(x.sales)]));
    const miss = all.filter((d) => !have.has(d));
    if (!miss.length) continue;
    const avg = have.size ? [...have.values()].reduce((s, v) => s + v, 0) / have.size : 0;
    out.push({ 채널: label, 결손일: miss, 결손일수: miss.length, 일평균: R(avg), 누락추정: R(avg * miss.length) });
  }
  return out;
}

// 자사몰 주문일 기준(Cafe24) — 출고 기준과의 차이를 금액으로 설명한다.
async function cafe24Ref(a, b) {
  try {
    const c = await store.collection('orders_raw');
    const grab = async (p) => {
      const r = await c.aggregate([
        { $match: { order_date: { $gte: p.start, $lte: p.end }, paid: true, canceled: false } },
        { $group: { _id: null, sales: { $sum: '$payment_amount' }, n: { $sum: 1 } } },
      ]).toArray();
      const t = r[0] || { sales: 0, n: 0 };
      return { sales: R(t.sales), orders: t.n };
    };
    const [x, y] = await Promise.all([grab(a), grab(b)]);
    if (!x.sales && !y.sales) return null;
    return {
      기준: 'Cafe24 주문일·결제완료(취소제외) — 이카운트 출고일 기준과 다름',
      A매출: x.sales, B매출: y.sales, 매출증감_pct: pct(x.sales, y.sales),
      A주문: x.orders, B주문: y.orders, 주문증감_pct: pct(x.orders, y.orders),
    };
  } catch (_) { return null; }
}

// 프로모션 — 양 기간 각각 요약. 기간 겹침 중복은 명시(합계를 그대로 더하면 안 된다).
async function promos(a, b) {
  const sum = async (p) => {
    const defs = await promoDefs.listDefs({ start: p.start, end: p.end });
    const byPromo = new Map();
    for (const d of defs) {
      const k = `${d.name}|${d.start}|${d.end}`;
      if (!byPromo.has(k)) byPromo.set(k, { name: d.name, start: d.start, end: d.end, 범위: (d.target || {}).scope || '', malls: [] });
      byPromo.get(k).malls.push(d.mall);
    }
    const 전제품 = [...byPromo.values()].filter((x) => x.범위 === '전제품');
    // 기간 커버율 — "전제품 프로모션이 그 달의 며칠을 덮었나". 이게 높으면 "프로모션 성과 = 그 달 매출" 이다.
    const cov = new Set();
    for (const x of 전제품) {
      for (let d = new Date(x.start + 'T00:00:00Z'); ; d = new Date(d.getTime() + 86400000)) {
        const ds = d.toISOString().slice(0, 10);
        if (ds > x.end) break;
        if (ds >= p.start && ds <= p.end) cov.add(ds);
      }
    }
    return {
      기간: `${p.start}~${p.end}`,
      프로모션수: byPromo.size, 행수: defs.length,
      전제품프로모션: 전제품.map((x) => ({ 이름: x.name, 기간: `${x.start}~${x.end}`, 몰: x.malls })),
      기타프로모션: [...byPromo.values()].filter((x) => x.범위 !== '전제품').map((x) => ({ 이름: x.name, 범위: x.범위, 기간: `${x.start}~${x.end}` })),
      전제품커버일수: `${cov.size}/${days(p)}일`,
    };
  };
  const [x, y] = await Promise.all([sum(a), sum(b)]);
  return {
    A: x, B: y,
    주의: '전제품 프로모션의 "성과"는 그 기간 그 몰의 매출 전액이다(프로모션 기여분이 아님). 커버일수가 높으면 사실상 그 달 매출과 같다. 프로모션별 상세·매출은 promotion_performance 로.',
  };
}

// 광고·트래픽 — marketing 모듈 재사용(2025년분도 적재돼 있어 YoY 가능)
async function adTraffic(a, b) {
  try {
    const marketing = require('./marketing');
    const [sa, sb] = await Promise.all([marketing.series(a.start, a.end), marketing.series(b.start, b.end)]);
    const ta = marketing.totalsOf(sa.rows), tb = marketing.totalsOf(sb.rows);
    // 양(量) 지표만 YoY로 낸다 — 적재가 2025-01부터 연속이라 비교 가능.
    const o = { 비교가능: {} };
    for (const k of ['광고비', '방문', '신규가입', '구매', '회원매출', '비회원매출']) {
      o.비교가능[k] = { A: R(ta[k]), B: R(tb[k]), 증감_pct: pct(ta[k], tb[k]) };
    }
    o.비교가능.마케팅비용률_pct = { A: ta.마케팅비용률_pct, B: tb.마케팅비용률_pct };
    // 효율 지표는 매체가 2026년 중 측정방식을 바꿔(네이버쇼핑 2026-03·네이버키워드 2026-06·META 2026-02 계단식)
    //   값이 단절됐다. 광고비에는 단절이 없으므로 성과 변화가 아니다. 전환매출 자체도 실매출의 약 2배로 과대계상이라
    //   YoY로 쓰면 안 된다 — 숫자는 참고로만 주고 비교값은 내지 않는다.
    o.비교불가_효율지표 = {
      광고전환매출: { A: R(ta.광고전환매출), B: R(tb.광고전환매출) },
      광고ROAS: { A: ta.광고ROAS, B: tb.광고ROAS },
      사유: '매체별 전환 측정방식이 2026년 중 단절(계단식 변화)되어 연도 간 비교 불가. 전환매출은 매체 자체 귀속값으로 실매출보다 크게 계상된다(2025-08 기준 온라인 실매출의 약 1.9배). 이 두 값으로 YoY·증감률을 만들지 말 것.',
    };
    return o;
  } catch (e) { return { 미산출: String(e.message).slice(0, 80) }; }
}

// 매출/수량/객단가 방향이 엇갈릴 때 사람이 읽을 한 문장으로 정리 — LLM이 매출만 보고 오독하는 것을 막는다.
function diagnose(rows) {
  const out = [];
  for (const r of rows) {
    if (r.A매출 === 0 && r.B매출 === 0) continue;
    const s = r.매출증감_pct, q = r.수량증감_pct, v = r.객단가증감_pct;
    if (s == null) continue;
    let t = `${r.채널}: 매출 ${s > 0 ? '+' : ''}${s}%`;
    if (q != null) t += ` · 수량 ${q > 0 ? '+' : ''}${q}%`;
    if (v != null) t += ` · 객단가 ${v > 0 ? '+' : ''}${v}%`;
    if (q != null && v != null && q < -10 && v > 10) t += ' → 적게 팔고 비싸게 팔았다(구성 상향·저가 이탈)';
    else if (q != null && v != null && q > 10 && v < -10) t += ' → 많이 팔았지만 단가가 내려갔다(할인 의존)';
    out.push(t);
  }
  return out;
}

/**
 * 메인 — a(비교 기준) vs b(관심 구간).
 *   opts.light=true 면 상품·프로모션·광고를 생략(빠른 요약).
 */
async function compare(a, b, opts = {}) {
  if (!a || !b) throw new Error('비교할 두 기간이 필요합니다');
  if (a.start > b.start) { const t = a; a = b; b = t; } // 항상 이른 쪽을 A로 — 부호 오독 방지
  const light = !!opts.light;

  const [rows, ext, off, gapA, gapB, c24] = await Promise.all([
    channels(a, b), extShift(a, b), storeShift(a, b), gaps(a), gaps(b), cafe24Ref(a, b),
  ]);

  const T = (k) => rows.reduce((s, r) => s + r[k], 0);
  const onlineRows = rows.filter((r) => r.채널 !== '오프라인');
  const 전사 = {
    A매출: T('A매출'), B매출: T('B매출'), 매출증감_pct: pct(T('A매출'), T('B매출')),
    A수량: T('A수량'), B수량: T('B수량'), 수량증감_pct: pct(T('A수량'), T('B수량')),
    온라인_A: onlineRows.reduce((s, r) => s + r.A매출, 0), 온라인_B: onlineRows.reduce((s, r) => s + r.B매출, 0),
    오프라인_A: (rows.find((r) => r.채널 === '오프라인') || {}).A매출 || 0,
    오프라인_B: (rows.find((r) => r.채널 === '오프라인') || {}).B매출 || 0,
  };
  전사.온라인증감_pct = pct(전사.온라인_A, 전사.온라인_B);
  전사.오프라인증감_pct = pct(전사.오프라인_A, 전사.오프라인_B);

  const 경고 = [];
  for (const [tag, g] of [['A', gapA], ['B', gapB]]) {
    for (const x of g) 경고.push(`${tag}기간 ${x.채널} ${x.결손일.join(',')} 원장 0행 — 그 채널 ${x.결손일수}일치 누락(일평균 ${x.일평균.toLocaleString()}원 기준 약 ${x.누락추정.toLocaleString()}원). 실제 매출이 0이 아니라 적재가 안 된 것이다.`);
  }
  if (ext.신규합계) 경고.push(`B기간에만 있는 외부채널 ${ext.신규채널.map((x) => x.입점몰).join('·')} 합계 ${ext.신규합계.toLocaleString()}원 — 전년엔 없던 채널이라 외부채널 증감을 그대로 읽으면 안 된다.`);
  if (off.폐점합계 || off.신규합계) {
    const ch = rows.find((r) => r.채널 === '오프라인');
    경고.push(`오프라인은 매장 명단이 바뀌었다 — 폐점 ${off.폐점.length}곳(전년 ${off.폐점합계.toLocaleString()}원)·신규 ${off.신규.length}곳(${off.신규합계.toLocaleString()}원). `
      + `전체 증감 ${ch && ch.매출증감_pct != null ? ch.매출증감_pct + '%' : '-'} 가 아니라 **동일매장 ${off.동일매장증감_pct != null ? off.동일매장증감_pct + '%' : '-'}**(${off.동일매장수}곳)가 실제 영업 성과다. ${off.교체설명 || ''}`);
  }
  if (ext.소멸합계) 경고.push(`A기간에만 있던 외부채널 ${ext.소멸채널.map((x) => x.입점몰).join('·')} 합계 ${ext.소멸합계.toLocaleString()}원 — 철수·중단분.`);
  if (c24 && c24.매출증감_pct != null) {
    const ec = rows.find((r) => r.채널 === '자사몰');
    if (ec && ec.매출증감_pct != null && (c24.매출증감_pct > 0) !== (ec.매출증감_pct > 0)) {
      경고.push(`자사몰 증감 부호가 원장에 따라 반대다 — 출고일 기준 ${ec.매출증감_pct}% / 주문일 기준 ${c24.매출증감_pct}%. B기간 주문 중 ${(c24.B매출 - ec.B매출).toLocaleString()}원이 아직 출고에 반영되지 않았다(출고 시차). 월 단위 비교는 출고일 기준끼리 하는 것이 일관되고, "주문이 얼마 들어왔나"는 주문일 기준을 본다.`);
    }
  }

  // 보정 시나리오 — 같은 8월인데 정의에 따라 전사 YoY가 -10.8% ~ -3.9% 로 움직인다.
  //   하나의 숫자만 단정하면 반드시 오해가 생기므로 무엇을 넣고 뺐는지 같이 보여준다.
  const gapAmtB = gapB.reduce((s, x) => s + x.누락추정, 0);
  const gapAmtA = gapA.reduce((s, x) => s + x.누락추정, 0);
  const 시나리오 = [{ 정의: '원데이터 그대로', A: 전사.A매출, B: 전사.B매출, 증감_pct: 전사.매출증감_pct }];
  if (gapAmtA || gapAmtB) {
    시나리오.push({ 정의: '원장 결손일 보정', A: 전사.A매출 + gapAmtA, B: 전사.B매출 + gapAmtB,
      증감_pct: pct(전사.A매출 + gapAmtA, 전사.B매출 + gapAmtB), 설명: `A +${gapAmtA.toLocaleString()} / B +${gapAmtB.toLocaleString()} (일평균 추정)` });
  }
  if (ext.신규합계 || ext.소멸합계) {
    const A2 = 전사.A매출 + gapAmtA - ext.소멸합계, B2 = 전사.B매출 + gapAmtB - ext.신규합계;
    시나리오.push({ 정의: '결손보정 + 신규·철수 외부채널 제외', A: A2, B: B2, 증감_pct: pct(A2, B2),
      설명: '양년 공통 채널만 비교 — 채널 포트폴리오 변화를 제거한 순수 증감' });
  }
  if (off.폐점합계 || off.신규합계) {
    const A3 = 전사.A매출 + gapAmtA - ext.소멸합계 - off.폐점합계;
    const B3 = 전사.B매출 + gapAmtB - ext.신규합계 - off.신규합계;
    시나리오.push({ 정의: '위 + 오프라인 동일매장만', A: A3, B: B3, 증감_pct: pct(A3, B3),
      설명: `폐점 ${off.폐점.length}곳·신규 ${off.신규.length}곳 제외 — 같은 매장·같은 채널끼리의 비교(가장 보수적)` });
  }

  const out = {
    비교: `A(${a.label || a.start}) → B(${b.label || b.start})`,
    기준: '이카운트 출고일 기준(on.orders 자사몰=홈페이지·스마트스토어·외부채널 / off.orders 오프라인) · 상품매출만(배송비·할인 등 비상품 제외) · 반품은 음수로 차감된 순매출',
    기간: { A: { ...a, 일수: days(a) }, B: { ...b, 일수: days(b) } },
    전사, 채널별: rows, 구조진단: diagnose(rows),
    보정시나리오: { 표: 시나리오, 읽는법: '정의에 따라 전사 증감률이 이 범위에서 움직인다. 답변할 때 하나만 단정하지 말고 "원데이터 X%, 신규채널·폐점 제거 시 Y%" 처럼 범위로 말하라.' },
    외부채널_변동: ext,
    오프라인_매장변동: off,
    자사몰_주문일기준_참고: c24,
    데이터경고: 경고.length ? 경고 : ['없음'],
  };
  if (days(a) !== days(b)) out.기간주의 = `A ${days(a)}일 / B ${days(b)}일 — 길이가 달라 총액 비교는 불공정하다. 일평균으로 보려면 marketing_period_compare 를 쓰라.`;

  if (!light) {
    const [cat, prod, pro, ad] = await Promise.all([
      categories(a, b), products(a, b), promos(a, b), adTraffic(a, b),
    ]);
    out.제품군별 = cat;
    out.상품_증감기여 = {
      기준: '온라인(on.orders) 전 채널 — 오프라인 상품명은 2026년에 "(EPP)" 접미가 붙는 대규모 리네임이 있어(2026-08 오프라인 상품매출의 약 48%) 상품명 단위 YoY가 성립하지 않으므로 제외했다. 오프라인은 제품군별로 보라.',
      ...prod,
    };
    out.프로모션 = pro;
    // 커버 일수가 다르면 "프로모션 성과 합계"를 두 기간에서 비교하는 것이 무의미하다.
    //   실측: 2025-08 17일 vs 2026-08 28일 → 프로모션 합계는 +17.9%인데 실제 매출은 -14.1%(부호 반대).
    const cvA = parseInt(pro.A.전제품커버일수, 10) || 0, cvB = parseInt(pro.B.전제품커버일수, 10) || 0;
    if (Math.abs(cvA - cvB) >= 3) {
      out.데이터경고.push(`전제품 프로모션 커버 일수가 다르다 — A ${pro.A.전제품커버일수} / B ${pro.B.전제품커버일수}. `
        + '이 상태에서 "프로모션 성과 합계"를 두 기간끼리 비교하면 커버율 차이가 부호를 뒤집는다(프로모션을 더 많이 걸면 합계가 커진다). '
        + '프로모션 비교는 합계가 아니라 같은 프로모션끼리 짝지어(promotion_performance 의 비교 필드) 보라.');
    }
    out.광고_트래픽 = ad;
  }
  return out;
}

/** 자연어 한 방 — "2025년 8월 vs 2026년 8월", "2026년 8월"(→ 전년 동월 자동), "작년 8월 대비 올해 8월" */
async function fromText(text, opts = {}) {
  const pair = period.parsePair(text);
  if (pair) return compare(pair.a, pair.b, opts);
  const p = period.parsePeriod(text);
  return compare(period.prevYear(p), p, opts); // 한 기간만 주면 전년 동기와 비교
}

module.exports = { compare, fromText, channels, products, categories, gaps, extShift, promos };
