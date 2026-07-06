'use strict';

/**
 * 통합 마케팅 개요 — 매출(이카운트, 클러스터 A) + 광고(adboard, 클러스터 B) + 트래픽을 한 번에 교차.
 *   Claude(Desktop/MCP)가 자연어로 "이 기간 광고 대비 실매출·CAC·비용률 알려줘" 라고 물으면
 *   이 한 함수(marketing_overview 툴)가 필요한 수치를 조합해서 돌려준다.
 *
 *   ⚠️ 한계(반드시 인지): 주문 단위 광고 귀속(attribution) 데이터가 없어 모두 "일별·집계 수준"의 대조다.
 *      - convValue(광고 전환매출)는 매체가 광고기여로 잡은 값(중복·과대 가능).
 *      - 실매출은 이카운트 확정 출고 기준(별도 소스). 둘은 다른 수치 → 직접 합산 금지.
 *      - 매체→몰은 귀속이 아니라 "주력 추정" 매핑(참고용).
 */

const adEfficiency = require('./adEfficiency');
const dailyReport = require('./dailyReport');
const orders = require('./orders'); // 자사몰 회원/비회원 일별

const R = (n) => Math.round(n || 0);
const dash = (ymd) => (String(ymd).length === 8 ? `${String(ymd).slice(0, 4)}-${String(ymd).slice(4, 6)}-${String(ymd).slice(6, 8)}` : String(ymd));
function enumDays(start, end) {
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // 로컬 날짜(toISOString UTC 변환 금지 — KST -1일 밀림 방지)
  const out = []; const d = new Date(start + 'T00:00:00'); const e = new Date(end + 'T00:00:00');
  for (let g = 0; d <= e && g < 800; g++) { out.push(fmt(d)); d.setDate(d.getDate() + 1); }
  return out;
}
// 매체사(벤더) → 주력 대상몰 "추정"(귀속 아님). 네이버=스마트스토어, 그 외=자사몰 중심.
const VENDOR_MALL = { 네이버: '스마트스토어', 메타: '자사몰', 크리테오: '자사몰', 카카오: '자사몰', GFA: '자사몰' };

async function overview(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
    throw new Error('start/end는 YYYY-MM-DD 형식이어야 합니다');
  }
  const [ad, series, traffic] = await Promise.all([
    adEfficiency.efficiency(start, end),
    dailyReport.dailyChannelSeries('2025-01-01').catch(() => []),
    dailyReport.trafficSeries('2025-01-01').catch(() => []),
  ]);

  // ── 매출(이카운트, 채널별) ──
  const inRange = series.filter((d) => d.Date >= start && d.Date <= end);
  const bySales = inRange.reduce((a, d) => {
    a.자사몰 += d.자사몰 || 0; a.스마트스토어 += d.스마트스토어 || 0; a.외부채널 += d.외부채널 || 0; return a;
  }, { 자사몰: 0, 스마트스토어: 0, 외부채널: 0 });
  const 실매출 = bySales.자사몰 + bySales.스마트스토어 + bySales.외부채널;

  // ── 트래픽(자사몰 Cafe24 기준: 방문·가입·구매) ──
  const tRange = traffic.filter((t) => t.Date >= start && t.Date <= end);
  const 방문 = tRange.reduce((a, t) => a + (t.Visits || 0), 0);
  const 가입 = tRange.reduce((a, t) => a + (t.Signups || 0), 0);
  const 구매 = tRange.reduce((a, t) => a + (t.Purchases || 0), 0);

  // ── 광고 ──
  const spend = ad.total.spend || 0;

  // ── 교차 지표 ──
  const 비용률 = 실매출 ? +((spend / 실매출) * 100).toFixed(2) : null;   // 광고비 ÷ 실매출 %
  const CAC_신규가입 = 가입 ? R(spend / 가입) : null;                     // 광고비 ÷ Cafe24 신규가입수(참고 프록시)

  return {
    start, end,
    매출: {
      실매출_이카운트: R(실매출),
      자사몰: R(bySales.자사몰), 스마트스토어: R(bySales.스마트스토어), 외부채널: R(bySales.외부채널),
    },
    광고: {
      총광고비: spend, 광고ROAS: ad.total.roas, 광고기여전환매출: ad.total.convValue,
      노출: ad.total.imp, 클릭: ad.total.clk, CTR: ad.total.ctr, 전환수: ad.total.conv,
      벤더별: ad.vendors.map((v) => ({
        매체: v.platform, 광고비: v.spend, ROAS: v.roas, 전환매출: v.convValue, CPA: v.cpa,
        추정대상몰: VENDOR_MALL[v.platform] || '?',
      })),
    },
    교차지표: {
      실질_마케팅비용률_pct: 비용률,        // 광고비 ÷ 실매출
      신규가입당_광고비_CAC: CAC_신규가입,   // 광고비 ÷ 신규가입(자사몰 Cafe24 기준 · 총광고비 대비라 프록시)
      방문: 방문, 신규가입: 가입, 구매: 구매,
      방문대비_구매전환율_pct: 방문 ? +((구매 / 방문) * 100).toFixed(2) : null,
    },
    주의: '주문 단위 광고 귀속 데이터 없음 → 일별·집계 수준 대조(상관, 인과 아님). convValue=매체 광고기여(중복·과대 가능), 실매출=이카운트 확정 출고. 매체→몰은 추정.',
  };
}

