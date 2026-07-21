'use strict';

/**
 * 기간 자연어 파서 — "지난달", "2026년 7월", "최근 7일", "2026-07-01~2026-07-15", "6월부터" 등을
 * { start, end, label }(YYYY-MM-DD)로 변환. export API·MCP 도구 공용.
 *
 *   모든 기준일은 KST — UTC 시각에 +9h 한 뒤 getUTC*로 읽으면 한국 달력값이 나온다(서버 TZ 무관).
 *   미래 구간은 데이터가 없으므로 오늘로 자른다. 해석 불가·역전 구간은 명시적 에러.
 */

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

// 오늘(KST) YYYY-MM-DD — 상대 기본값 계산용
function todayKst() { return fmt(kstNow()); }

module.exports = { parsePeriod, parsePoint, todayKst };
