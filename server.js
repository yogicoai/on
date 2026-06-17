'use strict';

/**
 * Cafe24 판매 분석 대시보드 서버 (무프레임워크 http).
 *   GET /                     대시보드
 *   GET /api/overview         ?start&end&force  — 유입/회원·비회원/프로모션 종합 (DB 캐시)
 *   GET /api/health           상태/설정 확인
 *   GET /api/cache            캐시 목록(디버그)
 * 파라미터 없으면 기본 구간 = 어제(전날).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./lib/env');
loadEnv();

const report = require('./lib/report');
const store = require('./lib/store');
const cafe24 = require('./lib/cafe24');
const ingest = require('./lib/ingest');
const catalog = require('./lib/catalog');
const promotions = require('./lib/promotions');
const couponsLib = require('./lib/coupons');
const tagPromotions = require('./lib/tagPromotions');
const patterns = require('./lib/patterns');
const productAnalysis = require('./lib/productAnalysis');
const analytics = require('./lib/analytics');
const segments = require('./lib/segments');
const target = require('./lib/target');
const promoPeriods = require('./lib/promoPeriods');
const compare = require('./lib/compare');
const benefit = require('./lib/benefit');
const smartstore = require('./lib/smartstore');
const smartstoreIngest = require('./lib/smartstoreIngest');
const smartstoreAnalysis = require('./lib/smartstoreAnalysis');
const otherChannels = require('./lib/otherChannels');
const dailySync = require('./lib/dailySync');
const mallPromos = require('./lib/mallPromotions');
const cafe24Products = require('./lib/cafe24Products');
const products = require('./lib/products');
const promoPerformance = require('./lib/promoPerformance');
const cafe24Coupons = require('./lib/cafe24Coupons');
const ai = require('./lib/ai');

const PORT = Number(process.env.PORT || 5200);
const PUBLIC = path.join(__dirname, 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// CSV 다운로드 (UTF-8 BOM → 엑셀 한글 깨짐 방지)
function sendCsv(res, filename, headers, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(esc).join(',')].concat(rows.map((r) => r.map(esc).join(',')));
  const body = '﻿' + lines.join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  res.end(body);
}

const Y = () => report.yesterdayStr();

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    // app.js/style.css/index.html 은 자주 바뀌므로 브라우저 캐시 방지(항상 최신 로드 → stale 화면 방지)
    const noCache = ['.js', '.css', '.html'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);

  // 읽기 전용 배포(Vercel)에서는 수집·동기화·설정 변경을 비활성화
  if (process.env.READ_ONLY === '1') {
    const WRITE = new Set(['/api/refresh-week', '/api/refresh-today', '/api/sync-today', '/api/daily-sync', '/api/sync-month', '/api/sync-coupon-names', '/api/ingest', '/api/smartstore/sync-month', '/api/smartstore/sync-week', '/api/target/set', '/api/target/mall/set', '/api/promo-periods/set', '/api/promo-periods/delete', '/api/promotions/set', '/api/promotions/delete']);
    if (req.method === 'POST' || WRITE.has(u.pathname)) {
      return sendJson(res, 403, { ok: false, error: '읽기 전용 배포입니다. 수집·동기화·설정 변경은 로컬에서 실행하세요.' });
    }
  }

  if (u.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true, mall: cafe24.MALL, apiVersion: cafe24.API_VERSION,
      tokenSource: cafe24.enabled() ? 'mongo(읽기전용)' : '미설정',
      cacheDb: store.configured() ? store.DB_NAME : '미설정',
      staleMin: report.STALE_MIN, today: report.todayStr(), yesterday: report.yesterdayStr(),
    });
  }

  if (u.pathname === '/api/cache') {
    try { return sendJson(res, 200, { ok: true, items: await store.listCache() }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // 최근 N일(오늘~N일 전) 재취합: 겹치는 캐시 삭제 후 라이브 강제 재집계
  if (u.pathname === '/api/refresh-week') {
    const days = Math.min(Number(u.searchParams.get('days') || report.REFRESH_DAYS), 7); // 최대 1주일
    const t0 = Date.now();
    console.log(`[${new Date().toISOString()}] /api/refresh-week days=${days}`);
    try {
      const data = await report.refreshRecent(days);
      data.elapsedMs = Date.now() - t0;
      console.log(`  → ${data.start}~${data.end} 캐시 ${data.deleted}건 삭제 후 재집계 (${data.elapsedMs}ms)`);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      console.error('refresh-week 실패:', e);
      return sendJson(res, 500, { ok: false, error: String(e.message) });
    }
  }

  // 오늘만 재취합 — 오늘 주문 적재(Cafe24+SmartStore) + 오늘 포함 구간 빠른 갱신(쿠폰 funnel 은 캐시 유지)
  if (u.pathname === '/api/sync-today' || u.pathname === '/api/refresh-today') {
    const t0 = Date.now();
    console.log(`[${new Date().toISOString()}] /api/sync-today`);
    try {
      const data = await dailySync.runToday();
      data.elapsedMs = Date.now() - t0;
      console.log(`  → 오늘 재취합 완료 (${data.elapsedMs}ms)`);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      console.error('sync-today 실패:', e);
      return sendJson(res, 500, { ok: false, error: String(e.message) });
    }
  }

  // 수동 일일 동기화(최근 N일 적재 + 워밍) — 스케줄러와 동일 루틴을 즉시 1회 실행
  if (u.pathname === '/api/daily-sync') {
    const days = Math.min(Number(u.searchParams.get('days') || 7), 31);
    const t0 = Date.now();
    console.log(`[${new Date().toISOString()}] /api/daily-sync days=${days}`);
    try {
      const data = await dailySync.runDaily({ days });
      data.elapsedMs = Date.now() - t0;
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      console.error('daily-sync 실패:', e);
      return sendJson(res, 500, { ok: false, error: String(e.message) });
    }
  }

  if (u.pathname === '/api/overview') {
    const y = report.yesterdayStr();
    const start = u.searchParams.get('start') || y;
    const end = u.searchParams.get('end') || y;
    const force = u.searchParams.get('force') === '1';
    const forceFunnel = u.searchParams.get('funnel') === '1'; // '지금 집계' — 무거운 쿠폰 funnel 즉시 스캔(1~2분)
    const t0 = Date.now();
    console.log(`[${new Date().toISOString()}] /api/overview ${start}~${end}${force ? ' (force)' : ''}${forceFunnel ? ' (funnel)' : ''}`);
    try {
      // 평소 force(↻ 갱신)는 주문만 재집계, funnel 은 캐시 유지. funnel=1 일 때만 쿠폰 스캔까지 강제.
      const data = await report.getOverview(start, end, { force: force || forceFunnel, forceFunnel });
      data.elapsedMs = Date.now() - t0;
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      console.error('overview 실패:', e);
      return sendJson(res, 500, { ok: false, error: String(e.message) });
    }
  }

  // ── 월 목표 달성률 (채널별) ──
  if (u.pathname === '/api/target') {
    try { return sendJson(res, 200, { ok: true, ...(await target.targetStatus(u.searchParams.get('month'))) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/target/list') {
    try { return sendJson(res, 200, { ok: true, items: await target.listTargets() }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/target/set' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const saved = await target.setTarget(b.month, b.cafe24, b.smartstore);
      return sendJson(res, 200, { ok: true, saved });
    } catch (e) { return sendJson(res, 400, { ok: false, error: String(e.message) }); }
  }
  // 몰별 목표(달성률 포함) — 자사몰·스마트스토어 + 기타 채널 그룹
  if (u.pathname === '/api/target/mall') {
    try { return sendJson(res, 200, { ok: true, ...(await target.mallTargetStatus(u.searchParams.get('month'), u.searchParams.get('mall'))) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/target/mall/set' && req.method === 'POST') {
    try { const b = await readBody(req); return sendJson(res, 200, { ok: true, saved: await target.setMallTarget(b.month, b.mall, b.amount) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: String(e.message) }); }
  }
  // ── 통합 비교 ──
  if (u.pathname === '/api/compare/period') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await compare.periodCompare(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/compare/best') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await compare.bestProducts(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/compare/category-promo') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await compare.categoryPromo(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 통합분석 ① 프로모션 매출 — 그 기간 진행 전 몰 프로모션 + 채널·프로모션명별 성과
  if (u.pathname === '/api/compare/promo-performance') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await promoPerformance.allForPeriod(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 카테고리 성과 드릴다운 — 그 카테고리의 상품별 매출(자사몰)
  if (u.pathname === '/api/compare/category-products') {
    const cat = u.searchParams.get('cat') || '';
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    if (!cat) return sendJson(res, 400, { ok: false, error: 'cat 필요' });
    try { return sendJson(res, 200, { ok: true, ...(await compare.categoryProducts(cat, start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/compare/promos') {
    try { return sendJson(res, 200, { ok: true, ...(await compare.promoCompare()) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 트래픽 전환 — 선택 기간 일별(방문/PV/구매/가입) + 요일평균 + Top10
  if (u.pathname === '/api/traffic/daily') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await analytics.trafficDaily(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 일일 점검: 선택일의 '같은 요일 평균' 대비 방문수·일일매출 (평균 미달 시 경고용)
  if (u.pathname === '/api/cafe24/daily-health') {
    try { return sendJson(res, 200, { ok: true, ...(await analytics.dailyHealth(u.searchParams.get('date'), u.searchParams.get('weeks'))) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 트래픽 월별 (2025-01~현재) — 방문/가입 전년 동월 비교(YoY)
  if (u.pathname === '/api/traffic/monthly') {
    const start = u.searchParams.get('start') || '2025-01-01';
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await analytics.trafficMonthly(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 월별 매출 시계열 (몰별, 2024-01~현재) — 전년 동월 비교(YoY)용. 2024 백필로 2025 YoY 비교 가능.
  if (u.pathname === '/api/compare/monthly') {
    const start = u.searchParams.get('start') || '2024-01-01';
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await compare.monthlySeries(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 월별 충전재(등급)별 매출 시계열 (2024-01~현재)
  if (u.pathname === '/api/compare/monthly-tier') {
    const start = u.searchParams.get('start') || '2024-01-01';
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await compare.monthlyTierSeries(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // ── 기타 채널(이카운트) — on.orders 직접 집계 ──
  if (u.pathname === '/api/other/overview') {
    const start = u.searchParams.get('start') || '';
    const end = u.searchParams.get('end') || '';
    try { return sendJson(res, 200, { ok: true, ...(await otherChannels.overview(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 기타 채널 그룹별 전주/전월/전년 비교 (통합비교 표용)
  if (u.pathname === '/api/other/period-compare') {
    const start = u.searchParams.get('start') || '';
    const end = u.searchParams.get('end') || '';
    try { return sendJson(res, 200, { ok: true, ...(await otherChannels.groupsPeriodCompare(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 그룹 카테고리/충전재 → 상품 상세 (드릴다운)
  if (u.pathname === '/api/other/group-breakdown') {
    const group = u.searchParams.get('group') || '';
    const field = u.searchParams.get('field') || 'category';
    const value = u.searchParams.get('value') || '';
    const start = u.searchParams.get('start') || '';
    const end = u.searchParams.get('end') || '';
    if (!group) return sendJson(res, 400, { ok: false, error: 'group 필요' });
    try { return sendJson(res, 200, { ok: true, ...(await otherChannels.groupBreakdownProducts(group, field, value, start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/other/group') {
    const group = u.searchParams.get('group') || '';
    const start = u.searchParams.get('start') || '';
    const end = u.searchParams.get('end') || '';
    if (!group) return sendJson(res, 400, { ok: false, error: 'group 파라미터 필요' });
    try { return sendJson(res, 200, { ok: true, ...(await otherChannels.groupDetail(group, start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/other/channel') {
    const storeName = u.searchParams.get('store') || '';
    const start = u.searchParams.get('start') || '';
    const end = u.searchParams.get('end') || '';
    if (!storeName) return sendJson(res, 400, { ok: false, error: 'store 파라미터 필요' });
    try { return sendJson(res, 200, { ok: true, ...(await otherChannels.channelDetail(storeName, start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // 상품별 판매량 (몰별, 매출순 Top N)
  if (u.pathname === '/api/compare/product-by-channel') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    const limit = Math.max(10, Math.min(100, Number(u.searchParams.get('limit') || 40)));
    try { return sendJson(res, 200, { ok: true, ...(await compare.productByChannel(start, end, limit)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 트래픽 전환 + 충전재별 판매량 (몰별)
  if (u.pathname === '/api/compare/extra') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try {
      const [traffic, tiers] = await Promise.all([compare.traffic(start, end), compare.tierByChannel(start, end)]);
      return sendJson(res, 200, { ok: true, traffic, tiers });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // 성장 Top10 — 전년비/전월비 성장률 상위 상품 (자사+스토어)
  if (u.pathname === '/api/compare/growth') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await compare.growthTop(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 충전재(비즈타입) 현재/전월/전년 3기간 동시 비교
  if (u.pathname === '/api/compare/tier-3period') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await compare.tierPeriods(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 리퍼(refurb) 전용 분석 — Top10 + 월별/일자별 추이
  if (u.pathname === '/api/compare/refurb') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await compare.refurb(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // ── 월별 전사 프로모션 기간 ──
  if (u.pathname === '/api/promo-periods/list') {
    try { return sendJson(res, 200, { ok: true, items: await promoPeriods.listPromos() }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/promo-periods/set' && req.method === 'POST') {
    try { const b = await readBody(req); return sendJson(res, 200, { ok: true, saved: await promoPeriods.setPromo(b.month, b.name, b.start, b.end) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/promo-periods/delete' && req.method === 'POST') {
    try { const b = await readBody(req); await promoPeriods.deletePromo(b.month); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: String(e.message) }); }
  }

  // ── 몰별 프로모션 (몰·상품·할인율) — 전사 promo_periods 대체 ──
  if (u.pathname === '/api/promotions/list') {
    try { return sendJson(res, 200, { ok: true, items: await mallPromos.listPromotions(u.searchParams.get('mall') || '') }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/promotions/set' && req.method === 'POST') {
    try { const b = await readBody(req); return sendJson(res, 200, { ok: true, saved: await mallPromos.setPromotion(b) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/promotions/delete' && req.method === 'POST') {
    try { const b = await readBody(req); await mallPromos.deletePromotion(b.id); return sendJson(res, 200, { ok: true }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: String(e.message) }); }
  }
  // 프로모션 성과 — 등록 프로모션 상품이 기간 내 실제 얼마나 팔렸는지(몰별 매칭)
  if (u.pathname === '/api/promotions/performance') {
    try { return sendJson(res, 200, { ok: true, ...(await promoPerformance.forMall(u.searchParams.get('mall') || '')) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 자사몰: 그 기간 Cafe24 쿠폰 목록(혜택·대상상품 + 사용 주문수) — 프로모션 편집기 '쿠폰 불러오기'용
  if (u.pathname === '/api/cafe24/coupons') {
    const start = u.searchParams.get('start') || '';
    const end = u.searchParams.get('end') || '';
    try { return sendJson(res, 200, { ok: true, ...(await cafe24Coupons.listCoupons(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 자사몰: 프로모션별 쿠폰기준 성과 — start/end 주면 '프로모션 기간 ∩ 분석구간'으로 집계
  if (u.pathname === '/api/promotions/coupon-performance') {
    const start = u.searchParams.get('start') || '';
    const end = u.searchParams.get('end') || '';
    try { return sendJson(res, 200, { ok: true, ...(await cafe24Coupons.forMallCoupons(u.searchParams.get('mall') || '', start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 단일 프로모션 전체기간(또는 지정구간) 쿠폰성과 — '프로모션 기간 매출 확인' 버튼
  if (u.pathname === '/api/promotions/coupon-perf-one') {
    const id = u.searchParams.get('id') || '';
    if (!id) return sendJson(res, 400, { ok: false, error: 'id 필요' });
    try { return sendJson(res, 200, { ok: true, ...(await cafe24Coupons.couponPerfForPromo(id, u.searchParams.get('start') || '', u.searchParams.get('end') || '')) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // ── AI 판매 분석 (Claude API, mkboard 방식) — GET 으로 두어 읽기전용 배포에서도 동작 ──
  if (u.pathname === '/api/ai/status') {
    return sendJson(res, 200, { ok: true, enabled: ai.enabled(), model: ai.model() });
  }
  if (u.pathname === '/api/ai/ask') {
    const q = u.searchParams.get('q') || '';
    const start = u.searchParams.get('start') || '';
    const end = u.searchParams.get('end') || '';
    if (!q.trim()) return sendJson(res, 400, { ok: false, error: '질문을 입력하세요' });
    try { return sendJson(res, 200, { ok: true, ...(await ai.ask(q, start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // ── Cafe24 상품 검색 (프로모션 대상 선택용) ──
  if (u.pathname === '/api/cafe24/products/search') {
    try { return sendJson(res, 200, { ok: true, items: await cafe24Products.search(u.searchParams.get('q') || '', u.searchParams.get('limit')) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // ── 통합 상품 검색 (몰별: Cafe24/스마트스토어 + 카탈로그 누적, offset 페이지네이션) ──
  if (u.pathname === '/api/products/search') {
    try { return sendJson(res, 200, { ok: true, ...(await products.search(u.searchParams.get('q') || '', u.searchParams.get('mall') || '', u.searchParams.get('limit'), u.searchParams.get('offset'))) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // ── MD 데이터: 주문 거울 적재 ──
  if (u.pathname === '/api/ingest') {
    const months = Math.min(Number(u.searchParams.get('months') || 12), 24);
    console.log(`[${new Date().toISOString()}] /api/ingest months=${months}`);
    try {
      const meta = await ingest.syncOrders(months);
      return sendJson(res, 200, { ok: true, ...meta });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 이번 달(또는 ?ym=YYYY-MM) 주문 동기화
  if (u.pathname === '/api/sync-month') {
    const ym = u.searchParams.get('ym') || undefined;
    console.log(`[${new Date().toISOString()}] /api/sync-month ${ym || '(이번 달)'}`);
    try { return sendJson(res, 200, { ok: true, ...(await ingest.syncMonth(ym)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 주문→사용쿠폰명 매핑 적재 (order_coupons) — ⑤ 적립금·쿠폰 드릴다운용
  if (u.pathname === '/api/sync-coupon-names') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    console.log(`[${new Date().toISOString()}] /api/sync-coupon-names ${start}~${end}`);
    try {
      const r = await couponsLib.syncCouponNames(start, end, { onProgress: (p) => { if (p.done % 50 === 0) console.log(`  쿠폰명 적재 ${p.done}/${p.total} · 매핑주문 ${p.orders}`); } });
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // ── 스마트스토어(네이버 커머스) ──
  if (u.pathname === '/api/smartstore/status') {
    try {
      const st = await smartstoreIngest.syncStatus();
      return sendJson(res, 200, { ok: true, enabled: smartstore.enabled(), ...st });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/smartstore/analysis') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await smartstoreAnalysis.analyze(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/smartstore/payment') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await smartstoreAnalysis.paymentAnalysis(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/smartstore/detail') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    const kind = u.searchParams.get('kind') || '';
    const value = u.searchParams.get('value') || '';
    try { return sendJson(res, 200, { ok: true, ...(await smartstoreAnalysis.detailOrders(start, end, kind, value)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/smartstore/biz-promote' || u.pathname === '/api/smartstore/biz-promote.csv') {
    const months = Number(u.searchParams.get('months') || 3);
    try {
      const data = await smartstoreAnalysis.bizPromote(months);
      if (u.pathname.endsWith('.csv')) {
        const H = ['주문자ID', '이름', '연락처', '본품구매일', '경과개월', '구매본품'];
        const rows = data.rows.map((r) => [r.orderer_id, r.name, r.tel, r.mainDate, r.monthsSince, (r.products || []).join(' / ')]);
        return sendCsv(res, `스마트스토어_비즈유도_${months}개월_${report.todayStr()}.csv`, H, rows);
      }
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/smartstore/line-tier') {
    const line = u.searchParams.get('line') || '';
    const tier = u.searchParams.get('tier') || '';
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await smartstoreAnalysis.lineTierProducts(start, end, line, tier)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/smartstore/sync-month') {
    if (!smartstore.enabled()) return sendJson(res, 400, { ok: false, error: '네이버 커머스 자격증명 미설정(.env NAVER_COMMERCE_CLIENT_ID/SECRET)' });
    const ym = u.searchParams.get('ym') || undefined;
    console.log(`[${new Date().toISOString()}] /api/smartstore/sync-month ${ym || '(이번 달)'}`);
    try { return sendJson(res, 200, { ok: true, ...(await smartstoreIngest.syncMonth(ym)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 최근 N일(기본 7일) 동기화 — 월 동기화보다 API 호출 적음
  if (u.pathname === '/api/smartstore/sync-week') {
    if (!smartstore.enabled()) return sendJson(res, 400, { ok: false, error: '네이버 커머스 자격증명 미설정(.env NAVER_COMMERCE_CLIENT_ID/SECRET)' });
    const days = Math.max(1, Math.min(31, Number(u.searchParams.get('days') || 7)));
    const endD = new Date();
    const startD = new Date(); startD.setDate(startD.getDate() - (days - 1));
    const pad2 = (n) => String(n).padStart(2, '0');
    const f = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    console.log(`[${new Date().toISOString()}] /api/smartstore/sync-week ${f(startD)}~${f(endD)} (${days}일)`);
    try { return sendJson(res, 200, { ok: true, days, ...(await smartstoreIngest.syncRange(f(startD), f(endD))) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  if (u.pathname === '/api/ingest/status') {
    try { return sendJson(res, 200, { ok: true, ...(await ingest.syncStatus()) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/groups') {
    try { return sendJson(res, 200, { ok: true, groups: await segments.listGroups() }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // ── 프로모션 구매 고객 성과 ──
  if (u.pathname === '/api/promotions') {
    const start = u.searchParams.get('start') || report.todayStr().slice(0, 8) + '01';
    const end = u.searchParams.get('end') || Y();
    try {
      const data = await promotions.couponPerformance(start, end);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // ── 특정 쿠폰의 구매 고객 명단 (JSON / CSV) ──
  if (u.pathname === '/api/coupon-buyers' || u.pathname === '/api/coupon-buyers.csv') {
    const couponNo = u.searchParams.get('coupon_no');
    const start = u.searchParams.get('start') || report.todayStr().slice(0, 8) + '01';
    const end = u.searchParams.get('end') || Y();
    if (!couponNo) return sendJson(res, 400, { ok: false, error: 'coupon_no 필요' });
    try {
      const data = await promotions.couponBuyers(couponNo, start, end);
      if (u.pathname.endsWith('.csv')) {
        const H = ['회원ID', '이름', '연락처', '이메일', '가입일', '가입개월', '등급', '구분', '주문수', '구매액', '사용일', '구매상품'];
        const rows = data.rows.map((r) => [r.member_id, r.name, r.cellphone, r.email, r.created_date, r.tenureMonths, r.group_no, r.segment, r.orders, r.amount, r.usedDate, (r.products || []).join(' / ')]);
        return sendCsv(res, `프로모션구매고객_${couponNo}_${start}_${end}.csv`, H, rows);
      }
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 자사몰: 쿠폰 사용(coupon_discount>0) 구매 고객 명단 — 사용 쿠폰명 포함 (JSON / CSV)
  if (u.pathname === '/api/cafe24/coupon-used-buyers' || u.pathname === '/api/cafe24/coupon-used-buyers.csv') {
    const start = u.searchParams.get('start') || report.todayStr().slice(0, 8) + '01';
    const end = u.searchParams.get('end') || Y();
    try {
      const data = await promotions.couponUsedBuyers(start, end);
      if (u.pathname.endsWith('.csv')) {
        const H = ['이름', '회원ID', '연락처', '이메일', '가입일', '등급', '구분', '주문수', '구매액', '쿠폰할인', '사용 쿠폰', '구매상품', '최근구매일'];
        const rows = data.rows.map((r) => [r.name, r.member_id, r.cellphone, r.email, r.created_date, r.group_no, r.segment, r.orders, r.amount, r.couponDiscount, (r.coupons || []).join(' | '), (r.products || []).slice(0, 5).join(', '), r.lastDate]);
        return sendCsv(res, `쿠폰사용구매고객_${start}_${end}.csv`, H, rows);
      }
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // ── 상품태그 프로모션 ([클리어런스]/[공동구매]...) 매출 집계 (JSON / CSV) ──
  if (u.pathname === '/api/tag-promotions' || u.pathname === '/api/tag-promotions.csv') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try {
      const data = await tagPromotions.tagPromotionSales(start, end);
      if (u.pathname.endsWith('.csv')) {
        const H = ['프로모션태그', '매출', '수량', '주문수', '기간할인', '쿠폰할인', '총할인', '상품종수'];
        const rows = data.tags.map((t) => [t.tag, t.sales, t.qty, t.orders, t.directDiscount, t.couponDiscount, t.totalDiscount, t.productCount]);
        return sendCsv(res, `상품태그프로모션_${start}_${end}.csv`, H, rows);
      }
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 특정 태그 상세 — 상품별 + 일별 (집계)
  if (u.pathname === '/api/tag-detail') {
    const tag = u.searchParams.get('tag');
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    if (!tag) return sendJson(res, 400, { ok: false, error: 'tag 필요' });
    try { return sendJson(res, 200, { ok: true, ...(await tagPromotions.tagPromotionDetail(tag, start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 특정 태그 구매 고객 명단 (드릴다운, JSON / CSV)
  if (u.pathname === '/api/tag-buyers' || u.pathname === '/api/tag-buyers.csv') {
    const tag = u.searchParams.get('tag');
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    if (!tag) return sendJson(res, 400, { ok: false, error: 'tag 필요' });
    try {
      const data = await tagPromotions.tagPromotionBuyers(tag, start, end);
      if (u.pathname.endsWith('.csv')) {
        const H = ['회원ID', '이름', '연락처', '이메일', '가입일', '가입개월', '등급', '구분', '주문수', '구매액', '구매상품'];
        const rows = data.rows.map((r) => [r.member_id, r.name, r.cellphone, r.email, r.created_date, r.tenureMonths, r.group_no, r.segment, r.orders, r.amount, (r.products || []).join(' / ')]);
        return sendCsv(res, `태그구매고객_${tag}_${start}_${end}.csv`, H, rows);
      }
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  // 상품 분석 — 카테고리/충전재/제품TOP/색상/요일 + CVR
  if (u.pathname === '/api/product-analysis') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try {
      const data = await productAnalysis.analyze(start, end);
      // CVR = 구매건수 / 방문수
      let visits = 0;
      try { const v = await analytics.dailyVisitors(start, end, 'total'); visits = v.reduce((a, r) => a + (r.visits || 0), 0); } catch (_) {}
      data.kpis.visits = visits;
      data.kpis.cvr = visits ? data.kpis.orders / visits : 0;
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // 제품라인 × 충전재 셀 클릭 → 판매 제품 상세
  if (u.pathname === '/api/line-tier') {
    const line = u.searchParams.get('line') || '';
    const tier = u.searchParams.get('tier') || '';
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await productAnalysis.lineTierProducts(start, end, line, tier)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // 적립금/쿠폰 사용 분류 + 공동구매 주문
  if (u.pathname === '/api/benefit') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await benefit.benefitUsage(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/benefit-orders') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    const type = u.searchParams.get('type') || '';
    try { return sendJson(res, 200, { ok: true, ...(await benefit.benefitOrders(start, end, type)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }
  if (u.pathname === '/api/groupbuy') {
    const start = u.searchParams.get('start') || (report.todayStr().slice(0, 8) + '01');
    const end = u.searchParams.get('end') || Y();
    try { return sendJson(res, 200, { ok: true, ...(await benefit.groupBuy(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // 구매 패턴 — 커버 동시구매(attach) / 주문구성(단품·묶음)
  if (u.pathname === '/api/patterns') {
    const start = u.searchParams.get('start') || null;
    const end = u.searchParams.get('end') || null;
    try { return sendJson(res, 200, { ok: true, ...(await patterns.purchasePatterns(start, end)) }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // ── 비즈 구매 유도 고객 (본품 구매 후 N개월·비즈 미구매) JSON / CSV ──
  if (u.pathname === '/api/biz-promote' || u.pathname === '/api/biz-promote.csv') {
    const months = Number(u.searchParams.get('months') || 3);
    const force = u.searchParams.get('fresh') === '1';
    try {
      const data = await segments.bizPromote(months, { force });
      if (u.pathname.endsWith('.csv')) {
        const H = ['회원ID', '이름', '연락처', '이메일', '마케팅수신', 'SMS수신', '이메일수신', '가입일', '가입개월', '등급', '본품구매일', '경과개월', '구매본품'];
        const rows = data.rows.map((r) => [r.member_id, r.name, r.cellphone, r.email, r.marketing, r.smsAgree ? 'Y' : 'N', r.mailAgree ? 'Y' : 'N', r.created_date, r.tenureMonths, r.group_no, r.mainDate, r.monthsSince, (r.products || []).join(' / ')]);
        return sendCsv(res, `비즈유도고객_${months}개월_${report.todayStr()}.csv`, H, rows);
      }
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  // ── 상품그룹 세그먼트 (JSON / CSV) ──
  if (u.pathname === '/api/segment' || u.pathname === '/api/segment.csv') {
    const group = u.searchParams.get('group') || '커버';
    const mode = u.searchParams.get('mode') === 'only' ? 'only' : 'bought';
    const tenureMonths = Number(u.searchParams.get('tenure') || 0);
    const start = u.searchParams.get('start') || null;
    const end = u.searchParams.get('end') || null;
    try {
      const data = await segments.segmentByGroup(group, { mode, tenureMonths, start, end, withPII: true });
      if (u.pathname.endsWith('.csv')) {
        const H = ['회원ID', '이름', '연락처', '이메일', '가입일', '가입개월', '등급', '주문수', '총구매액', '첫주문', '최근주문', '구매상품'];
        const rows = data.rows.map((r) => [r.member_id, r.name, r.cellphone, r.email, r.created_date, r.tenureMonths, r.group_no, r.orders, r.spend, r.firstDate, r.lastDate, (r.products || []).join(' / ')]);
        return sendCsv(res, `세그먼트_${group}_${mode}_${tenureMonths}m.csv`, H, rows);
      }
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message) }); }
  }

  if (u.pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'unknown api route' });
  return serveStatic(res, u.pathname);
}

// 매일 00시(로컬=KST) 자동 동기화 스케줄러 — 의존성 없이 setTimeout 으로 다음 자정까지 대기 후 24h 반복.
//  ENABLE_DAILY_SYNC=1 인 항상 켜진 호스트(ychat 등)에서만 켠다. 배포(Vercel/READ_ONLY)에선 절대 켜지 말 것.
function msUntilNextMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 10); // 00:00:10
  return next.getTime() - now.getTime();
}
function startDailyScheduler() {
  if (process.env.ENABLE_DAILY_SYNC !== '1') return;
  if (process.env.READ_ONLY === '1') { console.log('[scheduler] READ_ONLY 이므로 자동 동기화 비활성'); return; }
  const days = Number(process.env.DAILY_SYNC_DAYS || 7);
  const run = async () => {
    try { console.log(`[scheduler] 00시 자동 동기화 시작 (최근 ${days}일)`); await dailySync.runDaily({ days }); }
    catch (e) { console.error('[scheduler] 자동 동기화 실패:', e.message); }
  };
  const schedule = () => {
    const wait = msUntilNextMidnight();
    console.log(`[scheduler] 다음 자동 동기화까지 ${(wait / 3600000).toFixed(1)}시간`);
    setTimeout(async () => { await run(); schedule(); }, wait); // 매 자정마다 재예약
  };
  if (process.env.DAILY_SYNC_ON_BOOT === '1') run(); // 기동 직후 1회(옵션)
  schedule();
}

const server = http.createServer(handle);
// 로컬에서 직접 실행할 때만 리슨 (Next/Vercel에서 require 시에는 서버를 띄우지 않음)
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n🟢 Cafe24 분석 대시보드  →  http://localhost:${PORT}`);
    console.log(`   mall=${cafe24.MALL} | 캐시DB=${store.configured() ? store.DB_NAME : '미설정'} | 기본구간=어제(${report.yesterdayStr()})\n`);
    startDailyScheduler();
  });
}

module.exports = { handle };
