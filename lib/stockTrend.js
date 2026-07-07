'use strict';

/**
 * 재고 추이 — OFFLINE_ORDER.stockDailySnapshot (매일 자정 재고 스냅샷, 일별 1문서 × 전 품목).
 *   "이 품목 재고가 최근 어떻게 줄었나" → 일별 수량 추이 + 일평균 소진 속도 + 소진 예상일.
 *   search(품목명/색상 부분일치) 필수 — 전 품목 추이는 응답이 너무 커서 미지원.
 */

const store = require('./store');

const N = (v) => (Number.isFinite(+v) ? +v : 0);

async function trend(search, { days = 14 } = {}) {
  const q = String(search || '').trim();
  if (!q) throw new Error('search(품목명/색상)가 필요합니다 — 예: "맥스 커버"');
  const c = await store.namedCollection('OFFLINE_ORDER', 'stockDailySnapshot');
  const snaps = await c.find({}, { projection: { snapshot_date: 1, items: 1 } })
    .sort({ snapshot_date: -1 }).limit(Math.max(2, Math.min(31, days))).toArray();
  snaps.reverse(); // 과거→최신

  // 스냅샷별로 검색어 매칭 품목 수량 추적 (code 기준 시계열)
  const series = {}; // code → { name, spec, category, points: {date: qty} }
  for (const s of snaps) {
    for (const it of (s.items || [])) {
      const hay = `${it.name || ''} ${it.spec || ''}`;
      if (!hay.includes(q)) continue;
      const k = it.code || `${it.name}|${it.spec}`;
      const e = (series[k] = series[k] || { code: it.code, 품목: it.name, 색상: it.spec === '-' ? '' : (it.spec || ''), 카테고리: it.category, points: {} });
      e.points[s.snapshot_date] = N(it.qty);
    }
  }
  const dates = snaps.map((s) => s.snapshot_date);
  const items = Object.values(series).map((e) => {
    const qtys = dates.map((d) => (e.points[d] != null ? e.points[d] : null));
    const first = qtys.find((v) => v != null), last = [...qtys].reverse().find((v) => v != null);
    const span = Math.max(1, dates.length - 1);
    const 일평균소진 = first != null && last != null ? +(((first - last) / span)).toFixed(2) : null; // +값=감소중
    const 소진예상일 = 일평균소진 > 0 && last > 0 ? Math.ceil(last / 일평균소진) : null;
    return {
      품목: e.품목, 색상: e.색상, 카테고리: e.카테고리, 현재고: last,
      기간시작재고: first, 일평균소진, 소진예상일,
      일별: Object.fromEntries(dates.map((d, i) => [d, qtys[i]])),
    };
  }).sort((a, b) => (a.소진예상일 || 9e9) - (b.소진예상일 || 9e9));

  if (!items.length) return { search: q, 매칭: 0, 안내: '매칭 품목 없음 — 품목명을 넓혀서 다시 검색하세요' };
  return {
    search: q, 스냅샷기간: `${dates[0]} ~ ${dates[dates.length - 1]}`, 매칭: items.length,
    items: items.slice(0, 40),
    주의: '스냅샷=매일 자정 기준. 일평균소진>0이면 감소 추세(입고 시 증가로 음수 가능). 소진예상일=현재고÷일평균소진(입고 미반영 단순 추정).',
  };
}

module.exports = { trend };
