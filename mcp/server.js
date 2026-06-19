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

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const fail = (e) => ({ content: [{ type: 'text', text: 'ERROR: ' + ((e && e.message) || String(e)) }], isError: true });
const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

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
    title: '스마트스토어 상세 분석',
    description: '기간별 스마트스토어 매출·상품·카테고리·충전재·유입경로·적용쿠폰·할인이벤트·결제패턴',
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
    title: '마케팅채널 유입수(비즈어드바이저)',
    description: '기간 채널별 유입수 합계 (스마트스토어 비즈어드바이저 적재 기준, on.bizInflow)',
    inputSchema: D,
  }, wrap(async ({ start, end }) => {
    const s = await bizadvisor.summary(start, end);
    return { from: s.from, to: s.to, 합계유입: s.grandTotal, 채널별: s.channels.map((c) => ({ 채널: c, 유입수: s.totalsByChannel[c] })) };
  }));

  server.registerTool('other_channels', {
    title: '기타채널 매출(쿠팡·롯데·현대·신세계·오늘의집 등)',
    description: '기간 기타채널 그룹별 매출·주문 (이카운트 집계)',
    inputSchema: D,
  }, wrap(({ start, end }) => otherChannels.overview(start, end)));

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
