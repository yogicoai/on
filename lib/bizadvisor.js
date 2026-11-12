'use strict';

/**
 * 스마트스토어 유입수 — 일별 × 경로 수집/조회.
 *
 *   비즈어드바이저가 종료돼 2026-10-30부터 스토어분석(방문 분석)으로 받는다.
 *     POST https://sell.smartstore.naver.com/api/v1/seller-insight/store-analytics/metrics/query
 *          reportType=VISIT · searchType=COUNT · interval=TOTAL · startDate=endDate=그날 → 경로(3단계)별 방문수
 *
 *   ⚠️ 2026-10-30부터의 inflow 는 실측이 아니라 예전 유입수로 환산한 추정값이다.
 *      스토어분석 방문수는 상품 상세 방문만 세고 예전 유입수와 지표가 달라 그대로 쓰면 구매율이 낮아진다.
 *      과거 기준을 이어 가기로 해서(사용자 2026-11-04) 방문수 × INFLOW_PER_VISIT 로 환산한다. 원본은 visits 에 함께 저장.
 *      비율 0.61 대조: 2026-10-05~29 하루 오차 평균 8.5%(프로모션 10/23~25는 25~30% 낮게), 2026년 월 합계 오차 ±7% 이내.
 *      '스토어 내부'만 빼는 방식은 쓰지 않는다 — 그 경로가 2026-07에야 늘어나 7월 전후로 숫자가 끊긴다.
 *
 *   인증: 사용자가 브라우저에서 복사한 cURL 의 로그인 쿠키 (갱신 시 1회 전달, 서버 미저장).
 *   저장: on.bizInflow  { date, channel, inflow, visits, source, updatedAt }  (유니크 키 date+channel)
 *         FIRST_DATE 이전은 비즈어드바이저 실측이라 덮어쓰지 않는다.
 *
 *   ⚠️ 함수 최대 실행시간이 60초라 한 번에 받는 기간은 지난달 1일부터로 제한한다(입력 창 선택지).
 */

const store = require('./store');

const HOST = 'https://sell.smartstore.naver.com';
const QUERY_URL = `${HOST}/api/v1/seller-insight/store-analytics/metrics/query`;
const VISIT_PAGE = `${HOST}/mg/insight/store-analytics/visit`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const PAGE_SIZE = 100; // 200은 400으로 거절된다
const SOURCE = 'store-analytics';
const DB = 'on', COLL = 'bizInflow';
const FIRST_DATE = '2026-10-30'; // 비즈어드바이저 마지막 수집 다음 날
const INFLOW_PER_VISIT = 0.61;   // 예전 유입수 ÷ 스토어분석 방문수

const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function coll() { return store.namedCollection(DB, COLL); }

// ── cURL 텍스트에서 로그인 쿠키 추출 (bash·cmd 호환) ─────────────────────────
function parseAuthFromCurl(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('cURL 텍스트가 비어있습니다');
  if (!/store-analytics/.test(raw)) throw new Error('스토어분석 요청의 cURL이 아닙니다 (방문 분석 화면의 query 요청을 복사해 주세요)');

  let cookie = null;
  let m = raw.match(/-b\s+\$?'([^']*)'/) || raw.match(/--cookie\s+\$?'([^']*)'/) || raw.match(/-H\s+\$?'cookie:\s*([^']*)'/i);
  if (m) cookie = m[1];
  if (!cookie) { // Windows cmd 캐럿 이스케이프(^%^3A 등) 복원
    m = raw.match(/-b\s+\^"([\s\S]*?)\^"\s*\^/) || raw.match(/-b\s+\^"([\s\S]*?)\^"\s*$/m);
    if (m) cookie = m[1].replace(/\^/g, '').replace(/\\"/g, '"');
  }
  if (!cookie) { m = raw.match(/-b\s+"([^"]*)"/); if (m) cookie = m[1]; }

  if (!cookie) throw new Error('cURL에서 로그인 쿠키를 못 찾았습니다 ("cURL(bash)로 복사" 권장)');
  return { cookie };
}

const AUTH_ERROR = '인증 실패 — 로그인이 만료됐을 수 있어요. 방문 분석 화면을 새로고침하고 cURL을 다시 복사해 주세요.';

