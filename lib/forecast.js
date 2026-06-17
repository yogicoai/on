'use strict';

/**
 * 발주 예측 — 이카운트 판매(전체 몰) 기준 제품×색상 월평균 판매수량 → 1개월 예상.
 *   salesForecast({months})       : on.orders 를 (productName,color)로 묶어 최근 N 완료월 월평균 판매수량.
 *   reorderPlan({months,target})  : 판매예측 → 품목코드 → 실시간 재고 조인 → 소진예상·발주필요·제안수량.
 *
 *   ── 품목코드 다리 ──
 *   on.orders(판매)·재고·매핑은 표기가 제각각이지만 '품목코드(ecount_code)'가 공통키.
 *   Cafe24×이카운트 매핑(offorder API)의 ecount_name/spec 은 "한글 / English" 병기인데,
 *   판매 적재(parseProduct)는 ' / ' 뒤를 잘라 한글만 쓴다 → 매핑도 같은 strip 적용하면 판매와 일치.
 *   판매 (name,color) → strip-정규화 매핑 → 품목코드 → 재고(코드 보유, 96% 일치) 로 정확 조인.
 *   검증: 판매수량 가중 ~88% 코드 태깅·재고 연결 (이름매칭 39% → 88%).
 */

const store = require('./store');
const https = require('https');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const tok = (s) => norm(s).split(' ').filter(Boolean).sort().join(' '); // 어순 무시
const sk = (s) => String(s || '').replace(/\s+/g, '');                  // 공백 제거
const stripSlash = (s) => String(s || '').split('/')[0].trim();         // "한글 / English" → "한글"

const STOCK_HOST = 'port-0-realtime-lzgmwhc4d9883c97.sel4.cloudtype.app'; // 실시간 재고
const MAP_HOST = 'port-0-offorder-lzgmwhc4d9883c97.sel4.cloudtype.app';   // Cafe24×이카운트 매핑
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function getJson(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://' + host + path, (r) => {
      let b = ''; r.on('data', (c) => (b += c));
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('API 응답 파싱 실패(' + host + ')')); } });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('API 시간초과(' + host + ')')));
  });
}

// 오늘(미완료)을 빼고 직전부터 N개 완료월 (최근→과거)
function completeMonths(n, today) {
  const [y, m] = today.split('-').map(Number);
  const out = []; let yy = y, mm = m - 1;
  for (let i = 0; i < n; i++) { if (mm < 1) { mm = 12; yy--; } out.push(`${yy}-${String(mm).padStart(2, '0')}`); mm--; }
  return out;
}
function partType(name) {
  const s = String(name || '');
  if (s.includes('커버')) return '커버';
  if (/비즈|리필|충전재|이너/.test(s)) return '충전재';
  return '본품';
}
// 커버/이너 수요는 '등급'(프리미엄/플러스/스탠다드/EPP)·'커버'·'이너' 토큰을 떼어 같은 제품으로 본다.
//   예) 맥스 / 맥스 프리미엄 / 맥스 프리미엄 플러스 / 맥스 프리미엄(EPP) / 맥스 커버 / 맥스 이너 → 모두 '맥스'.
//   본품(빈백)이 팔리면 그 색상 커버 1장 + 이너 1장이 필요. 커버만 팔리면 커버만, 이너만 팔리면 이너만.
//   → 본품판매는 커버·이너 양쪽 수요, 커버단품은 커버 수요, 이너단품은 이너 수요.
const BASE_STRIP = new Set(['프리미엄', '플러스', '프리미엄플러스', '스탠다드', 'premium', 'plus', 'standard', '커버', '이너']);
const baseName = (name) => norm(stripSlash(name).replace(/\(epp\)/gi, ' ').replace(/\bepp\b/gi, ' '))
  .split(' ').filter((t) => t && !BASE_STRIP.has(t.toLowerCase())).join(' ');
const coverKey = (name, color) => baseName(name) + '|' + norm(stripSlash(color));

