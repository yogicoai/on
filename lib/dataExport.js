'use strict';

/**
 * 외부 제공용 데이터 export — 오너/외부 분석자가 자기 시스템으로 가져가 가공하는 용도.
 *   4종: sales-online(이카운트 온라인) · sales-offline(오프라인 매장) · ads(광고) · stock(재고)
 *   ✅ 개인정보 없음: 매출은 상품/매장 단위 집계 원장, 재고는 품목 단위 (고객명·연락처·주소 미포함)
 *   출력: JSON 또는 CSV. 실시간 아님 — 매출은 매일 오전 9시, 광고 9시30분, 재고 10분 주기 동기화된 값.
 */

const store = require('./store');
const adEfficiency = require('./adEfficiency');
const forecast = require('./forecast');

const MAX_ROWS = 50000;
const ymd = (s) => String(s || '').slice(0, 10);

// ── 기간 자연어 파서 ──────────────────────────────────────────────
// "지난달", "2026년 7월", "최근 7일", "2026-07-01~2026-07-15", "6월부터" 등을 start/end로 변환.
// 모든 기준일은 KST — UTC 시각에 +9h 한 뒤 getUTC*로 읽으면 한국 달력값이 나온다(서버 TZ 무관).
const pad = (n) => String(n).padStart(2, '0');
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const mk = (y, m, d) => new Date(Date.UTC(y, m - 1, d)); // 월/일 범위 밖이면 Date.UTC가 자동 보정
const shift = (d, n) => new Date(d.getTime() + n * 86400000);

function parsePoint(s) {
  const now = kstNow();
  const Y = now.getUTCFullYear(), M = now.getUTCMonth() + 1, D = now.getUTCDate();
  const today = mk(Y, M, D);
  const day = (d, label) => ({ start: fmt(d), end: fmt(d), label });
  const span = (a, b, label) => ({ start: fmt(a), end: fmt(b), label });
  // m이 0이나 13이어도 Date.UTC가 보정 → 전월/익월 말일 계산에 그대로 사용
  const monthSpan = (y, m) => {
    const a = mk(y, m, 1), b = new Date(Date.UTC(y, m, 0));
    return span(a, b, `${a.getUTCFullYear()}년 ${a.getUTCMonth() + 1}월`);
  };

  if (/^(오늘|금일|today)$/.test(s)) return day(today, '오늘');
  if (/^(어제|전일|yesterday)$/.test(s)) return day(shift(today, -1), '어제');
  if (/^(그저께|그제)$/.test(s)) return day(shift(today, -2), '그저께');

  let m;
  if ((m = s.match(/^(?:최근|지난|last)(\d+)일(?:간)?$/)) || (m = s.match(/^last(\d+)days?$/))) {
    const n = +m[1]; return span(shift(today, -(n - 1)), today, `최근 ${n}일`);
  }
  if ((m = s.match(/^(?:최근|지난|last)(\d+)(?:개월|달)$/)) || (m = s.match(/^last(\d+)months?$/))) {
    const n = +m[1]; return span(mk(Y, M - n, D), today, `최근 ${n}개월`);
  }
  if (/^(이번주|금주|이번주간|thisweek)$/.test(s)) {
    const off = (today.getUTCDay() + 6) % 7; return span(shift(today, -off), today, '이번 주');
  }
  if (/^(지난주|저번주|전주|lastweek)$/.test(s)) {
    const off = (today.getUTCDay() + 6) % 7, mon = shift(today, -off - 7);
    return span(mon, shift(mon, 6), '지난주');
  }
  if (/^(이번달|이달|당월|금월|thismonth)$/.test(s)) return span(mk(Y, M, 1), today, '이번 달');
  if (/^(지난달|저번달|전월|lastmonth)$/.test(s)) return monthSpan(Y, M - 1);
  if (/^(올해|금년|thisyear)$/.test(s)) return span(mk(Y, 1, 1), today, `${Y}년`);
  if (/^(작년|지난해|전년|lastyear)$/.test(s)) return span(mk(Y - 1, 1, 1), mk(Y - 1, 12, 31), `${Y - 1}년`);

  // 절대 날짜 — 연·월·일 순으로 좁혀가며 매칭.
  // 월/일 구분자는 필수: optional로 두면 "2026-07"이 (월=0, 일=7)로 쪼개져 2025-12-07이 된다.
  const ckM = (v) => { if (v < 1 || v > 12) throw new Error(`월이 범위를 벗어났습니다: ${v}`); return v; };
  const ckD = (v) => { if (v < 1 || v > 31) throw new Error(`일이 범위를 벗어났습니다: ${v}`); return v; };
  if ((m = s.match(/^(\d{4})[-.년](\d{1,2})[-.월](\d{1,2})일?$/))) return day(mk(+m[1], ckM(+m[2]), ckD(+m[3])), `${+m[1]}년 ${+m[2]}월 ${+m[3]}일`);
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return day(mk(+m[1], ckM(+m[2]), ckD(+m[3])), `${+m[1]}-${m[2]}-${m[3]}`);
  if ((m = s.match(/^(\d{4})[-.년](\d{1,2})월?$/))) return monthSpan(+m[1], ckM(+m[2]));
  if ((m = s.match(/^(\d{4})년$/))) { const y = +m[1]; return span(mk(y, 1, 1), mk(y, 12, 31), `${y}년`); }
  if ((m = s.match(/^(\d{4})$/))) { const y = +m[1]; return span(mk(y, 1, 1), mk(y, 12, 31), `${y}년`); }
  if ((m = s.match(/^(\d{1,2})월(\d{1,2})일$/))) return day(mk(Y, ckM(+m[1]), ckD(+m[2])), `${Y}년 ${+m[1]}월 ${+m[2]}일`);
  if ((m = s.match(/^(\d{1,2})월$/))) return monthSpan(Y, ckM(+m[1])); // 연도 생략 → 올해

  throw new Error(`기간을 해석하지 못했습니다: "${s}"`);
}

