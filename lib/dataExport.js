'use strict';

/**
 * 외부 제공용 데이터 export — 오너/외부 분석자가 자기 시스템으로 가져가 가공하는 용도.
 *   4종: sales-online(이카운트 온라인) · sales-offline(오프라인 매장) · ads(광고) · stock(재고)
 *   ✅ 개인정보 없음: 매출은 상품/매장 단위 집계 원장, 재고는 품목 단위 (고객명·연락처·주소 미포함)
 *   출력: JSON 또는 CSV. 실시간 아님 — 매출은 매일 오전 9시, 광고 9시30분, 재고 10분 주기 동기화된 값.
 */

const store = require('./store');
const adEfficiency = require('./adEfficiency');
const forecast = require('./forecast');
const { parsePeriod } = require('./period'); // 기간 자연어 파서 — export API·MCP 공용

const MAX_ROWS = 50000;
const ymd = (s) => String(s || '').slice(0, 10);

// 이카운트 온라인 매출 (on.orders) — 출고일 기준
async function salesOnline(start, end) {
  const c = await store.namedCollection('on', 'orders');
  return c.find({ date: { $gte: ymd(start), $lte: ymd(end) } }, {
    projection: { _id: 0, orderNo: 1, date: 1, store: 1, productName: 1, color: 1, category: 1, beadType: 1, qty: 1, amount: 1, isSet: 1, isCover: 1 },
  }).sort({ date: 1 }).limit(MAX_ROWS).toArray();
}

// 오프라인 매장 매출 (off.orders)
async function salesOffline(start, end) {
  const c = await store.namedCollection('off', 'orders');
  return c.find({ date: { $gte: ymd(start), $lte: ymd(end) } }, {
    projection: { _id: 0, orderNo: 1, date: 1, store: 1, manager: 1, productName: 1, color: 1, category: 1, beadType: 1, qty: 1, amount: 1, isSet: 1, isCover: 1 },
  }).sort({ date: 1 }).limit(MAX_ROWS).toArray();
}

// 광고 (adboard.daily_stats) — 매체×일자
async function ads(start, end) {
  const rows = await adEfficiency.rows(start, end);
  return rows.map((r) => ({
    date: String(r.date).length === 8 ? `${String(r.date).slice(0, 4)}-${String(r.date).slice(4, 6)}-${String(r.date).slice(6, 8)}` : r.date,
    platform: r.platform, spend: r.spend, imp: r.imp, clk: r.clk, conv: r.conv, convValue: r.convValue,
  })).sort((a, b) => a.date.localeCompare(b.date));
}

// 재고 (실시간 동기화본) — 품목×색상
async function stock() {
  const [rows, at] = await Promise.all([forecast.stockList(), forecast.stockUpdatedAt().catch(() => null)]);
  return { updatedAt: at, items: rows.map((r) => ({ code: r.code, name: r.name, color: r.color, category: r.category, qty: r.qty })) };
}

// 자사몰 트래픽 (onlinedata.traffic_daily) — 일별 방문·페이지뷰·가입·구매·매출
async function traffic(start, end) {
  const c = await store.collection('traffic_daily');
  const rows = await c.find({ date: { $gte: ymd(start), $lte: ymd(end) } }, {
    projection: { _id: 0, date: 1, visits: 1, pv: 1, signups: 1, orders: 1, revenue: 1 },
  }).sort({ date: 1 }).limit(MAX_ROWS).toArray();
  return rows.map((r) => ({
    date: r.date, visits: r.visits || 0, pv: r.pv || 0, signups: r.signups || 0,
    purchases: r.orders || 0, revenue: r.revenue || 0,
  }));
}

// 마케팅 채널별 유입수 (on.bizInflow, 네이버 비즈어드바이저) — 일별×채널
async function inflow(start, end) {
  const c = await store.namedCollection('on', 'bizInflow');
  return c.find({ date: { $gte: ymd(start), $lte: ymd(end) } }, {
    projection: { _id: 0, date: 1, channel: 1, inflow: 1 },
  }).sort({ date: 1 }).limit(MAX_ROWS).toArray();
}

// 온라인 목표 (onlinedata.targets, 월별) — long 포맷: (월, 몰, 목표액)
async function targetsOnline(start, end) {
  const ms = ymd(start).slice(0, 7), me = ymd(end).slice(0, 7);
  const c = await store.collection('targets');
  const docs = await c.find({ month: { $gte: ms, $lte: me } }).sort({ month: 1 }).toArray();
  const out = [];
  for (const d of docs) {
    if (d.cafe24 != null) out.push({ month: d.month, mall: '자사몰', target: Number(d.cafe24) || 0 });
    if (d.smartstore != null) out.push({ month: d.month, mall: '스마트스토어', target: Number(d.smartstore) || 0 });
    for (const [mall, v] of Object.entries(d.byMall || {})) out.push({ month: d.month, mall, target: Number(v) || 0 });
  }
  return out;
}

