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

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const fail = (e) => ({ content: [{ type: 'text', text: 'ERROR: ' + ((e && e.message) || String(e)) }], isError: true });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };
const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);

function build() {
  const server = new McpServer({ name: 'yogibo-sales', version: '1.0.0' });
  const D = { start: z.string().describe('시작일 YYYY-MM-DD'), end: z.string().describe('종료일 YYYY-MM-DD') };

  server.registerTool('cafe24_analysis', {
    title: '자사몰(Cafe24) 상품·매출 분석 [확정집계]',
    description: '기간별 자사몰 매출·주문·객단가·카테고리·충전재등급·상품TOP·인기색상·요일패턴. ' +
      '대시보드 기준(Cafe24 주문일) 확정 집계값 — 매출/판매 분석엔 원시 주문(get_orders 등)으로 직접 계산하지 말고 반드시 이 도구를 사용.',
    inputSchema: D,
  }, wrap(({ start, end }) => productAnalysis.analyze(start, end)));

  server.registerTool('smartstore_analysis', {
    title: '스마트스토어 상세 분석 — 상품별 TOP 포함 [확정집계]',
    description: '기간별 스마트스토어 매출·**상품별 매출 TOP(productTop)**·카테고리·충전재·유입경로·적용쿠폰·할인이벤트·결제패턴. ' +
      '스마트스토어도 상품 단위 데이터를 제공함 — 자사몰 기준 추정 금지, 상품 TOP 질문엔 이 도구를 직접 호출.',
    inputSchema: D,
  }, wrap(({ start, end }) => smartstoreAnalysis.analyze(start, end)));

  server.registerTool('promotion_performance', {
    title: '프로모션 성과(전 몰) [확정집계]',
    description: '기간에 진행된 전 몰 등록 프로모션별 매출·주문 (자사몰=연결쿠폰 실사용, 그 외=대상상품 매칭). ' +
      '프로모션/이벤트 성과 질문엔 반드시 이 도구를 사용 — 원시 주문에서 추정/직접계산 금지.',
    inputSchema: D,
  }, wrap(({ start, end }) => promoPerformance.allForPeriod(start, end)));

  server.registerTool('cafe24_coupon_performance', {
    title: '자사몰 프로모션 쿠폰별 성과 [확정집계]',
    description: '기간 자사몰 프로모션에 연결된 쿠폰별 매출·주문·할인액 (실효할인율=할인액/(매출+할인액)). ' +
      '쿠폰/할인율 분석은 반드시 이 도구를 사용 — 원시 주문엔 쿠폰 구조가 없으니 직접계산 불가.',
    inputSchema: D,
  }, wrap(async ({ start, end }) => {
    const promos = await mallPromos.listPromotions('자사몰');
    const names = [];
    for (const p of (promos || [])) { if (p.end < start || p.start > end) continue; for (const c of (p.coupons || [])) if (c.coupon_name) names.push(c.coupon_name); }
    if (!names.length) return { start, end, byCoupon: [], note: '이 기간 연결 쿠폰 없음' };
    return cafe24Coupons.couponPerfFor([...new Set(names)], start, end);
  }));

  server.registerTool('cafe24_member_sales', {
    title: '자사몰 회원 vs 비회원 매출 [확정집계]',
    description: '기간 자사몰(Cafe24) 회원/비회원별 매출·주문·객단가·쿠폰할인·적립금사용·신규주문 + 회원 매출비중 + **일별 회원/비회원 매출 시계열**. ' +
      '"광고가 신규(비회원)를 데려오나", "회원 재구매 vs 신규 획득" 같은 마케팅↔고객군 분석에 사용. 개인정보 없이 집계만.',
    inputSchema: D,
  }, wrap(async ({ start, end }) => orders.memberReport(await orders.fetchOrdersSmart(start, end), start, end)));

  server.registerTool('cafe24_tag_sales', {
    title: '자사몰 상품태그별 매출 ([클리어런스]·[공동구매] 등) [확정집계]',
    description: '기간 자사몰 상품태그(프로모션 태그)별 매출·주문·수량. 태그로 묶인 기획전/클리어런스 성과, 어떤 상품군이 도는지 분석에 사용.',
    inputSchema: D,
  }, wrap(({ start, end }) => tagPromotions.tagPromotionSales(start, end)));

  server.registerTool('cafe24_benefit_usage', {
    title: '자사몰 적립금·쿠폰 사용 분석 [확정집계]',
    description: '기간 자사몰 주문의 혜택 사용 분류(쿠폰+적립금/쿠폰만/적립금만/미사용)별 매출·주문 + 적립금 사용액·쿠폰 할인액·사용 비율. ' +
      '프로모션/할인 의존도, 혜택이 매출에 미치는 영향 분석에 사용. (공동구매 제외)',
    inputSchema: D,
  }, wrap(({ start, end }) => benefit.benefitUsage(start, end)));

  server.registerTool('cafe24_inflow_detail', {
    title: '자사몰 유입경로 상세 — 광고소스별 주문·매출·가입 + 검색어 + 도메인 [Cafe24 통계]',
    description: '기간 자사몰(Cafe24) 통계: ' +
      '① adsales=광고 소스별(SA=검색광고·Brandchannel·채널없음 등) **주문수·주문금액·가입수**(Cafe24 자체 측정 광고→주문 귀속) ' +
      '② keywords=유입 검색어별 방문 TOP ③ domains=유입 도메인(네이버·구글·직접 등) TOP. ' +
      '"자사몰에서 어떤 광고/검색어가 실제 주문·유입을 만들었나" 분석에 사용. 스마트스토어 유입은 marketing_inflow.',
    inputSchema: D,
  }, wrap(({ start, end }) => analytics.inflowPaths(start, end)));

  server.registerTool('returns_analysis', {
    title: '반품/취소 분석 — 순매출·취소율·반품률 (자사몰+스토어) [확정집계]',
    description: '기간 자사몰(Cafe24)·스마트스토어의 정상/취소/반품 분류 → 순매출(반품·취소 제외)·취소율·반품률·반품금액. ' +
      '"진짜 매출(반품 뺀)", "반품률 높은 채널/기간" 분석에 사용. 자사몰은 라이브 주문 분류(다소 느릴 수 있음), 스토어는 DB status 기준.',
    inputSchema: D,
  }, wrap(({ start, end }) => returns.returnsReport(start, end)));

  server.registerTool('customer_retention', {
    title: '고객 재구매·LTV·리텐션 (자사몰) [확정집계]',
    description: '최근 N개월(기본 6) 자사몰 회원 기준: 구매회원수·재구매회원수·**재구매율**·회원 평균 주문수·평균 구매액(윈도우 LTV)·**평균 재구매 주기(일)** + 신규 vs 재구매 주문·매출 비중 + 비회원 비중. ' +
      '"단골 비중", "재구매 주기", "신규 의존도", "회원 LTV" 분석에 사용. 개인정보 없이 집계만.',
    inputSchema: { months: z.number().int().optional().describe('조회 개월수(기본 6, 최대 24)') },
  }, wrap(({ months }) => retention.retention(months)));

  server.registerTool('offline_analysis', {
    title: '오프라인 매장 판매 분석 — 매장·카테고리·충전재·상품·사원별 [확정집계]',
    description: '기간 오프라인 매장(신세계센텀시티몰·스타필드하남/고양·롯데동탄/안산/김포공항/대구·현대미아/무역센터·신세계본점/대전 등 백화점/몰 매장) 판매: ' +
      '합계(매출·수량·주문수·객단가) + 매장별(**월 목표매출·달성률 포함**) + 카테고리·충전재별 + 상품TOP + 판매사원TOP. ' +
      '오프라인/매장 매출·목표 달성률 질문엔 이 도구 사용 — 주차별 목표는 offline_weekly_target. 고객 개인정보 없음.',
    inputSchema: D,
  }, wrap(({ start, end }) => offline.analyze(start, end)));

  server.registerTool('offline_weekly_target', {
    title: '오프라인 매장 주차별 목표 대비 실적 (N주차 달성률) [확정집계]',
    description: '해당 월(YYYY-MM)의 오프라인 매장 주차별(1~6주차) 목표매출 vs 실적 vs 달성률 — 전체 주차 합계 + 매장별 주차 상세. ' +
      '"7월 1주차 목표 달성률", "이번 주차 매장별 실적" 같은 주간 목표 질문에 이 도구 사용. 월 전체 목표는 offline_analysis.',
    inputSchema: { month: z.string().describe('YYYY-MM (예: 2026-07)') },
  }, wrap(({ month }) => offline.weeklyStatus(month)));

  server.registerTool('offline_set_cover', {
    title: '오프라인 세트구매·커버 동시구매 분석 [확정집계]',
    description: '기간 오프라인 매장의 세트구매율·커버 동시구매율(주문 단위, 매장 분석화면과 동일 정의) — 전체 + 매장별 + 세트/커버 인기상품 TOP. ' +
      '"커버 동시구매율", "세트 구매 비율", "어느 매장이 커버 연계판매를 잘하나" 질문에 이 도구 사용.',
    inputSchema: D,
  }, wrap(({ start, end }) => offline.setCoverAnalysis(start, end)));

  server.registerTool('online_offline_compare', {
    title: '온라인 vs 오프라인 매출 비교 — 합계·비중·일별 [교차]',
    description: '기간 온라인(이카운트: 자사몰+스마트스토어+외부채널)과 오프라인(매장 주문서)의 매출 합계·비중(%)·일별 시계열을 한 번에 비교. ' +
      '"온·오프 비중", "오프라인이 온라인 대비 얼마나", "전사 매출(온+오프)" 질문에 사용. 서로 다른 원장이라 합산은 근사치.',
    inputSchema: D,
  }, wrap(({ start, end }) => offline.onOffCompare(start, end)));

  server.registerTool('y_league', {
    title: 'Y리그 — 좌수왕·캐스트·스토어 랭킹 (오프라인 매장 리그) [확정집계]',
    description: '기간 오프라인 매장 Y리그 3종목: ' +
      '① 좌수왕=목표 인원(좌수) 대비 판매 인원 달성률 순위(매니저별) ② 캐스트=직영(매니저/부매니저/시니어/일급제) 개인 매출 순위 ③ 스토어=매장 목표매출 대비 달성률 순위. ' +
      '"Y리그", "좌수", "좌수왕", "캐스트 순위", "매장 리그/베스트 스토어" 질문에 사용. ' +
      '※ 공식 화면은 일부 노출 보정(인원 화이트리스트 등)이 있어 소폭 다를 수 있음(여기는 원천 집계).',
    inputSchema: D,
  }, wrap(({ start, end }) => jwasuLeague.league(start, end)));

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
      status: z.string().optional().describe('배송상태 필터(예: SHIPPED)'),
    },
  }, wrap(({ orderNo, store: st, start, end, status }) => delivery.shipments({ orderNo, storeName: st, start, end, status })));

  server.registerTool('stock_trend', {
    title: '재고 소진 추이 — 일별 스냅샷 기반 [확정집계]',
    description: '품목 검색어(필수)로 최근 N일(기본 14) 일별 재고 추이 + 일평균 소진 속도 + 소진 예상일. ' +
      '"이 품목 재고 얼마나 빨리 빠져?", "언제 소진돼?" 질문에 사용. 현재 수량만 필요하면 stock_list, 발주 판단은 reorder_plan.',
    inputSchema: { search: z.string().describe('품목명/색상 (예: 맥스 커버)'), days: z.number().int().optional().describe('조회 일수(기본 14, 최대 31)') },
  }, wrap(({ search, days }) => stockTrend.trend(search, { days })));

  server.registerTool('usage_guide', {
    title: '사용 가이드 — 무엇을 물어볼 수 있나요? [도움말]',
    description: '사용자가 "뭘 물어볼 수 있어?", "어떤 데이터 있어?", "사용법/도움말", "여기서 뭐가 가능해?" 라고 물으면 이 도구를 호출해 ' +
      '분야별 예시 질문 목록을 보여줄 것. 신규 직원 온보딩용.',
    inputSchema: {},
  }, wrap(async () => ({
    안내: '아래는 자연어로 바로 물어볼 수 있는 예시입니다. 날짜(예: 6/20~28)를 함께 말하면 더 정확합니다.',
    '📊 일일 요약': ['어제 매출 브리핑 줘', '오늘까지 이번 달 목표 달성률 어때?'],
    '🛒 온라인 매출': ['6월 자사몰 매출·상품 TOP 알려줘', '회원 vs 비회원 매출 비중은?', '이번 달 스마트스토어 상품별 매출', '적립금·쿠폰 사용 분석', '상품태그별(클리어런스 등) 매출', '반품 뺀 순매출과 반품률은?'],
    '📣 마케팅·광고': ['이번 주 매체별 광고비·ROAS', '광고비 대비 실매출·비용률·CAC 뽑아줘', '광고 늘린 주랑 줄인 주 비교해줘', '자사몰에서 어떤 광고·검색어가 실제 주문 만들었어?', '스마트스토어 유입경로 알려줘'],
    '🏬 오프라인 매장': ['6월 매장별 매출·목표 달성률', '7월 1주차 목표 달성률은?', '온라인 vs 오프라인 비중', '커버 동시구매율 매장별로', 'Y리그 좌수왕/캐스트/스토어 순위', '오늘 매장별 근무자 누구야?', '이번 달 ○○매니저 근무시간'],
    '👥 고객': ['재구매율·재구매주기·회원 LTV는?', '신규 의존도 얼마나 돼?'],
    '📦 재고·물류': ['맥스 커버 재고 얼마나 남았어?', '이 품목 재고 소진 속도는?', '발주 필요한 품목 알려줘', '○○매장 어제 택배 발송 현황'],
    '📈 비교·추이': ['전년/전월/전주 대비 채널 비교', '월별 매출 추이', '제품별 판매 예측'],
    팁: '특정 도구를 콕 집을 필요 없이 평소 말로 질문하세요. 기간은 명시하는 것이 좋습니다. 데이터는 매일 오전 9시(매출)·9시반(광고) 자동 갱신됩니다.',
  })));

  server.registerTool('marketing_inflow', {
    title: '마케팅채널 유입수 — 일별 제공(비즈어드바이저)',
    description: '기간 스마트스토어 유입수: 일별 총유입 + 채널별 합계 + (기간 짧으면)일별×채널 상세. ' +
      'on.bizInflow에 일별 데이터가 적재돼 있음 — "일별 유입은 월합산만" 같은 추정 금지, 일별까지 이 도구로 제공.',
    inputSchema: D,
  }, wrap(async ({ start, end }) => {
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

  server.registerTool('other_channels', {
    title: '기타채널 매출(쿠팡·롯데·현대·신세계·오늘의집 등)',
    description: '기간 기타채널 그룹별 매출·주문 (이카운트 집계). 특정 채널의 상품별 상세는 other_channel_detail 사용.',
    inputSchema: D,
  }, wrap(({ start, end }) => otherChannels.overview(start, end)));

  server.registerTool('other_channel_detail', {
    title: '기타채널 상세 — 상품별·카테고리·색상 [확정집계]',
    description: '특정 기타채널(group: 쿠팡·롯데홈쇼핑·현대 이지웰·현대 M포인트몰·신세계몰·오늘의집 등)의 ' +
      '상품별 매출·수량·주문 + 카테고리·충전재(등급)·색상·입점몰별 상세 (이카운트 productName 기준). ' +
      '"상품별 데이터 미제공"이 아니라 이 도구로 품목 단위까지 분석.',
    inputSchema: { group: z.string().describe('채널 그룹명 (예: 쿠팡, 롯데홈쇼핑, 현대 이지웰, 현대 M포인트몰, 신세계몰, 오늘의집, 29CM)'), start: z.string().optional().describe('YYYY-MM-DD'), end: z.string().optional().describe('YYYY-MM-DD') },
  }, wrap(async ({ group, start, end }) => {
    const d = await otherChannels.groupDetail(group, start || '', end || '');
    return {
      group, totals: d.totals,
      상품TOP: (d.products || []).slice(0, 40),
      카테고리: d.byCategory, 충전재등급: d.byBead, 색상: (d.byColor || []).slice(0, 20), 입점몰별: d.subs,
    };
  }));

  server.registerTool('channel_comparison', {
    title: '채널 비교(전년/전월/전주)',
    description: '선택 기간 자사몰·스마트스토어 매출을 전년·전월·전주 동기간과 비교',
    inputSchema: D,
  }, wrap(({ start, end }) => compare.periodCompare(start, end)));

  server.registerTool('monthly_trend', {
    title: '월별 매출 추이(2024~현재)',
    description: '채널별 월 매출 시계열 (자사몰·스마트스토어·합계)',
    inputSchema: {},
  }, wrap(() => compare.monthlySeries('2024-01-01')));

  server.registerTool('discount_analysis', {
    title: '자사몰 할인율 분석 (정상가 대비) [확정집계]',
    description: '기간 Cafe24 품목별 "실판매단가 vs 정상가 → 할인율" + 가중평균 할인율. ' +
      '정상가는 주문이력에서 추출(정상가 불변 전제). 쿠폰 데이터가 없는 기간도 할인 깊이를 산출 — 쿠폰/프로모션 분석을 보완.',
    inputSchema: D,
  }, wrap(({ start, end }) => productPrices.discountAnalysis(start, end)));

  server.registerTool('sales_forecast', {
    title: '판매 예측 — 제품×색상 월평균 [확정집계]',
    description: '이카운트 전체몰 기준 제품×색상 최근 N완료월 월평균 판매수량. search로 품목명/색상 필터(없으면 판매량 상위 60).',
    inputSchema: { months: z.number().int().optional().describe('기준 완료월 수(기본 3)'), search: z.string().optional().describe('품목명/색상 필터') },
  }, wrap(async ({ months, search }) => {
    const m = num(months, 3);
    const r = await forecast.salesForecast({ months: m });
    let items = r.items || [];
    if (search) items = items.filter((x) => (x.name || '').includes(search) || (x.color || '').includes(search));
    return { months: m, total: r.count, count: items.length, items: items.slice(0, 60).map((x) => ({ 품목: x.name, 색상: x.color, 월평균: x.monthlyAvg, 누적: x.total })) };
  }));

  server.registerTool('reorder_plan', {
    title: '발주 판단 — 재고↔판매예측 [확정집계]',
    description: '실시간 재고 vs 판매예측 조인 → 소진예상개월·발주필요·제안수량. 기본은 "발주 필요" 품목만. search=품목명 필터, all=true면 전체. (커버/이너 BOM 반영)',
    inputSchema: { months: z.number().int().optional(), target: z.number().optional().describe('발주 목표 개월수(기본 1)'), search: z.string().optional(), all: z.boolean().optional() },
  }, wrap(async ({ months, target, search, all }) => {
    const m = num(months, 3), tg = num(target, 1);
    const r = await forecast.reorderPlan({ months: m, targetMonths: tg });
    const allItems = Array.isArray(r) ? r : (r.items || r.rows || []);
    let items = allItems;
    if (search) items = items.filter((x) => (x.name || '').includes(search) || (x.color || '').includes(search));
    else if (!all) items = items.filter((x) => x.needOrder);
    items = [...items].sort((a, b) => (a.monthsLeft == null ? 999 : a.monthsLeft) - (b.monthsLeft == null ? 999 : b.monthsLeft));
    return { months: m, targetMonths: tg, 발주필요_품목수: allItems.filter((x) => x.needOrder).length, count: items.length, items: items.slice(0, 80) };
  }));

  server.registerTool('stock_list', {
    title: '실시간 재고 조회',
    description: '현재 실시간 재고(품목코드·품목명·색상·수량 qty). search로 품목명 필터 권장. search 없으면 재고 적은 순 상위 40 + 총개수.',
    inputSchema: { search: z.string().optional().describe('품목명/색상 필터(예: 맥스 커버)') },
  }, wrap(async ({ search }) => {
    const [rows, updatedAt] = await Promise.all([forecast.stockList(), forecast.stockUpdatedAt().catch(() => null)]);
    const items = Array.isArray(rows) ? rows : [];
    const total = items.length;
    // 재고는 ~10분 주기 동기화 — 기준 시각을 함께 반환해 "언제 기준 재고"인지 답변에 명시되게 함
    const base = { total, 재고기준시각: updatedAt, 주의: '재고는 약 10분 주기로 동기화됨 — 재고기준시각 기준 수량(실시간 판매분은 다음 동기화에 반영).' };
    if (search) {
      const f = items.filter((x) => (x.name || '').includes(search) || (x.color || '').includes(search));
      return { ...base, count: f.length, items: f.slice(0, 80) };
    }
    const low = [...items].sort((a, b) => (a.qty || 0) - (b.qty || 0)).slice(0, 40);
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
    inputSchema: { start: z.string().describe('YYYY-MM-DD'), end: z.string().describe('YYYY-MM-DD') },
  }, wrap(async ({ start, end }) => adEfficiency.efficiency(start, end)));

  server.registerTool('ad_vs_sales', {
    title: '광고비 vs 온라인 매출 — 마케팅 비용률·통합 ROAS [교차]',
    description: '기간 총 광고비(adboard)와 실제 온라인 매출(이카운트 자사몰+스마트스토어+외부채널)을 한 번에 비교. ' +
      '마케팅비용률(광고비÷실매출)·벤더별 광고비·광고기여 전환매출(convValue)·광고 ROAS 제공. ' +
      '⚠️ 전환매출(convValue)은 매체가 "광고 기여"로 잡은 값(중복·과대 가능)이고, 실매출은 이카운트 확정 출고 기준이라 둘은 다른 수치임.',
    inputSchema: { start: z.string().describe('YYYY-MM-DD'), end: z.string().describe('YYYY-MM-DD') },
  }, wrap(async ({ start, end }) => {
    const [ad, series] = await Promise.all([
      adEfficiency.efficiency(start, end),
      dailyReport.dailyChannelSeries('2025-01-01').catch(() => []),
    ]);
    const inRange = series.filter((d) => d.Date >= start && d.Date <= end);
    const sales = inRange.reduce((a, d) => a + (d.자사몰 || 0) + (d.스마트스토어 || 0) + (d.외부채널 || 0), 0);
    const spend = ad.total.spend || 0;
    return {
      start, end,
      온라인매출_이카운트: Math.round(sales),         // 자사몰+스토어+외부 (출고 기준, 공동구매 제외)
      총광고비: spend,
      마케팅비용률: sales ? +((spend / sales) * 100).toFixed(2) : null, // 광고비 ÷ 실매출 %
      광고기여_전환매출: ad.total.convValue,           // 매체가 광고 기여로 집계(참고용, 실매출과 다름)
      광고ROAS: ad.total.roas,
      벤더별: ad.vendors.map((v) => ({ 매체: v.platform, 광고비: v.spend, 전환매출: v.convValue, ROAS: v.roas })),
    };
  }));

  server.registerTool('marketing_overview', {
    title: '통합 마케팅 개요 — 광고+온라인+오프라인+트래픽 한 번에 (전사매출·비용률·CAC) [교차]',
    description: '기간 하나로 전사매출(온라인+오프라인 매장)·채널별 매출·광고(매체별 광고비·ROAS)·트래픽(방문·신규가입·구매)을 한 번에 조합. ' +
      '실질 마케팅비용률(온라인 기준+전사 기준)·신규가입당 광고비(CAC)·오프라인 비중까지 제공. ' +
      '"광고 대비 매출", "전사 매출과 광고", "이 기간 마케팅 종합" 질문엔 여러 도구 대신 이 도구 하나로 답할 것. ' +
      '⚠️ 주문 단위 귀속 없음 → 집계 수준 대조. convValue(광고기여)와 실매출은 다른 수치라 합산 금지.',
    inputSchema: { start: z.string().describe('YYYY-MM-DD'), end: z.string().describe('YYYY-MM-DD') },
  }, wrap(async ({ start, end }) => marketing.overview(start, end)));

  server.registerTool('marketing_sales_series', {
    title: '일별 마케팅↔매출 시계열 (광고×온라인×오프라인×회원/비회원×트래픽) [교차·관계분석]',
    description: '기간을 "하루=한 줄"로 정렬한 통합 표. 각 날짜: 매체별 광고비(네이버·메타·크리테오·카카오)·온라인 매출(자사몰·스토어·외부)·**오프라인 매장 매출·전사 합계**·자사몰 회원/비회원·방문·신규가입·구매. ' +
      '광고와 매출(온·오프)의 관계·상관·추세·시차 분석엔 이 도구를 사용 — 여러 도구를 따로 부르지 말 것(날짜 정렬은 서버가 끝냄). ' +
      '⚠️ 주문 단위 광고 귀속 없음 → 상관관계(인과 아님).',
    inputSchema: D,
  }, wrap(({ start, end }) => marketing.series(start, end)));

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
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : undefined); } catch (_) { resolve(undefined); } });
    req.on('error', () => resolve(undefined));
  });

  const syncJobs = require('../lib/syncJobs');
  const authed = (req) => !TOKEN || req.headers['authorization'] === `Bearer ${TOKEN}`;
  const sendJson = (res, code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));

  const httpServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === '/health') { return sendJson(res, 200, { ok: true, server: 'yogibo-sales-mcp' }); }

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
