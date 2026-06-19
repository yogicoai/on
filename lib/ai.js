'use strict';

/**
 * AI 판매 데이터 질의응답 — 키 종류로 엔진 자동 감지(SDK 없이 내장 fetch).
 *   · OpenAI 키(sk-…)      → ChatGPT  POST https://api.openai.com/v1/chat/completions (OPENAI_MODEL, 기본 gpt-4.1)
 *   · Anthropic 키(sk-ant-) → Claude   POST https://api.anthropic.com/v1/messages     (ANTHROPIC_MODEL, 기본 claude-opus-4-8)
 *   env: OPENAI_API_KEY 또는 ANTHROPIC_API_KEY 중 설정된 값 사용 — .env의 키만 바꾸면 엔진이 따라 바뀜.
 *
 *   ask(question,start,end)  : 단발 질의   chat(history,start,end) : 멀티턴(대화 히스토리)
 */

const { loadEnv } = require('./env');
loadEnv();

const compare = require('./compare');
const otherChannels = require('./otherChannels');
const target = require('./target');
const promoPerformance = require('./promoPerformance');
const productAnalysis = require('./productAnalysis');
const smartstoreAnalysis = require('./smartstoreAnalysis');
const bizadvisor = require('./bizadvisor');
const mallPromos = require('./mallPromotions');
const cafe24Coupons = require('./cafe24Coupons');

const KEY = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const IS_ANTHROPIC = /^sk-ant/.test(KEY); // 키 프리픽스로 엔진 자동 감지
const MODEL = IS_ANTHROPIC
  ? (process.env.ANTHROPIC_MODEL || 'claude-opus-4-8')
  : (process.env.OPENAI_MODEL || 'gpt-4.1');

function enabled() { return !!KEY; }

const SYSTEM = `당신은 Yogibo 온라인 판매 데이터 분석 어시스턴트입니다. 보는 사람이 빠르게 이해하도록 평이한 한국어로 답합니다.
제공된 '대시보드 데이터'(JSON, 금액 단위 원)만 근거로, 단순 숫자 나열이 아니라 평가와 방향성을 함께 줍니다.
채널 정의: 자사몰=Cafe24 자사몰, 스마트스토어=네이버 스마트스토어, 기타채널=쿠팡·롯데·현대·신세계·오늘의집 등(이카운트 집계, 방문수·회원 데이터는 없음).
데이터 구성(기간 설정 시 풀 디테일): 월별추이, 채널비교(전년/전월/전주), 목표 달성률, 프로모션 성과, 자사몰 상품분석(카테고리·충전재등급·상품TOP·색상)+프로모션 쿠폰별 성과, 스마트스토어 상세(상품·카테고리·충전재·유입경로·쿠폰·할인이벤트), 기타채널, 마케팅채널 유입수(비즈어드바이저).
※ 매출의 약 70%는 자사몰+스마트스토어이므로 두 채널을 우선 깊게 분석한다. 프로모션·상품·쿠폰 디테일은 기간을 설정해야 채워진다.
규칙:
- 반드시 실제 숫자를 인용하고(원화), 비교는 %와 증감으로 표현.
- 데이터에 없는 내용은 추측하지 말고 "데이터에 없음"이라고 한다. (프로모션 성과가 없으면 "기간을 설정해 주세요"라고 안내)
- 질문에 집중해 핵심부터 답한다. 마크다운(##, **굵게**, - 목록)으로 간결하게, 서론·사족 없이 바로 답변.
- 추천·조언은 데이터 근거로 실행가능하게 제시한다.`;

