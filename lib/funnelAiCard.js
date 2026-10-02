'use strict';

/**
 * AI 분석 카드 v2 — 온라인 MD 설계(md/AI분석시트_설계서.html · md/AI분석_최종프롬프트.txt · md/AI분석카드_최종폼.html, 2026-10-02).
 *
 *   숫자도 문장도 서버(규칙)가 만들고, AI 는 규칙이 놓친 조언만 짧게(사용자 결정 2026-10-02 — 토큰이 과하게 나가지 않게).
 *     · 비율·케이스(A~E)·배지·병목·기회손실·의지 목표 갭 분해·연속 일수 = 서버 계산(설계서 §7-1).
 *     · 카드 문장(한 줄 판정 · 병목 · 잘된 것 · 갭 설명 · 원인 가설 · 액션) = 규칙(ruleDay · rulePeriod) — 비용 0, 열 때마다 바로.
 *     · AI 조언(Claude Sonnet, effort low) = 버튼을 누를 때만 1~3문장. 저장 후 재사용.
 *     · AI 상세 분석(Claude Sonnet, effort medium) = MD 설계서 방식 — 버튼을 누를 때만 카드 문장 전체를 AI 가 쓴다(장당 수십 원, 2026-10-02 사용자 결정).
 *     · 배지는 의지 목표 달성률이 아니라 순매출 7일평균 대비(설계서 §2-2) — 자사몰 평상시 하루 달성률이 47%라 달성률로 달면 매일 위험이 뜬다.
 *     · 의지 목표 갭은 금액 3항 분해(유입·전환·객단가, 순차 치환 — 세 항의 합이 실제 − 목표와 원 단위로 맞는다). 목표는 퍼널 목표 곱 기준(§9-2 기본값).
 *     · 저장 키는 (날짜 + 채널) — funnel_ai_cards. 한 번 만든 카드는 저장본을 다시 쓴다(새로고침·재조회 비용 0).
 *       그날 원자료가 나중에 바뀌면(예: 이프두를 늦게 올림) stale 로만 표시하고, 사람이 "다시 분석"을 눌렀을 때만 새로 만든다.
 *     · 기간(2일 이상)은 일자별 카드 + 기간 종합 카드 1장(funnel_ai_periods, 키 = 시작|끝|채널). 일괄 분석은 1회 최대 7일(화면에서 순서대로 호출).
 *   상품 신호(블록 H)는 상품 매핑표·프로모션 설정 할인율이 준비되면 붙인다(설계서 §3-4·§9-1) — 지금은 빈 배열(블록 생략).
 */

const crypto = require('crypto');
const funnel = require('./funnelDaily');
const store = require('./store');
const ai = require('./ai');
const promoDefs = require('./promoDefs');
const adEfficiency = require('./adEfficiency');

const VERSION = 2;
const CARD_COLL = 'funnel_ai_cards', PERIOD_COLL = 'funnel_ai_periods';
const CH_NAME = { mall: '자사몰', ss: '스마트스토어' };
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
// 판정 기준 — 설계서 초기값. "동등" 폭은 설정으로 바꿀 수 있어야 한다(§2-1 · §9-1-3) → funnel_config._id='aiCard'
const CFG_DEFAULT = { eqPp: 0.5, inflowEqPct: 5, batchMax: 7 };
// 버튼으로 새로 만들 때 쓰는 모델 — 사용자 결정(2026-10-02): API 호출은 Sonnet. 바꾸려면 env FUNNEL_AI_MODEL
const MODEL = () => process.env.FUNNEL_AI_MODEL || 'claude-sonnet-5-5';
// Vercel 함수는 60초에 끊긴다(app/api/[...path] maxDuration) — 그 안에 저장까지 끝나게 AI 는 50초
const AI_TIMEOUT_MS = 50000;
// MD 프롬프트는 temperature 0 을 요구하지만 Sonnet 5.5 는 temperature 를 받지 않는다(deprecated) — 숫자는 서버가 정하므로 문장만 흔들린다.
//   effort 기본값은 보이지 않는 생각에 2~3천 토큰을 써서 상한·60초에 걸렸다(2026-10-02 실측) → medium. 바꾸려면 env FUNNEL_AI_EFFORT
const AI_EFFORT = process.env.FUNNEL_AI_EFFORT || 'low';
// 간략 모드(2026-10-02 사용자 결정) — "토큰이 과하게 나갈 거면 간략하게만". 숫자·판정은 이미 서버가 다 계산하므로
//   AI 에는 계산값만 보내고(최근 8일 원자료 제외), 블록마다 1문장 · 가설 최대 2 · 액션 최대 3 만 쓰게 한다.
//   실측(9/30 자사몰, effort medium·원자료 포함): 입력 2,915 · 출력 839 토큰 → 간략 모드 목표 입력 ~1,500 · 출력 ~350

const R = (n) => Math.round(n || 0);
const r1 = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 10) / 10);
const r2 = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const shift = (iso, d) => new Date(Date.parse(iso + 'T00:00:00Z') + d * 86400000).toISOString().slice(0, 10);
const dow = (iso) => DOW[new Date(iso + 'T00:00:00Z').getUTCDay()];
const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const dates = (a, b) => { const out = []; for (let d = a; d <= b; d = shift(d, 1)) out.push(d); return out; };
const N = (v) => (v == null ? null : Number(v));

async function cfgDoc() {
  try {
    const c = await store.collection(funnel.COLL.cfg);
    const d = await c.findOne({ _id: 'aiCard' });
    return { ...CFG_DEFAULT, ...((d && d.cfg) || {}) };
  } catch (_) { return { ...CFG_DEFAULT }; }
}

// ── 원자료 — 날짜별 자사몰·스토어 한 줄씩 ────────────────────────────────────
//   자사몰 유입·주문완료 = 이프두(MD 업로드), 없는 날은 Cafe24(funnelDaily.mallBase — 퍼널 화면·메일과 같은 값).
//   스토어 유입 = 비즈어드바이저(MD 입력, 없으면 null = 미입력), 주문 = MD 파일 주문건수 → 없으면 이카운트 원장 고유주문.
async function signupMap(from, to) {
  const c = await store.collection('traffic_daily');
  const r = await c.find({ date: { $gte: from, $lte: to } }, { projection: { _id: 0, date: 1, signups: 1 } }).toArray();
  return new Map(r.map((x) => [x.date, x.signups == null ? null : R(x.signups)]));
}
async function adMap(from, to) {
  try {
    const rows = await adEfficiency.dailyTrend(from.replace(/-/g, ''), to.replace(/-/g, ''));
    return new Map(rows.map((x) => [`${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}`, R(x.spend)]));
  } catch (_) { return new Map(); }
}
async function loadSet(from, to) {
  const [mallIn, storeIn, traffic, inflow, ssSales, bench, targets, sig, ads] = await Promise.all([
    funnel.rowsIn('mall', from, to), funnel.rowsIn('store', from, to),
    funnel.trafficMap(from, to), funnel.storeInflowMap(from, to), funnel.storeSalesMap(from, to),
    funnel.getCfgDoc(), funnel.targetsMap(), signupMap(from, to), adMap(from, to),
  ]);
  const mIn = new Map(mallIn.map((x) => [x.date, x])), sIn = new Map(storeIn.map((x) => [x.date, x]));
  const days = {};
  let lastInflow = null;
  for (const d of inflow.keys()) if (!lastInflow || d > lastInflow) lastInflow = d;
  for (const d of dates(from, to)) {
    const t = traffic.get(d), i = mIn.get(d);
    let mall = null;
    if (t || i) {
      const b = funnel.mallBase(t, i || {});
      const ifdo3 = !!(i && (i.상품조회 > 0 || i.장바구니조회 > 0 || i.주문서작성 > 0));
      mall = {
        inflow: t || (i && i.이프두_방문시작 > 0) ? b.visits : null,
        inflowSrc: b.src === '이프두' ? '이프두' : 'Cafe24',
        view: ifdo3 ? R(i.상품조회) : null, cart: ifdo3 ? R(i.장바구니조회) : null, orderform: ifdo3 ? R(i.주문서작성) : null,
        done: t || (i && i.이프두_방문시작 > 0) ? b.orders : null,
        net: t && t.revenue != null ? R(t.revenue) : null,
        ifdo3,
        orders_cafe24: t && t.orders != null ? R(t.orders) : null,
        visits_cafe24: t ? R(t.visits) : null, signups: sig.has(d) ? sig.get(d) : null, ad_cost: ads.has(d) ? ads.get(d) : null,
      };
    }
    const sale = ssSales.get(d), v = inflow.get(d), si = sIn.get(d) || {};
    let ss = null;
    if (v != null || sale) {
      ss = {
        inflow: v != null ? R(v) : null,
        done: si.주문건수 != null ? R(si.주문건수) : (sale ? sale.orders : null),
        net: sale ? R(sale.amt) : null, sales: sale ? R(sale.sales) : null, returns: sale ? R(sale.returns) : null,
        ad_cost: ads.has(d) ? ads.get(d) : null,
      };
    }
    days[d] = { mall, ss };
  }
  return { from, to, days, bench, targets, lastInflow };
}

// ── 월 목표 원본(반올림 없이) — 퍼널 화면 targetsFor 와 같은 공식이지만 월 단위 그대로 ─────────────
//   설계서 §3-5: 일 목표로 비율을 역산하면 틀린다(반올림). 비율은 월 목표 단계 ÷ 월 목표 유입.
function goalFor(set, ch, ym) {
  const t = set.targets[ch] && set.targets[ch][ym];
  if (!t || !t.net) return null;
  const days = funnel.daysInMonth(ym);
  if (ch === 'mall') {
    const B = set.bench.mall;
    const gross = t.net / (1 - B.cancelPct / 100), done = gross / B.aov, inflow = done / (B.doneRate / 100);
    return { days, net_revenue: t.net, inflow, view: (inflow * B.viewRate) / 100, cart: (inflow * B.cartRate) / 100, orderform: (inflow * B.orderRate) / 100, done, aov: B.aov };
  }
  const B = set.bench.ss;
  const done = t.net / B.perOrder, inflow = done / (B.rate / 100);
  return { days, net_revenue: t.net, inflow, done, aov: B.perOrder };
}

const STEPS = {
  mall: [['inflow', '유입'], ['view', '상품조회'], ['cart', '장바구니'], ['orderform', '주문서작성'], ['done', '주문완료']],
  ss: [['inflow', '유입'], ['done', '구매율']],
};
const IFDO_KEYS = ['view', 'cart', 'orderform'];

function caseOf(vsT, vsA, eq) {
  if (vsT == null || vsA == null) return null;
  if (vsT < 0 && vsA < -eq) return 'A';      // 진짜 병목
  if (vsT < 0 && Math.abs(vsA) <= eq) return 'B'; // 의지 목표 갭(평소 수준)
  if (vsT < 0 && vsA > eq) return 'C';       // 의지 목표 갭(평소보다 좋음)
  if (vsT >= 0 && vsA < -eq) return 'D';     // 조용한 악화
  return 'E';                                // 정상
}

