'use strict';

/**
 * 좌수(Y리그 상담 인원) ↔ 오프라인 매출 관계 분석 — 원샷.
 *   좌수 소스: realtime API(/api/jwasu/dashboard)는 "월초~해당일 누적"을 주므로 하루씩 차분해 일별 좌수를 만든다.
 *   커버리지: jwasuLeague.jwasu()의 원본(노출 매니저 전체)을 사용 — y_league의 top15 컷을 쓰지 않는다.
 *   매출: off.orders(매장 주문서) 일별/매장별.
 *   반환: 일별(좌수·매출·좌수당매출) + 좌수↔매출 상관계수 + 매장별 상담당매출 효율.
 *
 *   "좌수에 따라 매출이 어떻게 움직이나", "상담 대비 매출 효율 매장별로" 류 질문을 도구 1개로 처리(수동 11회 호출·차분 방지).
 */

const store = require('./store');
const jl = require('./jwasuLeague');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (s) => String(s || '').slice(0, 10);
const addDays = (d, n) => { const t = new Date(ymd(d) + 'T00:00:00'); t.setDate(t.getDate() + n); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
const isFirstOfMonth = (d) => ymd(d).slice(8, 10) === '01';
const enumDays = (s, e) => { const out = []; for (let d = ymd(s); d <= ymd(e); d = addDays(d, 1)) out.push(d); return out; };

// 특정일까지의 월누적 좌수(매니저 전체 합 + 매장별 합). 실패 시 null.
async function cumJwasu(day) {
  try {
    const jw = await jl.jwasu(day, day);
    const rows = Array.isArray(jw) ? jw : [];
    let total = 0; const byStore = {};
    for (const r of rows) { const c = N(r.실적_좌수); total += c; const st = r.매장 || '(미상)'; byStore[st] = (byStore[st] || 0) + c; }
    return { total, byStore };
  } catch (_) { return null; }
}

function pearson(xs, ys) {
  const n = xs.length; if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  return (vx && vy) ? cov / Math.sqrt(vx * vy) : null;
}

async function analyze(start, end) {
  const days = enumDays(start, end);
  if (!days.length) throw new Error('기간이 올바르지 않습니다');
  // 누적 좌수: 각 날 + (start가 1일이 아니면) 전날 baseline. realtime 호출은 병렬.
  const needBaseline = !isFirstOfMonth(start);
  const cumDays = needBaseline ? [addDays(start, -1), ...days] : days;
  const cumArr = await Promise.all(cumDays.map((d) => cumJwasu(d)));
  const cums = {}; cumDays.forEach((d, i) => { cums[d] = cumArr[i]; });

  // 일별 매출(off.orders) 병렬
  const offColl = await store.namedCollection('off', 'orders');
  const revArr = await Promise.all(days.map((d) =>
    offColl.aggregate([{ $match: { date: d } }, { $group: { _id: null, rev: { $sum: '$amount' }, cust: { $addToSet: '$orderNo' } } }]).toArray()
  ));

  const daily = [];
  const storeJwasu = {};
  let apiMissing = 0;
  days.forEach((d, i) => {
    const cur = cums[d];
    const prev = cums[addDays(d, -1)];
    const base = isFirstOfMonth(d) ? { total: 0, byStore: {} } : prev;
    let 좌수 = null;
    if (cur && base) {
      좌수 = Math.max(0, N(cur.total) - N(base.total));
      // 매장별 증분 누적
      const curB = cur.byStore || {}, baseB = (base.byStore) || {};
      for (const st of new Set([...Object.keys(curB), ...Object.keys(baseB)])) {
        storeJwasu[st] = (storeJwasu[st] || 0) + Math.max(0, N(curB[st]) - N(baseB[st]));
      }
    } else { apiMissing++; }
    const r = revArr[i]; const 매출 = r[0] ? N(r[0].rev) : 0, 주문 = r[0] ? r[0].cust.length : 0;
    daily.push({ 날짜: d, 좌수, 매출, 주문, 좌수당매출: 좌수 ? Math.round(매출 / 좌수) : null });
  });

  // 상관계수(좌수 채워진 날만)
  const valid = daily.filter((x) => x.좌수 != null);
  const corr = pearson(valid.map((x) => x.좌수), valid.map((x) => x.매출));

  // 매장별 효율(범위 합)
  const storeRev = await offColl.aggregate([{ $match: { date: { $gte: ymd(start), $lte: ymd(end) } } }, { $group: { _id: '$store', rev: { $sum: '$amount' } } }]).toArray();
  const revByStore = Object.fromEntries(storeRev.map((x) => [x._id, N(x.rev)]));
  const 매장별효율 = Object.keys({ ...storeJwasu, ...revByStore })
    .map((st) => ({ 매장: st, 좌수: storeJwasu[st] || 0, 매출: revByStore[st] || 0, 상담당매출: (storeJwasu[st] || 0) ? Math.round((revByStore[st] || 0) / storeJwasu[st]) : 0 }))
    .filter((x) => x.좌수 > 0)
    .sort((a, b) => b.상담당매출 - a.상담당매출);

  const totJwasu = valid.reduce((s, x) => s + x.좌수, 0), totRev = valid.reduce((s, x) => s + x.매출, 0);
  return {
    start: ymd(start), end: ymd(end), 일수: days.length,
    상관계수_좌수_매출: corr != null ? +corr.toFixed(3) : null,
    상관해석: corr == null ? null : (corr >= 0.7 ? '강한 양(좌수↑ → 매출↑ 뚜렷)' : corr >= 0.4 ? '중간 양' : corr >= 0 ? '약한 양' : '음(역방향)'),
    합계: { 좌수: totJwasu, 매출: totRev, 평균_상담당매출: totJwasu ? Math.round(totRev / totJwasu) : 0 },
    일별: daily,
    매장별효율: 매장별효율,
    ...(apiMissing ? { 경고: `${apiMissing}일은 realtime 좌수 조회 실패로 상관계산에서 제외됨` } : {}),
    주의: '좌수=realtime Y리그 실적좌수(월초누적을 일별 차분). 노출 매니저 전체 사용(y_league의 15명 컷 아님). 매출=off.orders. 순위밖·미상담 매니저의 좌수는 집계 안 될 수 있음(과소집계 방향). 상관은 표본기간에 따라 달라짐.',
  };
}

module.exports = { analyze };
