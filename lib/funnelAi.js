'use strict';

/**
 * 일일 퍼널 AI 분석 — 퍼널 점검 화면의 [🤖 AI 분석] 버튼.
 *   그날(date)의 자사몰·스마트스토어 퍼널을 Claude가 분석해 **날짜별로 DB(funnel_ai_daily)에 저장**한다.
 *   같은 날을 다시 누르면 저장본을 돌려준다 → Claude 를 다시 부르지 않아 토큰이 들지 않는다.
 *   그날 입력 데이터가 바뀌면(예: MD가 이프두 3단계를 나중에 올림) 저장본에 stale 표시만 하고,
 *   사용자가 "다시 분석"을 눌렀을 때만 새로 만든다(stale 이 아니면 regenerate 요청도 저장본 반환).
 *
 *   입력(Claude 에 보내는 JSON): 그날 실적·일 목표·유입 대비 비율 vs 기준, 최근 7일, 이번 달 누적 달성률.
 *     숫자·목표 공식은 화면과 같다(funnelDaily.buildDb · targetsFor).
 *   엔진·키·모델은 lib/ai.js 와 같은 설정(ANTHROPIC_API_KEY · ANTHROPIC_MODEL)을 쓴다.
 */

const crypto = require('crypto');
const funnel = require('./funnelDaily');
const store = require('./store');
const ai = require('./ai');

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const R = (n) => Math.round(n || 0);
const pct1 = (a, b) => (b ? +((a / b) * 100).toFixed(1) : null);
const shift = (iso, d) => new Date(Date.parse(iso + 'T00:00:00Z') + d * 86400000).toISOString().slice(0, 10);
const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
// 남은 기간 하루 평균 필요액 — 이미 넘겼으면 음수 대신 문구로(모델이 "-16만원 필요"로 오독하지 않게)
const needPerDay = (left, days) => (left <= 0 ? '월 목표 이미 달성' : days > 0 ? R(left / days) : '남은 날 없음');

async function coll() {
  const c = await store.collection(funnel.COLL.ai);
  try { await c.createIndex({ date: 1 }, { unique: true }); } catch (_) {}
  return c;
}