async function callApi(auth, date, page = 0) {
  const r = await fetch(QUERY_URL, {
    method: 'POST',
    redirect: 'manual', // 로그인 만료면 로그인 페이지로 보내므로 따라가지 않고 인증 실패로 본다
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      cookie: auth.cookie,
      origin: HOST,
      referer: VISIT_PAGE,
      'x-current-state': VISIT_PAGE,
      'x-site-preference': 'NORMAL',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({
      expandChannelProducts: false, reportType: 'VISIT', dimensionType: 'L1', dimensionKey: 'ALL', searchType: 'COUNT',
      startDate: date, endDate: date, interval: 'TOTAL', page, size: PAGE_SIZE, sortField: 'VISIT_COUNT', sortDirection: 'DESC',
    }),
  });
  if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) throw new Error(`${AUTH_ERROR} (HTTP ${r.status})`);
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch (_) { throw new Error(`${AUTH_ERROR} (HTTP ${r.status})`); }
  if (r.status >= 400) throw new Error(`스토어분석 HTTP ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return j;
}

// ── 응답 → { total, rows:[{channel, visits}] } ─ 첫 행(ALL)은 그날 합계라 경로 행과 나눈다 ─
function parseRows(j) {
  let total = null;
  const rows = [];
  for (const m of (j && j.metrics) || []) {
    const d = m.dimension || {};
    const visits = Number(m.visitCount) || 0;
    if (d.path1Name === 'ALL') { total = visits; continue; }
    rows.push({ channel: [d.path1Name, d.path2Name, d.path3Name].filter(Boolean).join(' > ') || '(미상)', visits });
  }
  return { total, rows };
}

// 경로별로 따로 반올림하면 합이 틀어지므로, 하루 합(방문수 × 비율)에 맞춰 나머지가 큰 경로부터 1씩 더 준다.
function toInflow(rows) {
  const sum = rows.reduce((s, r) => s + r.visits, 0);
  const exact = rows.map((r) => r.visits * INFLOW_PER_VISIT);
  const out = rows.map((r, i) => ({ ...r, inflow: Math.floor(exact[i]) }));
  let left = Math.round(sum * INFLOW_PER_VISIT) - out.reduce((s, r) => s + r.inflow, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; out[i].inflow += 1; left -= 1; }
  return out;
}

async function fetchDay(auth, date) {
  const first = await callApi(auth, date);
  const { total, rows } = parseRows(first);
  for (let page = 1; page * PAGE_SIZE < (first.totalCount || 0); page++) {
    rows.push(...parseRows(await callApi(auth, date, page)).rows);
  }
  return { total, rows };
}

function daysBetween(start, end) {
  const out = [];
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}
const kstYesterday = () => new Date(Date.now() + 9 * 3600e3 - 86400e3).toISOString().slice(0, 10);

// ── 갱신: cURL → 시작일 ~ 어제 하루씩 호출 → on.bizInflow upsert ─────────────
async function refresh(curlOrAuth, opts = {}) {
  const auth = typeof curlOrAuth === 'string' ? parseAuthFromCurl(curlOrAuth) : curlOrAuth;
  const asked = opts.fromYear && opts.fromMonth ? `${opts.fromYear}-${pad(opts.fromMonth)}-01` : FIRST_DATE;
  const start = asked < FIRST_DATE ? FIRST_DATE : asked; // 실측 구간은 덮어쓰지 않는다
  const c = await coll();
  try { await c.createIndex({ date: 1, channel: 1 }, { unique: true }); } catch (_) {}

  let total = 0, firstWithData = null, lastDate = null;
  const missing = []; // 저장하지 못한 날 { date, why } — 입력 창이 그대로 보여 준다
  const byMonth = new Map();
  const add = (ym, n) => { const o = byMonth.get(ym) || { ym, rows: 0 }; o.rows += n; byMonth.set(ym, o); };
  const months = () => [...byMonth.values()];

  for (const date of daysBetween(start, kstYesterday())) {
    const ym = date.slice(0, 7);
    let day;
    try { day = await fetchDay(auth, date); }
    catch (e) {
      if (/인증 실패/.test(e.message)) { e.partial = { firstWithData, totalRows: total, months: months() }; throw e; }
      missing.push({ date, why: e.message });
      await sleep(150); continue;
    }
    if (!day.rows.length || !day.total) missing.push({ date, why: '네이버 집계 전' });
    else {
      if (!firstWithData) firstWithData = date;
      lastDate = date;
      const rows = toInflow(day.rows);
      const now = new Date().toISOString();
      await c.bulkWrite(rows.map((r) => ({
        updateOne: {
          filter: { date, channel: r.channel },
          update: { $set: { date, channel: r.channel, inflow: r.inflow, visits: r.visits, source: SOURCE, updatedAt: now } },
          upsert: true,
        },
      })), { ordered: false });
      await c.deleteMany({ date, channel: { $nin: rows.map((r) => r.channel) } }); // 그날 사라진 경로·옛 소스 빈 행
      total += rows.length;
      add(ym, rows.length);
    }
    await sleep(150);
  }
  return { ok: true, source: SOURCE, from: start, factor: INFLOW_PER_VISIT, firstWithData, lastDate, totalRows: total, months: months(), missing };
}

// ── 조회: on.bizInflow [start,end] 원본 행 ──────────────────────────────────
async function query(start, end) {
  const c = await coll();
  const m = {};
  if (start || end) { m.date = {}; if (start) m.date.$gte = start; if (end) m.date.$lte = end; }
  return c.find(m, { projection: { _id: 0, date: 1, channel: 1, inflow: 1 } }).sort({ date: 1 }).toArray();
}

// ── 요약: 차트/표/CSV 용 피벗 ({channels, days:[{date,total,ch}], totalsByChannel, ...}) ─
async function summary(start, end) {
  const rows = await query(start, end);
  const totalsByChannel = {};
  for (const r of rows) totalsByChannel[r.channel] = (totalsByChannel[r.channel] || 0) + (r.inflow || 0);
  const channels = Object.keys(totalsByChannel).sort((a, b) => totalsByChannel[b] - totalsByChannel[a]);

  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, {});
    const o = byDate.get(r.date);
    o[r.channel] = (o[r.channel] || 0) + (r.inflow || 0);
  }
  const days = [...byDate.keys()].sort().map((date) => {
    const ch = byDate.get(date);
    let total = 0; for (const k in ch) total += ch[k];
    return { date, total, ch };
  });
  const grandTotal = channels.reduce((s, c) => s + totalsByChannel[c], 0);
  const latestDate = days.length ? days[days.length - 1].date : null;
  return {
    from: days.length ? days[0].date : (start || null),
    to: latestDate || (end || null),
    channels, days, totalsByChannel, grandTotal, latestDate, count: rows.length,
  };
}

module.exports = {
  parseAuthFromCurl, callApi, parseRows, toInflow,
  refresh, query, summary, coll,
  FIRST_DATE, INFLOW_PER_VISIT,
};
