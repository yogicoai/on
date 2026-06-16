'use strict';

/**
 * Claude API로 판매 데이터 질의응답 — mkboard 방식과 동일(SDK 없이 내장 fetch, Messages API).
 *   POST https://api.anthropic.com/v1/messages · x-api-key · anthropic-version: 2023-06-01
 *   env: ANTHROPIC_API_KEY(필수), ANTHROPIC_MODEL(선택, 기본 claude-opus-4-8)
 */

const { loadEnv } = require('./env');
loadEnv();

const compare = require('./compare');
const otherChannels = require('./otherChannels');
const target = require('./target');

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

function enabled() { return !!KEY; }

const SYSTEM = `당신은 Yogibo 온라인 판매 데이터 분석 어시스턴트입니다. 보는 사람이 빠르게 이해하도록 평이한 한국어로 답합니다.
제공된 '대시보드 데이터'(JSON, 금액 단위 원)만 근거로, 단순 숫자 나열이 아니라 평가와 방향성을 함께 줍니다.
채널 정의: 자사몰=Cafe24 자사몰, 스마트스토어=네이버 스마트스토어, 기타채널=쿠팡·롯데·현대·신세계·오늘의집 등(이카운트 집계, 방문수·회원 데이터는 없음).
데이터 구성: 월별추이(2024~현재 채널별), 선택구간 채널비교(전년/전월/전주), 기타채널 그룹별 매출, 이번달 목표 달성률.
규칙:
- 반드시 실제 숫자를 인용하고(원화), 비교는 %와 증감으로 표현.
- 데이터에 없는 내용은 추측하지 말고 "데이터에 없음"이라고 한다.
- 질문에 집중해 핵심부터 답한다. 마크다운(##, **굵게**, - 목록)으로 간결하게, 서론·사족 없이 바로 답변.
- 추천·조언은 데이터 근거로 실행가능하게 제시한다.`;

// 질문 답변에 필요한 대시보드 데이터를 모아 압축 컨텍스트로 구성
async function gatherContext(start, end) {
  const now = new Date();
  const ym = /^\d{4}-\d{2}/.test(start || '') ? start.slice(0, 7) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const safe = (p) => p.then((v) => v).catch(() => null);
  const [monthly, period, other, tgCa, tgSs] = await Promise.all([
    safe(compare.monthlySeries('2024-01-01')),
    safe(compare.periodCompare(start, end)),
    safe(otherChannels.overview(start, end)),
    safe(target.mallTargetStatus(ym, '자사몰')),
    safe(target.mallTargetStatus(ym, '스마트스토어')),
  ]);
  const mrows = monthly && (monthly.rows || (Array.isArray(monthly) ? monthly : null));
  return {
    조회구간: { 시작: start || null, 종료: end || null },
    이번달: ym,
    월별추이_2024_현재: mrows ? mrows.map((r) => ({ 월: r.ym, 자사몰: (r.cafe24 || {}).sales || 0, 스마트스토어: (r.smartstore || {}).sales || 0, 합계: (r.total || {}).sales || 0 })) : null,
    선택구간_채널비교_전년전월전주: period || null,
    기타채널_그룹별: other && other.groups ? other.groups.map((g) => ({ 그룹: g.group, 매출: g.sales, 주문: g.orders, 입점몰수: g.channels })) : null,
    기타채널_합계: other ? other.totals : null,
    이번달_목표달성: {
      자사몰: tgCa ? { 목표: tgCa.target, 실적: tgCa.actual, 달성률: tgCa.rate, 예상: tgCa.forecast } : null,
      스마트스토어: tgSs ? { 목표: tgSs.target, 실적: tgSs.actual, 달성률: tgSs.rate, 예상: tgSs.forecast } : null,
    },
  };
}

async function ask(question, start, end) {
  if (!KEY) throw new Error('ANTHROPIC_API_KEY 미설정 — .env(로컬) 또는 Vercel 환경변수에 키를 설정하세요');
  if (!question || !question.trim()) throw new Error('질문이 비어 있습니다');
  const ctx = await gatherContext(start, end);
  const userContent =
    `질문: ${question.trim()}\n` +
    `조회 구간: ${start || '미지정'} ~ ${end || '미지정'}\n\n` +
    `아래는 현재 대시보드 데이터(JSON, 금액 단위 원)입니다. 이 데이터만 근거로 위 질문에 답해 주세요.\n\n` +
    '```json\n' + JSON.stringify(ctx, null, 2) + '\n```';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  const j = await res.json();
  if (j.error) throw new Error(`Claude ${j.error.type}: ${j.error.message}`);
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { text, model: j.model, usage: j.usage };
}

module.exports = { ask, enabled, gatherContext, model: () => MODEL };
