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
    const rows = await forecast.stockList();
    const items = Array.isArray(rows) ? rows : [];
    const total = items.length;
    if (search) {
      const f = items.filter((x) => (x.name || '').includes(search) || (x.color || '').includes(search));
      return { total, count: f.length, items: f.slice(0, 80) };
    }
    const low = [...items].sort((a, b) => (a.qty || 0) - (b.qty || 0)).slice(0, 40);
    return { total, 안내: '품목명으로 search하면 정확히 조회됩니다. 아래는 재고 적은 순 상위 40.', 재고적은순: low };
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
  const crypto = require('crypto');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
  const PORT = Number(process.env.PORT || process.env.MCP_PORT || 8787);
  const TOKEN = process.env.MCP_TOKEN || '';
  const transports = {};

  const readBody = (req) => new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : undefined); } catch (_) { resolve(undefined); } });
    req.on('error', () => resolve(undefined));
  });

  const httpServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, server: 'yogibo-sales-mcp' })); return; }
    if (u.pathname !== '/mcp') { res.writeHead(404).end('not found'); return; }
    if (TOKEN && req.headers['authorization'] !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' })); return;
    }
    const sid = req.headers['mcp-session-id'];
    try {
      if (req.method === 'POST') {
        const body = await readBody(req);
        let transport;
        if (sid && transports[sid]) {
          transport = transports[sid];
        } else if (!sid && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (id) => { transports[id] = transport; },
          });
          transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
          await build().connect(transport);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: '세션 없음 또는 잘못된 초기화 요청' }, id: null }));
          return;
        }
        await transport.handleRequest(req, res, body);
      } else if (req.method === 'GET' || req.method === 'DELETE') {
        if (!sid || !transports[sid]) { res.writeHead(400).end('세션 없음'); return; }
        await transports[sid].handleRequest(req, res);
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