// ── 품목코드 매핑 (offorder) — 판매 (name,color) → ecount_code. 10분 캐시 ──
let _mapCache = null, _mapAt = 0;
const MAP_TTL = 10 * 60 * 1000;
async function mappingTable() {
  const now = Date.now();
  if (_mapCache && (now - _mapAt) < MAP_TTL) return _mapCache;
  const j = await getJson(MAP_HOST, '/api/admin/mapping-check?t=' + now);
  const rows = (j && j.data) || [];
  const exact = {}, token = {};
  for (const r of rows) {
    const code = String(r.ecount_code || '').trim();
    if (!code) continue;
    const ek = norm(stripSlash(r.ecount_name)) + '|' + norm(stripSlash(r.ecount_spec));
    const tk = tok(stripSlash(r.ecount_name)) + '|' + sk(stripSlash(r.ecount_spec));
    if (ek !== '|' && !exact[ek]) exact[ek] = code;   // strip-정규화 정확키
    if (tk !== '|' && !token[tk]) token[tk] = code;   // 어순무시 폴백키
  }
  _mapCache = { exact, token, rows: rows.length }; _mapAt = now;
  return _mapCache;
}
// 판매 (name,color) → 품목코드 : strip-정확 → 어순무시 폴백
function codeFor(map, name, color) {
  if (!map) return null;
  const ek = norm(stripSlash(name)) + '|' + norm(stripSlash(color));
  if (map.exact[ek]) return map.exact[ek];
  const tk = tok(stripSlash(name)) + '|' + sk(stripSlash(color));
  return map.token[tk] || null;
}

// 이카운트 전체 몰 — (productName,color)별 최근 N 완료월 월평균 판매수량
async function salesForecast({ months = 3, today, withCode = false } = {}) {
  const ec = await store.namedCollection('on', 'orders');
  const t = today || ymd(new Date());
  const yms = completeMonths(months, t);
  const start = yms[yms.length - 1] + '-01', end = yms[0] + '-31';
  const rows = await ec.aggregate([
    { $match: { date: { $gte: start, $lte: end }, productName: { $nin: [null, ''] } } },
    { $group: { _id: { name: '$productName', color: '$color', ym: { $substr: ['$date', 0, 7] } }, qty: { $sum: '$qty' }, cat: { $first: '$category' } } },
  ]).toArray();
  const map = {};
  for (const r of rows) {
    if (!yms.includes(r._id.ym)) continue;
    const name = r._id.name, color = r._id.color || '';
    const k = name + '||' + color; // 판매 원본명 그대로 보존(코드 매핑은 별도)
    const g = map[k] = map[k] || { name, color, type: partType(name), ecat: r.cat || '', byMonth: {} };
    g.byMonth[r._id.ym] = (g.byMonth[r._id.ym] || 0) + N(r.qty);
  }
  let codeMap = null;
  if (withCode) codeMap = await mappingTable().catch(() => null);
  const items = Object.values(map).map((g) => {
    const series = yms.map((m) => g.byMonth[m] || 0);
    const total = series.reduce((a, b) => a + b, 0);
    const monthlyAvg = Math.max(0, Math.round((total / months) * 10) / 10);
    const out = { name: g.name, color: g.color, type: g.type, ecat: g.ecat, series, total, monthlyAvg };
    if (withCode) out.code = codeFor(codeMap, g.name, g.color);
    return out;
  }).sort((a, b) => b.monthlyAvg - a.monthlyAvg);
  return { basis: '이카운트 전체 몰', months: yms, monthsCount: months, count: items.length, items };
}

// 실시간 재고 (cloudtype) — 제외만 거른다. EPP는 커버/이너 기준명으로 합쳐지므로 유지(사스→사이너스).
async function stockList() {
  const rows = await getJson(STOCK_HOST, '/api/stock/' + encodeURIComponent('전체'));
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((s) => s.category !== '제외')
    .map((s) => {
      let name = s.name || '';
      if (name.includes('사스')) name = name.replace('사스', '사이너스');
      return { code: String(s.code || '').trim(), category: s.category, name, color: s.spec === '-' ? '' : (s.spec || ''), qty: N(s.qty) };
    });
}
async function stockUpdatedAt() { try { const j = await getJson(STOCK_HOST, '/api/system/last-update'); return (j && j.timestamp) || null; } catch (_) { return null; } }

const round1 = (v) => Math.round((v || 0) * 10) / 10;
function reorderCalc(stock, monthlyAvg, targetMonths) {
  const monthsLeft = monthlyAvg > 0 ? round1(stock / monthlyAvg) : null;
  const needOrder = monthlyAvg > 0 && stock < monthlyAvg * targetMonths;
  const suggestQty = needOrder ? Math.ceil(monthlyAvg * targetMonths - stock) : 0;
  return { monthsLeft, needOrder, suggestQty };
}