// ── 일별 정렬 wide table — 광고(매체) × 매출(채널) × 회원/비회원 × 트래픽을 날짜축으로 통합 ──
//   관계·상관·시차 분석의 뼈대. 서버에서 미리 조인해 하루=한 줄로 반환(LLM 이 수동 정렬 안 하도록).
async function series(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
    throw new Error('start/end는 YYYY-MM-DD 형식이어야 합니다');
  }
  const [adRows, channel, traffic, memberDaily] = await Promise.all([
    adEfficiency.rows(start, end).catch(() => []),
    dailyReport.dailyChannelSeries('2025-01-01').catch(() => []),
    dailyReport.trafficSeries('2025-01-01').catch(() => []),
    orders.fetchOrdersSmart(start, end).then((o) => orders.memberReport(o, start, end).daily).catch(() => []),
  ]);

  const adBy = {}; // 'YYYY-MM-DD' → {vendor:spend, _spend, _cv, _conv}
  for (const r of adRows) {
    const dt = dash(r.date); const v = adEfficiency.vendorOf(r.platform);
    const a = (adBy[dt] = adBy[dt] || { _spend: 0, _cv: 0, _conv: 0 });
    a[v] = (a[v] || 0) + (+r.spend || 0);
    a._spend += (+r.spend || 0); a._cv += (+r.convValue || 0); a._conv += (+r.conv || 0);
  }
  const chBy = {}; for (const d of channel) chBy[d.Date] = d;
  const trBy = {}; for (const t of traffic) trBy[t.Date] = t;
  const meBy = {}; for (const m of memberDaily) meBy[m.date] = m;

  const rows = enumDays(start, end).map((date) => {
    const ad = adBy[date] || {}; const ch = chBy[date] || {}; const tr = trBy[date] || {}; const me = meBy[date] || {};
    const 자사몰 = R(ch.자사몰), 스토어 = R(ch.스마트스토어), 외부 = R(ch.외부채널);
    return {
      date,
      광고: { 네이버: R(ad.네이버), 메타: R(ad.메타), 크리테오: R(ad.크리테오), 카카오: R(ad.카카오), 합계: R(ad._spend), 전환매출: R(ad._cv) },
      매출: { 자사몰, 스마트스토어: 스토어, 외부채널: 외부, 합계: 자사몰 + 스토어 + 외부 },
      자사몰_회원매출: R(me.memberRevenue), 자사몰_비회원매출: R(me.guestRevenue),
      방문: R(tr.Visits), 신규가입: R(tr.Signups), 구매: R(tr.Purchases),
    };
  });
  return { start, end, days: rows.length, rows };
}

// series rows → 기간 합계 + 파생지표(비용률·CAC)
function totalsOf(rows) {
  const t = { 광고비: 0, 광고_네이버: 0, 광고_메타: 0, 광고_크리테오: 0, 광고_카카오: 0, 광고전환매출: 0, 매출: 0, 자사몰: 0, 스마트스토어: 0, 외부채널: 0, 회원매출: 0, 비회원매출: 0, 방문: 0, 신규가입: 0, 구매: 0 };
  for (const r of rows) {
    t.광고비 += r.광고.합계; t.광고_네이버 += r.광고.네이버; t.광고_메타 += r.광고.메타; t.광고_크리테오 += r.광고.크리테오; t.광고_카카오 += r.광고.카카오; t.광고전환매출 += r.광고.전환매출;
    t.매출 += r.매출.합계; t.자사몰 += r.매출.자사몰; t.스마트스토어 += r.매출.스마트스토어; t.외부채널 += r.매출.외부채널;
    t.회원매출 += r.자사몰_회원매출; t.비회원매출 += r.자사몰_비회원매출;
    t.방문 += r.방문; t.신규가입 += r.신규가입; t.구매 += r.구매;
  }
  t.마케팅비용률_pct = t.매출 ? +((t.광고비 / t.매출) * 100).toFixed(2) : null;
  t.광고ROAS = t.광고비 ? +(t.광고전환매출 / t.광고비).toFixed(2) : null;
  t.CAC_신규가입 = t.신규가입 ? R(t.광고비 / t.신규가입) : null;
  return t;
}

// ── 두 구간 비교 — 프로모션 전/중/후, 광고 늘린 주 vs 안 늘린 주 등. 길이 달라도 "일평균" 기준 비교 ──
async function periodCompare(aStart, aEnd, bStart, bEnd) {
  const [A, B] = await Promise.all([series(aStart, aEnd), series(bStart, bEnd)]);
  const ta = totalsOf(A.rows), tb = totalsOf(B.rows);
  const daysA = A.rows.length || 1, daysB = B.rows.length || 1;
  const keys = ['광고비', '매출', '자사몰', '스마트스토어', '외부채널', '회원매출', '비회원매출', '방문', '신규가입', '구매'];
  const 일평균비교 = {};
  for (const k of keys) {
    const av = ta[k] / daysA, bv = tb[k] / daysB;
    일평균비교[k] = { A: R(av), B: R(bv), 증감_pct: av ? +(((bv - av) / av) * 100).toFixed(1) : null };
  }
  const dSpend = (tb.광고비 / daysB) - (ta.광고비 / daysA);
  const dSales = (tb.매출 / daysB) - (ta.매출 / daysA);
  return {
    A: { start: aStart, end: aEnd, days: daysA, ...ta },
    B: { start: bStart, end: bEnd, days: daysB, ...tb },
    일평균비교,
    증분ROAS: dSpend ? +(dSales / dSpend).toFixed(2) : null, // (B-A 일평균 매출증분) ÷ (광고비증분)
    주의: '기간 길이가 달라도 비교되게 "일평균" 기준. 주문 단위 광고 귀속 없음 → 상관·구간비교(인과 아님).',
  };
}

module.exports = { overview, series, periodCompare, totalsOf, VENDOR_MALL };
