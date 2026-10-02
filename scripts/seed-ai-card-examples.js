'use strict';

/**
 * [예제] AI 조언을 Claude Code 세션(Opus)이 직접 써서 저장한다 — API 비용 없이 MD 에게 완성 화면을 보이기 위함(2026-10-02).
 *   카드의 숫자·판정·문장은 서버 규칙(lib/funnelAiCard ruleDay·rulePeriod)이 만들고, 여기 넣는 건 "규칙이 놓친 점" 조언만이다.
 *   이후 대시보드 [🤖 AI 조언 받기] 버튼은 Sonnet(API)으로 같은 형식의 조언을 만든다. 예제도 [Sonnet으로 다시 받기]로 덮어쓸 수 있다.
 *   사용법: node scripts/seed-ai-card-examples.js
 */

require('../lib/env').loadEnv();
const fc = require('../lib/funnelAiCard');
const store = require('../lib/store');

const MODEL = 'claude-opus-5-5 · Claude Code 예제';

const DAY = [
  { date: '2026-10-01', ch: 'mall', advice: [
    '9/29~9/30 장바구니 비율이 평소보다 크게 높았던 직후라, 10/1 하락은 프로모션 종료 전에 구매가 앞당겨진 반동일 가능성이 있어 하루 더 보고 판단하는 게 안전합니다.',
    '객단가가 7일평균(180,596원)보다 크게 낮은 100,232원이라 종료 후 저가 상품 위주로 팔린 날로 보이니, 상세 페이지 점검은 고단가 상품부터 하세요.',
  ] },
  { date: '2026-10-01', ch: 'ss', advice: [
    '이날 잡힌 반품이 요기보 위크 기간 주문분이라면, 프로모션 성과를 볼 때 그만큼을 빼야 실제 효과가 보입니다.',
    '판매분 객단가가 84,599원으로 7일평균(195,497원)의 절반에 못 미쳐 단품·소품 위주 판매일 가능성이 있으니 [충전재별 판매량] 탭에서 구성을 확인해 보세요.',
  ] },
];
const PERIOD = [
  { start: '2026-09-25', end: '2026-09-27', ch: 'mall', advice: [
    '장바구니·주문서작성이 3일 중 2일 진짜 병목이었고 모두 요기보 위크 기간이라, 프로모션 상품의 옵션·배송비 안내가 담기·주문서 단계에서 걸리는지 함께 보는 게 좋겠습니다.',
    '이프두 주문완료가 3일 내내 Cafe24보다 적게 잡혀(9/26 7건 vs 13건) 주말 전환 판단이 실제보다 나쁘게 보일 수 있습니다.',
  ] },
];

(async () => {
  for (const x of DAY) {
    const doc = await fc.saveExample({ date: x.date, ch: x.ch, advice: x.advice, model: MODEL });
    console.log(`저장: ${doc._id} · 조언 ${doc.advice.length}개`);
  }
  for (const x of PERIOD) {
    const doc = await fc.saveExample({ ch: x.ch, advice: x.advice, model: MODEL, period: { start: x.start, end: x.end } });
    console.log(`저장: ${doc._id} · 조언 ${doc.advice.length}개`);
  }
  await store.close();
  setTimeout(() => process.exit(0), 150);
})().catch((e) => { console.error('실패', e.message); process.exit(1); });
