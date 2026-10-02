'use strict';

/**
 * 경보 스캔 — "오늘 챙길 것" 한 방 (직원 아침용).
 *   어제/최근 데이터에서 이상 신호를 자동 감지해 심각도순으로 반환:
 *     · 매출 급락(전주 동요일 대비) — 온라인+오프라인
 *     · 광고 이상(광고비 급증/급락 · ROAS 급락, 7일 평균 대비)
 *     · 트래픽 급락(자사몰 방문, 7일 평균 대비)
 *     · 미답변 문의(자사몰 게시판 + 스마트스토어, 3일 경과 시 심각)
 *     · 재고 소진 임박(발주 필요 품목)
 *     · 월 목표 페이스 미달(온라인 채널 + 오프라인 매장별)
 *     · 스토어 반품/취소율 급등(직전 7일 대비)
 *     · 오프라인 좌수 급감(전주 동요일 대비)                       — 2026-10-01 추가
 *     · 퍼널 전환율 급락(자사몰 구매전환율 · 스토어 구매율, 7일 평균 대비) — 2026-10-01 추가
 *   각 항목은 개별 try/catch — 한 소스가 죽어도 나머지 경보는 나온다.
 */

const dailyReport = require('./dailyReport');
const jwasuSales = require('./jwasuSales');
const funnelDaily = require('./funnelDaily');
const offline = require('./offline');
const adEfficiency = require('./adEfficiency');
const target = require('./target');
const csTools = require('./csTools');
const ssExtra = require('./smartstoreExtra');
const forecast = require('./forecast');
const returns = require('./returns');

const R = (n) => Math.round(n || 0);
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return fmt(d); };
const won = (n) => Number(R(n)).toLocaleString() + '원';
const pctS = (v) => (v == null ? '-' : (v > 0 ? '+' : '') + v.toFixed(1) + '%');

