'use strict';

/**
 * 비즈어드바이저 마케팅채널 유입수 — 일별 × 채널 수집/조회.
 *
 *   소스: 네이버 비즈어드바이저 내부 리포트 API
 *     GET https://bizadvisor.naver.com/api/v3/sites/{site}/report
 *         ?useIndex=revenue-all-channel-detail
 *         &startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *         &dimensions=date_time&dimensions=mapped_channel_name   ← 일별 × 채널
 *         &metrics=num_interaction                               ← 유입수
 *         &service=biz_advisor
 *
 *   인증: 사용자가 브라우저에서 "Copy as cURL" 한 토큰/쿠키 (갱신 시 1회 전달, 서버 미저장).
 *   저장: on.bizInflow  { date, channel, inflow, updatedAt }  (유니크 키 date+channel)
 *
 *   ⚠️ 갱신(refresh)은 외부 API 호출 + DB 쓰기 → READ_ONLY 배포(Vercel)에선 POST 차단되어 동작 안 함.
 *      갱신은 로컬에서, 조회(query/summary)는 어디서나(같은 DB 공유).
 */

const store = require('./store');

const HOST = 'https://bizadvisor.naver.com';
const USE_INDEX = 'revenue-all-channel-detail';
const METRIC = 'num_interaction'; // 유입수 (유입당 결제율 = purchase_rate_by_interaction 이므로 interaction = 유입)
const SERVICE = 'biz_advisor';
const DB = 'on', COLL = 'bizInflow';

const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function coll() { return store.namedCollection(DB, COLL); }