// 그날 단계별 값 — 유입은 절대값(당일 vs 일 목표 · 7일평균, %), 나머지는 유입 대비 비율(%p)
function stepsFor(set, date, ch, cfg, goal) {
  const day = set.days[date] && set.days[date][ch];
  if (!day) return null;
  const prior = [];
  for (let k = 1; k <= 7; k++) { const r = set.days[shift(date, -k)]; if (r && r[ch]) prior.push(r[ch]); }
  const inflow = day.inflow;
  const out = [];
  for (const [key, name] of STEPS[ch]) {
    if (key === 'inflow') {
      const ok = prior.filter((p) => p.inflow > 0);
      const avg = ok.length >= 3 ? ok.reduce((s, p) => s + p.inflow, 0) / ok.length : null;
      const tgt = goal ? goal.inflow / goal.days : null;
      const vsT = inflow != null && tgt ? (inflow / tgt - 1) * 100 : null;
      const vsA = inflow != null && avg ? (inflow / avg - 1) * 100 : null;
      out.push({ key, name, unit: '명', cur: inflow, target: r1(tgt), avg7: r1(avg), vs_target_pct: r1(vsT), vs_avg7_pct: r1(vsA),
        case: caseOf(vsT, vsA, cfg.inflowEqPct), valid_days: ok.length });
      continue;
    }
    const hold = ch === 'mall' && IFDO_KEYS.includes(key) && !day.ifdo3 ? '이프두 미입력 — 판단 보류' : null;
    const cur = day[key];
    const valid = (p) => p.inflow > 0 && p[key] != null && (!(ch === 'mall' && IFDO_KEYS.includes(key)) || p.ifdo3);
    const ok = prior.filter(valid);
    const avgPct = ok.length >= 3 ? (ok.reduce((s, p) => s + p[key], 0) / ok.reduce((s, p) => s + p.inflow, 0)) * 100 : null;
    const curPct = !hold && inflow > 0 && cur != null ? (cur / inflow) * 100 : null;
    const tgtPct = goal ? (goal[key] / goal.inflow) * 100 : null;
    const vsT = curPct != null && tgtPct != null ? curPct - tgtPct : null;
    const vsA = curPct != null && avgPct != null ? curPct - avgPct : null;
    out.push({ key, name: ch === 'ss' ? '구매율' : name, unit: '%', cur, cur_pct: r2(curPct), target_pct: r2(tgtPct), avg7_pct: r2(avgPct),
      vs_target_pp: r2(vsT), vs_avg7_pp: r2(vsA), case: hold ? null : caseOf(vsT, vsA, cfg.eqPp), hold, valid_days: ok.length });
  }
  return out;
}

/**
 * 하루 · 한 채널 서버 계산 — 카드의 숫자·판정 전부.
 *   status: ok | data_error(유입 0인데 하위 단계 값 존재) | pending_input(스토어 유입 미입력) | no_data(그날 퍼널 없음)
 */
function computeDay(set, date, ch, cfg, promo = []) {
  const ym = date.slice(0, 7);
  const goal = goalFor(set, ch, ym);
  const day = set.days[date] && set.days[date][ch];
  const base = { version: VERSION, date, weekday: dow(date), ch, channel: CH_NAME[ch], goal: goalOut(goal), promo };
  if (!day) return { ...base, status: 'no_data', badge: null, note: `${date} ${CH_NAME[ch]} 퍼널 데이터가 없습니다 — 입력 후 분석해 주세요.` };

  const lowerAny = ch === 'mall' ? [day.view, day.cart, day.orderform, day.done].some((v) => v > 0) : day.done > 0;
  if (ch === 'ss' && day.inflow == null) {
    return { ...base, status: 'pending_input', badge: null, daily: dailyRows(set, date, ch),
      note: '스마트스토어 유입이 아직 입력되지 않았습니다(온라인팀 데이터 업데이트 전) — 유입 입력 후 분석해 주세요.',
      net_revenue: { actual: day.net, orders: day.done } };
  }
  if (day.inflow == null && !lowerAny && day.net == null) return { ...base, status: 'no_data', badge: null, note: `${date} ${CH_NAME[ch]} 퍼널 데이터가 없습니다 — 입력 후 분석해 주세요.` };

  const steps = stepsFor(set, date, ch, cfg, goal);
  // 7일평균 순매출 — 배지 기준(§2-2). 값이 있는 날만 평균, 3일 미만이면 기준선 부족
  const prior = [];
  for (let k = 1; k <= 7; k++) { const r = set.days[shift(date, -k)]; if (r && r[ch] && r[ch].net != null) prior.push(r[ch]); }
  const avgNet = prior.length >= 3 ? prior.reduce((s, p) => s + p.net, 0) / prior.length : null;
  const aovParts = prior.map((p) => aovParts1(ch, p)).filter(Boolean);
  const avgAov = aovParts.length >= 3 ? aovParts.reduce((s, x) => s + x.rev, 0) / aovParts.reduce((s, x) => s + x.n, 0) : null;
  const net = day.net, done = day.done, inflow = day.inflow;
  // 객단가는 같은 출처끼리 나눈다(2026-10-02).
  //   자사몰: Cafe24 매출 ÷ Cafe24 주문 — 주문완료(이프두)로 나누면 이프두가 못 잡은 주문만큼 부푼다(9/29: 이프두 14건 vs Cafe24 21건).
  //   스토어: 그날 판매분 ÷ 판매 주문 — 같은 날 잡힌 반품(지난 주문분)이 섞이면 음수까지 나온다(10/1: 판매 1,184,380원, 반품 −1,650,820원).
  const aov = aovOf(ch, day);
  //   갭 분해의 4번째 줄 — 세 항(유입·전환·객단가)의 합이 실제 순매출과 어긋나는 몫을 이름 붙여 따로 보인다(합계 = 실제 − 목표 유지)
  const other = aov == null || net == null ? null
    : ch === 'mall' ? (day.inflowSrc === '이프두' ? { label: '집계 차이 — 이프두에 안 잡힌 주문(Cafe24 매출 기준)', amount: net - done * aov } : null)
      : (day.returns ? { label: '반품·취소 차감 — 그날 잡힌 반품(지난 주문분 포함)', amount: day.returns } : null);
  const netTarget = goal ? goal.net_revenue / goal.days : null;
  const netChange = avgNet > 0 && net != null ? net / avgNet - 1 : null;
  const inflowStep = steps.find((s) => s.key === 'inflow');
  const baselineShort = avgNet == null || inflowStep.valid_days < 3;

  const isErr = (inflow == null || inflow === 0) && lowerAny;
  const cases = steps.filter((s) => s.case);
  const A = cases.filter((s) => s.case === 'A').length, D = cases.filter((s) => s.case === 'D').length;
  let badge;
  if (isErr) badge = 'data_error';
  else if (baselineShort) badge = 'normal';
  else if ((netChange != null && netChange <= -0.3) || A >= 2) badge = 'risk';
  else if ((netChange != null && netChange <= -0.1) || A === 1 || D >= 1) badge = 'warn';
  else if (netChange != null && netChange >= 0.1 && A === 0 && D === 0) badge = 'good';
  else badge = 'normal';

  // data_error 이면 퍼널 판정 전부 보류(§8-2)
  if (isErr) steps.forEach((s) => { s.case = null; });
  const bottleneck = isErr ? null : (steps.find((s) => s.case === 'A') || null);

  return {
    ...base,
    status: isErr ? 'data_error' : 'ok',
    badge,
    baseline_note: baselineShort ? '기준선 부족 — 최근 7일 중 값이 있는 날이 3일 미만이라 7일평균 비교를 하지 않았습니다' : null,
    headline: {
      net_vs_avg7_pct: netChange != null ? r1(netChange * 100) : null, // ← 배지 기준
      net_vs_target_pct: netTarget && net != null ? r1((net / netTarget) * 100) : null, // ← 표시만(배지에 쓰지 않음)
      inflow_vs_target_pct: inflowStep && inflowStep.vs_target_pct != null ? r1(100 + inflowStep.vs_target_pct) : null,
    },
    steps,
    net_revenue: { actual: net, target_daily: R(netTarget), avg7: avgNet != null ? R(avgNet) : null, orders: done,
      ...(ch === 'mall' ? { orders_cafe24: day.orders_cafe24 } : { sales: day.sales, returns: day.returns }),
      aov: aov != null ? R(aov) : null, aov_avg7: avgAov != null ? R(avgAov) : null, aov_target: goal ? goal.aov : null, aov_gap: aov != null && goal ? R(aov - goal.aov) : null },
    bottleneck: bottleneck ? bottleneck.name : null,
    opportunity_loss: bottleneck ? oppLoss(day, ch, bottleneck, aov) : null,
    will_gap: isErr ? null : willGap(day, goal, aov, other),
    gap_items: steps.filter((s) => s.case === 'B' || s.case === 'C').map((s) => s.name),
    quiet_decline: steps.filter((s) => s.case === 'D').map((s) => s.name),
    product_signals: productSignals(set, date, ch), // 블록 H — 트리거된 것만 최대 3개, 없으면 [] (화면에서 블록 생략)
    data_status: dataStatus(set, date, ch, day),
    daily: dailyRows(set, date, ch),
  };
}

function goalOut(g) {
  if (!g) return null;
  const m = { inflow: r1(g.inflow), done: r1(g.done), net_revenue: R(g.net_revenue) };
  if (g.view != null) Object.assign(m, { view: r1(g.view), cart: r1(g.cart), orderform: r1(g.orderform) });
  return { monthly: m, days_in_month: g.days, aov: g.aov, basis: '퍼널 목표 곱(월 순매출 목표 → 취소율·객단가·구매전환율 역산)' };
}

// 기회손실 — 병목(케이스 A)이 있을 때만. "7일평균 수준만 했어도 얼마였나"(§3-2). 1건 미만이면 금액 없이 "영향 미미"
function oppLoss(day, ch, b, aov) {
  const inflow = day.inflow;
  if (!(inflow > 0) || !(aov > 0)) return null;
  let orders = null;
  if (b.key === 'inflow') {
    if (!(b.avg7 > 0) || !(day.done > 0)) return null;
    orders = (b.avg7 - inflow) * (day.done / inflow);
  } else {
    const chain = STEPS[ch].map(([k]) => k).filter((k) => k !== 'inflow');
    const at = chain.indexOf(b.key);
    let mult = 1;
    for (let i = at + 1; i < chain.length; i++) {
      const prev = day[chain[i - 1]], cur = day[chain[i]];
      if (!(prev > 0) || cur == null) return null;
      mult *= cur / prev;
    }
    orders = ((b.avg7_pct - b.cur_pct) / 100) * inflow * mult;
  }
  if (orders == null || !isFinite(orders)) return null;
  const minor = orders < 1;
  return { stage: b.name, orders: r1(orders), amount: minor ? null : R(orders * aov), minor };
}

// 의지 목표 갭 3항 분해(§2-3 · 프롬프트 1-4) — 비율은 반올림 없이 원본 값으로
function aovParts1(ch, d) {
  if (ch === 'mall') { const n = d.orders_cafe24 > 0 ? d.orders_cafe24 : d.done; return n > 0 && d.net != null ? { rev: d.net, n } : null; }
  return d.done > 0 && d.sales != null ? { rev: d.sales, n: d.done } : null;
}
function aovOf(ch, d) { const x = aovParts1(ch, d); return x && x.rev > 0 ? x.rev / x.n : null; }
function willGap(day, goal, aov, other) {
  const { inflow, done } = day;
  if (!goal || !(inflow > 0) || !(done > 0) || aov == null) return null;
  const tRate = goal.done / goal.inflow, inT = goal.inflow / goal.days, A = goal.aov;
  const inflowC = (inflow - inT) * tRate * A;
  const convC = inflow * (done / inflow - tRate) * A;
  const aovC = done * (aov - A);
  const extra = other && other.amount ? other.amount : 0;
  const total = inflowC + convC + aovC + extra;
  const actual = done * aov + extra, target = inT * tRate * A;
  return {
    total: R(total), inflow: R(inflowC), conversion: R(convC), aov: R(aovC),
    other: extra ? { label: other.label, amount: R(extra) } : null,
    actual: R(actual), target: R(target),
    target_inflow: r1(inT), target_rate_pct: r2(tRate * 100), cur_rate_pct: r2((done / inflow) * 100), target_aov: A, cur_aov: R(aov),
    checksum_ok: Math.abs(total - (actual - target)) <= 1000,
  };
}