// 발주 계획 — 판매예측을 (커버/이너=기준명 수요통합, 그 외=품목코드)로 재고와 조인
async function reorderPlan({ months = 3, targetMonths = 1, today } = {}) {
  const [fc, stock, updatedAt, map] = await Promise.all([
    salesForecast({ months, today }),
    stockList().catch(() => null),
    stockUpdatedAt().catch(() => null),
    mappingTable().catch(() => null),
  ]);
  if (stock === null) {
    return { months: fc.months, monthsCount: months, targetMonths, updatedAt, stockError: true, mappingUsed: !!map, count: 0, matchedCount: 0, needOrderCount: 0, items: [], unmatchedSellers: [] };
  }
  // ── 수요 집계 ──
  //   coverDemand/innerDemand : 기준명(등급·EPP·커버/이너 제거)+색상. 본품판매=양쪽, 커버단품=커버, 이너단품=이너.
  //   codeDemand : 품목코드별(인형·리빙 등 비커버/이너용).
  const coverDemand = {}, innerDemand = {}, codeDemand = {};
  const unmapped = [];
  for (const it of fc.items) {
    const nm = it.name || '';
    const isCover = nm.includes('커버'), isInner = nm.includes('이너');
    const isBody = !isCover && !isInner && (it.ecat === '소파' || it.ecat === '바디필로우'); // 빈백 본품
    const ck = coverKey(nm, it.color); // 커버: 기준명+색상(색상별)
    const ik = baseName(nm);           // 이너: 기준명만 — 속커버는 색상 무관(전 색상 합산)
    if (isBody || isCover) coverDemand[ck] = (coverDemand[ck] || 0) + it.monthlyAvg;
    if (isBody || isInner) innerDemand[ik] = (innerDemand[ik] || 0) + it.monthlyAvg;
    const code = codeFor(map, nm, it.color);
    if (code) codeDemand[code] = (codeDemand[code] || 0) + it.monthlyAvg;
    else if (it.monthlyAvg > 0 && !isCover && !isInner && !isBody) unmapped.push({ name: nm, color: it.color, monthlyAvg: it.monthlyAvg, reason: '코드 미매핑' });
  }
  // ── 재고: 커버/이너는 기준명으로 묶어(등급·EPP 합산) 1줄, 그 외는 품목코드 단위 ──
  const groups = {}, others = [];
  for (const s of stock) {
    if (s.category === '커버' || s.category === '이너') {
      const isInnerCat = s.category === '이너';
      const bk = isInnerCat ? baseName(s.name) : coverKey(s.name, s.color); // 이너는 색상 무관
      const gk = s.category + '|' + bk;
      const g = groups[gk] = groups[gk] || { kind: s.category, baseKey: bk, name: baseName(s.name) + ' ' + s.category, color: isInnerCat ? '' : norm(stripSlash(s.color)), category: s.category, codes: [], stock: 0 };
      g.stock += s.qty; if (s.code) g.codes.push(s.code);
    } else others.push(s);
  }
  const items = [];
  for (const g of Object.values(groups)) {
    const monthlyAvg = round1((g.kind === '커버' ? coverDemand[g.baseKey] : innerDemand[g.baseKey]) || 0);
    const { monthsLeft, needOrder, suggestQty } = reorderCalc(g.stock, monthlyAvg, targetMonths);
    items.push({ code: g.codes[0] || '', variants: g.codes.length, category: g.category, name: g.name, color: g.color, stock: g.stock, monthlyAvg, expected1m: monthlyAvg, monthsLeft, needOrder, suggestQty, matched: monthlyAvg > 0, basis: g.kind + '(등급·EPP 통합)' });
  }
  for (const s of others) {
    const monthlyAvg = round1(codeDemand[s.code] || 0);
    const { monthsLeft, needOrder, suggestQty } = reorderCalc(s.qty, monthlyAvg, targetMonths);
    items.push({ code: s.code, variants: 1, category: s.category, name: s.name, color: s.color, stock: s.qty, monthlyAvg, expected1m: monthlyAvg, monthsLeft, needOrder, suggestQty, matched: monthlyAvg > 0, basis: '품목코드' });
  }
  return {
    months: fc.months, monthsCount: months, targetMonths, updatedAt, stockError: false, mappingUsed: !!map,
    count: items.length,
    matchedCount: items.filter((x) => x.matched).length,
    needOrderCount: items.filter((x) => x.needOrder).length,
    items,
    unmatchedSellers: unmapped.sort((a, b) => b.monthlyAvg - a.monthlyAvg).slice(0, 150),
  };
}

module.exports = { salesForecast, reorderPlan, stockList, stockUpdatedAt, mappingTable };