// 질문 답변에 필요한 대시보드 데이터를 모아 컨텍스트로 구성 (기간 설정 시 풀 디테일)
async function gatherContext(start, end) {
  const now = new Date();
  const ym = /^\d{4}-\d{2}/.test(start || '') ? start.slice(0, 7) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const safe = (p) => p.then((v) => v).catch(() => null);
  const ranged = !!(start && end); // 무거운 상세 분석은 구간 지정 시에만(미지정이면 전체 스캔 → 과부하)

  // 자사몰 프로모션에 연결된 쿠폰들의 기간 내 실제 사용 성과(쿠폰별 매출·할인·주문)
  async function cafeCouponPerf() {
    if (!ranged) return null;
    const promos = await mallPromos.listPromotions('자사몰').catch(() => []);
    const names = [];
    for (const p of (promos || [])) {
      if (p.end < start || p.start > end) continue;
      for (const c of (p.coupons || [])) if (c.coupon_name) names.push(c.coupon_name);
    }
    if (!names.length) return null;
    const perf = await cafe24Coupons.couponPerfFor([...new Set(names)], start, end).catch(() => null);
    if (!perf || !perf.byCoupon) return null;
    return perf.byCoupon.map((c) => ({
      쿠폰: c.coupon_name, 매출: c.revenue, 주문: c.orders, 할인액: c.discount,
      실효할인율_퍼센트: (c.revenue + c.discount) ? +((c.discount / (c.revenue + c.discount)) * 100).toFixed(1) : 0,
    }));
  }

  const [monthly, period, other, tgCa, tgSs, promo, paCafe, ssA, bizIn, cafeCp] = await Promise.all([
    safe(compare.monthlySeries('2024-01-01')),
    safe(compare.periodCompare(start, end)),
    safe(otherChannels.overview(start, end)),
    safe(target.mallTargetStatus(ym, '자사몰')),
    safe(target.mallTargetStatus(ym, '스마트스토어')),
    ranged ? safe(promoPerformance.allForPeriod(start, end)) : Promise.resolve(null),
    ranged ? safe(productAnalysis.analyze(start, end)) : Promise.resolve(null),
    ranged ? safe(smartstoreAnalysis.analyze(start, end)) : Promise.resolve(null),
    ranged ? safe(bizadvisor.summary(start, end)) : Promise.resolve(null),
    safe(cafeCouponPerf()),
  ]);
  const mrows = monthly && (monthly.rows || (Array.isArray(monthly) ? monthly : null));
  const NEED = '기간을 설정하면 제공됩니다';

  const slimPA = paCafe ? {
    kpis: paCafe.kpis,
    카테고리: paCafe.categoryDist,
    충전재등급: paCafe.fillerDist,
    상품TOP: (paCafe.productTop || []).slice(0, 15).map((p) => ({ 상품: p.name, 등급: p.tier, 수량: p.qty, 매출: p.sales })),
    인기색상: (paCafe.colorTop || []).slice(0, 10).map((c) => ({ 색상: c.color, 수량: c.qty, 매출: c.sales })),
  } : (ranged ? null : NEED);

  const slimSS = ssA ? {
    kpis: ssA.kpis,
    유입경로: ssA.inflow,
    카테고리: ssA.categoryDist,
    충전재등급: ssA.fillerDist,
    상품TOP: (ssA.productTop || []).slice(0, 15).map((p) => ({ 상품: p.name, 등급: p.tier, 수량: p.qty, 매출: p.sales })),
    인기색상: (ssA.colorTop || []).slice(0, 10).map((c) => ({ 색상: c.color, 수량: c.qty, 매출: c.sales })),
    할인이벤트: ssA.discountEvents,
    적용쿠폰: ssA.coupons,
  } : (ranged ? null : NEED);

  const slimBiz = (bizIn && bizIn.channels && bizIn.channels.length)
    ? { 합계유입수: bizIn.grandTotal, 채널별: bizIn.channels.map((c) => ({ 채널: c, 유입수: bizIn.totalsByChannel[c] })) }
    : (ranged ? '비즈어드바이저 적재 데이터 없음' : NEED);

  return {
    조회구간: { 시작: start || null, 종료: end || null },
    이번달: ym,
    안내: ranged ? null : '아래 상세(프로모션·상품·쿠폰·유입)는 조회 기간을 설정해야 채워집니다.',
    월별추이_2024_현재: mrows ? mrows.map((r) => ({ 월: r.ym, 자사몰: (r.cafe24 || {}).sales || 0, 스마트스토어: (r.smartstore || {}).sales || 0, 합계: (r.total || {}).sales || 0 })) : null,
    선택구간_채널비교_전년전월전주: period || null,
    이번달_목표달성: {
      자사몰: tgCa ? { 목표: tgCa.target, 실적: tgCa.actual, 달성률: tgCa.rate, 예상: tgCa.forecast } : null,
      스마트스토어: tgSs ? { 목표: tgSs.target, 실적: tgSs.actual, 달성률: tgSs.rate, 예상: tgSs.forecast } : null,
    },
    선택구간_프로모션성과: ranged
      ? (promo && promo.promotions ? { 합계: promo.totals, 목록: promo.promotions.map((p) => ({ 몰: p.mall, 프로모션: p.name, 기간: `${p.start}~${p.end}`, 방식: p.method, 매출: p.sales, 주문: p.orders, 수량: p.qty })) } : null)
      : NEED,
    '자사몰_상품분석(Cafe24)': slimPA,
    자사몰_프로모션쿠폰별성과: cafeCp || (ranged ? '이 기간 사용된 프로모션 쿠폰 없음/미연결' : NEED),
    스마트스토어_상세분석: slimSS,
    기타채널_그룹별: other && other.groups ? other.groups.map((g) => ({ 그룹: g.group, 매출: g.sales, 주문: g.orders, 입점몰수: g.channels })) : null,
    기타채널_합계: other ? other.totals : null,
    마케팅채널유입_비즈어드바이저: slimBiz,
  };
}