function dataStatus(set, date, ch, day) {
  if (ch === 'mall') return { ifdu_3steps: day.ifdo3, inflow_source: day.inflowSrc, net_revenue: day.net != null ? 'actual' : null };
  const lag = set.lastInflow && set.lastInflow < date ? Math.round((Date.parse(date) - Date.parse(set.lastInflow)) / 86400000) : 0;
  return { inflow_uploaded: day.inflow != null, inflow_last_date: set.lastInflow, inflow_lag_days: lag || null, net_revenue: day.net != null ? 'actual' : null };
}

// AI 에 넘기는 최근 8일(대상일 포함, 오름차순)
function dailyRows(set, date, ch) {
  const out = [];
  for (let k = 7; k >= 0; k--) {
    const d = shift(date, -k), r = set.days[d] && set.days[d][ch];
    if (!r) continue;
    const av = aovOf(ch, r), aov = av != null ? R(av) : null;
    out.push(ch === 'mall'
      ? { date: d, weekday: dow(d), inflow: r.inflow, view: r.view, cart: r.cart, orderform: r.orderform, done: r.done, orders_cafe24: r.orders_cafe24, net_revenue: r.net, aov, visits_cafe24: r.visits_cafe24, signups: r.signups, ad_cost_all_media: r.ad_cost, inflow_source: r.inflowSrc }
      : { date: d, weekday: dow(d), inflow: r.inflow, done: r.done, sales: r.sales, returns: r.returns, net_revenue: r.net, aov, ad_cost_all_media: r.ad_cost });
  }
  return out;
}

// 연속 일수 — 같은 단계가 같은 케이스로 며칠째인지(대상일 포함, 최대 14일 거슬러 올라감)
function addStreaks(set, card, ch, cfg) {
  if (!card.steps) return;
  const back = [];
  for (let k = 1; k <= 14; k++) {
    const d = shift(card.date, -k);
    if (d < shift(set.from, 7)) break; // 그 날의 7일 기준선이 데이터 범위를 벗어나면 멈춘다
    const g = goalFor(set, ch, d.slice(0, 7));
    back.push(stepsFor(set, d, ch, cfg, g));
  }
  for (const s of card.steps) {
    if (!s.case) { s.consecutive_days = null; continue; }
    let n = 1;
    for (const st of back) {
      const p = st && st.find((x) => x.key === s.key);
      if (p && p.case === s.case) n++; else break;
    }
    s.consecutive_days = n;
  }
}

async function promoFor(date, ch) {
  try {
    const defs = await promoDefs.listDefs({ mall: CH_NAME[ch], start: shift(date, -1), end: date });
    return defs.map((p) => ({
      promo_id: p.promo_id, name: p.name, type: p.promo_type || null, start: p.start, end: p.end,
      active: p.start <= date && p.end >= date, first_day: p.start === date, day_after_end: p.end === shift(date, -1),
      discount: typeof p.discount === 'number' ? p.discount : (p.discount && (p.discount.max || p.discount.rate)) || null,
    })).filter((p) => p.active || p.day_after_end);
  } catch (_) { return []; }
}

// 상품 신호(블록 H) — MD 설계서 §3-3: H1 할인율 이탈 > H2 조회–전환 괴리 > H3 충전재 믹스 > H4 부착 판매, 최대 3개.
//   전제 데이터는 MD 가 넣기로 했다(2026-10-02 사용자) — ① product_no → 상품명 매핑표 ② promo_defs 의 "대상(티어/SKU) × 설정 할인율" 행.
//   그 데이터가 들어오기 전에는 신호를 만들지 않는다(빈 배열 → 카드에서 블록 H 생략, 설계서 "0개면 블록 자체를 생략").
//   항목 형식(화면·AI 공통): { type:'H1'|'H2'|'H3'|'H4', name, detail, value, peer, consecutive_days, ledger:'cafe24'|'ecount', note }
function productSignals(/* set, date, ch */) {
  return [];
}

// 해시 — 카드의 판단에 쓰인 값이 바뀌었는지(=다시 분석이 필요한지)
function hashOf(card) {
  const core = { v: VERSION, s: card.status, b: card.badge, st: card.steps, n: card.net_revenue, w: card.will_gap, d: card.daily, g: card.goal, p: card.promo };
  return crypto.createHash('sha1').update(JSON.stringify(core)).digest('hex');
}

/** 기간의 서버 계산(일자별) — 저장본은 붙이지 않는다 */
async function computeRange(start, end, ch) {
  if (!isYmd(start) || !isYmd(end) || start > end) throw new Error('기간 형식 오류(YYYY-MM-DD ~ YYYY-MM-DD)');
  if (!CH_NAME[ch]) throw new Error('채널은 mall 또는 ss 입니다');
  const span = dates(start, end).length;
  if (span > 62) throw new Error('한 번에 볼 수 있는 기간은 62일까지입니다');
  const cfg = await cfgDoc();
  // 연속 일수(최대 14일) + 그 날들의 7일 기준선까지 — 시작 22일 전부터 읽는다. 기간 종합의 직전 기간 비교용으로 기간 길이만큼 더.
  const set = await loadSet(shift(start, -(22 + span)), end);
  const out = [];
  for (const d of dates(start, end)) {
    const card = computeDay(set, d, ch, cfg, await promoFor(d, ch));
    if (card.status === 'ok' || card.status === 'data_error') addStreaks(set, card, ch, cfg);
    card.inputHash = hashOf(card);
    out.push(card);
  }
  return { set, cfg, cards: out };
}

// ── 기간 종합(서버 계산) — "N일 중 M일"·요일·갭 추세(§5-2) ───────────────────────
function computePeriodFrom(set, cfg, cards, start, end, ch) {
  const ok = cards.filter((c) => c.status === 'ok' || c.status === 'data_error');
  const days = cards.length;
  const steps = {};
  for (const c of ok) for (const s of c.steps || []) {
    const o = (steps[s.key] = steps[s.key] || { key: s.key, name: s.name, A: 0, B: 0, C: 0, D: 0, E: 0, hold: 0, n: 0 });
    if (s.case) { o[s.case]++; o.n++; } else o.hold++;
  }
  const repeat = Object.values(steps).map((o) => ({ ...o, is_structural: o.A >= 2, days: `${o.A}/${o.n}` }));
  const gapSeries = ok.filter((c) => c.will_gap).map((c) => ({ date: c.date, total: c.will_gap.total, inflow: c.will_gap.inflow, conversion: c.will_gap.conversion, aov: c.will_gap.aov }));
  const avg = (arr, k) => (arr.length ? R(arr.reduce((s, x) => s + x[k], 0) / arr.length) : null);
  // 직전 같은 길이 기간의 갭(비교) — 서버 계산만(저장 안 함)
  const prevCards = dates(shift(start, -days), shift(start, -1)).map((d) => computeDay(set, d, ch, cfg));
  const prevGaps = prevCards.filter((c) => c.will_gap).map((c) => c.will_gap);
  const gapAvg = avg(gapSeries, 'total'), prevAvg = prevGaps.length ? avg(prevGaps, 'total') : null;
  // 요일 — 토·일 vs 평일(일 목표 = 월 목표 ÷ 일수 균등 배분이라 주말 초과·주중 미달은 성과 변화가 아님)
  const wk = (fn) => { const a = ok.filter(fn).filter((c) => c.net_revenue && c.net_revenue.actual != null); return a.length ? { days: a.length, net_avg: avg(a.map((c) => ({ v: c.net_revenue.actual })), 'v'), inflow_avg: avg(a.map((c) => ({ v: (c.steps || [])[0] && c.steps[0].cur || 0 })), 'v'), net_vs_target_avg_pct: r1(a.reduce((s, c) => s + (c.headline.net_vs_target_pct || 0), 0) / a.length) } : null; };
  const isWeekend = (c) => c.weekday === '토' || c.weekday === '일';
  // 합계 — 기간 실적 / 목표(일 목표 합)
  const sum = (k) => ok.reduce((s, c) => s + ((c.net_revenue && c.net_revenue[k]) || 0), 0);
  const netSum = sum('actual'), tgtSum = sum('target_daily');
  // 단계별 비율 추세 — 기간 비율 vs 직전 기간 비율(±0.5%p 안이면 횡보)
  const ratio = (cs, key) => {
    let a = 0, b = 0;
    for (const c of cs) { const r = set.days[c.date] && set.days[c.date][ch]; if (!r || !(r.inflow > 0) || r[key] == null) continue; if (ch === 'mall' && IFDO_KEYS.includes(key) && !r.ifdo3) continue; a += r[key]; b += r.inflow; }
    return b ? (a / b) * 100 : null;
  };
  const trend = STEPS[ch].filter(([k]) => k !== 'inflow').map(([k, name]) => {
    const cur = ratio(ok, k), prev = ratio(prevCards.filter((c) => c.status === 'ok'), k);
    const delta = cur != null && prev != null ? cur - prev : null;
    return { key: k, name: ch === 'ss' ? '구매율' : name, period_pct: r2(cur), prev_pct: r2(prev), delta_pp: r2(delta), direction: delta == null ? null : delta > cfg.eqPp ? '개선' : delta < -cfg.eqPp ? '악화' : '횡보' };
  });
  return {
    version: VERSION, ch, channel: CH_NAME[ch],
    period: { start, end, days },
    badges: cards.map((c) => ({ date: c.date, weekday: c.weekday, badge: c.badge, status: c.status })),
    totals: { net: R(netSum), target: R(tgtSum), achievement_pct: tgtSum ? r1((netSum / tgtSum) * 100) : null },
    repeat_patterns: repeat,
    weekday: { weekend: wk(isWeekend), weekday: wk((c) => !isWeekend(c)) },
    gap_series: gapSeries,
    gap_trend: {
      avg_gap: gapAvg, prev_avg_gap: prevAvg, vs_prev_period: gapAvg != null && prevAvg != null ? gapAvg - prevAvg : null, // 양수 = 갭 축소
      avg_inflow: avg(gapSeries, 'inflow'), avg_conversion: avg(gapSeries, 'conversion'), avg_aov: avg(gapSeries, 'aov'),
      prev_avg_inflow: prevGaps.length ? avg(prevGaps, 'inflow') : null, prev_avg_conversion: prevGaps.length ? avg(prevGaps, 'conversion') : null, prev_avg_aov: prevGaps.length ? avg(prevGaps, 'aov') : null,
    },
    step_trends: trend,
    data_notes: cards.filter((c) => c.status !== 'ok').map((c) => `${c.date} ${c.status === 'data_error' ? '데이터 이상(판정 보류)' : c.status === 'pending_input' ? '유입 미입력' : '데이터 없음'}`),
  };
}

// ── 저장 ────────────────────────────────────────────────────────────────────
async function cardColl() { const c = await store.collection(CARD_COLL); return c; }
async function periodColl() { const c = await store.collection(PERIOD_COLL); return c; }
const cardId = (date, ch) => `${date}|${ch}`;
const periodId = (start, end, ch) => `${start}|${end}|${ch}`;

