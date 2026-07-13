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
 *   각 항목은 개별 try/catch — 한 소스가 죽어도 나머지 경보는 나온다.
 */

const dailyReport = require('./dailyReport');
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
  const today = fmt(new Date());
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
      if (!yRow || !prior.length) return;
      const avgSpend = prior.reduce((a, t) => a + t.spend, 0) / prior.length;
      const avgRoas = prior.reduce((a, t) => a + (t.roas || 0), 0) / prior.length;
      const spendChg = avgSpend ? ((yRow.spend - avgSpend) / avgSpend) * 100 : null;
      if (spendChg != null && Math.abs(spendChg) >= 50) add('🟡', '광고', `어제 광고비 ${won(yRow.spend)} — 7일 평균(${won(avgSpend)}) 대비 ${pctS(spendChg)}`);
      if (yRow.roas != null && avgRoas > 0 && yRow.roas < avgRoas * 0.5) add('🟡', '광고', `어제 ROAS ${yRow.roas} — 7일 평균(${avgRoas.toFixed(1)})의 절반 이하`);
      if ((spendChg == null || Math.abs(spendChg) < 50) && !(yRow.roas != null && avgRoas > 0 && yRow.roas < avgRoas * 0.5)) 정상.push(`광고: 어제 ${won(yRow.spend)} · ROAS ${yRow.roas ?? '-'}`);
    })(),

    // ── ③ 트래픽 급락 (자사몰 방문, 어제 vs 7일 평균) ──
    traffic: (async () => {
      const rows = await dailyReport.trafficSeries(addDays(y, -8));
      const yRow = rows.find((r) => r.Date === y);
      const prior = rows.filter((r) => r.Date >= addDays(y, -7) && r.Date < y && r.Visits > 0);
      if (!yRow || !prior.length) return;
      const avg = prior.reduce((a, r) => a + r.Visits, 0) / prior.length;
      const chg = avg ? ((yRow.Visits - avg) / avg) * 100 : null;
      if (chg != null && chg <= -40) add('🟡', '트래픽', `어제 자사몰 방문 ${yRow.Visits}명 — 7일 평균(${R(avg)}명) 대비 ${pctS(chg)}`);
      else 정상.push(`트래픽: 어제 방문 ${yRow.Visits}명 (7일 평균比 ${pctS(chg)})`);
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
      const items = (Array.isArray(r) ? r : (r.items || r.rows || [])).filter((x) => x.needOrder);
      if (!items.length) { 정상.push('재고: 발주 필요 품목 없음'); return; }
      const urgent = items.filter((x) => x.monthsLeft != null && x.monthsLeft <= 0.5)
        .sort((a, b) => a.monthsLeft - b.monthsLeft);
      if (urgent.length) add('🔴', '재고', `보름 내 소진 예상 ${urgent.length}품목 — ${urgent.slice(0, 3).map((x) => `${x.name}${x.color ? '(' + x.color + ')' : ''} ${x.monthsLeft}개월`).join(', ')} 외`);
      else add('🟡', '재고', `발주 필요 품목 ${items.length}개 (자세히: inventory mode=reorder)`);
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
  };

  const settled = await Promise.allSettled(Object.values(tasks));
  const 실패 = [];
  Object.keys(tasks).forEach((k, i) => { if (settled[i].status === 'rejected') 실패.push(`${k}: ${String(settled[i].reason && settled[i].reason.message).slice(0, 60)}`); });

  const sev = { '🔴': 0, '🟡': 1 };
  경보.sort((a, b) => sev[a.심각도] - sev[b.심각도]);

  return {
    기준일: y, 스캔시각: new Date().toISOString(),
    요약: 경보.length ? `경보 ${경보.length}건 (심각 ${경보.filter((a) => a.심각도 === '🔴').length})` : '이상 신호 없음 ✅',
    경보, 정상항목: 정상,
    ...(실패.length ? { 스캔실패: 실패 } : {}),
    주의: '기준일=어제(완성일). 임계치: 매출 전주동요일比 -30/-50% · 광고비 7일평균比 ±50% · ROAS 반토막 · 방문 -40% · 목표 페이스 70% 미만 · 재고 0.5개월 내 소진.',
  };
}

module.exports = { scan };
