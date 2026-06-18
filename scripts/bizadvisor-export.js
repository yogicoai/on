'use strict';

/**
 * 비즈어드바이저 마케팅채널 유입수 — 일별 × 채널 벌크 추출
 *
 *   네이버 비즈어드바이저 내부 리포트 API:
 *     GET https://bizadvisor.naver.com/api/v3/sites/{siteId}/report
 *         ?useIndex=revenue-all-channel-detail
 *         &startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *         &dimensions=date_time&dimensions=mapped_channel_name   ← 일별 × 채널
 *         &metrics=num_interaction                               ← 유입수
 *         &service=biz_advisor
 *
 *   이 스크립트가 하는 일:
 *     1) scripts/bizadvisor-curl.txt 에서 인증(토큰+쿠키)을 읽음 (git 미추적)
 *     2) 2024-01 부터 오늘까지 "월 단위"로 호출 → 가장 오래된 데이터 자동 탐지
 *     3) 전체를 모아 JSON + CSV(엑셀용, UTF-8 BOM)로 저장
 *
 *   사용법:
 *     1) DevTools Network 에서 report?useIndex= 요청 우클릭 → Copy → "Copy as cURL (bash)"
 *     2) 그 내용을 scripts/bizadvisor-curl.txt 에 통째로 붙여넣고 저장
 *     3) node scripts/bizadvisor-export.js
 *
 *   ⚠️ bizadvisor-curl.txt 에는 로그인 토큰/쿠키가 들어있습니다 → 절대 커밋 금지(.gitignore 처리됨).
 *      실행 후 비즈어드바이저 로그아웃→재로그인으로 세션을 갈아주세요.
 */

const fs = require('fs');
const path = require('path');

const AUTH_FILE = path.join(__dirname, 'bizadvisor-curl.txt');
const OUT_DIR = path.join(__dirname, '..', 'bizadvisor_out');

const SCAN_FROM = { y: 2025, m: 1 };          // 2024년은 비즈어드바이저에 데이터 미보관 → 2025-01부터 수집
const METRIC = 'num_interaction';             // 유입수
const USE_INDEX = 'revenue-all-channel-detail';
const THROTTLE_MS = 280;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');