/** 화면용 — 기간의 서버 계산 + 저장된 문장(있으면) + stale 여부. AI 호출 없음(비용 0) */
async function list(start, end, ch) {
  const { set, cfg, cards } = await computeRange(start, end, ch);
  const c = await cardColl();
  const saved = new Map((await c.find({ _id: { $in: cards.map((x) => cardId(x.date, ch)) } }).toArray()).map((d) => [d.date, d]));
  const days = cards.map((card) => {
    const s = saved.get(card.date);
    return attachDay(card, s);
  });
  let period = null;
  if (cards.length >= 2) {
    const pc = computePeriodFrom(set, cfg, cards, start, end, ch);
    pc.inputHash = crypto.createHash('sha1').update(JSON.stringify({ v: VERSION, b: pc.badges, g: pc.gap_series, r: pc.repeat_patterns, t: pc.totals })).digest('hex');
    const ps = await (await periodColl()).findOne({ _id: periodId(start, end, ch) });
    period = attachPeriod(pc, ps);
  }
  return { start, end, ch, channel: CH_NAME[ch], cfg: { batchMax: cfg.batchMax, eqPp: cfg.eqPp, inflowEqPct: cfg.inflowEqPct }, model: MODEL(), modelDetail: MODEL_DETAIL(), effortDetail: AI_EFFORT_DETAIL, days, period };
}
// ── 규칙 분석 — MD 카드의 문장을 우리 데이터 · 서버 계산값으로 만든다(비용 0) ─────────────────────────
//   사용자 결정(2026-10-02): "우리 데이터에서 로직으로 잡을 수 있는 건 로직으로, AI 는 그 분석이 놓친 조언만".
//   MD 설계서의 블록·규칙(케이스 B·C 는 병목이 아니라 의지 목표 갭 · 목표 수정 제안 금지 · 데이터 이상이면 판정 보류 · 프로모션 영향 부기)을
//   그대로 문장 규칙으로 옮겼다. AI 를 부르지 않아도 카드 한 장이 완성된다.
const hasBatchim = (w) => { const c = String(w || '').trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0; };
const iga = (w) => w + (hasBatchim(w) ? '이' : '가');
const eunNeun = (w) => w + (hasBatchim(w) ? '은' : '는');
const listJosa = (items, pair) => items.join('·') + (hasBatchim(items[items.length - 1]) ? pair[0] : pair[1]); // 마지막 낱말 기준
const termAmt = (t) => `${t[0]}(${swonS(t[1])})`;
const termsJosa = (ts, pair) => ts.map(termAmt).join('·') + (hasBatchim(ts[ts.length - 1][0]) ? pair[0] : pair[1]);
const wonS = (n) => (n == null ? '—' : (n < 0 ? '−' : '') + Math.abs(R(n)).toLocaleString('ko-KR') + '원');
const swonS = (n) => (n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(R(n)).toLocaleString('ko-KR') + '원');
const ppS = (n) => Math.abs(n).toFixed(2) + '%p';
const pctS = (n) => Math.abs(n).toFixed(1) + '%';
const promoTail = (card) => ((card.promo || []).some((p) => p.active || p.day_after_end) ? ' 프로모션 영향 포함.' : '');

// 병목 단계별 — 원인 가설과 확인할 화면, 바로 할 수 있는 조치(설계서 §3 F·G — 탭 이름을 지목한다)
const STAGE_RULES = {
  inflow: { hyp: '광고 집행·검색 노출이나 유입 경로 구성이 바뀌었을 가능성', check: '[트래픽 현황] 탭에서 매체별 유입을 전날·7일평균과 비교', act: '[트래픽 현황] 탭에서 줄어든 유입 경로 확인', eta: 10 },
  view: { hyp: '들어온 고객이 상품까지 가지 않는 랜딩·메인 노출 문제 가능성', check: '[트래픽 현황] 탭에서 랜딩 페이지별 유입과 이탈 확인', act: '메인·랜딩 페이지의 상품 노출(배너·추천 영역) 점검', eta: 15 },
  cart: { hyp: '상품 상세의 가격·옵션·재고 표시 때문에 담기 직전에 멈췄을 가능성', check: '[베스트 상품] 탭에서 조회 상위 상품의 판매 변화 확인', act: '조회 상위 상품의 상세 페이지(가격·옵션·품절 표시) 점검', eta: 15 },
  orderform: { hyp: '장바구니에서 배송비·쿠폰 적용 단계에 걸렸을 가능성', check: '장바구니 화면에서 배송비·쿠폰 적용 흐름 직접 확인', act: '장바구니에 담고 멈춘 고객 리마인드(알림톡·앱 푸시) 발송 여부 확인', eta: 10 },
  done: { hyp: '결제 단계 오류나 결제수단 문제 가능성', check: '결제 오류·CS 문의에서 그날 결제 실패 여부 확인', act: '결제 오류·CS 문의 확인', eta: 10 },
  ss_done: { hyp: '상품 가격·리뷰·검색 노출 순위가 바뀌어 들어온 고객이 덜 샀을 가능성', check: '스마트스토어 상품 노출 순위·리뷰 변화와 [베스트 상품] 탭 확인', act: '스마트스토어 주력 상품의 노출 순위·가격 표시 점검', eta: 15 },
};

