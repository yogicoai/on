'use strict';

/**
 * Yogibo 판매분석 MCP 서버 — 기존 lib/ 분석 함수들을 MCP 도구로 노출.
 *   Claude(Desktop/웹 커넥터)가 이 도구들을 호출해 MongoDB 집계 데이터를 직접 조회·분석한다.
 *   ※ 고객 개인정보(이름·연락처 등)는 노출하지 않음 — 집계/성과 데이터만.
 *
 *   실행:
 *     - stdio(로컬 Claude Desktop): node mcp/server.js
 *     - HTTP(원격 호스팅):          node mcp/server.js --http   (PORT, MCP_TOKEN 환경변수)
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const { parsePeriod } = require('../lib/period'); // 기간 자연어 파서("지난달","최근 7일" 등) — 날짜 도구 공용

const productAnalysis = require('../lib/productAnalysis');
const smartstoreAnalysis = require('../lib/smartstoreAnalysis');
const promoPerformance = require('../lib/promoPerformance');
const cafe24Coupons = require('../lib/cafe24Coupons');
const bizadvisor = require('../lib/bizadvisor');
const otherChannels = require('../lib/otherChannels');
const compare = require('../lib/compare');
const target = require('../lib/target');
const mallPromos = require('../lib/mallPromotions');
const productPrices = require('../lib/productPrices');
const forecast = require('../lib/forecast');
const adEfficiency = require('../lib/adEfficiency'); // 광고효율 (adboard, 별도 클러스터 MONGODB_URI)
const dailyReport = require('../lib/dailyReport');    // 온라인 매출(이카운트) — ad_vs_sales 교차용
const marketing = require('../lib/marketing');        // 통합 마케팅 개요(매출+광고+트래픽 교차)
const orders = require('../lib/orders');               // 자사몰 회원/비회원 결제 분석
const tagPromotions = require('../lib/tagPromotions'); // 자사몰 상품태그별 매출
const benefit = require('../lib/benefit');             // 자사몰 적립금·쿠폰 사용 분석
const analytics = require('../lib/analytics');         // 자사몰 유입경로 상세(광고소스·검색어·도메인)
const returns = require('../lib/returns');             // 반품/취소·순매출(자사몰+스토어)
const retention = require('../lib/retention');         // 고객 재구매/LTV/리텐션(자사몰)
const offline = require('../lib/offline');             // 오프라인 매장 판매(off.orders) + 온·오프 비교
const jwasuLeague = require('../lib/jwasuLeague');     // Y리그(좌수왕·캐스트·스토어)
const workSchedule = require('../lib/workSchedule');   // 매니저 근무 스케줄(오프라인 매장)
const briefing = require('../lib/briefing');           // 일일 브리핑(온+오프+광고+목표 요약)
const delivery = require('../lib/delivery');           // 매장 택배 배송 조회(PII 마스킹)
const stockTrend = require('../lib/stockTrend');       // 재고 일별 스냅샷 추이
const segments = require('../lib/segments');           // 비즈 충전 유도 대상(본품 N개월 경과·비즈 미구매)
const voc = require('../lib/voc');                     // 자사몰 게시판 VOC(리뷰·Q&A·A/S)
const cafe24api = require('../lib/cafe24');            // 진행중 혜택 등 Admin API 직접 조회용
const ssExtra = require('../lib/smartstoreExtra');     // 스마트스토어 상품/재고·정산(네이버 커머스 API)
const couponUsage = require('../lib/couponUsage');     // 쿠폰 사용 현황·쿠폰별 구매 주문 리스트
const csTools = require('../lib/csTools');             // CS: 주문 통합조회·게시판 미답변 체크
const csKnowledge = require('../lib/csKnowledge');     // CS: 정책/FAQ 지식·과거 답변 사례(응답 초안용)
const alerts = require('../lib/alerts');               // 경보 스캔 — "오늘 챙길 것"(이상신호 자동 감지)
const cafe24Stock = require('../lib/cafe24Stock');     // 자사몰 옵션별 진열 재고/품절

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const fail = (e) => ({ content: [{ type: 'text', text: 'ERROR: ' + ((e && e.message) || String(e)) }], isError: true });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };
const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);

// ── 기간 입력 처리 (period 자연어 → start/end) ──────────────────────────────
// period가 있으면 파서로 풀고, 없으면 start/end 그대로. 순수 날짜 도구는 wrapR, mode 도구는 withPeriod 사용.
const hasPeriod = (a) => a && a.period != null && String(a.period).trim() !== '';
const RANGE = (a = {}) => {
  if (hasPeriod(a)) { const p = parsePeriod(a.period); return { start: p.start, end: p.end, label: p.label }; }
  if (a.start && a.end) return { start: a.start, end: a.end, label: null };
  throw new Error('기간이 필요합니다 — period(예: "지난달","최근 7일","2026년 7월","6월부터") 또는 start·end(YYYY-MM-DD)를 주세요.');
};
// 순수 (start,end) 도구용: RANGE로 풀어 fn(start,end,args) 호출 + 응답에 실제 해석 구간 표기
const wrapR = (fn) => wrap(async (a) => {
  const r = RANGE(a);
  const out = await fn(r.start, r.end, a);
  return (r.label && out && typeof out === 'object' && !Array.isArray(out)) ? { 기간: `${r.start}~${r.end} (${r.label})`, ...out } : out;
});
// mode 도구용: period가 있으면 start/end를 채워 넣고 기존 핸들러 로직을 그대로 태움
const withPeriod = (a) => { if (hasPeriod(a)) { const p = parsePeriod(a.period); return { ...a, start: p.start, end: p.end, _periodLabel: p.label }; } return a || {}; };
// 기간 스키마 조각 — inputSchema에 ...RANGE_SCHEMA 로 펴 넣음
const PERIOD_FIELD = z.string().optional().describe('자연어 기간 — "지난달"·"최근 7일"·"이번달"·"2026년 7월"·"6월부터"·"2026-07-01~2026-07-15" 등. 지정하면 start/end 대신 사용(권장).');
const RANGE_SCHEMA = {
  start: z.string().optional().describe('시작일 YYYY-MM-DD (period 지정 시 생략 가능)'),
  end: z.string().optional().describe('종료일 YYYY-MM-DD (period 지정 시 생략 가능)'),
  period: PERIOD_FIELD,
};

function build() {
  const server = new McpServer({ name: 'yogibo-sales', version: '1.0.0' }, {
    // 클라이언트(Claude)에게 전달되는 전역 지침 — 통화·표기 규칙
    instructions: '이 서버의 모든 금액 수치는 대한민국 원(KRW)이다. 숫자 표기 규칙(반드시 준수): ' +
      '① "$", "₩" 등 통화 기호 금지 ② "9.3M", "70K", "1.2K" 같은 영문 축약(K/M/B) 절대 금지 — 금액이든 수량이든 모든 숫자에 적용 ③ 환율 환산 금지. ' +
      '모든 숫자는 천단위 콤마가 있는 전체 숫자로 쓴다: "70K~275K"(X) → "70,000원~275,000원"(O), "₩9.3M"(X) → "9,300,000원"(O). ' +
      '아주 큰 금액은 전체 숫자를 기본으로 하되 필요 시 "1.2억원" 같은 한국식 표현을 괄호로 보조 병기만 허용: "120,000,000원(1.2억원)". ' +
      '날짜/시간은 한국 시간(KST) 기준. 데이터는 매일 오전 9시(매출)·9시 30분(광고) 자동 갱신된다. ' +
      '기간 지정 규칙: 날짜 도구는 대부분 period 파라미터로 자연어 기간을 받는다("지난달","최근 7일","이번달","2026년 7월","6월부터","2026-07-01~2026-07-15" 등). ' +
      '사용자가 상대적 기간("지난달","이번 주" 등)을 말하면 start/end를 직접 계산하지 말고 period에 그 표현을 그대로 넘겨라 — 도구가 KST 기준으로 정확히 해석하고 응답의 "기간" 필드에 실제 조회 구간을 표기한다(오늘 날짜 오산·하루 밀림 방지). 특정 날짜를 아는 경우엔 start/end를 써도 된다. ' +
      '답변 분량 규칙: 도구가 반환한 목록/일별 데이터를 전부 옮겨 적지 말 것 — 핵심 요약 + 상위 5~10개만 표로 보여주고, ' +
      '나머지는 "전체 N건 중 상위만 표시, 더 필요하면 말씀하세요"로 안내한다. 한 답변이 과도하게 길어질 것 같으면 요약을 우선한다. ' +
      '라우팅 규칙: 사용자가 "오늘 챙길 것", "챙길 거 있어", "일일 점검", "이상 없어?"라고 하면 캘린더/일정/할일이 아니라 alerts 도구(업무 데이터 경보 스캔)를 호출한다. ' +
      '"어제 브리핑/어제 어땠어"는 daily_briefing. 매출·재고·광고·CS 등 업무 질문에 개인 메모리·외부 파일(엑셀/Drive)로 답하지 말고 반드시 이 서버 도구로 조회한다.',
  });
  // 순수 날짜 도구 스키마 — period(자연어) 우선, 없으면 start/end. 핸들러는 wrapR로 감쌀 것.
  const D = RANGE_SCHEMA;

  server.registerTool('cafe24_analysis', {
    title: '자사몰(Cafe24) 상품·매출 분석 [확정집계]',
    description: '기간별 자사몰 매출·주문·객단가·카테고리·충전재등급·상품TOP·인기색상·요일패턴. ' +
      '대시보드 기준(Cafe24 주문일) 확정 집계값 — 매출/판매 분석엔 원시 주문(get_orders 등)으로 직접 계산하지 말고 반드시 이 도구를 사용.',
    inputSchema: D,
  }, wrapR((start, end) => productAnalysis.analyze(start, end)));

  server.registerTool('smartstore_analysis', {
    title: '스마트스토어 상세 분석 — 상품별 TOP 포함 [확정집계]',
    description: '기간별 스마트스토어 매출·**상품별 매출 TOP(productTop)**·카테고리·충전재·유입경로·적용쿠폰·할인이벤트·결제패턴. ' +
      '스마트스토어도 상품 단위 데이터를 제공함 — 자사몰 기준 추정 금지, 상품 TOP 질문엔 이 도구를 직접 호출.',
    inputSchema: D,
  }, wrapR((start, end) => smartstoreAnalysis.analyze(start, end)));

  server.registerTool('promotion_performance', {
    title: '프로모션 성과(전 몰) [확정집계]',
    description: '기간에 진행된 전 몰 등록 프로모션별 매출·주문 (자사몰=연결쿠폰 실사용, 그 외=대상상품 매칭). ' +
      '프로모션/이벤트 성과 질문엔 반드시 이 도구를 사용 — 원시 주문에서 추정/직접계산 금지.',
    inputSchema: D,
  }, wrapR((start, end) => promoPerformance.allForPeriod(start, end)));

  // ── 통합: 자사몰 쿠폰·혜택 (성과/사용현황/진행중 할인) ──
  server.registerTool('cafe24_coupons', {
    title: '자사몰 쿠폰·혜택 — 성과/사용현황/진행중 할인 [확정집계]',
    description: 'mode 선택: performance=프로모션 연결 쿠폰별 성과(매출·주문·실효할인율) / usage=기간 실사용 쿠폰별 집계(+coupon 지정 시 그 쿠폰 구매 주문 리스트) / benefits=현재 진행중 혜택·할인 설정 목록. ' +
      '"쿠폰 성과", "어떤 쿠폰 얼마나 쓰였어", "○○쿠폰으로 산 주문", "지금 무슨 할인 걸려있어" 질문에 사용.',
    inputSchema: {
      mode: z.enum(['performance', 'usage', 'benefits']).describe('performance=연결쿠폰 성과 / usage=실사용 집계 / benefits=진행중 혜택'),
      start: z.string().optional().describe('YYYY-MM-DD (performance·usage 필수)'), end: z.string().optional().describe('YYYY-MM-DD'),
      period: PERIOD_FIELD,
      coupon: z.string().optional().describe('usage 모드: 쿠폰명 부분일치 → 그 쿠폰 구매 주문 리스트'),
    },
  }, wrap(async (a) => {
    const { mode, start, end, coupon } = withPeriod(a);
    if (mode === 'benefits') {
      const j = await cafe24api.adminGet('/benefits', { shop_no: 1, limit: 100 });
      const today = new Date().toISOString().slice(0, 10);
      const rows = (j.benefits || []).map((b) => ({
        혜택명: b.benefit_name, 사용중: b.use_benefit === 'T', 구분: b.benefit_division || '', 유형: b.benefit_type || '',
        기간: b.use_benefit_period === 'T' ? `${String(b.benefit_start_date || '').slice(0, 10)} ~ ${String(b.benefit_end_date || '').slice(0, 10)}` : '상시',
        플랫폼: b.platform_types || null,
        진행중: b.use_benefit === 'T' && (b.use_benefit_period !== 'T' || (String(b.benefit_start_date || '').slice(0, 10) <= today && today <= String(b.benefit_end_date || '9999').slice(0, 10))),
      }));
      return { 기준일: today, 전체: rows.length, 진행중: rows.filter((r) => r.진행중).length, 목록: rows.sort((a, b) => (b.진행중 - a.진행중)) };
    }
    if (mode === 'usage') return couponUsage.usage(start, end, { coupon });
    // performance
    const promos = await mallPromos.listPromotions('자사몰');
    const names = [];
    for (const p of (promos || [])) { if (p.end < start || p.start > end) continue; for (const c of (p.coupons || [])) if (c.coupon_name) names.push(c.coupon_name); }
    if (!names.length) return { start, end, byCoupon: [], note: '이 기간 연결 쿠폰 없음' };
    return cafe24Coupons.couponPerfFor([...new Set(names)], start, end);
  }));

  // ── 통합: 자사몰 고객/혜택군 분석 (회원vs비회원 / 상품태그 / 적립금·쿠폰 사용) ──
  server.registerTool('cafe24_customer', {
    title: '자사몰 고객·태그·혜택 분석 [확정집계]',
    description: 'mode 선택: member=회원 vs 비회원 매출·객단가·일별 시계열(신규 획득 분석) / tag=상품태그별([클리어런스]·[공동구매] 등) 매출 / benefit=적립금·쿠폰 사용 분류별 매출·의존도. ' +
      '"회원 vs 비회원 비중", "상품태그별 매출", "적립금·쿠폰 사용 분석" 질문에 사용. 개인정보 없이 집계만.',
    inputSchema: { mode: z.enum(['member', 'tag', 'benefit']).describe('member|tag|benefit'), start: z.string().optional().describe('YYYY-MM-DD'), end: z.string().optional().describe('YYYY-MM-DD'), period: PERIOD_FIELD },
  }, wrap(async (a) => {
    const { mode, start, end } = withPeriod(a);
    if (mode === 'tag') return tagPromotions.tagPromotionSales(start, end);
    if (mode === 'benefit') return benefit.benefitUsage(start, end);
    return orders.memberReport(await orders.fetchOrdersSmart(start, end), start, end);
  }));

  // ── 통합: 자사몰 트래픽·유입 상세 (유입소스 / 행동통계 / 페이지뷰) ──
  server.registerTool('cafe24_traffic', {
    title: '자사몰 트래픽·유입 상세 — 광고소스/검색어/도메인·행동퍼널·페이지뷰 [Cafe24 통계]',
    description: 'mode 선택: inflow=광고소스별 주문·매출·가입+유입 검색어+도메인(Cafe24 광고→주문 귀속) / behavior=페이지별 뷰 TOP·상품 조회→담기→구매 퍼널·시간대별 구매·순방문자 / pageview=특정 URL 일별 뷰 추이(url 필수, "N월 프로모션"·전체URL 지원). ' +
      '"어떤 광고·검색어로 주문", "조회는 많은데 안 담기는 상품", "몇 시에 많이 사", "7월 프로모션 페이지 뷰" 질문에 사용.',
    inputSchema: {
      mode: z.enum(['inflow', 'behavior', 'pageview']).describe('inflow|behavior|pageview'),
      start: z.string().optional().describe('YYYY-MM-DD'), end: z.string().optional().describe('YYYY-MM-DD'),
      period: PERIOD_FIELD,
      url: z.string().optional().describe('pageview 모드 필수: URL 조각·전체URL·"N월 프로모션"'),
    },
  }, wrap((a) => {
    const { mode, start, end, url } = withPeriod(a);
    if (mode === 'pageview') return analytics.pageViewsByUrl(url, start, end);
    if (mode === 'behavior') return analytics.behaviorStats(start, end);
    return analytics.inflowPaths(start, end);
  }));

  server.registerTool('cafe24_voc', {
    title: '자사몰 VOC — 상품후기·Q&A·A/S문의 최근 글 [조회전용·마스킹]',
    description: '자사몰 게시판 최근 글: board=review(상품후기, 평점분포·평균평점 포함)|qna(Q&A)|as(A/S문의), 최근 N일(기본 14). ' +
      '"최근 리뷰 뭐 올라왔어", "요즘 고객 문의 뭐가 많아", "A/S 문의 내용" 질문에 사용. 작성자 마스킹·본문 200자 요약.',
    inputSchema: {
      board: z.string().optional().describe('review | qna | as (기본 review)'),
      days: z.number().int().optional().describe('최근 N일 (기본 14, 최대 90)'),
    },
  }, wrap(({ board, days }) => voc.articles(board, { days })));

  server.registerTool('returns_analysis', {
    title: '반품/취소 분석 — 순매출·취소율·반품률 (자사몰+스토어) [확정집계]',
    description: '기간 자사몰(Cafe24)·스마트스토어의 정상/취소/반품 분류 → 순매출(반품·취소 제외)·취소율·반품률·반품금액. ' +
      '"진짜 매출(반품 뺀)", "반품률 높은 채널/기간" 분석에 사용. 자사몰은 라이브 주문 분류(다소 느릴 수 있음), 스토어는 DB status 기준.',
    inputSchema: D,
  }, wrapR((start, end) => returns.returnsReport(start, end)));

  server.registerTool('customer_retention', {
    title: '고객 재구매·LTV·리텐션 (자사몰) [확정집계]',
    description: '최근 N개월(기본 6) 자사몰 회원 기준: 구매회원수·재구매회원수·**재구매율**·회원 평균 주문수·평균 구매액(윈도우 LTV)·**평균 재구매 주기(일)** + 신규 vs 재구매 주문·매출 비중 + 비회원 비중. ' +
      '"단골 비중", "재구매 주기", "신규 의존도", "회원 LTV" 분석에 사용. 개인정보 없이 집계만.',
    inputSchema: { months: z.number().int().optional().describe('조회 개월수(기본 6, 최대 24)') },
  }, wrap(({ months }) => retention.retention(months)));

  // ── 통합: 오프라인 매장 판매 (종합/주차목표/세트·커버) ──
  server.registerTool('offline_sales', {
    title: '오프라인 매장 판매 — 종합·주차별목표·세트/커버 [확정집계]',
    description: '오프라인 11개 매장(신세계센텀시티몰·스타필드하남/고양·롯데동탄/안산/김포공항/대구·현대미아/무역센터·신세계본점/대전). mode 선택: ' +
      'summary=매출·주문·객단가+매장별(월 목표·달성률)+카테고리·충전재+상품TOP+사원TOP (store 지정 시 그 매장만) / ' +
      'weekly=월 주차별(1~6주차) 목표 대비 실적·달성률 (month 필수) / setcover=세트구매율·커버 동시구매율(매장별). ' +
      '"매장별 매출·목표", "○○매장 카테고리", "7월 1주차 달성률", "커버 동시구매율" 질문에 사용. 개인정보 없음.',
    inputSchema: {
      mode: z.enum(['summary', 'weekly', 'setcover']).describe('summary|weekly|setcover'),
      start: z.string().optional().describe('YYYY-MM-DD (summary·setcover 필수)'), end: z.string().optional().describe('YYYY-MM-DD'),
      period: PERIOD_FIELD,
      store: z.string().optional().describe('summary 모드: 매장명 부분일치(예: 센텀)'),
      month: z.string().optional().describe('weekly 모드 필수: YYYY-MM'),
    },
  }, wrap((a) => {
    const { mode, start, end, store: st, month } = withPeriod(a);
    if (mode === 'weekly') return offline.weeklyStatus(month);
    if (mode === 'setcover') return offline.setCoverAnalysis(start, end);
    return offline.analyze(start, end, { storeName: st });
  }));

  server.registerTool('online_offline_compare', {
    title: '온라인 vs 오프라인 매출 비교 — 합계·비중·일별 [교차]',
    description: '기간 온라인(이카운트: 자사몰+스마트스토어+외부채널)과 오프라인(매장 주문서)의 매출 합계·비중(%)·일별 시계열을 한 번에 비교. ' +
      '"온·오프 비중", "오프라인이 온라인 대비 얼마나", "전사 매출(온+오프)" 질문에 사용. 서로 다른 원장이라 합산은 근사치.',
    inputSchema: D,
  }, wrapR((start, end) => offline.onOffCompare(start, end)));

  server.registerTool('y_league', {
    title: 'Y리그 — 좌수왕·캐스트·스토어 랭킹 (오프라인 매장 리그) [확정집계]',
    description: '기간 오프라인 매장 Y리그 3종목: ' +
      '① 좌수왕=목표 인원(좌수) 대비 판매 인원 달성률 순위(매니저별) ② 캐스트=직영(매니저/부매니저/시니어/일급제) 개인 매출 순위 ③ 스토어=매장 목표매출 대비 달성률 순위. ' +
      '"Y리그", "좌수", "좌수왕", "캐스트 순위", "스토어 리그", "매장 리그/베스트 스토어" 질문에 사용. 스토어 리그 1위 매장의 상세(카테고리 등)는 이 도구로 1위 확인 후 offline_analysis(store 필터)로 조회. ' +
      '※ 공식 화면은 일부 노출 보정(인원 화이트리스트 등)이 있어 소폭 다를 수 있음(여기는 원천 집계).',
    inputSchema: D,
  }, wrapR((start, end) => jwasuLeague.league(start, end)));

  server.registerTool('staff_schedule', {
    title: '매니저 근무 스케줄 조회 (오프라인 매장) [조회전용]',
    description: '기간 오프라인 매장 매니저 스케줄: 일별(출근~퇴근·근무시간·구분: 근무/주휴/연차/반차/대체휴무) + 매니저별 요약(근무일·총근무시간·휴무일수) + 매장×일자 근무 인원 명단. ' +
      'store(매장명)·manager(이름) 부분일치 필터 지원. 미래 날짜=사전 편성 스케줄. ' +
      '"오늘 ○○매장 누가 출근?", "이번 달 ○○ 근무시간", "다음 주 스케줄" 질문에 사용. 조회 전용 — 편성/수정은 스케줄 앱에서.',
    inputSchema: {
      start: z.string().describe('시작일 YYYY-MM-DD'), end: z.string().describe('종료일 YYYY-MM-DD'),
      store: z.string().optional().describe('매장명 필터(부분일치)'), manager: z.string().optional().describe('매니저명 필터(부분일치)'),
    },
  }, wrap(({ start, end, store: st, manager }) => workSchedule.schedule(start, end, { storeName: st, manager })));

  server.registerTool('daily_briefing', {
    title: '일일 브리핑 — 온+오프 매출·목표 페이스·광고·트래픽 한 방 요약 [직원용]',
    description: '기준일(미지정 시 어제) 하루 요약: 전체/온라인(자사몰·스토어·외부)/오프라인 매출 + 전일·전주 동요일 대비 + 월 누적·목표 달성률(온라인/오프라인) + 당일·월누적 광고비·ROAS + 자사몰 트래픽(방문·가입·구매). ' +
      '"어제 어땠어", "오늘 브리핑", "어제 매출 요약" 같은 일일 요약 질문엔 여러 도구 대신 이 도구 하나만 호출.',
    inputSchema: { date: z.string().optional().describe('기준일 YYYY-MM-DD (생략=어제)') },
  }, wrap(({ date }) => briefing.briefing(date)));

  server.registerTool('delivery_status', {
    title: '매장 택배 배송 조회 (오프라인 주문서) [조회전용·개인정보 마스킹]',
    description: '오프라인 매장 택배 발송 현황: 주문번호(부분일치)·매장명·발송일 기간·상태(SHIPPED 등)로 조회 → 상태·택배사·송장번호·발송일·상품. ' +
      '"○○매장 어제 발송 건", "주문번호 X 배송 어디까지" 질문에 사용. 고객명 마스킹·연락처/주소 미제공.',
    inputSchema: {
      orderNo: z.string().optional().describe('주문번호(부분일치)'),
      store: z.string().optional().describe('매장명(부분일치)'),
      start: z.string().optional().describe('발송일 시작 YYYY-MM-DD'),
      end: z.string().optional().describe('발송일 종료 YYYY-MM-DD'),
      period: PERIOD_FIELD,
      status: z.string().optional().describe('배송상태 필터(예: SHIPPED)'),
    },
  }, wrap((a) => { const { orderNo, store: st, start, end, status } = withPeriod(a); return delivery.shipments({ orderNo, storeName: st, start, end, status }); }));

  server.registerTool('bead_refill_targets', {
    title: '비즈 충전 유도 대상 — 본품 구매 N개월 경과·비즈 미구매 회원 [프로모션 타겟]',
    description: '자사몰 회원 중 본품(소파·바디필로우·메이트) 구매 후 N개월(기본 6) 이상 경과했는데 리필/비즈를 아직 안 산 회원 집계: ' +
      '대상자 수·마케팅 수신동의 인원·경과개월 분포·구매 본품 TOP. "비즈 충전 프로모션 대상", "비즈 리필 타겟 고객" 질문에 사용. ' +
      '⚠️ 개인정보 보호: 이름·연락처는 MCP로 제공하지 않음 — 실제 발송용 명단(CSV)은 판매분석 대시보드 ⑧ 비즈 유도 고객 탭에서 다운로드하라고 안내할 것. 첫 조회는 수십 초 걸릴 수 있음(이후 캐시).',
    inputSchema: { months: z.number().int().optional().describe('본품 구매 후 경과 개월 기준(기본 6)') },
  }, wrap(async ({ months }) => {
    const mo = Number.isFinite(+months) && +months > 0 ? +months : 6;
    const r = await segments.bizPromote(mo, { withPII: true, limit: 5000 });
    const rows = r.rows || [];
    // 집계만 반환(PII 폐기) — 수신동의·경과개월 분포·본품 TOP
    const consent = rows.filter((x) => x.smsAgree || x.mailAgree).length;
    const sms = rows.filter((x) => x.smsAgree).length;
    const buckets = {};
    for (const x of rows) {
      const m = x.monthsSince || 0;
      const k = m >= 24 ? '24개월+' : m >= 18 ? '18~23개월' : m >= 12 ? '12~17개월' : `${mo}~11개월`;
      buckets[k] = (buckets[k] || 0) + 1;
    }
    const prodCount = {};
    for (const x of rows) for (const p of (x.products || [])) prodCount[p] = (prodCount[p] || 0) + 1;
    const 본품TOP = Object.entries(prodCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([p, n]) => ({ 본품: p, 보유고객: n }));
    return {
      기준: `본품(소파·바디필로우·메이트) 구매 후 ${mo}개월+ 경과 · 리필/비즈 미구매 · 자사몰 회원`,
      대상자수: r.count,
      마케팅수신동의: { 인원: consent, SMS동의: sms, 동의율_pct: r.count ? +((consent / r.count) * 100).toFixed(1) : 0 },
      경과개월분포: buckets,
      본품TOP: 본품TOP,
      데이터기준: { cached: !!r.cached, builtAt: r.builtAt, stale: !!r.stale },
      발송명단안내: '이름·연락처가 포함된 실제 발송용 명단은 판매분석 대시보드 → ⑧ 비즈 유도 고객 탭에서 CSV 다운로드 (개인정보 보호로 MCP 미제공).',
    };
  }));

  server.registerTool('cafe24_product_stock', {
    title: '자사몰 옵션별 진열 재고/품절 [실시간 API]',
    description: '자사몰(Cafe24) 쇼핑몰에 표시되는 상품 옵션(색상)별 재고·품절표시·판매여부 — 상품명 검색(상위 4개 상품). ' +
      '"자사몰에서 ○○ 품절 옵션 뭐야", "자사몰 재고 얼마로 떠 있어" 질문에 사용. ' +
      '⚠️ 재고 3종 구분: 창고 실물=inventory / 스토어 등록=smartstore_ops / 자사몰 진열=이 도구.',
    inputSchema: { search: z.string().describe('상품명 부분일치 (예: 맥스)') },
  }, wrap(({ search }) => cafe24Stock.productStock(search)));

  server.registerTool('alerts', {
    title: '경보 스캔 — "오늘 챙길 것" 어제 실적 보고 + 이상신호 점검 [직원용]',
    description: '⚠️ "오늘 챙길 것/챙길 거"는 캘린더 일정이 아니라 **이 도구(업무 데이터 점검)**를 의미함 — 일정 도구를 찾지 말고 이 도구를 호출할 것. ' +
      '반환: ① 어제실적(전사/온라인/오프라인 매출·전주동요일比·광고비·ROAS·방문·가입) ② 경보(매출 급락·광고 이상·트래픽 급락·미답변 문의·재고 소진 임박·목표 페이스 미달·반품 급등, 심각도 🔴🟡순). ' +
      '답변은 보고 형식으로: 어제 실적 요약 먼저 → 경보 목록 → 정상 항목 한 줄. ' +
      '"오늘 챙길 거 있어?", "이상 없어?", "일일 점검", "모닝 체크" 질문엔 이 도구 하나만 호출. 스캔 10~30초.',
    inputSchema: {},
  }, wrap(() => alerts.scan()));

  server.registerTool('usage_guide', {
    title: '사용 가이드 — 무엇을 물어볼 수 있나요? [도움말]',
    description: '사용자가 "뭘 물어볼 수 있어?", "어떤 데이터 있어?", "사용법/도움말", "여기서 뭐가 가능해?" 라고 물으면 이 도구를 호출해 ' +
      '분야별 예시 질문 목록을 보여줄 것. 신규 직원 온보딩용.',
    inputSchema: {},
  }, wrap(async () => ({
    안내: '아래는 자연어로 바로 물어볼 수 있는 예시입니다. 기간은 "지난달"·"최근 7일"·"이번 달"·"7월"·"6월부터"처럼 편하게 말하면 됩니다(정확한 날짜도 가능).',
    '📊 일일 요약': ['어제 매출 브리핑 줘', '오늘 챙길 거 있어? (경보 스캔)', '오늘까지 이번 달 목표 달성률 어때?'],
    '🛒 온라인 매출': ['6월 자사몰 매출·상품 TOP 알려줘', '회원 vs 비회원 매출 비중은?', '이번 달 스마트스토어 상품별 매출', '적립금·쿠폰 사용 분석', '상품태그별(클리어런스 등) 매출', '반품 뺀 순매출과 반품률은?'],
    '📣 마케팅·광고': ['이번 주 매체별 광고비·ROAS', '광고비 대비 실매출·비용률·CAC 뽑아줘', '광고 늘린 주랑 줄인 주 비교해줘', '자사몰에서 어떤 광고·검색어가 실제 주문 만들었어?', '스마트스토어 유입경로 알려줘'],
    '🏬 오프라인 매장': ['6월 매장별 매출·목표 달성률', '7월 1주차 목표 달성률은?', '온라인 vs 오프라인 비중', '커버 동시구매율 매장별로', 'Y리그 좌수왕/캐스트/스토어 순위', '오늘 매장별 근무자 누구야?', '이번 달 ○○매니저 근무시간'],
    '👥 고객': ['재구매율·재구매주기·회원 LTV는?', '신규 의존도 얼마나 돼?'],
    '📦 재고·물류': ['맥스 커버 재고 얼마나 남았어?', '이 품목 재고 소진 속도는?', '발주 필요한 품목 알려줘', '○○매장 어제 택배 발송 현황'],
    '📈 비교·추이': ['전년/전월/전주 대비 채널 비교', '월별 매출 추이', '제품별 판매 예측'],
    팁: '특정 도구를 콕 집을 필요 없이 평소 말로 질문하세요. 기간은 "지난달"·"최근 7일" 같은 자연어로 말하면 시스템이 KST 기준으로 정확히 잡습니다(날짜 계산 불필요). 데이터는 매일 오전 9시(매출)·9시반(광고) 자동 갱신됩니다. 모든 금액은 원(KRW)입니다.',
  })));

  // ── 통합: 스마트스토어 운영 (상품/재고·정산) ──
  server.registerTool('smartstore_ops', {
    title: '스마트스토어 운영 — 상품/재고·정산 [실시간 API]',
    description: 'mode 선택: products=등록 상품 판매상태·스토어재고·가격(search 상품명 / status 상태 / lowStock 재고N이하 필터) / settlement=기간 정산액·수수료·실효수수료율. ' +
      '"스토어 품절 상품", "스토어 재고 10개 이하", "이번 달 스토어 정산·수수료" 질문에 사용. 실물 창고 재고는 inventory(다른 데이터).',
    inputSchema: {
      mode: z.enum(['products', 'settlement']).describe('products|settlement'),
      start: z.string().optional().describe('settlement 필수 YYYY-MM-DD'), end: z.string().optional().describe('YYYY-MM-DD'),
      period: PERIOD_FIELD,
      search: z.string().optional().describe('products: 상품명 부분일치'), status: z.string().optional().describe('products: 상태(판매중/품절 등)'),
      lowStock: z.number().int().optional().describe('products: 판매중 & 재고 N개 이하'),
    },
  }, wrap((a) => { const { mode, start, end, search, status, lowStock } = withPeriod(a); return mode === 'settlement' ? ssExtra.settlements(start, end) : ssExtra.products({ search, status, lowStock }); }));

  server.registerTool('cs_order_lookup', {
    title: 'CS 주문 조회 — 주문번호로 자사몰+스마트스토어 통합 상태 확인 [조회전용]',
    description: '주문번호(부분일치)로 자사몰(Cafe24)·스마트스토어 주문을 한 번에 조회: 채널·주문일·상태(결제/취소·배송중/배송완료/구매확정 등)·금액·쿠폰/적립금·상품·자사몰 송장번호. ' +
      '"주문번호 ○○○ 어떻게 됐어?", "이 주문 배송 나갔어?" 같은 CS 응대 질문에 사용. 구매자 개인정보 미제공.',
    inputSchema: { orderNo: z.string().describe('주문번호(부분일치, 자사몰 YYYYMMDD-0000000 / 스토어 주문·상품주문번호)') },
  }, wrap(({ orderNo }) => csTools.orderLookup(orderNo)));

  // ── 통합: CS 미답변 체크 (자사몰+스토어 한 번에) ──
  server.registerTool('cs_unanswered', {
    title: 'CS 미답변 문의 체크 — 자사몰+스마트스토어 통합 [CS 모니터링]',
    description: 'channel 선택(기본 both): 자사몰 게시판(Q&A·A/S·1:1상담·교환/반품) + 스마트스토어 고객문의의 **미답변 원글**을 한 번에 체크. 최근 N일(기본 7). ' +
      '"자사몰이랑 스토어 미답변 문의 한 번에 체크해줘", "답변 안 남긴 문의 있어?" 질문에 사용. 작성자 마스킹.',
    inputSchema: {
      channel: z.enum(['both', 'cafe24', 'smartstore']).optional().describe('both(기본)|cafe24|smartstore'),
      days: z.number().int().optional().describe('최근 N일 (기본 7, 최대 60)'),
    },
  }, wrap(async ({ channel = 'both', days = 7 }) => {
    const out = {};
    if (channel !== 'smartstore') out.자사몰 = await csTools.unanswered(days).catch((e) => ({ error: e.message }));
    if (channel !== 'cafe24') {
      const pad = (n) => String(n).padStart(2, '0'); const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const e = new Date(); const s = new Date(); s.setDate(s.getDate() - Math.max(1, Math.min(60, days)));
      out.스마트스토어 = await ssExtra.inquiries(fmt(s), fmt(e)).catch((er) => ({ error: er.message }));
    }
    out.총미답변 = (out.자사몰 && out.자사몰.총미답변 || 0) + (out.스마트스토어 && out.스마트스토어.미답변 && out.스마트스토어.미답변.건수 || 0);
    return out;
  }));

  // ── 통합: CS 답변 지원 (정책 지식 / 과거 답변 사례) ──
  server.registerTool('cs_reference', {
    title: 'CS 답변 지원 — 공식 정책/FAQ 검색·과거 답변 사례 [답변 초안 근거]',
    description: 'mode 선택: policy=공식 정책 게시판(배송·교환/환불·세탁방법·제품정보·FAQ) 키워드 검색 → 정책 원문 / examples=과거 실제 문의→답변 사례 검색(톤·포맷 참고). ' +
      '고객 문의 답변 초안 작성 시 **반드시 policy로 공식 정책을 확인**하고 examples로 톤을 맞출 것(정책 추측 금지). "반품하면 쿠폰 어떻게 돼", "배송 지연 답변 어떻게 했었어" 질문에 사용.',
    inputSchema: {
      mode: z.enum(['policy', 'examples']).describe('policy|examples'),
      query: z.string().optional().describe('검색 키워드(policy 필수, examples는 생략 시 최근 전체)'),
      days: z.number().int().optional().describe('examples: 최근 N일(기본 60)'),
    },
  }, wrap(({ mode, query, days }) => mode === 'examples' ? csKnowledge.answerExamples(query, { days }) : csKnowledge.knowledge(query)));

  server.registerTool('marketing_inflow', {
    title: '마케팅채널 유입수 — 일별 제공(비즈어드바이저)',
    description: '기간 스마트스토어 유입수: 일별 총유입 + 채널별 합계 + (기간 짧으면)일별×채널 상세. ' +
      'on.bizInflow에 일별 데이터가 적재돼 있음 — "일별 유입은 월합산만" 같은 추정 금지, 일별까지 이 도구로 제공.',
    inputSchema: D,
  }, wrapR(async (start, end) => {
    const s = await bizadvisor.summary(start, end);
    const days = s.days || [];
    const out = {
      from: s.from, to: s.to, 합계유입: s.grandTotal,
      채널별합계: s.channels.map((c) => ({ 채널: c, 유입수: s.totalsByChannel[c] })),
      일별총유입: days.map((d) => ({ 날짜: d.date, 총유입: d.total })),
    };
    if (days.length <= 62) out.일별채널별 = days; // 날짜×채널 상세(기간 짧을 때)
    else out.안내 = '기간이 길어 일별×채널 상세는 생략(일별총유입·채널합계만). 한 달 이내로 좁히면 일별×채널도 제공.';
    return out;
  }));

  // ── 통합: 기타채널(쿠팡·롯데·현대·신세계·오늘의집 등) 매출 — 그룹 지정 시 상품 상세 ──
  server.registerTool('other_channels', {
    title: '기타채널 매출 (쿠팡·롯데·현대·신세계·오늘의집 등) [확정집계]',
    description: '기간 기타채널 매출(이카운트). group 미지정 → 채널 그룹별 매출·주문 요약. group 지정(쿠팡·롯데홈쇼핑·현대 이지웰·현대 M포인트몰·신세계몰·오늘의집·29CM 등) → 그 채널 상품별 매출·카테고리·충전재·색상·입점몰별 상세. ' +
      '"기타채널 매출", "쿠팡에서 뭐 팔렸어" 질문에 사용.',
    inputSchema: { start: z.string().optional().describe('YYYY-MM-DD'), end: z.string().optional().describe('YYYY-MM-DD'), period: PERIOD_FIELD, group: z.string().optional().describe('채널 그룹명(지정 시 상품 상세)') },
  }, wrap(async (a) => {
    const { start, end, group } = withPeriod(a);
    if (!group) return otherChannels.overview(start, end);
    const d = await otherChannels.groupDetail(group, start || '', end || '');
    return { group, totals: d.totals, 상품TOP: (d.products || []).slice(0, 15), 카테고리: d.byCategory, 충전재등급: d.byBead, 색상: (d.byColor || []).slice(0, 20), 입점몰별: d.subs };
  }));

  // ── 통합: 매출 비교·추이·할인율 ──
  server.registerTool('sales_trend', {
    title: '매출 비교·추이·할인율 — 전년/전월/전주·월별추이·할인분석 [확정집계]',
    description: 'mode 선택: compare=선택 기간 자사몰·스마트스토어 매출을 전년/전월/전주 동기간과 비교(start/end) / monthly=채널별 월 매출 시계열(2024~현재) / discount=자사몰 품목별 실판매단가 vs 정상가 → 할인율·가중평균(start/end). ' +
      '"전년 대비", "월별 추이", "할인율 분석" 질문에 사용.',
    inputSchema: { mode: z.enum(['compare', 'monthly', 'discount']).describe('compare|monthly|discount'), start: z.string().optional().describe('compare·discount 필수 YYYY-MM-DD'), end: z.string().optional(), period: PERIOD_FIELD },
  }, wrap((a) => {
    const { mode, start, end } = withPeriod(a);
    if (mode === 'monthly') return compare.monthlySeries('2024-01-01');
    if (mode === 'discount') return productPrices.discountAnalysis(start, end);
    return compare.periodCompare(start, end);
  }));

  // ── 통합: 재고·발주·예측 (현재재고/소진추이/발주판단/판매예측) ──
  server.registerTool('inventory', {
    title: '재고·발주·예측 — 현재재고/소진추이/발주판단/판매예측 [확정집계]',
    description: 'mode 선택: current=지금 현재 재고 수량("○○ 재고 얼마나 남았어", 품절, 남은개수 — 기본값) / trend=일별 소진 추이·소진 예상일(search 필수) / reorder=발주 필요 품목·제안수량 / forecast=제품×색상 월평균 판매량. ' +
      '재고·발주·판매예측 질문엔 반드시 이 도구를 사용. search로 품목명 필터(예: "맥스 커버"). 스토어 등록재고는 smartstore_ops.',
    inputSchema: {
      mode: z.enum(['current', 'trend', 'reorder', 'forecast']).optional().describe('current(기본)|trend|reorder|forecast'),
      search: z.string().optional().describe('품목명/색상 필터(trend는 필수)'),
      days: z.number().int().optional().describe('trend: 조회 일수(기본 14)'),
      months: z.number().int().optional().describe('reorder·forecast: 기준 완료월 수(기본 3)'),
      target: z.number().optional().describe('reorder: 발주 목표 개월수(기본 1)'),
      all: z.boolean().optional().describe('reorder: true면 발주불필요 포함 전체'),
    },
  }, wrap(async ({ mode, search, days, months, target, all }) => {
    if (mode === 'trend') return stockTrend.trend(search, { days });
    if (mode === 'forecast') {
      const m = num(months, 3);
      const r = await forecast.salesForecast({ months: m });
      let items = r.items || [];
      if (search) items = items.filter((x) => (x.name || '').includes(search) || (x.color || '').includes(search));
      return { mode: 'forecast', months: m, total: r.count, count: items.length, items: items.slice(0, 30).map((x) => ({ 품목: x.name, 색상: x.color, 월평균: x.monthlyAvg, 누적: x.total })) };
    }
    if (mode === 'reorder') {
      const m = num(months, 3), tg = num(target, 1);
      const r = await forecast.reorderPlan({ months: m, targetMonths: tg });
      const allItems = Array.isArray(r) ? r : (r.items || r.rows || []);
      let items = allItems;
      if (search) items = items.filter((x) => (x.name || '').includes(search) || (x.color || '').includes(search));
      else if (!all) items = items.filter((x) => x.needOrder);
      items = [...items].sort((a, b) => (a.monthsLeft == null ? 999 : a.monthsLeft) - (b.monthsLeft == null ? 999 : b.monthsLeft));
      return { mode: 'reorder', months: m, targetMonths: tg, 발주필요_품목수: allItems.filter((x) => x.needOrder).length, count: items.length, items: items.slice(0, 40) };
    }
    // current (기본)
    const [rows, updatedAt] = await Promise.all([forecast.stockList(), forecast.stockUpdatedAt().catch(() => null)]);
    const items = Array.isArray(rows) ? rows : [];
    const base = { mode: 'current', total: items.length, 재고기준시각: updatedAt, 주의: '재고는 약 10분 주기 동기화 — 재고기준시각 기준 수량.' };
    if (search) { const f = items.filter((x) => (x.name || '').includes(search) || (x.color || '').includes(search)); return { ...base, count: f.length, items: f.slice(0, 40) }; }
    const low = [...items].sort((a, b) => (a.qty || 0) - (b.qty || 0)).slice(0, 25);
    return { ...base, 안내: '품목명으로 search하면 정확히 조회됩니다. 아래는 재고 적은 순 상위 40.', 재고적은순: low };
  }));

  server.registerTool('target_status', {
    title: '월 목표 달성률 [확정집계]',
    description: '해당 월(YYYY-MM) 자사몰·스마트스토어 목표 대비 실적·달성률·월말예상. 대시보드 확정값 — 직접 계산 금지.',
    inputSchema: { month: z.string().describe('YYYY-MM') },
  }, wrap(async ({ month }) => {
    const [ca, ss] = await Promise.all([
      target.mallTargetStatus(month, '자사몰').catch(() => null),
      target.mallTargetStatus(month, '스마트스토어').catch(() => null),
    ]);
    return { month, 자사몰: ca, 스마트스토어: ss };
  }));

  // ── 광고효율 (adboard.daily_stats — 매체 API 적재본) ──
  server.registerTool('ad_efficiency', {
    title: '광고효율 — 매체별 ROAS·CTR·CPC·CPA [adboard]',
    description: '기간별 광고 매체 효율. 벤더(네이버·메타·크리테오·카카오)별 + 상세매체별 광고비·전환·전환매출·ROAS·CTR·CPC·CVR·CPA + 전체 합계. ' +
      '데이터 출처: ad-dashboard(mkboard)가 각 매체 API에서 적재한 일별 광고 데이터. 매출(이카운트)과는 다른 집계라 직접 합산하지 말 것.',
    inputSchema: D,
  }, wrapR((start, end) => adEfficiency.efficiency(start, end)));

  server.registerTool('marketing_overview', {
    title: '통합 마케팅 개요 — 광고+온라인+오프라인+트래픽 한 번에 (전사매출·비용률·CAC) [교차]',
    description: '기간 하나로 전사매출(온라인+오프라인 매장)·채널별 매출·광고(매체별 광고비·ROAS)·트래픽(방문·신규가입·구매)을 한 번에 조합. ' +
      '실질 마케팅비용률(온라인 기준+전사 기준)·신규가입당 광고비(CAC)·오프라인 비중까지 제공. ' +
      '"광고 대비 매출", "전사 매출과 광고", "이 기간 마케팅 종합" 질문엔 여러 도구 대신 이 도구 하나로 답할 것. ' +
      '⚠️ 주문 단위 귀속 없음 → 집계 수준 대조. convValue(광고기여)와 실매출은 다른 수치라 합산 금지.',
    inputSchema: D,
  }, wrapR((start, end) => marketing.overview(start, end)));

  server.registerTool('marketing_sales_series', {
    title: '일별 마케팅↔매출 시계열 (광고×온라인×오프라인×회원/비회원×트래픽) [교차·관계분석]',
    description: '기간을 "하루=한 줄"로 정렬한 통합 표. 각 날짜: 매체별 광고비(네이버·메타·크리테오·카카오)·온라인 매출(자사몰·스토어·외부)·**오프라인 매장 매출·전사 합계**·자사몰 회원/비회원·방문·신규가입·구매. ' +
      '광고와 매출(온·오프)의 관계·상관·추세·시차 분석엔 이 도구를 사용 — 여러 도구를 따로 부르지 말 것(날짜 정렬은 서버가 끝냄). ' +
      '⚠️ 주문 단위 광고 귀속 없음 → 상관관계(인과 아님).',
    inputSchema: D,
  }, wrapR((start, end) => marketing.series(start, end)));

  server.registerTool('marketing_period_compare', {
    title: '두 구간 마케팅↔매출 비교 (프로모션 전/중/후·광고 늘린 주 등) [교차]',
    description: '두 기간(A·B)의 광고비·온라인/오프라인/전사 매출·회원/비회원·트래픽을 "일평균 기준"으로 비교(기간 길이 달라도 됨) + 증감률 + 증분ROAS(온라인 매출증분÷광고비증분). ' +
      '"광고 늘린 주 vs 안 늘린 주", "프로모션 기간 vs 평소" 같은 비교 질문에 이 도구를 사용.',
    inputSchema: {
      aStart: z.string().describe('A구간 시작 YYYY-MM-DD'), aEnd: z.string().describe('A구간 종료 YYYY-MM-DD'),
      bStart: z.string().describe('B구간 시작 YYYY-MM-DD'), bEnd: z.string().describe('B구간 종료 YYYY-MM-DD'),
    },
  }, wrap(({ aStart, aEnd, bStart, bEnd }) => marketing.periodCompare(aStart, aEnd, bStart, bEnd)));

  return server;
}

// ── 실행: stdio (로컬 Claude Desktop) ───────────────────────────────────────
async function runStdio() {
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  await build().connect(new StdioServerTransport());
  console.error('[mcp] yogibo-sales stdio 서버 시작');
}

// ── 실행: Streamable HTTP (원격 호스팅 · 두 사람 공유) ──────────────────────
//   인증: MCP_TOKEN 설정 시 Authorization: Bearer <MCP_TOKEN> 필요. 엔드포인트 /mcp
async function runHttp() {
  const http = require('http');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const PORT = Number(process.env.PORT || process.env.MCP_PORT || 8787);
  const TOKEN = process.env.MCP_TOKEN || '';

  const readBody = (req) => new Promise((resolve) => {
    // 바이트를 모아 한 번에 UTF-8 디코드 — 한글 인자("맥스 커버" 등)가 chunk 경계에서 깨지는 문제 방지.
    //   Buffer/문자열 chunk 둘 다 Buffer로 정규화(어댑터 호환).
    const chunks = []; let len = 0;
    req.on('data', (c) => { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); chunks.push(b); len += b.length; if (len > 4e6) req.destroy(); });
    req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : undefined); } catch (_) { resolve(undefined); } });
    req.on('error', () => resolve(undefined));
  });

  const syncJobs = require('../lib/syncJobs');
  const authed = (req) => !TOKEN || req.headers['authorization'] === `Bearer ${TOKEN}`;
  const sendJson = (res, code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));

  const httpServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === '/health') { return sendJson(res, 200, { ok: true, server: 'yogibo-sales-mcp' }); }

    // ── CS 미답변 문의 체크 (REST) — cs-self-guide 어드민 배지/모달용 ─────────
    //   MCP 툴 cs_unanswered 와 동일 로직을 REST(JSON)로 노출. Bearer MCP_TOKEN 인증.
    //   channel=both|cafe24|smartstore (기본 both), days=1~60 (기본 7).
    if (u.pathname === '/api/cs/unanswered') {
      if (!authed(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      try {
        const channel = u.searchParams.get('channel') || 'both';
        const days = Math.min(60, Math.max(1, parseInt(u.searchParams.get('days') || '7', 10) || 7));
        const out = { ok: true, channel, days };
        if (channel !== 'smartstore') {
          out.자사몰 = await csTools.unanswered(days).catch((e) => ({ error: e.message }));
        }
        if (channel !== 'cafe24') {
          const pad = (n) => String(n).padStart(2, '0');
          const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
          const e = new Date();
          const s = new Date();
          s.setDate(s.getDate() - days);
          out.스마트스토어 = await ssExtra.inquiries(fmt(s), fmt(e)).catch((er) => ({ error: er.message }));
        }
        out.총미답변 =
          ((out.자사몰 && out.자사몰.총미답변) || 0) +
          ((out.스마트스토어 && out.스마트스토어.미답변 && out.스마트스토어.미답변.건수) || 0);
        return sendJson(res, 200, out);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    }

    // ── 무거운 동기화 트리거(Vercel 버튼 → cloudtype 1회 실행) ──────────────
    //   Vercel 은 고정IP 없음·60초 제한이라 직접 못 하는 적재를 여기서 백그라운드로 실행한다.
    if (u.pathname === '/sync/run') {
      if (!authed(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
      const body = (await readBody(req)) || {};
      const task = body.task || u.searchParams.get('task') || 'today';
      const params = {
        days: body.days || u.searchParams.get('days'),
        start: body.start || u.searchParams.get('start'),
        end: body.end || u.searchParams.get('end'),
      };
      const r = syncJobs.start(task, params);
      return sendJson(res, 200, { ok: r.started || !!r.already, ...r });
    }
    if (u.pathname === '/sync/status') {
      if (!authed(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, ...syncJobs.status() });
    }
    // 진단: 이 서버(cloudtype)의 아웃바운드(egress) IP — 네이버 커머스 IP 허용목록에 등록해야 SmartStore 동기화가 됨.
    //   (egress IP 는 비밀이 아니라 진단용 → 브라우저로 바로 확인하도록 인증 없이 공개)
    if (u.pathname === '/sync/egress-ip') {
      try {
        const ip = await new Promise((resolve, reject) => {
          require('https').get('https://checkip.amazonaws.com', (r2) => { let b = ''; r2.on('data', (c) => { b += c; }); r2.on('end', () => resolve(b.trim())); }).on('error', reject);
        });
        return sendJson(res, 200, { ok: true, egressIp: ip, hint: '이 IP를 네이버 커머스 API 허용목록(최대 3개)에 등록하세요. cloudtype egress 는 회전할 수 있으니 여러 번 호출해 확인.' });
      } catch (e) { return sendJson(res, 502, { ok: false, error: 'IP 조회 실패: ' + e.message }); }
    }

    if (u.pathname !== '/mcp') { res.writeHead(404).end('not found'); return; }
    if (TOKEN && req.headers['authorization'] !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' })); return;
    }
    try {
      if (req.method === 'POST') {
        // 무상태(stateless): 요청마다 새 transport+server 를 만들어 처리한다. 세션을 메모리에 들지 않으므로
        // cloudtype 재시작/재배포로 세션 맵이 비워져 "세션 없음" 400 이 나던 문제를 원천 차단.
        // enableJsonResponse: SSE 대신 순수 JSON 응답(프록시 호환). sessionIdGenerator 미지정 = 무상태 모드.
        const body = await readBody(req);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { try { transport.close(); } catch (_) {} });
        await build().connect(transport);
        await transport.handleRequest(req, res, body);
      } else if (req.method === 'GET' || req.method === 'DELETE') {
        // 무상태 모드 — 독립 SSE 스트림/세션 종료 불필요. 스펙대로 405(요청/응답은 POST로만).
        res.writeHead(405, { Allow: 'POST' }).end('Method Not Allowed (stateless)');
      } else {
        res.writeHead(405).end('method not allowed');
      }
    } catch (e) {
      console.error('[mcp http] error:', e.message);
      if (!res.headersSent) res.writeHead(500).end('server error');
    }
  });
  httpServer.listen(PORT, () => console.error(`[mcp] yogibo-sales HTTP 서버 :${PORT}/mcp (auth ${TOKEN ? 'ON' : 'OFF'})`));
}

if (require.main === module) {
  (process.argv.includes('--http') ? runHttp() : runStdio()).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { build };