async function scan() {
  // 오늘 = 한국 날짜 — 서버 시간대(Vercel=UTC)와 무관하게. fmt(new Date())는 UTC 서버에서 새벽 0~9시에 하루 밀린다.
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const y = addDays(today, -1);          // 어제(최근 완성일)
  const weekAgo = addDays(y, -7);        // 전주 동요일
  const lo7 = addDays(y, -6);            // 최근 7일 시작
  const prev7lo = addDays(lo7, -7);      // 직전 7일
  const monthStart = y.slice(0, 8) + '01';
  const ym = y.slice(0, 7);
  const daysInMonth = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
  const elapsedPct = (+y.slice(8, 10) / daysInMonth) * 100; // 월 경과율(어제까지)

  const 경보 = []; const 정상 = [];
  const add = (sev, 분야, 내용) => 경보.push({ 심각도: sev, 분야, 내용 });
  const 실적 = {}; // 어제 실적 보고용(스캔하면서 수집)

  const tasks = {
    // ── ① 매출 급락 (어제 vs 전주 동요일, 온+오프) ──
    sales: (async () => {
      const [onSeries, offDaily] = await Promise.all([
        dailyReport.dailyChannelSeries('2025-01-01'),
        offline.dailySeries(addDays(y, -8), y),
      ]);
      const onBy = {}; for (const d of onSeries) onBy[d.Date] = R((d.자사몰 || 0) + (d.스마트스토어 || 0) + (d.외부채널 || 0));
      const offBy = {}; for (const d of offDaily) offBy[d.date] = d.매출;
      const cur = (onBy[y] || 0) + (offBy[y] || 0);
      const base = (onBy[weekAgo] || 0) + (offBy[weekAgo] || 0);
      실적.매출 = { 전사: cur, 온라인: onBy[y] || 0, 오프라인: offBy[y] || 0, 전주동요일比_pct: base > 0 ? +(((cur - base) / base) * 100).toFixed(1) : null };
      if (base > 0) {
        const chg = ((cur - base) / base) * 100;
        if (chg <= -50) add('🔴', '매출', `어제 전사 매출 ${won(cur)} — 전주 동요일(${won(base)}) 대비 ${pctS(chg)} 급락`);
        else if (chg <= -30) add('🟡', '매출', `어제 전사 매출 ${won(cur)} — 전주 동요일 대비 ${pctS(chg)} 하락`);
        else 정상.push(`매출: 어제 ${won(cur)} (전주 동요일比 ${pctS(chg)})`);
      }
    })(),

    // ── ② 광고 이상 (어제 vs 최근 7일 평균) ──
    ad: (async () => {
      const trend = await adEfficiency.dailyTrend(addDays(y, -7), y);
      const yRow = trend.find((t) => t.date === y.replace(/-/g, ''));
      const prior = trend.filter((t) => t.date !== y.replace(/-/g, ''));
      if (yRow) 실적.광고 = { 광고비: yRow.spend, ROAS: yRow.roas };
      if (!yRow || !prior.length) return;
      const avgSpend = prior.reduce((a, t) => a + t.spend, 0) / prior.length;
      const avgRoas = prior.reduce((a, t) => a + (t.roas || 0), 0) / prior.length;
      const spendChg = avgSpend ? ((yRow.spend - avgSpend) / avgSpend) * 100 : null;
      if (spendChg != null && Math.abs(spendChg) >= 50) add('🟡', '광고', `어제 광고비 ${won(yRow.spend)} — 7일 평균(${won(avgSpend)}) 대비 ${pctS(spendChg)}`);
      if (yRow.roas != null && avgRoas > 0 && yRow.roas < avgRoas * 0.5) add('🟡', '광고', `어제 ROAS ${yRow.roas} — 7일 평균(${avgRoas.toFixed(1)})의 절반 이하`);
      // 정상 문구에는 ROAS 절대값을 쓰지 않는다 — 플랫폼 전환매출은 매체끼리 같은 주문을 중복으로 잡아 부풀려진다
      //   (dash 홈 화면 원칙과 같음). ROAS 는 7일 평균 대비 "반토막" 판단에만 쓰고, 값은 어제실적.광고.ROAS 에 남긴다.
      if ((spendChg == null || Math.abs(spendChg) < 50) && !(yRow.roas != null && avgRoas > 0 && yRow.roas < avgRoas * 0.5)) 정상.push(`광고: 어제 ${won(yRow.spend)} (7일 평균比 ${pctS(spendChg)})`);
    })(),

    // ── ③ 트래픽 급락 (자사몰 방문, 어제 vs 7일 평균) ──
    //   급락 감시는 매일 빠짐없이 들어오는 Cafe24 집계로 한다(이프두는 MD 업로드 시점에 따라 비는 날이 있어 비교가 흔들린다).
    //   KPI 표의 방문(이프두 기준)과 숫자가 달라 문구에 출처를 적는다.
    traffic: (async () => {
      const rows = await dailyReport.trafficSeries(addDays(y, -8));
      const yRow = rows.find((r) => r.Date === y);
      const prior = rows.filter((r) => r.Date >= addDays(y, -7) && r.Date < y && r.Visits > 0);
      if (yRow) 실적.트래픽 = { 방문: yRow.Visits, 신규가입: yRow.Signups };
      if (!yRow || !prior.length) return;
      const avg = prior.reduce((a, r) => a + r.Visits, 0) / prior.length;
      const chg = avg ? ((yRow.Visits - avg) / avg) * 100 : null;
      if (chg != null && chg <= -40) add('🟡', '트래픽', `어제 자사몰 방문(Cafe24 집계) ${yRow.Visits}명 — 7일 평균(${R(avg)}명) 대비 ${pctS(chg)}`);
      else 정상.push(`트래픽: 어제 방문(Cafe24 집계) ${yRow.Visits}명 (7일 평균比 ${pctS(chg)})`);
    })(),

    // ── ④ 미답변 문의 (자사몰 게시판 + 스토어) ──
    cs: (async () => {
      const [ca, ss] = await Promise.all([
        csTools.unanswered(7).catch(() => null),
        ssExtra.inquiries(lo7, today).catch(() => null),
      ]);
      const caUn = (ca && ca.총미답변) || 0;
      const ssUn = (ss && ss.미답변 && ss.미답변.건수) || 0;
      const total = caUn + ssUn;
      if (total === 0) { 정상.push('CS: 미답변 문의 없음'); return; }
      // 3일 경과 건 확인(자사몰 목록의 작성일 기준)
      const threeDaysAgo = addDays(today, -3);
      const oldOnes = [];
      for (const b of ((ca && ca.게시판별) || [])) for (const a of (b.미답변목록 || [])) if (a.작성일 <= threeDaysAgo) oldOnes.push(`${b.게시판}:"${a.제목}"(${a.작성일})`);
      if (oldOnes.length) add('🔴', 'CS', `미답변 ${total}건 중 3일 경과 ${oldOnes.length}건 — ${oldOnes.slice(0, 3).join(', ')}`);
      else add('🟡', 'CS', `미답변 문의 ${total}건 (자사몰 ${caUn} · 스토어 ${ssUn}) — 답변 필요`);
    })(),

    // ── ⑤ 재고 소진 임박 (발주 필요) ──
    stock: (async () => {
      const r = await forecast.reorderPlan({ months: 3, targetMonths: 1 });
      // 급한 순 = 남은 기간 짧은 순, 같으면 많이 팔리는 순 — 재고 0 인 품목끼리는 월평균이 큰 쪽이 더 급하다
      //   (발주 대상 판단 자체는 forecast.reorderPlan 그대로 — 순서만 정한다)
      const items = (Array.isArray(r) ? r : (r.items || r.rows || [])).filter((x) => x.needOrder)
        .sort((a, b) => ((a.monthsLeft == null ? 99 : a.monthsLeft) - (b.monthsLeft == null ? 99 : b.monthsLeft)) || ((b.monthlyAvg || 0) - (a.monthlyAvg || 0)));
      const label = (x) => `${x.name}${x.color ? '(' + x.color + ')' : ''}`;
      // 남은 기간 — 한 달 안쪽은 일수로. 개월(소수 1자리)로만 쓰면 재고가 남았는데도 "0개월"이 된다.
      const daysLeft = (x) => (x.monthlyAvg > 0 ? Math.round((x.stock / x.monthlyAvg) * 30) : null);
      const left = (x) => {
        if (x.stock <= 0) return '재고 0';
        const d = daysLeft(x);
        if (d != null && d < 30) return d < 1 ? '1일 이내' : `약 ${d}일`;
        return `${x.monthsLeft}개월`;
      };
      // 화면(dash "오늘 챙길 것")에 품목별로 보이도록 급한 순 목록을 구조화해 둔다.
      //   발주 판단 기준 = 온라인 판매 월평균(오프라인 제외) — 기준 변경은 MD 결정 사항이라 표기만 한다.
      실적.재고 = {
        발주필요: items.length,
        보름내소진: items.filter((x) => x.monthsLeft != null && x.monthsLeft <= 0.5).length,
        급한순: items.slice(0, 8).map((x) => ({ 품목: x.name, 색상: x.color || '', 재고: x.stock, 월평균: x.monthlyAvg, 소진_개월: x.monthsLeft, 남은_일: daysLeft(x), 제안수량: x.suggestQty })),
        기준: '월평균 수요 = 온라인 판매(오프라인 제외) · 최근 3개월 · 1개월치 기준',
      };
      if (!items.length) { 정상.push('재고: 발주 필요 품목 없음'); return; }
      const urgent = items.filter((x) => x.monthsLeft != null && x.monthsLeft <= 0.5);
      const zero = urgent.filter((x) => x.stock <= 0).length;
      if (urgent.length) add('🔴', '재고', `보름 내 소진 예상 ${urgent.length}품목${zero ? `(그중 재고 0 ${zero}품목)` : ''} — ${urgent.slice(0, 3).map((x) => `${label(x)} ${left(x)}`).join(', ')}${urgent.length > 3 ? ' 외' : ''}`);
      else add('🟡', '재고', `발주 필요 품목 ${items.length}개 — 급한 순: ${items.slice(0, 3).map((x) => `${label(x)} ${left(x)}`).join(', ')}${items.length > 3 ? ' 외' : ''}`);
    })(),

    // ── ⑥ 월 목표 페이스 (온라인 채널 + 오프라인 매장) ──
    pace: (async () => {
      const [tgt, off] = await Promise.all([
        target.targetStatus(ym).catch(() => null),
        offline.analyze(monthStart, y).catch(() => null),
      ]);
      const behind = [];
      if (tgt && tgt.total && tgt.total.target > 0) {
        const rate = +tgt.total.rate || 0;
        if (rate < elapsedPct * 0.7) behind.push(`온라인 ${rate.toFixed(1)}%`);
      }
      if (off && off.totals && off.totals.목표달성률_pct != null) {
        if (off.totals.목표달성률_pct < elapsedPct * 0.7) behind.push(`오프라인 전체 ${off.totals.목표달성률_pct}%`);
        const storeBehind = (off.매장별 || []).filter((s) => s.달성률_pct != null && s.달성률_pct < elapsedPct * 0.6)
          .sort((a, b) => a.달성률_pct - b.달성률_pct).slice(0, 3);
        for (const s of storeBehind) behind.push(`${s.매장} ${s.달성률_pct}%`);
      }
      if (behind.length) add('🟡', '목표', `월 경과 ${elapsedPct.toFixed(0)}% 대비 페이스 미달: ${behind.join(' · ')}`);
      else 정상.push(`목표: 페이스 정상 (월 경과 ${elapsedPct.toFixed(0)}%)`);
    })(),

    // ── ⑦ 스토어 반품/취소율 급등 (최근 7일 vs 직전 7일) ──
    returns: (async () => {
      const [cur, prev] = await Promise.all([
        returns.smartstoreReturns(lo7, y),
        returns.smartstoreReturns(prev7lo, addDays(lo7, -1)),
      ]);
      const curRate = (cur.취소 && cur.취소.비율_pct || 0) + (cur.반품 && cur.반품.반품률_pct || 0);
      const prevRate = (prev.취소 && prev.취소.비율_pct || 0) + (prev.반품 && prev.반품.반품률_pct || 0);
      if (prevRate > 0 && curRate >= prevRate * 1.8 && curRate - prevRate >= 3) {
        add('🟡', '반품', `스토어 취소+반품률 ${curRate.toFixed(1)}% — 직전 7일(${prevRate.toFixed(1)}%) 대비 급등`);
      } else 정상.push(`반품: 스토어 취소+반품률 ${curRate.toFixed(1)}% (직전 7일 ${prevRate.toFixed(1)}%)`);
    })(),

    // ── ⑧ 오프라인 좌수 급감 (어제 vs 전주 동요일) ──
    //   좌수는 요일 영향이 커서(주말↑) 매출 경보처럼 전주 같은 요일과 비교한다. 전주 좌수가 20 미만이면 표본이 작아 판정하지 않는다.
    jwasu: (async () => {
      const a = await jwasuSales.analyze(weekAgo, y);
      const day = (d) => (a.일별 || []).find((x) => x.날짜 === d);
      const cur = day(y), base = day(weekAgo);
      if (!cur || cur.좌수 == null) throw new Error('어제 좌수를 읽지 못했습니다');
      실적.좌수 = { 어제: cur.좌수, 전주동요일: base ? base.좌수 : null };
      if (!base || base.좌수 == null || base.좌수 < 20) { 정상.push(`좌수: 어제 ${cur.좌수}좌`); return; }
      const chg = ((cur.좌수 - base.좌수) / base.좌수) * 100;
      if (chg <= -60) add('🔴', '좌수', `어제 오프라인 좌수 ${cur.좌수}좌 — 전주 동요일(${base.좌수}좌) 대비 ${pctS(chg)} 급감`);
      else if (chg <= -40) add('🟡', '좌수', `어제 오프라인 좌수 ${cur.좌수}좌 — 전주 동요일(${base.좌수}좌) 대비 ${pctS(chg)}`);
      else 정상.push(`좌수: 어제 ${cur.좌수}좌 (전주 동요일比 ${pctS(chg)})`);
    })(),

    // ── ⑨ 퍼널 전환율 급락 (어제 vs 최근 7일 평균) ──
    //   자사몰 구매전환율 = 주문완료 ÷ 방문(이프두 — 업로드 전인 날은 Cafe24, funnelDaily.mallBase) · 스토어 구매율 = 주문건수 ÷ 유입(MD 입력 — 입력 안 된 날은 판정 보류).
    funnel: (async () => {
      await dailyReport.trafficSeries(addDays(y, -6)).catch(() => null); // 방문 0 자가치유 먼저(야간 동기화가 0 으로 덮는 일이 있다)
      const db = await funnelDaily.buildDb({ from: addDays(y, -7), to: y });
      const rate = (num, den) => (den > 0 ? (num / den) * 100 : null);
      const check = (label, rows, iNum, iDen) => {
        const yr = rows.find((r) => r[0] === y);
        const prior = rows.filter((r) => r[0] < y && r[0] >= addDays(y, -7) && r[iDen] > 0);
        if (!yr || !(yr[iDen] > 0) || prior.length < 3) return null; // 어제 값 없음(미수집·미입력) 또는 비교 표본 부족
        return { label, cur: rate(yr[iNum], yr[iDen]), avg: prior.reduce((s, r) => s + rate(r[iNum], r[iDen]), 0) / prior.length };
      };
      const res = [check('자사몰 구매전환율', db.mall, 5, 1), check('스토어 구매율', db.ss, 2, 1)].filter(Boolean);
      const ok = [];
      for (const x of res) {
        if (x.avg > 0 && x.cur < x.avg * 0.6) add('🟡', '퍼널', `어제 ${x.label} ${x.cur.toFixed(2)}% — 7일 평균(${x.avg.toFixed(2)}%)의 60% 미만`);
        else ok.push(`${x.label} ${x.cur.toFixed(2)}% (7일 평균 ${x.avg.toFixed(2)}%)`);
      }
      if (ok.length) 정상.push('퍼널: ' + ok.join(' · '));
      if (!res.length) 정상.push('퍼널: 어제 값이 아직 없어 판정 보류(방문 수집 전 또는 스토어 유입 온라인팀 데이터 업데이트 전)');
      else if (res.length === 1 && res[0].label === '자사몰 구매전환율') 정상.push('퍼널: 스토어 구매율 판정 보류 — 스토어 유입 온라인팀 데이터 업데이트 전');
    })(),
  };

  const settled = await Promise.allSettled(Object.values(tasks));
  const 실패 = [];
  Object.keys(tasks).forEach((k, i) => { if (settled[i].status === 'rejected') 실패.push(`${k}: ${String(settled[i].reason && settled[i].reason.message).slice(0, 60)}`); });

  const sev = { '🔴': 0, '🟡': 1 };
  경보.sort((a, b) => sev[a.심각도] - sev[b.심각도]);

  return {
    기준일: y, 스캔시각: new Date().toISOString(),
    어제실적: 실적, // 보고 형식: 이걸 먼저 제시하고 그 아래 경보를 정리할 것
    요약: 경보.length ? `경보 ${경보.length}건 (심각 ${경보.filter((a) => a.심각도 === '🔴').length})` : '이상 신호 없음 ✅',
    경보, 정상항목: 정상,
    ...(실패.length ? { 스캔실패: 실패 } : {}),
    주의: '기준일=어제(완성일). 임계치: 매출 전주동요일比 -30/-50% · 광고비 7일평균比 ±50% · ROAS 반토막 · 방문 -40% · 목표 페이스 70% 미만 · 재고 0.5개월 내 소진 · 좌수 전주동요일比 -40/-60% · 구매전환율 7일평균의 60% 미만.',
  };
}

module.exports = { scan };