function ruleDay(card) {
  if (card.status === 'no_data' || card.status === 'pending_input') return null;
  const steps = card.steps || [], inflow = steps.find((s) => s.key === 'inflow');
  const hl = card.headline || {}, net = card.net_revenue || {}, w = card.will_gap;
  const bn = steps.find((s) => s.case === 'A' && s.name === card.bottleneck);
  const aCount = steps.filter((s) => s.case === 'A').length;
  const ss = card.ch === 'ss';
  const returnsHeavy = ss && net.returns < 0 && net.sales > 0 && -net.returns >= net.sales * 0.3;
  const out = { verdict_line: '', bottleneck_text: '', good_text: '', will_gap_text: '', hypotheses: [], actions: [] };

  // ── 데이터 이상(§8-2) — 판정 전부 보류, 액션 1번 고정
  if (card.status === 'data_error') {
    out.verdict_line = '유입이 0으로 집계됐는데 하위 단계에 값이 있습니다 — 숫자보다 데이터를 먼저 확인해야 하는 날입니다.';
    out.bottleneck_text = '유입 0은 실제 값이 아니라 집계 누락일 가능성이 높습니다. 유입이 없으면 전환 판정을 할 수 없어 이 날의 퍼널 판정은 전부 보류합니다.';
    out.good_text = net.aov != null ? `그래도 읽을 수 있는 것 — 객단가가 ${wonS(net.aov)}(목표 ${wonS(net.aov_target)})입니다.` : '';
    out.actions.push({ eta_min: 10, title: ss ? '비즈어드바이저에서 이 날 유입 재확인 후 재입력' : '이프두 이 날 값 재확인 후 퍼널 입력 다시 올리기', why: '유입 0은 집계 지연일 가능성이 높습니다. 재입력 후 이 카드가 다시 계산됩니다.' });
    return finish(out);
  }

  // ── 한 줄 판정 — "A는 ~했는데 B는 ~했다", 숫자 2개 이내
  const netPart = net.actual != null && net.actual < 0 ? '순매출이 마이너스가 됐습니다'
    : hl.net_vs_avg7_pct == null ? `순매출은 의지 목표의 ${hl.net_vs_target_pct}%였습니다`
      : `순매출이 7일평균 대비 ${pctS(hl.net_vs_avg7_pct)} ${hl.net_vs_avg7_pct >= 0 ? '늘었습니다' : '줄었습니다'}`;
  const inflowPart = !inflow || inflow.vs_avg7_pct == null ? '유입은 7일평균 비교 전이고'
    : Math.abs(inflow.vs_avg7_pct) <= 5 ? '유입은 7일평균과 비슷했는데'
      : inflow.vs_avg7_pct > 0 ? `유입이 7일평균보다 ${pctS(inflow.vs_avg7_pct)} 많았고` : `유입이 7일평균보다 ${pctS(inflow.vs_avg7_pct)} 적었고`;
  const conv = steps.find((s) => s.key === 'done');
  if (card.baseline_note) out.verdict_line = `기준선 부족 — 최근 7일 비교 없이 봅니다. 순매출은 의지 목표의 ${hl.net_vs_target_pct != null ? hl.net_vs_target_pct + '%' : '—'}입니다.`;
  else if (returnsHeavy) out.verdict_line = `${ss ? '구매율' : '전환'}은 ${conv && conv.case === 'A' ? '평소보다 낮았고' : '평소 수준이었는데'} 같은 날 잡힌 반품 ${wonS(-net.returns)}이 ${net.actual < 0 ? '판매분을 넘어 순매출이 마이너스가 됐습니다' : '순매출을 크게 끌어내렸습니다'}.`;
  else if (bn && bn.key !== 'inflow') {
    const up = hl.net_vs_avg7_pct != null && hl.net_vs_avg7_pct > 0;
    const inflowC = inflowPart.replace(/많았고$/, '많았는데').replace(/적었고$/, '적었고');
    out.verdict_line = `${inflowC} ${iga(bn.name)} 7일평균보다 ${ppS(bn.vs_avg7_pp)} 낮아 ` + (up ? `순매출은 7일평균 대비 ${pctS(hl.net_vs_avg7_pct)} 느는 데 그쳤습니다.` : `${netPart}.`);
  }
  else if (bn) out.verdict_line = hl.net_vs_avg7_pct != null && hl.net_vs_avg7_pct > 0
    ? `유입이 7일평균보다 ${pctS(bn.vs_avg7_pct)} 적은 진짜 병목이었는데도 순매출은 7일평균 대비 ${pctS(hl.net_vs_avg7_pct)} 늘었습니다.`
    : `유입이 7일평균보다 ${pctS(bn.vs_avg7_pct)} 적은 진짜 병목이라 ${netPart}.`;
  else if ((card.quiet_decline || []).length) out.verdict_line = `${iga(card.quiet_decline[0])} 목표는 넘겼지만 7일평균보다 낮아진 조용한 악화가 있고, ${netPart}.`;
  else out.verdict_line = `${inflowPart} 진짜 병목 없이 ${netPart}.`;

  // ── 오늘의 병목(스토어 = 구매율 점검)
  if (bn) {
    out.bottleneck_text = `${iga(bn.name)} 목표와 7일평균을 모두 밑돈 진짜 병목입니다${aCount >= 2 ? `(진짜 병목 ${aCount}개 중 퍼널 앞 단계 — 앞이 막히면 뒤는 따라 내려갑니다)` : ''}.`;
    const ol = card.opportunity_loss;
    if (ol) out.bottleneck_text += ol.minor ? ' 7일평균 대비 손실은 1건 미만이라 영향은 미미합니다.' : ` ${eunNeun(bn.name)} 7일평균만 했어도 약 ${ol.orders}건, 약 ${wonS(ol.amount)}이 더 나왔을 것으로 추정됩니다.`;
  } else {
    out.bottleneck_text = '병목 없음 — 목표와 7일평균을 모두 밑돈 단계가 없습니다.';
    if (w && w.total < 0) {
      const terms = [['유입', w.inflow], ['전환', w.conversion], ['객단가', w.aov]].concat(w.other ? [[w.other.label.split(' — ')[0], w.other.amount]] : []).filter((t) => t[1] < 0).sort((a, b) => a[1] - b[1]);
      if (terms.length) out.bottleneck_text += ` 의지 목표에 못 미친 몫은 주로 ${terms[0][0]}에서 났습니다.`;
    }
    if (ss && (card.quiet_decline || []).includes('유입')) out.bottleneck_text += ' 유입이 7일평균보다 줄어 주문이 함께 줄었습니다(구매율 문제가 아님).';
  }
  out.bottleneck_text += promoTail(card);

  // ── 잘된 것 — 7일평균을 가장 많이 넘긴 단계. 없으면 평소 수준을 지킨 단계(나쁜 날에도 하나는 찾는다)
  const ratios = steps.filter((s) => s.key !== 'inflow' && !s.hold && s.vs_avg7_pp != null);
  const best = ratios.slice().sort((a, b) => b.vs_avg7_pp - a.vs_avg7_pp)[0];
  if (best && best.vs_avg7_pp > 0) out.good_text = `${iga(best.name)} 7일평균보다 ${ppS(best.vs_avg7_pp)} 높아 가장 좋았습니다.`;
  else if (inflow && inflow.vs_avg7_pct > 5) out.good_text = `유입이 7일평균보다 ${pctS(inflow.vs_avg7_pct)} 많았습니다.`;
  else if (best) out.good_text = `${eunNeun(best.name)} 7일평균과 ${ppS(best.vs_avg7_pp)} 차이로 평소 수준을 지켰습니다.`;
  const day = (card.daily || [])[card.daily ? card.daily.length - 1 : 0];
  if (!ss && day && day.orderform > 0 && day.done === day.orderform) out.good_text += ' 주문서를 쓴 고객은 모두 결제까지 갔습니다.';
  if (ss && conv && conv.vs_target_pp != null && conv.vs_target_pp > 0 && !(best && best.vs_avg7_pp > 0)) out.good_text = out.good_text.replace(/지켰습니다.$/, `지켰고, 의지 목표 비율도 ${ppS(conv.vs_target_pp)} 넘겼습니다.`);

  // ── 의지 목표 갭 — 못 미친 날은 "주로 어디서 잃고 무엇이 메웠나", 넘긴 날은 "무엇이 끌어올렸나" + 상시 갭 구간
  if (w) {
    const terms = [['유입', w.inflow], ['전환', w.conversion], ['객단가', w.aov]].concat(w.other ? [[w.other.label.split(' — ')[0], w.other.amount]] : []);
    const neg = terms.filter((t) => t[1] < 0).sort((x, y) => x[1] - y[1]).slice(0, 2);
    const pos = terms.filter((t) => t[1] > 0).sort((x, y) => y[1] - x[1]).slice(0, 2);
    if (w.total < 0) {
      out.will_gap_text = `의지 목표에 ${wonS(-w.total)} 못 미쳤습니다.` + (neg.length ? ` 갭은 주로 ${neg.map(termAmt).join('·')}에서 났고` : '') +
        (pos.length ? ` ${termsJosa(pos.slice(0, 1), ['이', '가'])} 일부를 메웠습니다.` : neg.length ? ' 메운 항은 없습니다.' : '');
    } else {
      out.will_gap_text = `의지 목표를 ${wonS(w.total)} 넘겼습니다.` + (pos.length ? ` ${termsJosa(pos, ['이', '가'])} 끌어올렸고` : '') +
        (neg.length ? ` ${termsJosa(neg, ['은', '는'])} 목표에 못 미쳤습니다.` : pos.length ? ' 못 미친 항은 없습니다.' : '');
    }
    if ((card.gap_items || []).length) out.will_gap_text += ` ${listJosa(card.gap_items, ['은', '는'])} 상시 갭 구간이라 오늘의 액션 대상이 아닙니다.`;
    if (w.other && /집계 차이/.test(w.other.label)) out.will_gap_text += ` 집계 차이는 이프두가 못 잡은 주문(이프두 ${net.orders}건 · Cafe24 ${net.orders_cafe24}건) 몫이라 성과가 아닙니다.`;
  }

  // ── 원인 가설 — 병목이 있을 때만, 최대 2개
  if (bn) {
    const p = (card.promo || []).find((x) => x.day_after_end || x.first_day);
    if (p && p.day_after_end) out.hypotheses.push({ text: `전날 끝난 프로모션(${p.name}) 할인이 정상가로 돌아가 ${bn.name} 단계에서 멈춘 고객이 늘었을 가능성`, how_to_check: '[프로모션 매출] 탭에서 프로모션 마지막 날과 이 날을 비교' });
    else if (p && p.first_day) out.hypotheses.push({ text: `프로모션(${p.name}) 첫날이라 유입 구성이 평소와 달랐을 가능성`, how_to_check: '[트래픽 현황] 탭에서 매체별 유입 비교' });
    const r = STAGE_RULES[ss && bn.key === 'done' ? 'ss_done' : bn.key];
    if (r && out.hypotheses.length < 2) out.hypotheses.push({ text: r.hyp, how_to_check: r.check });
    if (out.hypotheses.length < 2 && net.aov != null && net.aov_avg7 && net.aov < net.aov_avg7 * 0.8) out.hypotheses.push({ text: `객단가가 7일평균(${wonS(net.aov_avg7)})보다 크게 낮아 고단가 상품 구매가 빠졌을 가능성`, how_to_check: '[베스트 상품] 탭에서 이 날 판매 상품 구성 확인' });
  }

  // ── 액션 — 최대 3개, 근거는 계산값
  const acts = [];
  if (bn) {
    const r = STAGE_RULES[ss && bn.key === 'done' ? 'ss_done' : bn.key];
    const ol = card.opportunity_loss;
    acts.push({ eta_min: r.eta, title: r.act, why: `${iga(bn.name)} 7일평균보다 ${bn.key === 'inflow' ? pctS(bn.vs_avg7_pct) : ppS(bn.vs_avg7_pp)} 낮은 진짜 병목${ol && !ol.minor ? ` — 기회손실 약 ${wonS(ol.amount)}(추정)` : ''}입니다.` });
  }
  if (returnsHeavy) acts.push({ eta_min: 15, title: '이 날 잡힌 반품의 원 주문일·상품 확인', why: `반품 ${wonS(-net.returns)}이 순매출을 ${net.actual < 0 ? '마이너스로 만들었습니다' : '크게 줄였습니다'} — 지난 주문분인지 확인이 필요합니다.` });
  for (const q of card.quiet_decline || []) {
    const st = steps.find((s) => s.name === q);
    acts.push({ eta_min: 10, title: q === '유입' ? '[트래픽 현황] 탭에서 줄어든 유입 경로 확인' : `${q} 비율 7일 흐름 확인`, why: `${iga(q)} 목표는 넘겼지만 7일평균보다 ${st && st.key === 'inflow' ? pctS(st.vs_avg7_pct) : st ? ppS(st.vs_avg7_pp) : ''} 낮아진 조용한 악화 — 초록불이라 놓치기 쉽습니다.` });
  }
  if (w && w.total < 0 && w.aov < 0 && [w.inflow, w.conversion, w.other ? w.other.amount : 0].every((x) => w.aov <= x)) acts.push({ eta_min: 10, title: '[베스트 상품] 탭에서 이 날 판매 상품 구성 확인', why: `객단가 기여 ${swonS(w.aov)}이 갭에서 가장 큰 마이너스 항입니다.` });
  if (!ss && card.data_status && card.data_status.ifdu_3steps === false) acts.push({ eta_min: 5, title: '이프두 3단계(상품조회·장바구니·주문서) 입력', why: '입력 전이라 그 단계들은 판단 보류입니다.' });
  if (!ss && card.data_status && card.data_status.inflow_source === 'Cafe24') acts.push({ eta_min: 5, title: '이프두 방문·주문 값 올리기', why: '이프두가 아직 없어 Cafe24 값으로 계산했습니다(이프두보다 10~20% 많게 나옴).' });
  out.actions = acts.slice(0, 3);
  return finish(out);
}
function finish(out) {
  out.actions = out.actions.map((a, i) => ({ no: i + 1, ...a }));
  if (!out.actions.length && out.verdict_line && !/조치 불필요/.test(out.verdict_line)) out.verdict_line += ' 조치 불필요.';
  return out;
}

function rulePeriod(p) {
  const n = p.period.days, cnt = {};
  for (const b of p.badges || []) if (b.badge) cnt[b.badge] = (cnt[b.badge] || 0) + 1;
  const lab = { good: '좋음', normal: '정상', warn: '주의', risk: '위험', data_error: '데이터 이상' };
  const g = p.gap_trend || {}, tt = p.totals || {};
  const out = { summary_line: '', repeat_patterns: [], weekday_note: '', gap_trend_text: '', trend_text: '', actions: [] };
  out.summary_line = `${n}일 중 ${Object.keys(lab).filter((k) => cnt[k]).map((k) => `${lab[k]} ${cnt[k]}일`).join(' · ') || '판정 없음'} — 기간 순매출은 의지 목표의 ${tt.achievement_pct != null ? tt.achievement_pct + '%' : '—'}` +
    (g.vs_prev_period != null ? `, 평균 갭은 직전 같은 기간보다 ${wonS(Math.abs(g.vs_prev_period))} ${g.vs_prev_period >= 0 ? '줄었습니다' : '커졌습니다'}.` : '입니다.');
  // 반복 패턴 — 같은 단계 진짜 병목 2일 이상 = 구조 신호. B·C 만 반복이면 구조 문제가 아님
  for (const r of p.repeat_patterns || []) {
    if (!r.n) continue;
    if (r.A >= 2) out.repeat_patterns.push({ text: `${iga(r.name)} ${r.n}일 중 ${r.A}일 진짜 병목 — 구조 신호입니다.`, days: `${r.A}/${r.n}`, is_structural: true });
    else if (r.B + r.C === r.n && r.n >= 2) out.repeat_patterns.push({ text: `${eunNeun(r.name)} ${r.n}일 모두 의지 목표 갭 구간 — 평소 수준이라 구조 문제는 아닙니다.`, days: `${r.B + r.C}/${r.n}`, is_structural: false });
  }
  if (!out.repeat_patterns.some((x) => x.is_structural)) out.repeat_patterns.unshift({ text: '같은 단계가 이틀 이상 진짜 병목인 구조 신호는 없습니다.', days: null, is_structural: false });
  out.repeat_patterns = out.repeat_patterns.slice(0, 3);
  // 요일 — 균등 배분 목표라 주말 초과·평일 미달은 성과 변화가 아님(설계서 §5-2)
  const wk = p.weekday || {};
  if (wk.weekend && wk.weekday) out.weekday_note = `주말 하루 평균 순매출 ${wonS(wk.weekend.net_avg)}, 평일 ${wonS(wk.weekday.net_avg)}` +
    (wk.weekend.net_avg >= wk.weekday.net_avg ? ' — 일 목표는 월 목표를 일수로 똑같이 나눈 값이라 주말 초과·평일 미달은 성과 변화가 아닙니다.' : ' — 이번엔 평일이 더 높았습니다. 일 목표가 균등 배분이라 요일별 달성률 차이는 성과 변화로 보지 않습니다.');
  else out.weekday_note = `기간이 ${wk.weekend ? '주말' : '평일'}만이라 요일 비교는 하지 않았습니다.`;
  // 갭 추세 — 기여도별 방향(갭 축소가 유일한 진척 지표)
  if (g.prev_avg_gap != null) {
    const dir = (a, b) => (a == null || b == null ? '—' : a > b ? '나아짐' : a < b ? '나빠짐' : '같음');
    out.gap_trend_text = `평균 갭이 직전 같은 기간보다 ${g.vs_prev_period >= 0 ? '줄었습니다' : '커졌습니다'} — 유입 기여 ${dir(g.avg_inflow, g.prev_avg_inflow)}, 전환 기여 ${dir(g.avg_conversion, g.prev_avg_conversion)}, 객단가 기여 ${dir(g.avg_aov, g.prev_avg_aov)}.`;
  }
  const tr = p.step_trends || [];
  const by = (d) => tr.filter((x) => x.direction === d).map((x) => x.name);
  out.trend_text = [['개선', by('개선')], ['악화', by('악화')], ['횡보', by('횡보')]].filter((x) => x[1].length).map((x) => `${x[0]}: ${x[1].join('·')}`).join(' / ');
  // 기간 액션 — 구조·운영을 바꾸는 것(최대 3)
  for (const r of out.repeat_patterns.filter((x) => x.is_structural)) {
    const name = r.text.split(/[이가] /)[0];
    out.actions.push({ eta_min: 30, title: `${name} 단계 구조 점검 — 같은 병목이 ${r.days}일 반복`, why: '하루짜리 문제가 아니라 같은 자리에서 반복되는 막힘입니다.' });
  }
  const worse = tr.filter((x) => x.direction === '악화');
  for (const x of worse) out.actions.push({ eta_min: 20, title: `${x.name} 비율 하락 원인 점검`, why: `직전 같은 기간보다 ${ppS(x.delta_pp)} 낮아졌습니다.` });
  if (g.vs_prev_period != null && g.vs_prev_period < 0) {
    const t = [['유입', g.avg_inflow - g.prev_avg_inflow], ['전환', g.avg_conversion - g.prev_avg_conversion], ['객단가', g.avg_aov - g.prev_avg_aov]].sort((a, b) => a[1] - b[1])[0];
    if (t && t[1] < 0) out.actions.push({ eta_min: 20, title: `${t[0]} 기여가 나빠진 원인 점검`, why: `평균 갭이 직전 같은 기간보다 ${wonS(-g.vs_prev_period)} 커졌고 ${t[0]} 기여가 가장 많이 나빠졌습니다.` });
  }
  if ((p.data_notes || []).length) out.actions.push({ eta_min: 10, title: '입력이 빠진 날 데이터 채우기', why: p.data_notes.join(', ') + ' — 채워야 기간 판단이 정확해집니다.' });
  out.actions = out.actions.slice(0, 3).map((a, i) => ({ no: i + 1, ...a }));
  if (!out.actions.length) out.summary_line += ' 기간 조치 불필요.';
  return out;
}

