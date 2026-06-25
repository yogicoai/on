'use strict';

/**
 * 광고효율 — adboard.daily_stats 조회. mkboard(ad-dashboard)가 매체 API에서 적재한 일별×매체 데이터.
 *   ⚠️ 매출(on/onlinedata)과는 "다른 클러스터"에 있다:
 *      - 매출  = ONLINEDATA_URI (lib/store)
 *      - 광고  = MONGODB_URI    (이 파일 전용 커넥션, adboard DB)
 *   스키마: { platform, date(YYYYMMDD), spend(광고비), conv(전환수), convValue(전환매출), imp(노출), clk(클릭) }
 *   파생: ROAS=convValue/spend, CTR=clk/imp, CPC=spend/clk, CVR=conv/clk, CPA=spend/conv.
 */

const { MongoClient } = require('mongodb');
require('./env').loadEnv();

const URI = process.env.ADBOARD_URI || process.env.MONGODB_URI; // 클러스터 B (광고)
const DB_NAME = process.env.ADBOARD_DB || 'adboard';
const COLL = 'daily_stats';
const N = (v) => (Number.isFinite(+v) ? +v : 0);
const ymd = (d) => String(d || '').replace(/-/g, ''); // 'YYYY-MM-DD' → 'YYYYMMDD'

const _g = globalThis;
_g.__adboard = _g.__adboard || { client: null, promise: null };
function configured() { return !!URI; }
async function coll() {
  if (!URI) throw new Error('광고 DB 미설정 (MONGODB_URI / ADBOARD_URI)');
  const g = _g.__adboard;
  if (!g.promise) {
    const c = new MongoClient(URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
    g.promise = c.connect().then((x) => { g.client = x; return x; });
  }
  return (await g.promise).db(DB_NAME).collection(COLL);
}

// 매체명 정규화: 'Criteo'(영문 중복, 전환 0) → '크리테오' 로 통합.
function canonPlatform(p) {
  const s = String(p || '').trim();
  if (/criteo|크리테오/i.test(s)) return '크리테오';
  return s;
}
// 벤더(매체사) 그룹: 네이버(키워드/쇼핑/브랜드/기타) · 메타(요기보/샐리필) · 크리테오 · 카카오 · GFA
function vendorOf(p) {
  const s = String(p || '');
  if (s.startsWith('네이버')) return '네이버';
  if (/^meta|메타/i.test(s)) return '메타';
  if (/criteo|크리테오/i.test(s)) return '크리테오';
  if (/카카오|kakao/i.test(s)) return '카카오';
  if (/gfa|구글|google/i.test(s)) return 'GFA';
  return s;
}

function withDerived(m) {
  return {
    ...m,
    spend: Math.round(m.spend), conv: m.conv, convValue: Math.round(m.convValue), imp: m.imp, clk: m.clk,
    roas: m.spend ? +(m.convValue / m.spend).toFixed(2) : null,           // 전환매출 ÷ 광고비
    ctr: m.imp ? +((m.clk / m.imp) * 100).toFixed(2) : null,             // 클릭률 %
    cpc: m.clk ? Math.round(m.spend / m.clk) : null,                     // 클릭당 비용
    cvr: m.clk ? +((m.conv / m.clk) * 100).toFixed(2) : null,           // 전환율 %
    cpa: m.conv ? Math.round(m.spend / m.conv) : null,                   // 전환당 비용
  };
}

async function rows(start, end) {
  const c = await coll();
  return c.find({ date: { $gte: ymd(start), $lte: ymd(end) } }, { projection: { _id: 0 } }).toArray();
}

function aggregateBy(data, keyFn) {
  const map = {};
  for (const r of data) {
    const k = keyFn(r.platform);
    const m = (map[k] = map[k] || { platform: k, spend: 0, conv: 0, convValue: 0, imp: 0, clk: 0 });
    m.spend += N(r.spend); m.conv += N(r.conv); m.convValue += N(r.convValue); m.imp += N(r.imp); m.clk += N(r.clk);
  }
  return Object.values(map).map(withDerived).sort((a, b) => b.spend - a.spend);
}

// 매체별 효율(상세 매체 + 벤더 그룹 + 합계).
async function efficiency(start, end) {
  const data = await rows(start, end);
  const platforms = aggregateBy(data, canonPlatform);
  const vendors = aggregateBy(data, vendorOf);
  const t = data.reduce((a, r) => { a.spend += N(r.spend); a.conv += N(r.conv); a.convValue += N(r.convValue); a.imp += N(r.imp); a.clk += N(r.clk); return a; }, { platform: '전체', spend: 0, conv: 0, convValue: 0, imp: 0, clk: 0 });
  return { start, end, total: withDerived(t), vendors, platforms, days: new Set(data.map((r) => r.date)).size };
}

// 일별 추이(전체 합).
async function dailyTrend(start, end) {
  const data = await rows(start, end);
  const map = {};
  for (const r of data) { const m = (map[r.date] = map[r.date] || { date: r.date, spend: 0, convValue: 0, conv: 0 }); m.spend += N(r.spend); m.convValue += N(r.convValue); m.conv += N(r.conv); }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date))
    .map((m) => ({ date: m.date, spend: Math.round(m.spend), convValue: Math.round(m.convValue), conv: m.conv, roas: m.spend ? +(m.convValue / m.spend).toFixed(2) : null }));
}

module.exports = { configured, efficiency, dailyTrend, rows, canonPlatform, vendorOf };
