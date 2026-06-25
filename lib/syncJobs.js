'use strict';

/**
 * 동기화 작업 러너 — 항상 켜진 호스트(cloudtype)에서 무거운 적재/재취합을 1회 실행하고
 * 그 진행상태를 메모리에 보관한다.
 *   ▸ Vercel 은 고정 IP 가 없고(네이버 커머스 API 차단) 서버리스 60초 제한이 있어
 *     스마트스토어 적재·쿠폰 적재 같은 무거운 작업을 직접 못 한다.
 *   ▸ 대신 Vercel 버튼이 cloudtype 의 /sync/run 을 호출하면, 이 러너가 백그라운드로 1회 실행한다.
 *     모든 사용자가 버튼 하나로 트리거할 수 있고(공유), 진행상태는 /sync/status 로 폴링한다.
 *
 *   start(task, params): 작업 시작. 이미 실행 중이면 그 작업을 그대로 반환(= 중복 클릭/동시 클릭 방지).
 *   status(): 현재(실행 중) 또는 마지막으로 끝난 작업 스냅샷.
 *
 *   task: 'today'   → dailySync.runToday()            오늘 주문(Cafe24+스마트스토어) 적재 + 오늘 구간 갱신
 *         'daily'   → dailySync.runDaily({days})       최근 N일 Cafe24+스마트스토어 적재 + 캐시 워밍
 *         'coupons' → coupons.syncCouponNamesFromOrders(start,end)  주문→쿠폰명 매핑 적재
 */

const dailySync = require('./dailySync');

let JOB = null;   // 현재 실행 중인 작업(없으면 null)
let LAST = null;  // 마지막으로 끝난 작업(완료 후에도 status 로 결과 확인용)
let SEQ = 0;

function snap(j) {
  if (!j) return null;
  return {
    id: j.id, task: j.task, params: j.params, status: j.status,
    startedAt: j.startedAt, finishedAt: j.finishedAt, elapsedMs: j.elapsedMs || null,
    error: j.error, log: (j.log || []).slice(-40), result: j.result || null,
  };
}

async function _run(j) {
  const log = (m) => { j.log.push(`${new Date().toISOString().slice(11, 19)} ${m}`); console.log(`[sync:${j.id}] ${m}`); };
  try {
    if (j.task === 'today') {
      j.result = await dailySync.runToday({ log });
    } else if (j.task === 'daily') {
      j.result = await dailySync.runDaily({ days: Math.min(Number(j.params.days) || 7, 31), log });
    } else if (j.task === 'coupons') {
      const coupons = require('./coupons');
      const { start, end } = j.params;
      if (!start || !end) throw new Error('coupons: start/end 필요');
      j.result = await coupons.syncCouponNamesFromOrders(start, end, {
        onProgress: (p) => { if (p.done % 40 === 0) log(`쿠폰 ${p.done}/${p.total} · 매핑 ${p.mapped}`); },
      });
    } else {
      throw new Error('알 수 없는 task: ' + j.task);
    }
    j.status = 'done';
    log('✓ 완료');
  } catch (e) {
    j.status = 'error'; j.error = e.message; log('✗ ' + e.message);
  } finally {
    j.finishedAt = new Date().toISOString();
    j.elapsedMs = Date.now() - j._t0;
    LAST = j; JOB = null;
  }
}

// 작업 시작. 이미 같은/다른 작업이 실행 중이면 새로 띄우지 않고 진행 중인 작업을 반환(중복 방지).
function start(task, params = {}) {
  if (!['today', 'daily', 'coupons'].includes(task)) {
    return { started: false, error: '지원하지 않는 task: ' + task };
  }
  if (JOB) return { started: false, already: true, job: snap(JOB) };
  const j = {
    id: `${task}-${++SEQ}`, task, params, status: 'running',
    startedAt: new Date().toISOString(), finishedAt: null, error: null,
    log: [], result: null, _t0: Date.now(),
  };
  JOB = j;
  _run(j); // 의도적으로 await 하지 않음 — 백그라운드로 돌리고 즉시 반환
  return { started: true, job: snap(j) };
}

function status() {
  return { running: !!JOB, job: snap(JOB || LAST) };
}

module.exports = { start, status, snap };
