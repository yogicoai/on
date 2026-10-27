'use strict';

/**
 * onlineData 야간 동기화 예약 — 항상 켜진 MCP 서버(클라우드타입 yogibo-onmcp)에서 돈다.
 * (2026-10, yChat onlinesync/cron.js 에서 옮겨 옴. yChat을 끄면서 이 서버가 이어받는다)
 *
 *   매일 00:05(KST)에 별도 자식 프로세스로 scripts/daily-sync.js 를 실행한다
 *   (최근 7일 Cafe24 + 스마트스토어 적재 → 캐시·쿠폰 funnel 워밍).
 *     · 자식 프로세스라 MCP 응답(이벤트 루프·메모리)에 영향을 주지 않는다.
 *     · onlineData 날짜 계산은 한국 시간을 전제로 하므로 자식에 TZ=Asia/Seoul 을 넣는다(컨테이너는 UTC일 수 있음).
 *     · 30분이 넘으면 강제 종료해 다음 날 실행이 막히지 않게 한다.
 *   이 예약을 켜는 날 yChat을 끄거나 yChat의 ENABLE_ONLINE_SYNC 를 지워 같은 밤에 두 번 돌지 않게 한다.
 *
 *   켜기: ENABLE_ONLINE_SYNC=1 (없으면 아무것도 예약하지 않는다)
 *   옵션: ONLINE_SYNC_DAYS(기본 7), ONLINE_SYNC_TIMEOUT_MS(기본 30분), ONLINE_SYNC_ON_BOOT=1(서버 시작 10초 뒤 1회 — 첫 확인용)
 *   필요한 환경변수는 버튼 동기화(/sync/run)와 같다: CAFE24_TOKEN_URI · CAFE24_TOKEN_DB · CAFE24_TOKEN_COLLECTION ·
 *   CAFE24_MALL_ID · NAVER_COMMERCE_CLIENT_ID · NAVER_COMMERCE_CLIENT_SECRET
 */

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'daily-sync.js');
const KST_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let running = false;
// /health 로 보여 줄 상태 — 켜졌는지, 다음 실행 시각, 마지막 결과 (비밀값 없음)
const state = { enabled: false, nextRunAt: null, last: null };

// 다음 KST 00:05 까지 남은 ms — 매번 다시 계산해서 하루 간격이 밀리지 않게 한다
function msUntilNext0005KST(now = new Date()) {
  const k = new Date(now.getTime() + KST_MS);   // KST 벽시계를 UTC 필드로 읽는다
  const today0005 = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), 0, 5, 0) - KST_MS;
  const next = today0005 > now.getTime() ? today0005 : today0005 + DAY_MS;
  return next - now.getTime();
}

function runDailySync(reason) {
  if (running) { console.log(`[nightly-sync] 이미 진행 중 → ${reason} 건너뜀`); return; }
  running = true;
  const startedAt = new Date().toISOString();
  const days = process.env.ONLINE_SYNC_DAYS || '7';
  console.log(`[nightly-sync] 일일 동기화 시작 (${reason}) — 최근 ${days}일`);
  const child = spawn(process.execPath, [SCRIPT, days], {
    cwd: ROOT,
    env: { ...process.env, TZ: 'Asia/Seoul' },
    stdio: 'inherit',
  });
  const MAX_MS = Number(process.env.ONLINE_SYNC_TIMEOUT_MS || 30 * 60 * 1000);
  const watchdog = setTimeout(() => {
    console.error(`[nightly-sync] ⏱ ${Math.round(MAX_MS / 60000)}분 초과 → 강제 종료`);
    try { child.kill('SIGKILL'); } catch (_) {}
  }, MAX_MS);
  child.on('exit', (code) => {
    clearTimeout(watchdog); running = false;
    state.last = { reason, startedAt, finishedAt: new Date().toISOString(), code };
    if (code === 0) console.log(`[nightly-sync] ✅ 정상 종료 (${reason})`);
    else console.error(`[nightly-sync] ❌ 실패 종료 code=${code} (${reason}) — 캐시가 갱신되지 않았을 수 있음`);
  });
  child.on('error', (e) => {
    clearTimeout(watchdog); running = false;
    state.last = { reason, startedAt, finishedAt: new Date().toISOString(), error: e.message };
    console.error('[nightly-sync] 자식 프로세스 실행 오류:', e.message);
  });
}

// ── 스마트스토어 매시 동기화 — CS 주문 조회(상태·송장)를 하루 1번보다 빨리 맞춘다.
//   켜기: ENABLE_SMARTSTORE_HOURLY=1 (야간 동기화와 따로 켠다) · SMARTSTORE_HOURLY_HOURS(기본 2시간 창)
const RECENT_SCRIPT = path.join(ROOT, 'scripts', 'sync-smartstore-recent.js');
const HOUR_MS = 60 * 60 * 1000;
let hourlyRunning = false;
const hourly = { enabled: false, nextRunAt: null, last: null };

function runHourly() {
  // 야간 전체 동기화가 도는 중이면 스마트스토어도 그때 같이 적재되므로 건너뛴다.
  if (running || hourlyRunning) return;
  hourlyRunning = true;
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [RECENT_SCRIPT, process.env.SMARTSTORE_HOURLY_HOURS || '2'], {
    cwd: ROOT,
    env: { ...process.env, TZ: 'Asia/Seoul' },
    stdio: 'inherit',
  });
  const watchdog = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 10 * 60 * 1000);
  const done = (result) => {
    clearTimeout(watchdog); hourlyRunning = false;
    hourly.last = { startedAt, finishedAt: new Date().toISOString(), ...result };
  };
  child.on('exit', (code) => done({ code }));
  child.on('error', (e) => done({ error: e.message }));
}

function startHourly() {
  if (process.env.ENABLE_SMARTSTORE_HOURLY !== '1') return;
  hourly.enabled = true;
  const tick = () => { runHourly(); hourly.nextRunAt = new Date(Date.now() + HOUR_MS).toISOString(); };
  hourly.nextRunAt = new Date(Date.now() + 60 * 1000).toISOString();
  setTimeout(() => { tick(); setInterval(tick, HOUR_MS); }, 60 * 1000);
  console.log('[smartstore-hourly] 매시 스마트스토어 최근 변경분 동기화 켜짐');
}

function start() {
  startHourly();
  if (process.env.ENABLE_ONLINE_SYNC !== '1') {
    console.log('[nightly-sync] ENABLE_ONLINE_SYNC!=1 → 야간 동기화 꺼짐 (켜면 매일 00:05 KST)');
    return;
  }
  state.enabled = true;
  const schedule = () => {
    const wait = msUntilNext0005KST();
    state.nextRunAt = new Date(Date.now() + wait).toISOString();
    setTimeout(() => { runDailySync('매일 00:05 KST'); schedule(); }, wait);
    console.log(`[nightly-sync] 다음 실행까지 ${Math.round(wait / 60000)}분`);
  };
  schedule();
  if (process.env.ONLINE_SYNC_ON_BOOT === '1') setTimeout(() => runDailySync('서버 시작(첫 확인)'), 10000);
}

function status() {
  return { ...state, running, smartstoreHourly: { ...hourly, running: hourlyRunning } };
}

module.exports = { start, runDailySync, msUntilNext0005KST, status };