// ── AI 조언 — 규칙 분석이 놓친 관점만 짧게(1~3문장). 버튼을 누를 때만, 저장 후 재사용 ─────────────────
//   MD 프롬프트의 금지 규칙(숫자 새로 계산 금지 · 목표 수정 제안 금지 · 실행 불가 제안 금지 · B·C 를 병목이라 부르지 않기)은 그대로 둔다.
const SYSTEM_ADVICE = `당신은 요기보 코리아 온라인 MD의 조언자다. 사용자 메시지 JSON은 서버가 이미 계산하고 규칙으로 정리한 분석이다.
rule 에 화면에 이미 나간 판정·병목·액션이 있다. 그 규칙 분석이 놓쳤을 수 있는 관점만 1~3개, 각 1문장으로 짧게 조언한다.
화면에 이미 있는 판정·액션·숫자 나열을 반복하지 마라. 놓친 게 없으면 빈 배열을 낸다.
[금지] 숫자를 새로 계산하지 마라(주어진 값만 인용) · 목표 수정·하향 제안 금지(임원진이 정한 고정 의지치) · 광고비 증액·재고 확대·신규 출점·상시 할인 확대 제안 금지 ·
할인율 20% 초과 제안 금지 · 케이스 B·C(의지 목표 갭)를 병목이라 부르지 마라 · 추측은 "추정" 또는 "가능성"으로 쓴다.
[표기] 금액은 천단위 콤마 + "원"(K/M·만원 축약 금지), 비율·%p는 소수 둘째 자리.
출력: {"advice":["…","…"]} JSON 하나만. 머리말·코드펜스 금지.`;

function compactSteps(steps) {
  return (steps || []).map((s) => (s.key === 'inflow'
    ? { 단계: s.name, 당일: s.cur, vs목표_pct: s.vs_target_pct, vs7일평균_pct: s.vs_avg7_pct, 케이스: s.case, 연속일: s.consecutive_days }
    : { 단계: s.name, 비율_pct: s.cur_pct, vs목표_pp: s.vs_target_pp, vs7일평균_pp: s.vs_avg7_pp, 케이스: s.case, 보류: s.hold || undefined, 연속일: s.consecutive_days }));
}
function adviceInputDay(card, rule) {
  const n = card.net_revenue || {};
  return {
    날짜: `${card.date}(${card.weekday})`, 채널: card.channel, 배지: card.badge,
    순매출_7일평균대비_pct: card.headline && card.headline.net_vs_avg7_pct, 순매출_의지목표달성_pct: card.headline && card.headline.net_vs_target_pct,
    단계: compactSteps(card.steps), 병목: card.bottleneck, 기회손실: card.opportunity_loss, 조용한악화: card.quiet_decline,
    순매출: { 실제: n.actual, 일목표: n.target_daily, 평균7일: n.avg7, 객단가: n.aov, 객단가_7일평균: n.aov_avg7, 객단가_목표: n.aov_target, ...(card.ch === 'ss' ? { 판매: n.sales, 반품: n.returns } : { 주문_이프두: n.orders, 주문_Cafe24: n.orders_cafe24 }) },
    의지목표갭: card.will_gap ? { 합계: card.will_gap.total, 유입: card.will_gap.inflow, 전환: card.will_gap.conversion, 객단가: card.will_gap.aov,
      ...(card.will_gap.other ? { [card.will_gap.other.label.split(' — ')[0]]: card.will_gap.other.amount } : {}) } : null, // 집계 차이 · 반품·취소 차감은 이름 그대로
    프로모션: (card.promo || []).map((p) => p.name + (p.day_after_end ? '(종료 다음날)' : p.first_day ? '(첫날)' : '')),
    최근7일_순매출: (card.daily || []).map((d) => `${d.date.slice(5)}(${d.weekday}) ${d.net_revenue}`),
    rule: { 판정: rule && rule.verdict_line, 액션: rule ? rule.actions.map((a) => a.title) : [] },
  };
}
function adviceInputPeriod(p, rule) {
  return {
    기간: `${p.period.start}~${p.period.end}(${p.period.days}일)`, 채널: p.channel,
    일자별_배지: (p.badges || []).map((b) => `${b.date.slice(5)} ${b.badge || b.status}`),
    반복: (p.repeat_patterns || []).filter((r) => r.n).map((r) => ({ 단계: r.name, 진짜병목: r.A, 의지목표갭: r.B + r.C, 조용한악화: r.D, 일수: r.n })),
    요일: p.weekday, 갭추세: p.gap_trend, 단계추세: (p.step_trends || []).map((x) => ({ 단계: x.name, 방향: x.direction, 차이_pp: x.delta_pp })),
    합계: p.totals, 데이터: p.data_notes,
    rule: { 요약: rule && rule.summary_line, 액션: rule ? rule.actions.map((a) => a.title) : [] },
  };
}
function parseJson(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI 응답에서 결과(JSON)를 찾지 못했습니다');
  return JSON.parse(s.slice(a, b + 1));
}
const cleanAdvice = (j) => (Array.isArray(j && j.advice) ? j.advice : []).slice(0, 3).map((x) => String(x || '').slice(0, 300)).filter(Boolean);
function savedView(d) {
  return { advice: Array.isArray(d.advice) ? d.advice : null, model: d.model, source: d.source || 'api', createdAt: d.createdAt, usage: d.usage || null, ai_error: d.ai_error || null };
}

async function callAdvice(input) {
  const res = await ai.complete(SYSTEM_ADVICE, [{ role: 'user', content: JSON.stringify(input) }], { model: MODEL(), effort: AI_EFFORT, maxTokens: 800, timeoutMs: AI_TIMEOUT_MS });
  return { advice: cleanAdvice(parseJson(res.text)), model: res.model || MODEL(), usage: res.usage ? { input: res.usage.input_tokens || null, output: res.usage.output_tokens || null } : null };
}

const inflight = new Map();
/** 하루 AI 조언 — 저장본이 있으면 그대로(비용 0), regenerate 면 새로. 규칙 분석은 언제나 서버가 바로 만든다 */
async function analyzeDay(date, ch, { regenerate = false } = {}) {
  if (!isYmd(date)) throw new Error('date 형식 오류(YYYY-MM-DD)');
  if (date >= todayKst()) throw new Error('오늘·미래 날짜는 분석할 수 없습니다(하루가 끝난 뒤 분석)');
  const { cards } = await computeRange(date, date, ch);
  const card = cards[0];
  if (card.status === 'no_data' || card.status === 'pending_input') throw new Error(card.note);
  card.rule = ruleDay(card);
  const c = await cardColl();
  const cur = await c.findOne({ _id: cardId(date, ch) });
  if (cur && Array.isArray(cur.advice) && !cur.ai_error && !regenerate) return { card: attachDay(card, cur), cached: true };
  if (!ai.enabled()) throw new Error('AI 키가 설정되지 않아 조언을 만들 수 없습니다 — 서버 환경변수에 ANTHROPIC_API_KEY 를 넣어 주세요.');
  const key = cardId(date, ch);
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      let r = null, err = null;
      try { r = await callAdvice(adviceInputDay(card, card.rule)); } catch (e) { err = e.message; }
      return setDoc(c, key, { date, ch, version: VERSION, inputHash: card.inputHash, advice: r ? r.advice : null, ai_error: err, model: (r && r.model) || MODEL(), source: 'api', usage: r ? r.usage : null, createdAt: new Date().toISOString() });
    })().finally(() => inflight.delete(key)));
  }
  const doc = await inflight.get(key);
  return { card: attachDay(card, doc), cached: false };
}

/** 기간 AI 조언 */
async function analyzePeriod(start, end, ch, { regenerate = false } = {}) {
  const view = await list(start, end, ch);
  if (!view.period) throw new Error('기간 종합은 2일 이상일 때 만듭니다');
  const p = view.period;
  const pcol = await periodColl();
  const cur = await pcol.findOne({ _id: periodId(start, end, ch) });
  if (cur && Array.isArray(cur.advice) && !cur.ai_error && !regenerate) return { period: attachPeriod(p, cur), cached: true };
  if (!ai.enabled()) throw new Error('AI 키가 설정되지 않아 조언을 만들 수 없습니다 — 서버 환경변수에 ANTHROPIC_API_KEY 를 넣어 주세요.');
  let r = null, err = null;
  try { r = await callAdvice(adviceInputPeriod(p, p.rule)); } catch (e) { err = e.message; }
  const doc = await setDoc(pcol, periodId(start, end, ch), { start, end, ch, version: VERSION, inputHash: p.inputHash, advice: r ? r.advice : null, ai_error: err, model: (r && r.model) || MODEL(), source: 'api', usage: r ? r.usage : null, createdAt: new Date().toISOString() });
  return { period: attachPeriod(p, doc), cached: false };
}

/** 예제 저장 — Claude Code 세션(Opus)이 쓴 AI 조언을 같은 형식으로 넣는다(API 비용 없이 모양 보이기) */
async function saveExample({ date, ch, advice, model, period }) {
  if (period) {
    const view = await list(period.start, period.end, ch);
    if (!view.period) throw new Error('기간 종합은 2일 이상');
    return setDoc(await periodColl(), periodId(period.start, period.end, ch), { start: period.start, end: period.end, ch, version: VERSION, inputHash: view.period.inputHash, advice: cleanAdvice({ advice }), ai_error: null, model, source: 'example', usage: null, createdAt: new Date().toISOString() });
  }
  const { cards } = await computeRange(date, date, ch);
  return setDoc(await cardColl(), cardId(date, ch), { date, ch, version: VERSION, inputHash: cards[0].inputHash, advice: cleanAdvice({ advice }), ai_error: null, model, source: 'example', usage: null, createdAt: new Date().toISOString() });
}

