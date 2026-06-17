'use strict';

/**
 * 발주 예측 — 이카운트 판매(전체 몰) 기준 제품×색상 월평균 판매수량 → 1개월 예상.
 *   salesForecast({months}) : on.orders 를 (productName,color)로 묶어 최근 N 완료월 월평균 판매수량.
 *   reorderPlan({months,target}) : 실시간 재고(cloudtype API) ↔ 판매예측 조인 → 소진예상·발주필요·제안수량.
 *
 *   '전체 몰' = 이카운트의 모든 store 합(자사몰·스마트스토어·쿠팡·롯데·현대…) — 총수요 기준.
 *   진행중인 당월은 미완료라 제외하고 '완료월'만 평균.
 *   재고 시스템(cloudtype)과 이카운트는 상품명 표기가 달라(어순·본품/커버 등) 자동매칭률이 제한적 →
 *   matched 플래그와 unmatchedSellers(판매는 있는데 재고 매칭 실패)로 투명하게 노출.
 */

const store = require('./store');
const https = require('https');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const tok = (s) => norm(s).split(' ').filter(Boolean).sort().join(' '); // 어순 무시
const sk = (s) => String(s || '').replace(/\s+/g, '');                  // 색상 공백 제거
const joinKey = (name, color) => tok(name) + '|' + sk(color);

const STOCK_BASE = 'https://port-0-realtime-lzgmwhc4d9883c97.sel4.cloudtype.app';
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 오늘(미완료)을 빼고 직전부터 N개 완료월 (최근→과거)
function completeMonths(n, today) {
  const [y, m] = today.split('-').map(Number);
  const out = []; let yy = y, mm = m - 1;
  for (let i = 0; i < n; i++) { if (mm < 1) { mm = 12; yy--; } out.push(`${yy}-${String(mm).padStart(2, '0')}`); mm--; }
  return out;
}
// 재고 카테고리 대응용 제품 성격
function partType(name) {
  const s = String(name || '');
  if (s.includes('커버')) return '커버';
  if (/비즈|리필|충전재|이너/.test(s)) return '충전재';
  return '본품';
}

// 이카운트 전체 몰 — (productName,color)별 최근 N 완료월 월평균 판매수량
async function salesForecast({ months = 3, today } = {}) {
  const ec = await store.namedCollection('on', 'orders');
  const t = today || ymd(new Date());
  const yms = completeMonths(months, t);
  const start = yms[yms.length - 1] + '-01', end = yms[0] + '-31';
  const rows = await ec.aggregate([
    { $match: { date: { $gte: start, $lte: end }, productName: { $nin: [null, ''] } } },
    { $group: { _id: { name: '$productName', color: '$color', ym: { $substr: ['$date', 0, 7] } }, qty: { $sum: '$qty' } } },
  ]).toArray();
  const map = {};
  for (const r of rows) {
    if (!yms.includes(r._id.ym)) continue;
    const name = r._id.name, color = r._id.color || '';
    const k = joinKey(name, color);
    const g = map[k] = map[k] || { key: k, name, color, type: partType(name), byMonth: {} };
    g.byMonth[r._id.ym] = (g.byMonth[r._id.ym] || 0) + N(r.qty);
  }
  const items = Object.values(map).map((g) => {
    const series = yms.map((m) => g.byMonth[m] || 0);
    const total = series.reduce((a, b) => a + b, 0);
    const monthlyAvg = Math.max(0, Math.round((total / months) * 10) / 10);
    return { key: g.key, name: g.name, color: g.color, type: g.type, series, total, monthlyAvg };
  }).sort((a, b) => b.monthlyAvg - a.monthlyAvg);
  return { basis: '이카운트 전체 몰', months: yms, monthsCount: months, count: items.length, items };
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(STOCK_BASE + path, (r) => {
      let b = ''; r.on('data', (c) => (b += c));
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('재고 API 응답 파싱 실패')); } });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('재고 API 시간초과')));
  });
}
// 실시간 재고 (cloudtype) — 프론트와 동일 필터(제외/EPP 제거, 사스→사이너스)
async function stockList() {
  const rows = await getJson('/api/stock/' + encodeURIComponent('전체'));
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((s) => s.category !== '제외' && !String(s.name || '').toUpperCase().includes('EPP'))
    .map((s) => {
      let name = s.name || '';
      if (name.includes('사스')) name = name.replace('사스', '사이너스');
      return { code: s.code, category: s.category, name, color: s.spec === '-' ? '' : (s.spec || ''), qty: N(s.qty) };
    });
}
async function stockUpdatedAt() { try { const j = await getJson('/api/system/last-update'); return (j && j.timestamp) || null; } catch (_) { return null; } }

// 발주 계획 — 재고 ↔ 판매예측 조인
async function reorderPlan({ months = 3, targetMonths = 1, today } = {}) {
  const [fc, stock, updatedAt] = await Promise.all([
    salesForecast({ months, today }),
    stockList().catch(() => null),
    stockUpdatedAt().catch(() => null),
  ]);
  if (stock === null) {
    return { months: fc.months, monthsCount: months, targetMonths, updatedAt, stockError: true, count: 0, matchedCount: 0, needOrderCount: 0, items: [], unmatchedSellers: [] };
  }
  const fcMap = {}; fc.items.forEach((it) => { fcMap[it.key] = it; });
  const usedKeys = new Set();
  const items = stock.map((s) => {
    const k = joinKey(s.name, s.color);
    const f = fcMap[k]; if (f) usedKeys.add(k);
    const monthlyAvg = f ? f.monthlyAvg : 0;
    const monthsLeft = monthlyAvg > 0 ? Math.round((s.qty / monthlyAvg) * 10) / 10 : null;
    const needOrder = monthlyAvg > 0 && s.qty < monthlyAvg * targetMonths;
    const suggestQty = needOrder ? Math.ceil(monthlyAvg * targetMonths - s.qty) : 0;
    return { code: s.code, category: s.category, name: s.name, color: s.color, stock: s.qty, monthlyAvg, expected1m: monthlyAvg, monthsLeft, needOrder, suggestQty, matched: !!f };
  });
  // 판매는 있는데 재고에 매칭 안 된 SKU (이름 표기 불일치 점검 → 별칭 보정용)
  const unmatchedSellers = fc.items
    .filter((it) => it.monthlyAvg > 0 && !usedKeys.has(it.key))
    .map((it) => ({ name: it.name, color: it.color, type: it.type, monthlyAvg: it.monthlyAvg }))
    .sort((a, b) => b.monthlyAvg - a.monthlyAvg);
  return {
    months: fc.months, monthsCount: months, targetMonths, updatedAt, stockError: false,
    count: items.length,
    matchedCount: items.filter((x) => x.matched).length,
    needOrderCount: items.filter((x) => x.needOrder).length,
    items,
    unmatchedSellers: unmatchedSellers.slice(0, 150),
  };
}

module.exports = { salesForecast, reorderPlan, stockList, stockUpdatedAt };