// ── Claude 에 보낼 입력 — 그날 + 최근 7일 + 이번 달 누적 ──────────────────────
async function buildInput(date) {
  const monthStart = date.slice(0, 8) + '01';
  const from = shift(date, -6) < monthStart ? shift(date, -6) : monthStart;
  const db = await funnel.buildDb({ from, to: date });
  const cfg = db.cfg;
  const net = new Map((cfg.netDaily || []).map((x) => [x[0], x]));
  const Bm = cfg.benchMall, Bs = cfg.benchSS;
  const ym = date.slice(0, 7), dayNo = +date.slice(8, 10);

  // 자사몰 — [일자, 유입, 상품조회, 장바구니, 주문서작성, 주문완료]
  const mDay = db.mall.find((r) => r[0] === date);
  const Tm = funnel.targetsFor(cfg, 'mall', ym);
  let mall = null;
  if (mDay) {
    const [, visit, view, cart, order, done] = mDay;
    const n = net.get(date); const netV = n && n[1] != null ? R(n[1]) : null;
    const ifdo = view || cart || order ? '입력됨' : '미입력';
    const mtdRows = db.mall.filter((r) => r[0] >= monthStart && r[0] <= date);
    const mtdNet = mtdRows.reduce((s, r) => { const x = net.get(r[0]); return s + (x && x[1] != null ? x[1] : 0); }, 0);
    mall = {
      당일: { 유입: visit, 상품조회: view, 장바구니: cart, 주문서작성: order, 주문완료: done, 순매출: netV, 이프두입력: ifdo },
      당일목표: Tm ? { 유입: R(Tm.visit), 상품조회: R(Tm.view), 장바구니: R(Tm.cart), 주문서작성: R(Tm.order), 주문완료: R(Tm.done), 순매출: R(Tm.net) } : null,
      유입대비비율_pct: {
        실적: { 상품조회: pct1(view, visit), 장바구니: pct1(cart, visit), 주문서작성: pct1(order, visit), 주문완료: pct1(done, visit) },
        기준: { 상품조회: +Bm.viewRate.toFixed(1), 장바구니: +Bm.cartRate.toFixed(1), 주문서작성: +Bm.orderRate.toFixed(1), 주문완료: +Bm.doneRate.toFixed(2) },
      },
      최근7일: db.mall.filter((r) => r[0] > shift(date, -7) && r[0] <= date).map((r) => {
        const x = net.get(r[0]);
        return { 일자: r[0], 유입: r[1], 상품조회: r[2], 장바구니: r[3], 주문서작성: r[4], 주문완료: r[5], 순매출: x && x[1] != null ? R(x[1]) : null };
      }),
      이번달누적: {
        기간: `${monthStart}~${date}`, 유입: mtdRows.reduce((s, r) => s + r[1], 0), 주문완료: mtdRows.reduce((s, r) => s + r[5], 0), 순매출: R(mtdNet),
        ...(Tm ? { 목표_순매출_기준일까지: R(Tm.net * dayNo), 달성률_pct: pct1(mtdNet, Tm.net * dayNo), 월목표_순매출: R(Tm.mNet),
          남은일수: Tm.days - dayNo, 남은기간_필요일평균_순매출: needPerDay(Tm.mNet - mtdNet, Tm.days - dayNo) } : { 목표: '이 달 목표 미등록' }),
      },
    };
  }

  // 스마트스토어 — [일자, 유입수, 주문건수, 구매율%, 매출]
  const sDay = db.ss.find((r) => r[0] === date);
  const Ts = funnel.targetsFor(cfg, 'ss', ym);
  let ss = null;
  if (sDay) {
    const [, visit, orders, rate, amt] = sDay;
    const mtdRows = db.ss.filter((r) => r[0] >= monthStart && r[0] <= date);
    const mtdAmt = mtdRows.reduce((s, r) => s + (r[4] || 0), 0);
    ss = {
      당일: { 유입: visit, 주문: orders, 구매율_pct: rate, 매출: amt, 주문당매출: orders ? R(amt / orders) : null },
      당일목표: Ts ? { 유입: R(Ts.visit), 주문: R(Ts.orders), 매출: R(Ts.net) } : null,
      기준: { 구매율_pct: Bs.rate, 주문당매출: Bs.perOrder },
      최근7일: db.ss.filter((r) => r[0] > shift(date, -7) && r[0] <= date).map((r) => ({ 일자: r[0], 유입: r[1], 주문: r[2], 구매율_pct: r[3], 매출: r[4] })),
      이번달누적: {
        기간: `${monthStart}~${date}`, 유입: mtdRows.reduce((s, r) => s + r[1], 0), 주문: mtdRows.reduce((s, r) => s + r[2], 0), 매출: R(mtdAmt),
        ...(Ts ? { 목표_매출_기준일까지: R(Ts.net * dayNo), 달성률_pct: pct1(mtdAmt, Ts.net * dayNo), 월목표_매출: R(Ts.mNet),
          남은일수: Ts.days - dayNo, 남은기간_필요일평균_매출: needPerDay(Ts.mNet - mtdAmt, Ts.days - dayNo) } : { 목표: '이 달 목표 미등록' }),
      },
    };
  }
  if (!mall && !ss) throw new Error(`${date} 데이터가 없습니다 — 자사몰·스마트스토어 모두 그날 수치가 아직 들어오지 않았습니다.`);

  const input = {
    기준일: `${date} (${DOW[new Date(date + 'T00:00:00Z').getUTCDay()]})`,
    자사몰: mall || '그날 자사몰 데이터 없음',
    스마트스토어: ss || '그날 스마트스토어 데이터 없음',
    참고: [
      '자사몰 유입·주문완료는 Cafe24 통계, 상품조회·장바구니·주문서작성은 MD가 올린 이프두 값(미입력이면 0).',
      '자사몰 순매출은 취소·반품 반영 후 금액. 스마트스토어 매출은 이카운트 원장(반품 차감), 유입은 비즈어드바이저.',
      '장바구니 → 주문서작성 비율이 100%를 넘는 것은 바로구매 때문이며 오류가 아니다.',
      '목표는 월 목표를 일수로 나눈 일 목표이고, 기준(유입 대비 비율)은 성과가 가장 좋았던 기준월 벤치마크다.',
    ],
  };
  const hash = crypto.createHash('sha1').update(JSON.stringify(input)).digest('hex');
  return { input, hash };
}

