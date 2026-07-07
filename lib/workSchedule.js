'use strict';

/**
 * 매니저 근무 스케줄 조회/집계 — OFFLINE_ORDER.workHours (오프라인 스케줄 관리 시스템 적재본).
 *   스키마: { work_date, store_name, manager_name, manager_role, category, annual_leave_type,
 *            clock_in, clock_out, break_minutes, work_hours, standard_hours, flex_delta }
 *   category: WORK(근무) WEEKLY_OFF(주휴) SUBSTITUTE_OFF(대체휴무) ANNUAL_LEAVE(연차)
 *             BREAK_ADJUSTMENT(휴게조정) FLEX_ADJUSTMENT(탄력조정) · leave: FULL/HALF_AM/HALF_PM
 *   미래 스케줄 포함(월 단위 사전 편성). 조회/분석 전용 — 편성·수정은 스케줄 앱에서.
 */

const store = require('./store');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const CAT_KO = { WORK: '근무', WEEKLY_OFF: '주휴', SUBSTITUTE_OFF: '대체휴무', ANNUAL_LEAVE: '연차', BREAK_ADJUSTMENT: '휴게조정', FLEX_ADJUSTMENT: '탄력조정' };
const LEAVE_KO = { FULL: '종일', HALF_AM: '오전반차', HALF_PM: '오후반차' };

function label(r) {
  const c = CAT_KO[r.category] || r.category || '';
  const l = LEAVE_KO[r.annual_leave_type];
  return l && (r.category === 'ANNUAL_LEAVE' || r.category === 'SUBSTITUTE_OFF') ? `${c}(${l})` : c;
}

// 기간 스케줄 조회 (+매장/매니저 필터) — 일별 행 + 매니저별/매장별 요약
async function schedule(start, end, { storeName, manager } = {}) {
  const c = await store.namedCollection('OFFLINE_ORDER', 'workHours');
  const q = { work_date: { $gte: start, $lte: end } };
  if (storeName) q.store_name = { $regex: String(storeName).trim(), $options: 'i' };
  if (manager) q.manager_name = { $regex: String(manager).trim(), $options: 'i' };
  const rows = await c.find(q, {
    projection: { work_date: 1, store_name: 1, manager_name: 1, manager_role: 1, category: 1, annual_leave_type: 1, clock_in: 1, clock_out: 1, break_minutes: 1, work_hours: 1, flex_delta: 1 },
  }).sort({ work_date: 1, store_name: 1, manager_name: 1 }).toArray();

  const daily = rows.map((r) => ({
    date: r.work_date, 매장: r.store_name, 매니저: r.manager_name, 역할: r.manager_role || '',
    구분: label(r), 출근: r.clock_in || '', 퇴근: r.clock_out || '',
    근무시간: N(r.work_hours), 휴게분: N(r.break_minutes),
  }));

  // 매니저별 요약: 근무일/총시간/휴무·연차 일수
  const byMgr = {};
  for (const r of rows) {
    const k = `${r.store_name}\t${r.manager_name}`;
    const m = (byMgr[k] = byMgr[k] || { 매장: r.store_name, 매니저: r.manager_name, 역할: r.manager_role || '', 근무일: 0, 총근무시간: 0, 주휴: 0, 연차: 0, 대체휴무: 0 });
    if (r.category === 'WORK') { m.근무일++; m.총근무시간 += N(r.work_hours); }
    else if (r.category === 'WEEKLY_OFF') m.주휴++;
    else if (r.category === 'ANNUAL_LEAVE') m.연차 += (r.annual_leave_type === 'FULL' ? 1 : 0.5);
    else if (r.category === 'SUBSTITUTE_OFF') m.대체휴무 += (r.annual_leave_type === 'FULL' ? 1 : 0.5);
  }
  const managers = Object.values(byMgr).map((m) => ({ ...m, 총근무시간: +m.총근무시간.toFixed(1) }))
    .sort((a, b) => a.매장.localeCompare(b.매장) || b.총근무시간 - a.총근무시간);

  // 매장×일자 근무 인원 (누가 언제 출근하는지 한눈에)
  const byStoreDate = {};
  for (const r of rows) {
    if (r.category !== 'WORK') continue;
    const k = `${r.work_date}\t${r.store_name}`;
    (byStoreDate[k] = byStoreDate[k] || []).push(`${r.manager_name}(${r.clock_in || '?'}~${r.clock_out || '?'})`);
  }
  const 매장별근무 = Object.entries(byStoreDate).map(([k, who]) => {
    const [date, sn] = k.split('\t');
    return { date, 매장: sn, 근무인원: who.length, 명단: who };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.매장.localeCompare(b.매장));

  return {
    start, end, 필터: { 매장: storeName || null, 매니저: manager || null },
    행수: daily.length,
    매니저별요약: managers,
    매장별근무: 매장별근무.length > 90 ? 매장별근무.slice(0, 90) : 매장별근무, // 응답 크기 가드
    일별상세: daily.length > 200 ? daily.slice(0, 200) : daily,
    주의: '조회/분석 전용(편성·수정은 스케줄 앱). 미래 날짜 = 사전 편성된 스케줄. 반차=0.5일 환산.',
  };
}

module.exports = { schedule };
