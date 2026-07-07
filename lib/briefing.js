'use strict';

/**
 * 일일 브리핑 — "어제 어땠어?" 한 방 요약 (직원용 최상위 툴).
 *   기준일(기본 어제)의 온라인(자사몰/스마트스토어/외부채널) + 오프라인(매장) 매출,
 *   전일/전주 동요일 대비, 월 누적·목표 페이스(온라인 target + 오프라인 jwasu 목표), 광고비·ROAS, 트래픽.
 *   기존 lib 조합만 사용(새 원장 없음) — 개인정보 없음.
 */

const dailyReport = require('./dailyReport');
const offline = require('./offline');
const adEfficiency = require('./adEfficiency');
const target = require('./target');

const R = (n) => Math.round(n || 0);
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return fmt(d); };
const pct = (cur, prev) => (prev ? +(((cur - prev) / prev) * 100).toFixed(1) : null);

async function briefing(date) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : addDays(fmt(new Date()), -1); // 기본 어제
  const prevDay = addDays(day, -1);
  const weekAgo = addDays(day, -7);
  const monthStart = day.slice(0, 8) + '01';
  const ym = day.slice(0, 7);

  const [onSeries, offDaily, offMonth, ad, adMtd, tgt, traffic] = await Promise.all([
    dailyReport.dailyChannelSeries('2025-01-01').catch(() => []),
    offline.dailySeries(weekAgo, day).catch(() => []),
    offline.analyze(monthStart, day).catch(() => null),
    adEfficiency.efficiency(day, day).catch(() => null),
    adEfficiency.efficiency(monthStart, day).catch(() => null),
    target.targetStatus(ym).catch(() => null),
    dailyReport.trafficSeries(weekAgo).catch(() => []),
  ]);

  const onBy = {}; for (const d of onSeries) onBy[d.Date] = d;
  const onOf = (dt) => { const d = onBy[dt] || {}; return R((d.자사몰 || 0) + (d.스마트스토어 || 0) + (d.외부채널 || 0)); };
  const offBy = {}; for (const d of offDaily) offBy[d.date] = d.매출;
  const trBy = {}; for (const t of traffic) trBy[t.Date] = t;

  const 온라인 = onOf(day), 오프라인 = R(offBy[day] || 0), 전체 = 온라인 + 오프라인;
  const 전일전체 = onOf(prevDay) + R(offBy[prevDay] || 0);
  const 전주전체 = onOf(weekAgo) + R(offBy[weekAgo] || 0);
  const dRow = onBy[day] || {};
  const tr = trBy[day] || {};

  // 월 누적(온라인) — dailyChannelSeries 합
  let mtdOn = 0; for (let d = monthStart; d <= day; d = addDays(d, 1)) mtdOn += onOf(d);

  return {
    기준일: day,
    매출: {
      전체: 전체, 온라인, 오프라인,
      온라인상세: { 자사몰: R(dRow.자사몰), 스마트스토어: R(dRow.스마트스토어), 외부채널: R(dRow.외부채널) },
      전일대비_pct: pct(전체, 전일전체),
      전주동요일대비_pct: pct(전체, 전주전체),
    },
    월누적: {
      온라인: R(mtdOn),
      온라인목표: tgt && tgt.total ? { 목표: R(tgt.total.target), 실적: R(tgt.total.actual), 달성률_pct: tgt.total.rate != null ? +(+tgt.total.rate).toFixed(1) : null } : null,
      오프라인: offMonth ? { 매출: offMonth.totals.매출, 목표: offMonth.totals.목표매출합, 달성률_pct: offMonth.totals.목표달성률_pct } : null,
    },
    광고: ad && ad.total ? {
      당일광고비: ad.total.spend, 당일ROAS: ad.total.roas,
      월누적광고비: adMtd && adMtd.total ? adMtd.total.spend : null,
      월누적ROAS: adMtd && adMtd.total ? adMtd.total.roas : null,
    } : null,
    트래픽_자사몰: { 방문: R(tr.Visits), 신규가입: R(tr.Signups), 구매: R(tr.Purchases) },
    주의: '오프라인은 매장 주문서 기준, 온라인은 이카운트 출고 기준(다른 원장, 합산은 근사). 광고 당일치는 매체 확정 지연으로 미완성일 수 있음.',
  };
}

module.exports = { briefing };