// ── AI 상세 분석 — MD 설계서 방식: AI 가 카드 문장 전체를 쓴다(버튼을 누를 때만, 저장 후 재사용) ─────────────
//   사용자 결정(2026-10-02): 장당 수십 원이면 써도 된다 → 데이터 기반 카드는 그대로 두고 [🤖 AI 상세 분석] 버튼을 추가.
//   숫자·판정은 여전히 서버 계산값을 넘기고(설계서 §7-1), 작성 규칙은 MD 최종 프롬프트(PROMPT A·B) 그대로.
//   모델은 Sonnet 5.5 · effort medium(실측 9/30 자사몰: 7.4초 · 입력 2,915 · 출력 839 토큰). 바꾸려면 env FUNNEL_AI_MODEL_DETAIL · FUNNEL_AI_EFFORT_DETAIL
//   저장은 간략 조언과 같은 문서의 detail* 칸 — 서로 덮어쓰지 않는다.
const MODEL_DETAIL = () => process.env.FUNNEL_AI_MODEL_DETAIL || MODEL();
const AI_EFFORT_DETAIL = process.env.FUNNEL_AI_EFFORT_DETAIL || 'medium';

const SYSTEM_DETAIL_DAY = `당신은 요기보 코리아의 온라인 MD다. 자사몰·스마트스토어의 일일 퍼널 성과를 검토하고,
담당자가 출근 직후 30초 안에 읽을 분석 카드를 작성한다.

════════ 입력 ════════
사용자 메시지의 JSON만 사용한다. 도구를 호출하지 마라. 없는 값은 추측하지 말고 해당 항목을 생략한다.
  computed      서버가 이미 계산한 확정값 — 배지, 단계별(유입 대비) 당일·목표·7일평균 비율과 vs목표·vs평균(%p),
                케이스 A~E, 병목, 기회손실, 의지 목표 갭 분해, 연속 일수. 숫자를 새로 계산하지 말고 이 값만 인용한다.
  daily         대상일 포함 최근 8일 원자료(날짜 오름차순, 마지막 행이 대상일) — 관계를 읽는 참고용
  goal          월 목표 원본 · 해당 월 일수 · 목표 객단가(단가이므로 일할 분할하지 않는다)
  field_guide   각 숫자의 뜻(특히 % 와 %p 구분)
  data_status · promo · notes   데이터 상태 · 대상일 프로모션 · 데이터 출처 메모
케이스 — A 진짜 병목(목표·7일평균 모두 미달) · B·C 의지 목표 갭(평소 수준이거나 평소보다 좋은데 목표 미달 — 오늘의 문제가 아님)
       · D 조용한 악화(목표는 넘겼지만 평소보다 나빠짐) · E 정상.
배지는 7일평균 순매출 기준이다(data_error > risk > warn > good > normal). 의지 목표 달성률로 배지를 해석하지 마라.
월 일수가 달라지면 일 목표도 달라진다(30일→31일이면 약 3.2% 낮아진다). 이것은 성과 변화가 아니므로 전월과 비교할 때 언급하지 마라.

════════ 작성 ════════
[금지]
  · 숫자를 새로 만들지 마라. computed 값과 입력값만 인용한다.
  · 입력에 이미 있는 숫자를 그대로 나열하지 마라. 관계로 바꿔 쓴다.
      (X) "유입 880명, 목표 1,070명 대비 82%"
      (O) "유입은 7일평균보다 22.7% 많았는데 상품조회 비율은 그대로였다"
  · 케이스 B·C를 "병목"이나 "개선 필요"로 쓰지 마라. "의지 목표 갭"으로 쓴다.
  · 목표의 수정·재설정·하향을 제안하지 마라. 목표는 임원진이 설정한 고정 의지치다. 갭을 줄이는 방법만 제시한다.
  · 광고비 증액, 재고 확대, 신규 출점, 상시 할인 확대를 제안하지 마라. 전부 실행 불가다.
  · 할인율 20%를 넘기는 제안을 하지 마라.
  · 매핑되지 않은 상품명은 언급하지 마라.
  · 추측은 "추정" 또는 "가능성"으로 표시한다.
[표기]
  · 금액은 천단위 콤마 + "원". K/M·만원 축약 금지. (예: 214,631원)
  · 비율·%p는 소수 둘째 자리까지.
  · 한 블록은 3문장 이내. 짧고 평이하게.
  · 문장은 "~습니다"체로 쓴다(MD 카드 예시와 같게). 예: "유입은 늘었는데 장바구니 비율은 떨어졌습니다."
[블록별 지시]
  verdict_line     그날을 한 문장으로. 대조 구조("A는 ~했는데 B는 ~했다"). 숫자 최대 2개.
  bottleneck_text  병목이 있으면 기회손실 금액까지. 없으면 "병목 없음 — 전 단계가 7일평균 이상"으로 시작하고
                   순매출이 목표에 못 미친 원인이 어디인지 한 문장 덧붙인다.
                   스마트스토어는 단계가 유입 → 주문뿐이다. "어느 단계가 막혔나" 대신 "유입은 늘었는데 구매율이 떨어졌다"와
                   "유입이 줄어 주문이 줄었다"를 구분해 쓴다.
  good_text        7일평균을 넘긴 단계 중 가장 큰 것. 나쁜 날에도 반드시 하나는 찾는다.
  will_gap_text    갭 합계와 항목들을 제시하고, 갭이 어느 항에서 주로 났는지 한 문장. 케이스 B·C 단계(gap_items)는 상시 갭 구간이라
                   오늘의 액션 대상이 아니라고 적는다. will_gap.other(집계 차이·반품 차감)가 있으면 그 항이 성과가 아니라는 점을 밝힌다.
  hypotheses       병목이 있을 때만 2~3개. 각 항목에 how_to_check를 반드시 붙이고, 대시보드 탭 이름이나 구체적 화면을 지목한다.
                   (탭: 일일 퍼널 점검 · 일일 매출 리포트 · 채널 분석 · 전년/전월/전주 비교 · 프로모션 매출 · 트래픽 현황 · 베스트 상품 · 상품별 판매량 분석 · 충전재별 판매량)
  product_text     상품 신호가 있을 때만. 없으면 null.
  actions          3~5개. 트리거가 3개 미만이면 그만큼만. 0개면 빈 배열로 두고 verdict_line에 "조치 불필요"를 명시한다.
                   각 액션에 eta_min(분)과 why(근거)를 붙이고, why에는 computed 값을 인용한다.
[배지가 data_error일 때]
  퍼널 판정을 전부 보류한다. bottleneck_text는 "판단 보류"의 이유를 쓴다.
  actions의 1번은 "데이터 재확인 후 재입력"으로 고정한다. 그래도 읽을 수 있는 지표가 있으면 good_text에 쓴다.
[프로모션 기간일 때]
  promo가 비어 있지 않으면 bottleneck_text 끝에 "프로모션 영향 포함"을 붙인다.
[기준선 부족일 때]
  computed.baseline_note 가 있으면 7일평균 비교 문장을 쓰지 말고 verdict_line 에 "기준선 부족"을 밝힌다.

════════ 출력 ════════
아래 JSON 하나만 출력한다. 머리말·설명·코드펜스를 붙이지 마라.
{"verdict_line":"…","bottleneck_text":"…","good_text":"…","will_gap_text":"…","product_text":null,
 "hypotheses":[{"text":"…","how_to_check":"…"}],
 "actions":[{"no":1,"eta_min":15,"title":"…","why":"…"}]}`;

const SYSTEM_DETAIL_PERIOD = `당신은 요기보 코리아의 온라인 MD다. 아래는 같은 채널의 기간 분석 자료다(서버가 계산한 확정값 + 일자별 카드 요약).
일자별로는 보이지 않는 패턴만 찾아 기간 종합 카드를 작성한다. 숫자는 새로 계산하지 말고 주어진 값만 인용한다.

[찾을 것]
 1. 반복 패턴 — 같은 단계가 N일 중 M일 케이스 A였는가(repeat_patterns). 2일 이상이면 "구조 신호"로 올린다.
                케이스 B·C 반복은 의지 목표 갭이므로 구조 신호가 아니다.
 2. 요일 패턴 — 일 목표는 월 목표 ÷ 일수(균등 배분)다. 주중은 상시 미달, 주말은 상시 초과로 나타나기 쉽다.
                이 부분은 성과 변화가 아니라고 명시한다(weekday).
 3. 의지 갭 추세 — 기간 평균 갭과 유입·전환·객단가 기여도별 방향(gap_trend). vs_prev_period 가 양수면 갭 축소다.
                목표는 고정이므로 "갭 축소"가 유일한 진척 지표다.
 4. 단계별 비율 추세(step_trends) — 직전 같은 길이 기간 대비 개선/악화/횡보.
[금지] 일자별 카드에 이미 쓴 문장을 반복하지 마라. 목표 수정을 제안하지 마라. 광고비 증액·재고 확대·신규 출점·상시 할인 확대를 제안하지 마라.
[표기] 금액은 천단위 콤마 + "원"(K/M·만원 축약 금지). 비율·%p는 소수 둘째 자리까지. 한 블록 3문장 이내. 문장은 "~습니다"체.
[액션] 3~5개. 하루짜리 조치가 아니라 구조·설정·운영 방식을 바꾸는 것으로 쓴다. 각 액션에 eta_min(분)과 why(근거, 주어진 값 인용).

출력은 아래 JSON만. 머리말·코드펜스 금지.
{"summary_line":"기간을 한 문장으로","repeat_patterns":[{"text":"…","days":"5/5","is_structural":false}],"weekday_note":"…",
 "gap_trend_text":"…","trend_text":"…","actions":[{"no":1,"eta_min":30,"title":"…","why":"…"}]}`;

const strN = (v, n = 600) => (v == null ? null : String(v).slice(0, n));
function cleanDayText(j) {
  return {
    verdict_line: strN(j.verdict_line, 300) || '',
    bottleneck_text: strN(j.bottleneck_text), good_text: strN(j.good_text), will_gap_text: strN(j.will_gap_text),
    product_text: j.product_text ? strN(j.product_text) : null,
    hypotheses: (Array.isArray(j.hypotheses) ? j.hypotheses : []).slice(0, 3).map((h) => ({ text: strN(h && h.text, 300) || '', how_to_check: strN(h && h.how_to_check, 300) || '' })),
    actions: (Array.isArray(j.actions) ? j.actions : []).slice(0, 5).map((x, i) => ({ no: i + 1, eta_min: Number(x && x.eta_min) || null, title: strN(x && x.title, 200) || '', why: strN(x && x.why, 400) || '' })),
  };
}
function cleanPeriodText(j) {
  return {
    summary_line: strN(j.summary_line, 300) || '',
    repeat_patterns: (Array.isArray(j.repeat_patterns) ? j.repeat_patterns : []).slice(0, 5).map((r) => ({ text: strN(r && r.text, 400) || '', days: strN(r && r.days, 20), is_structural: !!(r && r.is_structural) })),
    weekday_note: strN(j.weekday_note), gap_trend_text: strN(j.gap_trend_text), trend_text: strN(j.trend_text),
    actions: (Array.isArray(j.actions) ? j.actions : []).slice(0, 5).map((x, i) => ({ no: i + 1, eta_min: Number(x && x.eta_min) || null, title: strN(x && x.title, 200) || '', why: strN(x && x.why, 400) || '' })),
  };
}