// ── 인증 로드 (bash / cmd / plain cURL 모두 best-effort 파싱) ──────────────
function loadAuth() {
  if (!fs.existsSync(AUTH_FILE)) {
    console.error(`\n❌ ${AUTH_FILE} 가 없습니다.`);
    console.error('   DevTools → report?useIndex= 요청 우클릭 → Copy → "Copy as cURL (bash)"');
    console.error('   → 그 내용을 위 파일에 붙여넣고 저장한 뒤 다시 실행하세요.\n');
    process.exit(1);
  }
  const raw = fs.readFileSync(AUTH_FILE, 'utf8');

  const token = (raw.match(/Bearer\s+([A-Za-z0-9+/=._\-]+)/) || [])[1];
  const site = (raw.match(/\/sites\/(s_[0-9]+)\//) || [])[1];

  // 쿠키: bash('...') → cmd(^"...^") → plain("...") 순서로 시도
  let cookie = null;
  let m = raw.match(/-b\s+'([^']*)'/) || raw.match(/--cookie\s+'([^']*)'/);
  if (m) cookie = m[1];
  if (!cookie) {
    m = raw.match(/-b\s+\^"([\s\S]*?)\^"\s*\^/) || raw.match(/-b\s+\^"([\s\S]*?)\^"\s*$/m);
    if (m) cookie = m[1].replace(/\^/g, '').replace(/\\"/g, '"'); // cmd 캐럿 이스케이프 복원
  }
  if (!cookie) { m = raw.match(/-b\s+"([^"]*)"/); if (m) cookie = m[1]; }

  if (!token || !site) {
    console.error('\n❌ 토큰 또는 사이트ID를 cURL에서 못 찾았습니다.');
    console.error(`   token=${token ? 'OK' : '없음'}  site=${site || '없음'}`);
    console.error('   "Copy as cURL (bash)" 로 다시 복사해서 붙여넣어 주세요.\n');
    process.exit(1);
  }
  return { token, cookie, site };
}

function buildUrl(site, start, end) {
  const u = new URL(`https://bizadvisor.naver.com/api/v3/sites/${site}/report`);
  u.searchParams.set('useIndex', USE_INDEX);
  u.searchParams.set('startDate', start);
  u.searchParams.set('endDate', end);
  u.searchParams.append('dimensions', 'date_time');
  u.searchParams.append('dimensions', 'mapped_channel_name');
  u.searchParams.append('metrics', METRIC);
  u.searchParams.set('service', 'biz_advisor');
  return u.toString();
}

async function call(auth, start, end) {
  const url = buildUrl(auth.site, start, end);
  const headers = { accept: 'application/json', authorization: `Bearer ${auth.token}` };
  if (auth.cookie) headers.cookie = auth.cookie;
  const r = await fetch(url, { headers });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch (_) { throw new Error(`JSON 파싱 실패 (HTTP ${r.status}): ${txt.slice(0, 200)}`); }
  if (r.status === 401 || r.status === 403) {
    throw new Error(`인증 실패 (HTTP ${r.status}) — 토큰이 만료됐을 수 있어요. 신선한 cURL로 다시 받아주세요. ${JSON.stringify(j).slice(0, 160)}`);
  }
  if (r.status >= 400) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// ── 응답에서 행 배열 찾기 (구조를 모르므로 방어적으로) ──────────────────────
function extractRows(j) {
  if (Array.isArray(j)) return j;
  const cands = [j.data, j.rows, j.result, j && j.data && j.data.rows, j && j.result && j.result.rows];
  for (const c of cands) if (Array.isArray(c) && c.length && typeof c[0] === 'object') return c;
  // 아무 곳이나 "객체들의 배열"을 1차로 탐색
  const seen = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') seen.push(v);
      else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(j, 0);
  return seen.sort((a, b) => b.length - a.length)[0] || null;
}

function normDate(d) {
  if (d == null) return null;
  if (typeof d === 'number') { // epoch?
    const dt = new Date(d > 1e12 ? d : d * 1000);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }
  let s = String(d).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10); // ISO 등에서 날짜부만
}

function normRow(row) {
  const date = normDate(row.date_time ?? row.dateTime ?? row.date ?? row.dt ?? row.standardDateTime);
  const channel = row.mapped_channel_name ?? row.mappedChannelName ?? row.channel ?? row.channelName ?? row.channel_name;
  const inflowRaw = row.num_interaction ?? row.numInteraction ?? row.inflow ?? row.value ?? row.metric;
  return { date, channel: channel != null ? String(channel) : '(미상)', inflow: Number(inflowRaw) || 0 };
}

// ── 월 목록 (SCAN_FROM ~ 오늘) ───────────────────────────────────────────
function monthList() {
  const out = [];
  const now = new Date();
  let y = SCAN_FROM.y, m = SCAN_FROM.m;
  while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
    const start = `${y}-${pad(m)}-01`;
    const last = new Date(y, m, 0).getDate();
    let end = `${y}-${pad(m)}-${pad(last)}`;
    if (y === now.getFullYear() && m === now.getMonth() + 1) end = `${y}-${pad(m)}-${pad(now.getDate())}`; // 이번 달은 오늘까지
    out.push({ ym: `${y}-${pad(m)}`, start, end });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function toCsvPivot(rows) {
  const channels = [...new Set(rows.map((r) => r.channel))].sort();
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, {});
    byDate.get(r.date)[r.channel] = (byDate.get(r.date)[r.channel] || 0) + r.inflow;
  }
  const dates = [...byDate.keys()].sort();
  const head = ['날짜', ...channels, '총합계'];
  const lines = [head.join(',')];
  for (const d of dates) {
    const o = byDate.get(d);
    let sum = 0;
    const cells = channels.map((c) => { const v = o[c] || 0; sum += v; return v; });
    lines.push([d, ...cells, sum].join(','));
  }
  return '﻿' + lines.join('\r\n'); // 엑셀용 BOM + CRLF
}

(async () => {
  console.log('\n=== 비즈어드바이저 마케팅채널 유입수 추출 ===\n');
  const auth = loadAuth();
  console.log(`✅ 인증 로드: site=${auth.site}  token=${auth.token.slice(0, 8)}…  cookie=${auth.cookie ? 'O' : 'X'}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const months = monthList();
  console.log(`📅 스캔 범위: ${months[0].ym} ~ ${months[months.length - 1].ym} (${months.length}개월)\n`);

  const all = [];
  let firstWithData = null;
  let probeSaved = false;

  for (const mo of months) {
    try {
      const j = await call(auth, mo.start, mo.end);
      if (!probeSaved) { // 첫 응답 원본 저장 → 구조 확인용
        fs.writeFileSync(path.join(OUT_DIR, 'sample-response.json'), JSON.stringify(j, null, 2));
        probeSaved = true;
      }
      const rows = extractRows(j);
      if (!rows) { console.log(`  ${mo.ym}: ⚠️ 행 배열을 못 찾음(구조 확인 필요 → sample-response.json)`); await sleep(THROTTLE_MS); continue; }
      const norm = rows.map(normRow).filter((r) => r.date);
      if (norm.length) { all.push(...norm); if (!firstWithData) firstWithData = mo.ym; }
      console.log(`  ${mo.ym}: ${norm.length}행${norm.length ? '' : ' (데이터 없음)'}`);
    } catch (e) {
      console.log(`  ${mo.ym}: ❌ ${e.message}`);
      if (/인증 실패/.test(e.message)) { console.error('\n토큰 만료로 중단합니다. 신선한 cURL 받아 다시 실행하세요.\n'); break; }
    }
    await sleep(THROTTLE_MS);
  }

  if (!all.length) {
    console.log('\n⚠️ 수집된 데이터가 없습니다. sample-response.json 의 구조를 확인해 주세요.\n');
    process.exit(0);
  }

  const dates = [...new Set(all.map((r) => r.date))].sort();
  const channels = [...new Set(all.map((r) => r.channel))];
  const from = dates[0], to = dates[dates.length - 1];
  const base = `bizadvisor_inflow_${from}_${to}`;

  fs.writeFileSync(path.join(OUT_DIR, base + '.json'),
    JSON.stringify({ metric: '유입수(num_interaction)', from, to, channels, rows: all }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, base + '.csv'), toCsvPivot(all));

  console.log('\n──────────────────────────────────────');
  console.log(`✅ 완료!  가장 오래된 데이터: ${firstWithData}  (요청 시작: ${SCAN_FROM.y}-${pad(SCAN_FROM.m)})`);
  console.log(`   기간: ${from} ~ ${to}  ·  일수 ${dates.length}  ·  채널 ${channels.length}  ·  총 ${all.length}행`);
  console.log(`   📄 ${path.join(OUT_DIR, base + '.json')}`);
  console.log(`   📊 ${path.join(OUT_DIR, base + '.csv')}  (엑셀에서 더블클릭으로 열림)`);
  console.log('──────────────────────────────────────');
  console.log('🔒 실행 끝났으면 비즈어드바이저 로그아웃→재로그인으로 세션을 갈아주세요.\n');
})().catch((e) => { console.error('\n💥', e.message, '\n'); process.exit(1); });