function parsePeriod(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('period 값이 비어 있습니다');
  const s = raw.replace(/\s+/g, '');
  const today = fmt(kstNow());
  let out;

  // "2026-07-01-2026-07-15" — 구분자 '-'가 날짜 내부와 겹치므로 먼저 처리
  let m = s.match(/^(\d{4}[-.]\d{1,2}[-.]\d{1,2})-(\d{4}[-.]\d{1,2}[-.]\d{1,2})$/);
  if (!m) m = s.match(/^(.+?)(?:~|\.{2}|→|부터|에서|to)(.*?)(?:까지)?$/);
  if (m && m[1]) {
    const a = parsePoint(m[1]);
    // 끝이 비면("6월부터") 오늘까지
    const b = m[2] ? parsePoint(m[2]) : { end: today, label: '오늘' };
    out = { start: a.start, end: b.end, label: `${a.label} ~ ${b.label}` };
  } else {
    const p = parsePoint(s);
    out = { start: p.start, end: p.end, label: p.label };
  }

  if (out.start > out.end) throw new Error(`시작일(${out.start})이 종료일(${out.end})보다 뒤입니다`);
  if (out.end > today) out.end = today; // 미래 구간은 데이터가 없으므로 오늘로 자름
  return out;
}

// 이카운트 온라인 매출 (on.orders) — 출고일 기준
async function salesOnline(start, end) {
  const c = await store.namedCollection('on', 'orders');
  return c.find({ date: { $gte: ymd(start), $lte: ymd(end) } }, {
    projection: { _id: 0, orderNo: 1, date: 1, store: 1, productName: 1, color: 1, category: 1, beadType: 1, qty: 1, amount: 1, isSet: 1, isCover: 1 },
  }).sort({ date: 1 }).limit(MAX_ROWS).toArray();
}

// 오프라인 매장 매출 (off.orders)
async function salesOffline(start, end) {
  const c = await store.namedCollection('off', 'orders');
  return c.find({ date: { $gte: ymd(start), $lte: ymd(end) } }, {
    projection: { _id: 0, orderNo: 1, date: 1, store: 1, manager: 1, productName: 1, color: 1, category: 1, beadType: 1, qty: 1, amount: 1, isSet: 1, isCover: 1 },
  }).sort({ date: 1 }).limit(MAX_ROWS).toArray();
}

