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

const R = (n) => Math.round(n || 0);
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

module.exports = { overview, VENDOR_MALL };