const SYSTEM = `너는 요기보(Yogibo) 온라인몰의 일일 퍼널 분석가다. MD가 매일 아침 이 분석을 보고 무엇을 손볼지 정한다.
규칙:
- 주어진 JSON 데이터만 근거로 쓴다. 데이터에 없는 사실(프로모션·광고·재고·날씨 등)을 지어내지 않는다.
- 숫자는 천단위 콤마, 금액은 원 단위, 비율은 소수 1자리 %로 쓴다. 핵심 숫자는 **굵게** 표시해도 된다.
- 당일 목표·기준 대비로 평가하고, 가장 큰 병목 한 곳을 짚는다. 하루 수치는 변동이 크므로 최근 7일과 이번 달 누적 흐름과 함께 판단한다.
- 자사몰 이프두입력이 '미입력'이면 상품조회·장바구니·주문서작성 단계는 판단하지 말고 "이프두 입력 후 확인"이라고만 쓴다.
- 마지막 항목은 오늘 MD가 할 수 있는 구체적인 다음 행동 1가지로 쓴다.
출력은 아래 형식의 JSON 하나만 쓴다(설명 문장·마크다운 코드블록 없이):
{"mall":{"level":"good|warn|bad","headline":"40자 이내 한 줄 요약","points":["관찰(숫자 포함)","관찰","관찰","다음 행동"]},"ss":{"level":"...","headline":"...","points":["..."]}}
level: good=목표·기준을 대체로 충족, warn=일부 미달, bad=핵심 지표(순매출·주문)가 크게 미달. 그 채널 데이터가 없으면 headline에 "데이터 없음"이라고 쓰고 points는 빈 배열로 둔다.`;

function parseOut(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI 응답에서 결과(JSON)를 찾지 못했습니다');
  const j = JSON.parse(s.slice(a, b + 1));
  const one = (x) => {
    if (!x || typeof x.headline !== 'string') return null;
    const level = ['good', 'warn', 'bad'].includes(x.level) ? x.level : 'warn';
    return { level, headline: x.headline.slice(0, 120), points: (Array.isArray(x.points) ? x.points : []).map(String).slice(0, 6) };
  };
  const out = { mall: one(j.mall), ss: one(j.ss) };
  if (!out.mall && !out.ss) throw new Error('AI 응답 형식이 올바르지 않습니다');
  return out;
}

const view = (d, extra = {}) => ({ date: d.date, mall: d.mall, ss: d.ss, model: d.model, createdAt: d.createdAt, ...extra });
const inflight = new Map(); // 같은 날짜를 동시에 두 번 누르면 Claude 호출을 한 번만 한다

/** 저장본만 조회(Claude 호출 없음) — { item|null, stale } */
async function get(date) {
  const c = await coll();
  const cur = await c.findOne({ date }, { projection: { _id: 0 } });
  if (!cur) return { item: null, stale: false };
  const { hash } = await buildInput(date).catch(() => ({ hash: cur.inputHash }));
  return { item: view(cur), stale: cur.inputHash !== hash };
}

/** 분석 — 저장본이 있으면 그대로(무료), 없거나 (regenerate && 데이터 바뀜)일 때만 Claude 호출 */
async function analyze(date, { regenerate = false } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date 형식 오류(YYYY-MM-DD)');
  if (date > todayKst()) throw new Error('미래 날짜는 분석할 수 없습니다');
  const { input, hash } = await buildInput(date);
  const c = await coll();
  const cur = await c.findOne({ date }, { projection: { _id: 0 } });
  if (cur && (!regenerate || cur.inputHash === hash)) return { item: view(cur), cached: true, stale: cur.inputHash !== hash };
  if (!ai.enabled()) throw new Error('AI 키가 설정되지 않아 새 분석을 만들 수 없습니다 — 서버 환경변수에 ANTHROPIC_API_KEY 를 넣어 주세요.');

  if (!inflight.has(date)) {
    inflight.set(date, (async () => {
      const res = await ai.complete(SYSTEM, [{ role: 'user', content: `기준일 ${date} 퍼널 데이터(JSON):\n${JSON.stringify(input)}` }]);
      const out = parseOut(res.text);
      const u = res.usage || {};
      const doc = { date, inputHash: hash, mall: out.mall, ss: out.ss, model: res.model || ai.model(),
        usage: { input: u.input_tokens || u.prompt_tokens || null, output: u.output_tokens || u.completion_tokens || null },
        createdAt: new Date().toISOString() };
      await c.updateOne({ date }, { $set: doc }, { upsert: true });
      return doc;
    })().finally(() => inflight.delete(date)));
  }
  const doc = await inflight.get(date);
  return { item: view(doc), cached: false, stale: false };
}

module.exports = { analyze, get, buildInput, parseOut };