// 상세 분석 입력 — 계산값 전부 + 최근 8일 원자료 + 월 목표 원본(MD 프롬프트 입력 구조)
function detailInputDay(card) {
  return {
    target: { date: card.date, weekday: card.weekday, channel: card.channel },
    goal: card.goal,
    computed: {
      status: card.status, badge: card.badge, baseline_note: card.baseline_note,
      headline: {
        net_change_vs_avg7_pct: card.headline && card.headline.net_vs_avg7_pct,
        net_achievement_vs_daily_target_pct: card.headline && card.headline.net_vs_target_pct,
        inflow_achievement_vs_daily_target_pct: card.headline && card.headline.inflow_vs_target_pct,
      },
      steps: (card.steps || []).map(({ valid_days, key, ...s }) => s),
      net_revenue: card.net_revenue, bottleneck: card.bottleneck, opportunity_loss: card.opportunity_loss,
      will_gap: card.will_gap, gap_items: card.gap_items, quiet_decline: card.quiet_decline, product_signals: card.product_signals,
    },
    daily: card.daily, data_status: card.data_status, promo: card.promo,
    field_guide: [
      'headline.net_change_vs_avg7_pct: 순매출이 7일평균보다 몇 % 많거나 적은지. 122.3 이면 "7일평균보다 122.3% 많다(두 배 이상)"이지 "7일평균의 122.3%"가 아니다.',
      'headline.net_achievement_vs_daily_target_pct: 순매출 ÷ 일 목표 × 100 (의지 목표 달성률, 표시용 — 판정에 쓰지 않는다).',
      'steps[유입].vs_target_pct · vs_avg7_pct: 유입이 일 목표 · 7일평균보다 몇 % 많거나(+) 적은지.',
      'steps[그 외].cur_pct · target_pct · avg7_pct: 유입 대비 비율(%). vs_target_pp · vs_avg7_pp: 그 차이(%p).',
      'will_gap: 원 단위. 음수 = 의지 목표 미달 몫. total = 실제 − 목표(퍼널 목표 곱). other 가 있으면 세 항 밖의 몫(집계 차이 또는 반품 차감).',
      'opportunity_loss: 병목 단계가 7일평균 수준이었다면 더 나왔을 주문 수(orders)와 금액(amount, 추정).',
    ],
    notes: [
      card.ch === 'mall'
        ? '자사몰 유입·주문완료는 이프두(MD 업로드) 값이고, 이프두가 없는 날은 Cafe24 통계 값이다(inflow_source). 순매출은 Cafe24 매출(취소·반품 반영). 객단가는 Cafe24 매출 ÷ Cafe24 주문(orders_cafe24)이다 — 이프두 주문완료가 Cafe24 주문보다 적은 몫은 will_gap.other(집계 차이)로 따로 잡혀 있으니 객단가가 높았다고 해석하지 마라.'
        : '스마트스토어 유입은 비즈어드바이저(MD 입력), 주문은 판매 주문 수, 순매출은 이카운트 원장(판매 − 그날 잡힌 반품)이다. 객단가는 판매분 ÷ 판매 주문이다. 반품은 지난 주문분이 그날 잡힌 것일 수 있어 will_gap.other(반품·취소 차감)로 따로 보인다.',
      'ad_cost_all_media 는 전 매체 광고비 합계(채널 구분 없음) — 참고용.',
    ],
  };
}
function detailInputPeriod(p, days) {
  const { saved, stale, inputHash, rule, detail, detailStale, gap_series, ...pin } = p;
  return {
    period: { ...pin, gap_series },
    daily_cards: days.map((d) => ({ date: d.date, weekday: d.weekday, badge: d.badge, status: d.status, bottleneck: d.bottleneck, gap_items: d.gap_items, quiet_decline: d.quiet_decline,
      will_gap_total: d.will_gap && d.will_gap.total, verdict_line: d.detail && d.detail.text ? d.detail.text.verdict_line : d.rule ? d.rule.verdict_line : null })),
  };
}

// AI 문장 뒷손질(보여 줄 때, 저장본은 AI 원문 그대로) — 설계서 규칙 중 기계로 지킬 수 있는 것만
//   · 금액·건수 콤마 자리(실측: "1,092281원") — 원·건·명이 붙은 네 자리 이상 숫자만 천단위로 다시 찍는다
//   · 프로모션 기간이면 병목 문장 끝에 "프로모션 영향 포함" · 데이터 이상이면 액션 1번은 "데이터 재확인 후 재입력"
const fixNums = (t) => String(t).replace(/\d[\d,]{3,}(?=\s*(?:원|건|명))/g, (m) => { const n = m.replace(/,/g, ''); return /^\d+$/.test(n) ? Number(n).toLocaleString('en-US') : m; });
const deepFix = (v) => (typeof v === 'string' ? fixNums(v) : Array.isArray(v) ? v.map(deepFix) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepFix(x)])) : v);
function fixDayText(t, card) {
  const o = deepFix(t);
  if (card && (card.promo || []).length && o.bottleneck_text && !o.bottleneck_text.includes('프로모션 영향 포함')) o.bottleneck_text = o.bottleneck_text.replace(/\s*$/, '') + ' (프로모션 영향 포함)';
  if (card && card.status === 'data_error' && !/데이터 재확인/.test((o.actions[0] || {}).title || '')) {
    o.actions = [{ no: 1, eta_min: 10, title: '데이터 재확인 후 재입력', why: '데이터 이상으로 퍼널 판정을 보류했습니다' }, ...o.actions].slice(0, 5).map((a, i) => ({ ...a, no: i + 1 }));
  }
  return o;
}
function detailView(d, card) {
  if (!d || (!d.detail && !d.detail_error)) return null;
  const text = !d.detail ? null : card ? fixDayText(d.detail, card) : deepFix(d.detail);
  return { text, model: d.detail_model || null, source: d.detail_source || 'api', createdAt: d.detail_createdAt || null, usage: d.detail_usage || null, ai_error: d.detail_error || null, errorAt: d.detail_errorAt || null };
}
// 상세 분석 저장 칸 — 성공하면 문장·모델·시각·토큰을 함께 바꾸고, 실패하면 오류만 적는다(이전 분석의 문장·저장 시각을 덮지 않게, §8-8)
function detailFields(base, res, text, err, inputHash) {
  const now = new Date().toISOString();
  if (!text) return { ...base, detail_error: err || 'AI 응답이 비어 있습니다', detail_errorAt: now };
  return { ...base, detail: text, detail_source: 'api', detail_inputHash: inputHash, detail_error: null, detail_errorAt: null, detail_model: (res && res.model) || MODEL_DETAIL(), detail_createdAt: now,
    detail_usage: res && res.usage ? { input: res.usage.input_tokens || null, output: res.usage.output_tokens || null } : null };
}
// 카드 · 기간에 저장본(간략 조언 · 상세 분석)을 붙인다 — 목록·분석 응답이 같은 모양이 되게
function attachDay(card, doc) {
  return {
    ...card, rule: card.rule || ruleDay(card),
    saved: doc && (Array.isArray(doc.advice) || doc.ai_error) ? savedView(doc) : null,
    stale: !!(doc && Array.isArray(doc.advice) && doc.inputHash !== card.inputHash),
    detail: detailView(doc, card), detailStale: !!(doc && doc.detail && doc.detail_inputHash !== card.inputHash),
  };
}
function attachPeriod(p, doc) {
  return {
    ...p, rule: p.rule || rulePeriod(p),
    saved: doc && (Array.isArray(doc.advice) || doc.ai_error) ? savedView(doc) : null,
    stale: !!(doc && Array.isArray(doc.advice) && doc.inputHash !== p.inputHash),
    detail: detailView(doc), detailStale: !!(doc && doc.detail && doc.detail_inputHash !== p.inputHash),
  };
}
const setDoc = async (coll, id, fields) => { await coll.updateOne({ _id: id }, { $set: fields }, { upsert: true }); return coll.findOne({ _id: id }); };

const inflightDetail = new Map();
/** 하루 AI 상세 분석 — 이미 받았으면 그대로(비용 0, 화면이 "이미 받았습니다" 경고 후에만 regenerate) */
async function analyzeDetail(date, ch, { regenerate = false } = {}) {
  if (!isYmd(date)) throw new Error('date 형식 오류(YYYY-MM-DD)');
  if (date >= todayKst()) throw new Error('오늘·미래 날짜는 분석할 수 없습니다(하루가 끝난 뒤 분석)');
  const { cards } = await computeRange(date, date, ch);
  const card = cards[0];
  if (card.status === 'no_data' || card.status === 'pending_input') throw new Error(card.note);
  const c = await cardColl();
  const key = cardId(date, ch);
  const cur = await c.findOne({ _id: key });
  if (cur && cur.detail && !regenerate) return { card: attachDay(card, cur), cached: true };
  if (!ai.enabled()) throw new Error('AI 키가 설정되지 않아 상세 분석을 만들 수 없습니다 — 서버 환경변수에 ANTHROPIC_API_KEY 를 넣어 주세요.');
  if (!inflightDetail.has(key)) {
    inflightDetail.set(key, (async () => {
      let text = null, err = null, res = null;
      try {
        res = await ai.complete(SYSTEM_DETAIL_DAY, [{ role: 'user', content: JSON.stringify(detailInputDay(card)) }], { model: MODEL_DETAIL(), effort: AI_EFFORT_DETAIL, maxTokens: 6000, timeoutMs: AI_TIMEOUT_MS });
        text = cleanDayText(parseJson(res.text));
      } catch (e) { err = e.message; }
      // 실패해도 데이터 기반 카드는 그대로 보인다(§8-8) — 이전 상세 분석이 있으면 지우지 않는다
      return setDoc(c, key, detailFields({ date, ch, version: VERSION }, res, text, err, card.inputHash));
    })().finally(() => inflightDetail.delete(key)));
  }
  const doc = await inflightDetail.get(key);
  return { card: attachDay(card, doc), cached: false };
}

/** 기간 AI 상세 분석 */
async function analyzePeriodDetail(start, end, ch, { regenerate = false } = {}) {
  const view = await list(start, end, ch);
  if (!view.period) throw new Error('기간 종합은 2일 이상일 때 만듭니다');
  const p = view.period;
  const pcol = await periodColl();
  const id = periodId(start, end, ch);
  const cur = await pcol.findOne({ _id: id });
  if (cur && cur.detail && !regenerate) return { period: attachPeriod(p, cur), cached: true };
  if (!ai.enabled()) throw new Error('AI 키가 설정되지 않아 상세 분석을 만들 수 없습니다 — 서버 환경변수에 ANTHROPIC_API_KEY 를 넣어 주세요.');
  let text = null, err = null, res = null;
  try {
    res = await ai.complete(SYSTEM_DETAIL_PERIOD, [{ role: 'user', content: JSON.stringify(detailInputPeriod(p, view.days)) }], { model: MODEL_DETAIL(), effort: AI_EFFORT_DETAIL, maxTokens: 6000, timeoutMs: AI_TIMEOUT_MS });
    text = cleanPeriodText(parseJson(res.text));
  } catch (e) { err = e.message; }
  const doc = await setDoc(pcol, id, detailFields({ start, end, ch, version: VERSION }, res, text, err, p.inputHash));
  return { period: attachPeriod(p, doc), cached: false };
}

module.exports = { list, analyzeDay, analyzePeriod, analyzeDetail, analyzePeriodDetail, saveExample, computeRange, computePeriodFrom, ruleDay, rulePeriod, adviceInputDay, adviceInputPeriod, detailInputDay, willGap, caseOf, SYSTEM_ADVICE, SYSTEM_DETAIL_DAY, MODEL, MODEL_DETAIL, CH_NAME };