// 오프라인 매장별 목표 (yogibo.jwasu_monthly_targets, 월별) — 매니저 중복 제거(store+month별 max), 월/주차 목표
async function targetsOffline(start, end) {
  const ms = ymd(start).slice(0, 7), me = ymd(end).slice(0, 7);
  const c = await store.namedCollection('yogibo', 'jwasu_monthly_targets');
  const rows = await c.aggregate([
    { $match: { month: { $gte: ms, $lte: me } } },
    { $group: {
      _id: { store: '$storeName', month: '$month' },
      monthlyTarget: { $max: '$targetMonthlySales' },
      w1: { $max: '$targetWeeklySales.w1' }, w2: { $max: '$targetWeeklySales.w2' }, w3: { $max: '$targetWeeklySales.w3' },
      w4: { $max: '$targetWeeklySales.w4' }, w5: { $max: '$targetWeeklySales.w5' }, w6: { $max: '$targetWeeklySales.w6' },
    } },
    { $sort: { '_id.month': 1, '_id.store': 1 } },
  ]).toArray();
  return rows.map((r) => ({
    month: r._id.month, store: r._id.store, monthlyTarget: Number(r.monthlyTarget) || 0,
    w1: Number(r.w1) || 0, w2: Number(r.w2) || 0, w3: Number(r.w3) || 0, w4: Number(r.w4) || 0, w5: Number(r.w5) || 0, w6: Number(r.w6) || 0,
  }));
}

const DATASETS = {
  'sales-online': { fn: salesOnline, range: true, desc: '이카운트 온라인 매출(출고일 기준) — 자사몰/스마트스토어/외부채널 상품 단위' },
  'sales-offline': { fn: salesOffline, range: true, desc: '오프라인 매장 매출 — 매장/판매사원/상품 단위' },
  ads: { fn: ads, range: true, desc: '광고 일별×매체 — 광고비·노출·클릭·전환·전환매출' },
  stock: { fn: stock, range: false, desc: '현재 재고 — 품목×색상 수량(약 10분 주기 동기화)' },
  traffic: { fn: traffic, range: true, desc: '자사몰 트래픽 일별 — 방문(visits)·페이지뷰(pv)·가입(signups)·구매(purchases)·매출(revenue)' },
  inflow: { fn: inflow, range: true, desc: '마케팅 채널별 유입수 일별×채널(네이버 비즈어드바이저) — date/channel/inflow' },
  'targets-online': { fn: targetsOnline, range: true, desc: '온라인 월 목표(자사몰·스마트스토어·기타몰) — month/mall/target, 기간에 걸친 월 반환' },
  'targets-offline': { fn: targetsOffline, range: true, desc: '오프라인 매장별 월/주차 목표 — month/store/monthlyTarget/w1~w6, 기간에 걸친 월 반환' },
};

// CSV 변환 (UTF-8 BOM — 엑셀 한글 대응)
function toCsv(rows) {
  if (!rows.length) return '﻿';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

async function fetchDataset(name, opts = {}) {
  const d = DATASETS[name];
  if (!d) throw new Error(`알 수 없는 dataset: ${name} — 사용 가능: ${Object.keys(DATASETS).join(', ')}`);
  if (d.range) {
    let { start, end } = opts;
    let 기간해석 = null;
    if (opts.period) { const p = parsePeriod(opts.period); start = p.start; end = p.end; 기간해석 = p.label; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
      throw new Error('기간이 필요합니다 — period=<자연어> 또는 start/end=YYYY-MM-DD. 예: period=지난달, period=2026년 7월, period=최근 7일');
    }
    const rows = await d.fn(start, end);
    return {
      dataset: name, start, end, ...(기간해석 ? { 기간해석 } : {}),
      count: rows.length, rows,
      ...(rows.length >= MAX_ROWS ? { note: `상한 ${MAX_ROWS}행 — 기간을 좁혀 재요청하세요` } : {}),
    };
  }
  const r = await d.fn();
  return { dataset: name, ...r, count: (r.items || []).length };
}

function catalog() {
  return {
    datasets: Object.entries(DATASETS).map(([k, v]) => ({ dataset: k, 설명: v.desc, 기간필요: v.range })),
    사용법: 'GET /api/export?dataset=<이름>&period=<자연어>&format=json|csv (헤더: Authorization: Bearer <EXPORT_TOKEN>)',
    기간지정: {
      period: '자연어 기간(권장). start/end 대신 사용',
      'start/end': 'YYYY-MM-DD 직접 지정(기존 방식, 계속 지원)',
      예시: ['어제', '이번주', '지난주', '이번달', '지난달', '올해', '작년',
        '최근 7일', '최근 3개월', '2026년 7월', '2026-07', '7월', '2026년',
        '2026-07-01~2026-07-15', '6월부터', '2026년 5월부터 7월까지'],
      주의: '기준일은 KST. 미래 구간은 오늘까지로 잘림. 응답의 start/end/기간해석 필드로 실제 적용 구간을 확인할 것.',
    },
    주의: '고객 개인정보 미포함(집계 원장만). 실시간 아님 — 매출 매일 09:00, 광고 09:30, 재고 10분 주기 갱신.',
  };
}

module.exports = { fetchDataset, catalog, toCsv, parsePeriod, DATASETS };