// 광고 (adboard.daily_stats) — 매체×일자
async function ads(start, end) {
  const rows = await adEfficiency.rows(start, end);
  return rows.map((r) => ({
    date: String(r.date).length === 8 ? `${String(r.date).slice(0, 4)}-${String(r.date).slice(4, 6)}-${String(r.date).slice(6, 8)}` : r.date,
    platform: r.platform, spend: r.spend, imp: r.imp, clk: r.clk, conv: r.conv, convValue: r.convValue,
  })).sort((a, b) => a.date.localeCompare(b.date));
}

// 재고 (실시간 동기화본) — 품목×색상
async function stock() {
  const [rows, at] = await Promise.all([forecast.stockList(), forecast.stockUpdatedAt().catch(() => null)]);
  return { updatedAt: at, items: rows.map((r) => ({ code: r.code, name: r.name, color: r.color, category: r.category, qty: r.qty })) };
}

const DATASETS = {
  'sales-online': { fn: salesOnline, range: true, desc: '이카운트 온라인 매출(출고일 기준) — 자사몰/스마트스토어/외부채널 상품 단위' },
  'sales-offline': { fn: salesOffline, range: true, desc: '오프라인 매장 매출 — 매장/판매사원/상품 단위' },
  ads: { fn: ads, range: true, desc: '광고 일별×매체 — 광고비·노출·클릭·전환·전환매출' },
  stock: { fn: stock, range: false, desc: '현재 재고 — 품목×색상 수량(약 10분 주기 동기화)' },
};

// CSV 변환 (UTF-8 BOM — 엑셀 한글 대응)
function toCsv(rows) {
  if (!rows.length) return '﻿';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

async function fetchDataset(name, opts = {}) {
  const d = DATASETS[name];
  if (!d) throw new Error(`알 수 없는 dataset: ${name} — 사용 가능: ${Object.keys(DATASETS).join(', ')}`);
  if (d.range) {
    let { start, end } = opts;
    let 기간해석 = null;
    if (opts.period) { const p = parsePeriod(opts.period); start = p.start; end = p.end; 기간해석 = p.label; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
      throw new Error('기간이 필요합니다 — period=<자연어> 또는 start/end=YYYY-MM-DD. 예: period=지난달, period=2026년 7월, period=최근 7일');
    }
    const rows = await d.fn(start, end);
    return {
      dataset: name, start, end, ...(기간해석 ? { 기간해석 } : {}),
      count: rows.length, rows,
      ...(rows.length >= MAX_ROWS ? { note: `상한 ${MAX_ROWS}행 — 기간을 좁혀 재요청하세요` } : {}),
    };
  }
  const r = await d.fn();
  return { dataset: name, ...r, count: (r.items || []).length };
}

function catalog() {
  return {
    datasets: Object.entries(DATASETS).map(([k, v]) => ({ dataset: k, 설명: v.desc, 기간필요: v.range })),
    사용법: 'GET /api/export?dataset=<이름>&period=<자연어>&format=json|csv (헤더: Authorization: Bearer <EXPORT_TOKEN>)',
    기간지정: {
      period: '자연어 기간(권장). start/end 대신 사용',
      'start/end': 'YYYY-MM-DD 직접 지정(기존 방식, 계속 지원)',
      예시: ['어제', '이번주', '지난주', '이번달', '지난달', '올해', '작년',
        '최근 7일', '최근 3개월', '2026년 7월', '2026-07', '7월', '2026년',
        '2026-07-01~2026-07-15', '6월부터', '2026년 5월부터 7월까지'],
      주의: '기준일은 KST. 미래 구간은 오늘까지로 잘림. 응답의 start/end/기간해석 필드로 실제 적용 구간을 확인할 것.',
    },
    주의: '고객 개인정보 미포함(집계 원장만). 실시간 아님 — 매출 매일 09:00, 광고 09:30, 재고 10분 주기 갱신.',
  };
}

module.exports = { fetchDataset, catalog, toCsv, parsePeriod, DATASETS };