// ── cURL 텍스트에서 token / cookie / site 추출 (bash·cmd·plain 호환) ──────────
function parseAuthFromCurl(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('cURL 텍스트가 비어있습니다');
  const token = (raw.match(/Bearer\s+([A-Za-z0-9+/=._\-]+)/) || [])[1];
  const site = (raw.match(/\/sites\/(s_[0-9]+)\//) || [])[1];

  let cookie = null;
  let m = raw.match(/-b\s+'([^']*)'/) || raw.match(/--cookie\s+'([^']*)'/);
  if (m) cookie = m[1];
  if (!cookie) { // Windows cmd 캐럿 이스케이프(^%^3A 등) 복원
    m = raw.match(/-b\s+\^"([\s\S]*?)\^"\s*\^/) || raw.match(/-b\s+\^"([\s\S]*?)\^"\s*$/m);
    if (m) cookie = m[1].replace(/\^/g, '').replace(/\\"/g, '"');
  }
  if (!cookie) { m = raw.match(/-b\s+"([^"]*)"/); if (m) cookie = m[1]; }

  if (!token) throw new Error('cURL에서 Bearer 토큰을 못 찾았습니다 ("Copy as cURL (bash)" 권장)');
  if (!site) throw new Error('cURL에서 사이트ID(s_…)를 못 찾았습니다');
  return { token, cookie, site };
}

function buildUrl(site, start, end) {
  const u = new URL(`${HOST}/api/v3/sites/${site}/report`);
  u.searchParams.set('useIndex', USE_INDEX);
  u.searchParams.set('startDate', start);
  u.searchParams.set('endDate', end);
  u.searchParams.append('dimensions', 'date_time');
  u.searchParams.append('dimensions', 'mapped_channel_name');
  u.searchParams.append('metrics', METRIC);
  u.searchParams.set('service', SERVICE);
  return u.toString();
}

async function callApi(auth, start, end) {
  const headers = { accept: 'application/json', authorization: `Bearer ${auth.token}` };
  if (auth.cookie) headers.cookie = auth.cookie;
  const r = await fetch(buildUrl(auth.site, start, end), { headers });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch (_) { throw new Error(`JSON 파싱 실패 (HTTP ${r.status}): ${txt.slice(0, 160)}`); }
  if (r.status === 401 || r.status === 403) throw new Error(`인증 실패(HTTP ${r.status}) — 토큰이 만료됐을 수 있어요. 신선한 cURL로 다시 받아주세요.`);
  if (r.status >= 400) throw new Error(`비즈어드바이저 HTTP ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return j;
}

// ── 응답 → [{date, channel, inflow}] (응답 구조를 모르므로 방어적으로) ─────────
function extractRows(j) {
  if (Array.isArray(j)) return j;
  const cands = [j && j.data, j && j.rows, j && j.result, j && j.data && j.data.rows, j && j.result && j.result.rows];
  for (const c of cands) if (Array.isArray(c) && c.length && typeof c[0] === 'object') return c;
  const found = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') found.push(v);
      else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(j, 0);
  return found.sort((a, b) => b.length - a.length)[0] || null;
}

function normDate(d) {
  if (d == null) return null;
  if (typeof d === 'number') { const dt = new Date(d > 1e12 ? d : d * 1000); return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`; }
  const s = String(d).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
}

function normRow(row) {
  const date = normDate(row.date_time ?? row.dateTime ?? row.date ?? row.dt ?? row.standardDateTime);
  const ch = row.mapped_channel_name ?? row.mappedChannelName ?? row.channel ?? row.channelName ?? row.channel_name;
  const inflow = row.num_interaction ?? row.numInteraction ?? row.inflow ?? row.value ?? row.metric;
  return { date, channel: ch != null ? String(ch) : '(미상)', inflow: Number(inflow) || 0 };
}

function parseRows(j) {
  const arr = extractRows(j);
  return arr ? arr.map(normRow).filter((r) => r.date && r.channel) : [];
}

// SCAN_FROM(년,월) ~ 오늘까지 월 단위 [{ym,start,end}]
function monthRanges(fromY, fromM) {
  const out = [];
  const now = new Date();
  let y = fromY, m = fromM;
  while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
    const start = `${y}-${pad(m)}-01`;
    const last = new Date(y, m, 0).getDate();
    let end = `${y}-${pad(m)}-${pad(last)}`;
    if (y === now.getFullYear() && m === now.getMonth() + 1) end = `${y}-${pad(m)}-${pad(now.getDate())}`;
    out.push({ ym: `${y}-${pad(m)}`, start, end });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// ── 갱신: cURL → fromYear-fromMonth ~ 오늘 월별 호출 → on.bizInflow upsert ───
async function refresh(curlOrAuth, opts = {}) {
  const auth = typeof curlOrAuth === 'string' ? parseAuthFromCurl(curlOrAuth) : curlOrAuth;
  const fromY = opts.fromYear || 2025, fromM = opts.fromMonth || 1;
  const months = monthRanges(fromY, fromM);
  const c = await coll();
  try { await c.createIndex({ date: 1, channel: 1 }, { unique: true }); } catch (_) {}

  let total = 0, firstWithData = null;
  const log = [];
  for (const mo of months) {
    let rows = [];
    try { rows = parseRows(await callApi(auth, mo.start, mo.end)); }
    catch (e) {
      log.push({ ym: mo.ym, error: e.message });
      if (/인증 실패/.test(e.message)) { e.partial = { firstWithData, totalRows: total, months: log }; throw e; }
      await sleep(280); continue;
    }
    if (rows.length) {
      if (!firstWithData) firstWithData = mo.ym;
      const now = new Date().toISOString();
      const ops = rows.map((r) => ({
        updateOne: {
          filter: { date: r.date, channel: r.channel },
          update: { $set: { date: r.date, channel: r.channel, inflow: r.inflow, updatedAt: now } },
          upsert: true,
        },
      }));
      await c.bulkWrite(ops, { ordered: false });
      total += rows.length;
    }
    log.push({ ym: mo.ym, rows: rows.length });
    await sleep(280);
  }
  return { ok: true, site: auth.site, firstWithData, totalRows: total, months: log };
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
  parseAuthFromCurl, buildUrl, callApi, parseRows, monthRanges,
  refresh, query, summary, coll,
};