// 엔진 공통 호출 (system + 멀티턴 messages) → { text, model, usage }
async function complete(system, messages) {
  if (!KEY) throw new Error('AI 키 미설정 — .env(로컬)/Vercel 환경변수에 OPENAI_API_KEY 또는 ANTHROPIC_API_KEY를 설정하세요');

  if (IS_ANTHROPIC) {
    // 프롬프트 캐싱: system(지시문+데이터 컨텍스트, ~수천토큰)을 캐시 마킹 → 같은 대화 이어지는 질문은 캐시 읽기(0.1x)로 재사용
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages }),
    });
    const aj = await res.json();
    if (aj.error) throw new Error(`Claude ${aj.error.type || ''}: ${aj.error.message}`);
    const text = (aj.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { text, model: aj.model, usage: aj.usage };
  }

  const msgs = [{ role: 'system', content: system }, ...messages];
  const call = async (tokenParam) => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, [tokenParam]: 8000, messages: msgs }),
    });
    return res.json();
  };
  // 신형/추론 모델은 max_completion_tokens, 구형은 max_tokens → 자동 호환(파라미터 거부 시 재시도)
  let j = await call('max_completion_tokens');
  if (j.error && /max_tokens|max_completion_tokens|unsupported/i.test(j.error.message || '')) j = await call('max_tokens');
  if (j.error) throw new Error(`OpenAI ${j.error.type || ''}: ${j.error.message}`);
  const text = (((j.choices || [])[0] || {}).message || {}).content || '';
  return { text: String(text).trim(), model: j.model, usage: j.usage };
}

// 단발 질의
async function ask(question, start, end) {
  if (!question || !question.trim()) throw new Error('질문이 비어 있습니다');
  const ctx = await gatherContext(start, end);
  const userContent =
    `질문: ${question.trim()}\n조회 구간: ${start || '미지정'} ~ ${end || '미지정'}\n\n` +
    `아래는 현재 대시보드 데이터(JSON, 금액 단위 원)입니다. 이 데이터만 근거로 위 질문에 답해 주세요.\n\n` +
    '```json\n' + JSON.stringify(ctx, null, 2) + '\n```';
  return complete(SYSTEM, [{ role: 'user', content: userContent }]);
}

// 멀티턴 대화 — history = [{role:'user'|'assistant', content}] (마지막은 user). 데이터는 system에 주입.
async function chat(history, start, end) {
  const msgs = (history || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content != null && String(m.content).trim())
    .map((m) => ({ role: m.role, content: String(m.content) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new Error('마지막 메시지는 사용자 질문이어야 합니다');
  const ctx = await gatherContext(start, end);
  const sys = SYSTEM +
    `\n\n[조회 구간: ${start || '미지정'} ~ ${end || '미지정'}]\n` +
    `아래는 현재 대시보드 데이터(JSON, 원)입니다. 이 데이터만 근거로 대화에 답하세요.\n` +
    '```json\n' + JSON.stringify(ctx, null, 2) + '\n```';
  return complete(sys, msgs);
}

module.exports = { ask, chat, enabled, gatherContext, model: () => MODEL };
