'use strict';

/**
 * 오늘 챙길 것 — 일일 모니터링 맨 위(매출 타일 바로 아래)의 매장별 · 광고별 심각/주의.
 *   사용자 요청(2026-10-12): 전사 경보 한 줄로는 부족하다 — 오프라인은 매장마다 "무엇이 얼마나 부족하니 채워라"가,
 *   온라인은 광고(매체별 전달 대비 · 어제 매출과의 연결 · 실시간)까지 맨 위에 잡히게.
 *
 *   ① 오프라인 매장별 — 좌수는 전달 같은 기간 대비(사용자 지정) · 매출은 월 목표 페이스 · 직원별 부족/쏠림 · 어제 이상
 *   ② 온라인 광고     — 매체별 이번 달 vs 전달 같은 기간(광고비 · 클릭 · CPC · CTR) + 수집이 끊긴 매체
 *   ③ 어제 매출 진단   — 채널별(자사몰 · 스마트스토어) 순매출 ← 유입(광고 클릭과 같이 움직였나) · 전환
 *   ④ 실시간 광고     — 오늘 지금까지(광고 통합 /api/summary): 수집 오류 · 잔액 · 집행 0 · CPC/CTR
 *   ⑤ 온라인 프로모션  — 진행 중(며칠째 · 프로모션 전/전년 대비 · 힘이 빠지는지 · 광고) · 곧 시작 · 막 끝남(결과 · 반동) · 없음(2026-10-12 추가 요청)
 *
 *   문장 옆에 그래프용 숫자(수치 · 흐름 · 잔액)도 같이 싣는다 — 일일 매출 대시보드의 "오늘 챙길 것 · 그래프"(public/actions-charts.js)가 쓴다.
 *   전부 규칙 계산이다(AI 호출 없음 · 비용 0). 구역마다 따로 감싸 한 곳이 죽어도 나머지는 나온다.
 *   매체가 주는 전환 · 전환매출은 매체끼리 같은 주문을 겹쳐 잡아 판정에 쓰지 않는다(dash 홈 원칙) — 광고비 · 노출 · 클릭만.
 *   좌수 = Y리그 상담 인원. 좌수 목표(매니저 목표 합)는 등급에 쓰지 않는다 — 전달 실적의 2~3배로 잡힌 매장이 있어 전부 "심각"이 된다.
 */

const jl = require('./jwasuLeague');
const adEfficiency = require('./adEfficiency');
const dailyReport = require('./dailyReport');
const funnelAiCard = require('./funnelAiCard');
const promoDefs = require('./promoDefs');
const promoPerformance = require('./promoPerformance');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const pad = (n) => String(n).padStart(2, '0');
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const kstNow = () => new Date(Date.now() + 9 * 3600e3);
const todayKST = () => kstNow().toISOString().slice(0, 10);
const yesterdayKST = () => addDays(todayKST(), -1);
const d8 = (s) => String(s).replace(/-/g, '');
const md = (s) => `${+String(s).slice(5, 7)}/${+String(s).slice(8, 10)}`; // 10/11
const md8 = (s) => `${+String(s).slice(4, 6)}/${+String(s).slice(6, 8)}`;  // 20261011 → 10/11
const daysIn = (d) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate();

// 문장용 표기 — 지시에 쓰는 금액은 만 원 단위(읽기 쉽게), 1만 원 미만은 원 단위
const comma = (n) => { const v = Math.round(n); return (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('en-US'); };
const won = (n) => comma(n) + '원';
const man = (n) => { const a = Math.abs(n); if (a < 10000) return won(n); const v = Math.round(n / 10000); return Math.abs(v) >= 10000 ? (v < 0 ? '−' : '') + (Math.abs(v) / 10000).toFixed(2) + '억 원' : comma(v) + '만 원'; };
const sgn = (v, digits = 1) => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(digits) + '%');
const chg = (cur, base) => (base > 0 ? ((cur - base) / base) * 100 : null);
const rel = (cur, base) => { const v = chg(cur, base); return v == null ? '—' : v > 200 ? (cur / base).toFixed(1) + '배' : sgn(v); }; // 3배 넘게 늘면 %(+1091%) 대신 "N배"
const r1 = (v) => (v == null ? null : +(+v).toFixed(1));

const RANK = { 심각: 0, 주의: 1, 양호: 2, 참고: 3 };
// 항목에서 바로 가는 곳 — dash 첫 화면 "오늘 챙길 것"의 "물류센터 재고 →"와 같은 방식(사용자 요청 2026-10-12).
//   입력 창은 판매분석(/)이 주소 파라미터로 바로 연다: openpt=프로모션 등록 · openfn=퍼널 입력 · openbiz=스토어 유입 · opentg=목표 설정(app.js)
const GO = {
  promo: { href: '/?openpt=1', label: '프로모션 등록하러 가기' },
  funnel: { href: '/?openfn=1', label: '퍼널 입력하러 가기' },
  biz: { href: '/?openbiz=1', label: '스토어 유입 입력하러 가기' },
  ads: () => ({ href: ADS_BASE() + '/', label: '광고 통합에서 확인' }),
};
const worst = (items) => items.reduce((w, x) => (RANK[x.등급] < RANK[w] ? x.등급 : w), '양호');

// 전달 같은 기간 — 기준일과 같은 "일"까지(전달이 더 짧으면 말일까지). 10/11 → 9/1~9/11 · 10/31 → 9/1~9/30
function prevMonth(d) {
  const y = +d.slice(0, 4), m = +d.slice(5, 7), day = +d.slice(8, 10);
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const ym = `${py}-${pad(pm)}`;
  return { ym, start: `${ym}-01`, same: `${ym}-${pad(Math.min(day, last))}`, end: `${ym}-${pad(last)}`, days: last };
}

// ── ① 오프라인 매장별 ────────────────────────────────────────────────────────
//   등급: 좌수 = 전달 같은 기간의 70% 미만 심각 · 90% 미만 주의 / 매출 = 달성률 ÷ 월 경과율이 0.7 미만 심각 · 0.9 미만 주의
//   지시는 "남은 날 하루 얼마" — 좌수는 전달 전체 실적까지, 매출은 월 목표까지.
//   월초 보호: 1~3일은 하루 이틀치로 페이스를 재면 거의 전 매장이 "심각"이 된다(10/1 실측 7곳 중 6곳) → 좌수 · 매출 페이스는 참고로만,
//   누적 0좌 직원은 5일부터. 전달 같은 기간 기록이 없는 매장(신규 · 미집계)은 좌수 등급을 매기지 않는다(좌수 목표로 대신 재지 않음).
async function offline(d, jw) {
  if (!jw || !Array.isArray(jw.매장)) throw new Error('좌수·매장 데이터를 읽지 못했습니다');
  const pm = prevMonth(d);
  const day = +d.slice(8, 10), left = daysIn(d) - day, el = jw.월경과율;
  const early = day <= 3; // 월초 — 페이스 등급 보류
  const soft = (g) => (early && (g === '심각' || g === '주의') ? '참고' : g);
  const [pSame, pFull, pSales] = await Promise.all([
    jl.jwasu(pm.same, pm.same).catch(() => null),
    jl.jwasu(pm.end, pm.end).catch(() => null),
    jl.storeLeague(pm.start, pm.same).catch(() => null),
  ]);
  const byStore = (rows) => { const o = {}; for (const r of rows || []) { const s = (o[r.매장] = o[r.매장] || { 좌수: 0, 직원: new Map() }); s.좌수 += N(r.실적_좌수); s.직원.set(r.매니저, N(r.실적_좌수)); } return o; };
  const ps = pSame ? byStore(pSame) : null, pf = pFull ? byStore(pFull) : null;
  const psales = pSales ? Object.fromEntries(pSales.map((r) => [r.매장, N(r.매출)])) : null;

  const stores = jw.매장.map((s) => {
    const staff = (jw.직원 || []).filter((x) => x.매장 === s.매장);
    const items = [];
    const add = (등급, 구분, 글, 짧게) => items.push({ 등급, 구분, 글, 짧게: 짧게 || null });

    // 좌수 — 전달 같은 기간 대비
    const C = s.누적좌수, P = ps && ps[s.매장] ? ps[s.매장].좌수 : null, F = pf && pf[s.매장] ? pf[s.매장].좌수 : null;
    const perDay = day > 0 ? C / day : 0;
    let seatShort = false, seatGrade = '참고', salesGrade = '참고'; // 그래프가 막대 색을 정할 때 쓰는 항목별 등급
    if (P != null && P >= 20) {
      const diff = C - P;
      const g = soft(C < P * 0.7 ? '심각' : C < P * 0.9 ? '주의' : '양호');
      seatShort = diff < 0 && !early;
      let t = `좌수 ${comma(C)}좌 — 전달 같은 기간(${comma(P)}좌)보다 ${diff >= 0 ? '+' : '−'}${comma(Math.abs(diff))}좌(${rel(C, P)})${diff < 0 ? ' 부족' : ''}.`;
      if (diff < 0) {
        const prevStaff = ps[s.매장].직원;
        const drops = staff.filter((x) => prevStaff.has(x.직원)).map((x) => ({ 이름: x.직원, 전: prevStaff.get(x.직원), 지금: x.누적좌수 })).filter((x) => x.지금 < x.전).sort((a, b) => (a.지금 - a.전) - (b.지금 - b.전)).slice(0, 2);
        const gone = [...prevStaff].filter(([n, v]) => v > 0 && !staff.some((x) => x.직원 === n)).sort((a, b) => b[1] - a[1]).slice(0, 2);
        const parts = drops.map((x) => `${x.이름} ${x.전}→${x.지금}좌`).concat(gone.map(([n, v]) => `${n}(전달 ${v}좌, 이번 달 명단에 없음)`));
        if (parts.length) t += ` 줄어든 곳: ${parts.join(' · ')}.`;
      }
      let short = null;
      if (F != null && F > C && left > 0) {
        const need = Math.ceil((F - C) / left);
        t += ` → 전달 전체(${comma(F)}좌)까지 ${comma(F - C)}좌: 남은 ${left}일 하루 ${need}좌(지금까지 하루 ${perDay.toFixed(1)}좌).`;
        if (diff < 0) short = `좌수 ${comma(Math.abs(diff))}좌 부족(전달 대비) → 하루 ${need}좌 채우기`;
      } else if (F != null && C >= F) t += ` 전달 전체(${comma(F)}좌)는 이미 넘겼습니다.`;
      else if (diff < 0) short = `좌수 ${comma(Math.abs(diff))}좌 부족(전달 대비)`;
      seatGrade = g; add(g, '좌수', t, short);
    } else {
      // 전달 같은 기간 기록이 없으면(신규 매장 · 그때는 집계 전) 견줄 곳이 없다 — 좌수 목표는 등급에 쓰지 않으므로 숫자만 보인다
      const rate = s.좌수달성률;
      add('참고', '좌수', `좌수 ${comma(C)}좌 — 전달 같은 기간 기록이 없어 견주지 않습니다(목표 ${comma(s.목표좌수)}좌의 ${rate != null ? rate + '%' : '—'}).`);
    }

    // 매출 — 월 목표 페이스
    const ratio = s.매출달성률 != null && el > 0 ? s.매출달성률 / el : null;
    let salesShort = false;
    if (ratio != null && s.목표매출 > 0) {
      const g0 = ratio < 0.7 ? '심각' : ratio < 0.9 ? '주의' : '양호', g = soft(g0);
      const gap = s.목표매출 * (el / 100) - s.누적매출, need = left > 0 ? (s.목표매출 - s.누적매출) / left : null, avg = day > 0 ? s.누적매출 / day : 0;
      const prevS = psales && psales[s.매장] > 0 ? psales[s.매장] : null;
      const vsPrev = prevS ? (chg(s.누적매출, prevS) > 200 ? ` 전달 같은 기간(${man(prevS)})의 ${rel(s.누적매출, prevS)}.` : ` 전달 같은 기간(${man(prevS)}) 대비 ${sgn(chg(s.누적매출, prevS))}.`) : '';
      salesShort = g0 !== '양호' && !early; salesGrade = g;
      let t = `매출 ${man(s.누적매출)} = 목표 ${man(s.목표매출)}의 ${s.매출달성률}%(월 경과 ${el}%)`;
      if (s.누적매출 >= s.목표매출) t += ' — 월 목표 달성.';
      else if (early) t += ` — 월초라 페이스 판정은 4일부터.${need != null ? ` 월 목표까지 하루 ${man(need)}.` : ''}`;
      else if (g === '양호') t += ` — 순항.${need != null ? ` 남은 ${left}일 하루 ${man(need)}이면 달성(지금까지 하루 ${man(avg)}).` : ''}`;
      else t += ` — 페이스보다 ${man(gap)} 부족.${need != null ? ` → 남은 ${left}일 하루 ${man(need)} 필요(지금까지 하루 ${man(avg)}${avg > 0 ? `, ${(need / avg).toFixed(1)}배` : ''}).` : ''}`;
      add(g, '매출', t + vsPrev, salesShort ? `매출 페이스 ${man(gap)} 부족${need != null ? ` → 하루 ${man(need)} 필요` : ''}` : null);
    }

    // 직원 — 누적 0좌 · 한 명에게 쏠림(매장이 뒤처질 때만 주의, 아니면 참고)
    const zero = staff.filter((x) => x.누적좌수 === 0 && x.목표좌수 > 0).map((x) => x.직원);
    if (zero.length && day >= 5) add('주의', '직원', `이번 달 누적 0좌 ${zero.length}명(${zero.join(' · ')}) — 근무 여부와 좌수 입력을 확인하세요.`, `누적 0좌 ${zero.length}명 확인`);
    if (staff.length >= 3 && C >= 50) {
      const top = staff.slice().sort((a, b) => b.누적좌수 - a.누적좌수)[0];
      const share = (top.누적좌수 / C) * 100;
      if (share >= 70) {
        const rest = staff.length - 1, restSum = C - top.누적좌수, restY = staff.filter((x) => x !== top && x.어제좌수 === 0).length;
        add(seatShort || salesShort ? '주의' : '참고', '직원',
          `좌수의 ${share.toFixed(0)}%가 ${top.직원} 1명(${comma(top.누적좌수)}좌) — 나머지 ${rest}명 합계 ${comma(restSum)}좌${restY ? `, 어제는 ${restY}명이 0좌` : ''}. → 나머지 인원 좌수 채우기.`,
          `좌수 ${share.toFixed(0)}%가 1명에 쏠림 → 나머지 ${rest}명 채우기`);
      }
    }

    // 어제 — 0 이거나 상담 대비 매출이 유난히 낮은 날
    const ys = s.어제좌수, ya = s.어제매출, yo = s.어제주문;
    const base = `어제 ${comma(ys)}좌 · 주문 ${comma(yo)}건 · ${man(ya)}`;
    const mtdPer = C > 0 ? s.누적매출 / C : 0;
    if (ys === 0 && ya === 0) add('주의', '어제', '어제 매출 · 좌수 모두 0 — 휴점이 아니면 주문서와 좌수 입력을 확인하세요.', '어제 매출·좌수 0 확인');
    else if (ys > 0 && ya === 0) add('주의', '어제', `${base} — 상담은 있었는데 매출이 0입니다. 주문서 입력을 확인하세요.`, '어제 주문서 입력 확인');
    else if (ys === 0 && ya > 0) add('주의', '어제', `${base} — 매출은 있는데 좌수가 0입니다. 좌수 입력을 확인하세요.`, '어제 좌수 입력 확인');
    else if (ys >= 10 && mtdPer > 0 && ya / ys < mtdPer * 0.5) {
      add('주의', '어제', `${base} — 좌수당 매출 ${won(ya / ys)}, 이번 달 평균(${won(mtdPer)})의 ${((ya / ys / mtdPer) * 100).toFixed(0)}%. 상담이 구매로 덜 이어진 날입니다${yo > 0 ? `(주문당 ${man(ya / yo)})` : ''} → 주문 누락 · 저단가 판매 여부 확인.`, '어제 상담 대비 매출 급락 확인');
    } else add('참고', '어제', base + '.');

    const 등급 = worst(items);
    const heads = items.filter((x) => x.짧게 && RANK[x.등급] <= 1).sort((a, b) => RANK[a.등급] - RANK[b.등급]).slice(0, 2).map((x) => x.짧게);
    const side = items.find((x) => x.짧게 && x.등급 === '참고'); // 순항인 매장도 참고할 점이 있으면 한 줄에 붙인다
    // 양호 매장은 화면에서 한 줄로 줄여 보인다(심각 · 주의 매장만 항목을 펼친다) — 그 한 줄
    const 한줄 = `좌수 ${comma(C)}좌${P != null && P >= 20 ? `(전달 같은 기간 대비 ${rel(C, P)})` : ''} · 매출 ${man(s.누적매출)}${s.매출달성률 != null ? `(목표의 ${s.매출달성률}%)` : ''} · 어제 ${comma(ys)}좌 · ${comma(yo)}건 · ${man(ya)}`;
    // 월초(1~3일)에 걸리는 것이 없으면 '순항'이 아니라 '판정 보류' — 하루 이틀치로 잘하고 있다고 말하지 않는다
    const calm = early ? '월초 — 페이스 판정은 4일부터' : '순항' + (side ? ' · ' + side.짧게 : ' — 지금 페이스 유지');
    return { 매장: s.매장, 등급: early && 등급 === '양호' ? '참고' : 등급, 지시: heads.length ? heads.join(' · ') : calm, 한줄, 항목: items, 매출비: ratio,
      수치: { 매출: s.누적매출, 목표: s.목표매출, 달성률: s.매출달성률, 좌수: C, 전달좌수: P != null && P >= 20 ? P : null, 전달전체: F, 어제좌수: ys, 어제매출: ya, 어제주문: yo, 매출등급: salesGrade, 좌수등급: seatGrade } };
  }).sort((a, b) => (RANK[a.등급] - RANK[b.등급]) || ((a.매출비 == null ? 9 : a.매출비) - (b.매출비 == null ? 9 : b.매출비)));

  const cnt = (g) => stores.filter((x) => x.등급 === g).length;
  return {
    매장: stores.map(({ 매출비, ...x }) => x),
    개수: { 심각: cnt('심각'), 주의: cnt('주의'), 양호: cnt('양호') },
    월경과율: el, 남은일: left, 전달기간: `${md(pm.start)}~${md(pm.same)}`,
    기준: `좌수 = Y리그 상담 인원 · 전달 같은 기간(${md(pm.start)}~${md(pm.same)}) 대비 70% 미만 심각 · 90% 미만 주의 / 매출 = 달성률 ÷ 월 경과율 0.7 미만 심각 · 0.9 미만 주의 / 좌수 목표는 등급에 쓰지 않음${early ? ' / 월초(1~3일)는 표본이 작아 좌수 · 매출 페이스 등급 보류' : ''}`,
    월초: early,
  };
}

// ── 광고 원자료(최근 14일) → 매체 · 일자 ───────────────────────────────────────
function adIndex(rows) {
  const by = {}; // 매체 → 날짜(YYYYMMDD) → {spend, clk, imp}
  for (const r of rows || []) {
    const p = adEfficiency.canonPlatform(r.platform);
    const o = ((by[p] = by[p] || {})[r.date] = by[p][r.date] || { spend: 0, clk: 0, imp: 0 });
    o.spend += N(r.spend); o.clk += N(r.clk); o.imp += N(r.imp);
  }
  return by;
}
// 스마트스토어로 떨어지는 매체(쇼핑검색 · 브랜드스토어) — 그 외(파워링크 · 메타 · 크리테오 · 카카오)는 자사몰로 본다
const isStoreAd = (p) => /네이버\s*(쇼핑|브랜드)/.test(p);

// ── ② 온라인 광고 — 매체별 이번 달 vs 전달 같은 기간 ─────────────────────────────
//   등급: 돈을 15% 이상 더 썼는데 CPC 가 20% 이상 올랐으면 주의(50% 이상 심각) · 광고비 30% 이상 줄었으면 주의 · 전달 집행하던 매체가 0 이면 주의
//   수집이 기준일 전에 끊긴 매체는 비교하지 않고 "수집 끊김"으로 올린다(끊긴 날수 2일 이상 심각).
async function adsVsPrev(d, recentP) {
  const pm = prevMonth(d), ms = d.slice(0, 8) + '01';
  const early = +d.slice(8, 10) < 3; // 하루 이틀치 비교는 요일 차이만으로도 크게 흔들린다
  const [cur, prev, recent, series] = await Promise.all([
    adEfficiency.efficiency(d8(ms), d8(d)), adEfficiency.efficiency(d8(pm.start), d8(pm.same)), recentP,
    dailyReport.dailyChannelSeries(pm.start).catch(() => null),
  ]);
  const idx = adIndex(recent);
  // 수집 끊김 — 최근 14일 안에 행이 있던 매체인데 기준일 행이 아예 없다.
  //   행이 있으면(광고비 0 이라도) 수집은 되는 것 — 카카오 메시지처럼 발송일 하루만 쓰는 매체를 끊김으로 잡지 않는다(2026-10 실측).
  const gaps = [], stopped = [];
  const prior7 = Array.from({ length: 7 }, (_, i) => d8(addDays(d, -(i + 1))));
  for (const [p, days] of Object.entries(idx)) {
    const cur0 = days[d8(d)];
    if (!cur0) {
      const last = Object.keys(days).sort().pop();
      gaps.push({ 매체: p, 마지막: last, 일수: Math.round((Date.parse(d) - Date.parse(`${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}`)) / 86400e3) });
    } else if (cur0.spend === 0 && cur0.imp === 0 && prior7.filter((k) => days[k] && days[k].spend > 0).length >= 5) stopped.push(p); // 매일 쓰던 매체가 어제 0
  }
  const gapOf = (p) => gaps.find((g) => g.매체 === p);
  const pmap = Object.fromEntries(prev.platforms.map((x) => [x.platform, x]));
  const names = [...new Set([...cur.platforms.map((x) => x.platform), ...prev.platforms.map((x) => x.platform)])];
  const rows = names.map((p) => {
    const a = cur.platforms.find((x) => x.platform === p) || { spend: 0, clk: 0, imp: 0, cpc: null, ctr: null }, b = pmap[p] || { spend: 0, clk: 0, imp: 0, cpc: null, ctr: null };
    const sp = chg(a.spend, b.spend), ck = chg(a.clk, b.clk), cp = a.cpc && b.cpc ? chg(a.cpc, b.cpc) : null;
    const nums = `광고비 ${man(a.spend)}(전달 ${man(b.spend)}, ${sgn(sp)}) · 클릭 ${comma(a.clk)}(${sgn(ck)})` + (a.cpc && b.cpc ? ` · CPC ${comma(b.cpc)}→${comma(a.cpc)}원(${sgn(cp)})` : '') + (a.ctr != null && b.ctr != null ? ` · CTR ${b.ctr}→${a.ctr}%` : '');
    const gap = gapOf(p);
    let 등급 = '양호', 평가;
    if (gap) { 등급 = gap.일수 >= 2 ? '심각' : '주의'; 평가 = `${md8(gap.마지막)} 이후 실적이 들어오지 않습니다(${gap.일수}일째) — 광고가 멈췄거나 수집이 끊겼습니다. 이번 달 숫자는 ${md8(gap.마지막)}까지라 전달과 비교하지 않습니다.`; }
    else if (stopped.includes(p)) { 등급 = '주의'; 평가 = `${md(d)} 집행이 0입니다 — 직전 7일은 매일 집행하던 매체 → 광고 꺼짐 · 예산 소진 · 잔액 확인. (이번 달 ${nums})`; }
    else if (!(b.spend > 0)) { 등급 = '참고'; 평가 = `광고비 ${man(a.spend)} · 클릭 ${comma(a.clk)} — 전달 같은 기간에는 집행이 없던 매체(신규).`; }
    else if (!(a.spend > 0)) { 등급 = '주의'; 평가 = `전달 같은 기간 ${man(b.spend)}을 쓰던 매체인데 이번 달 집행이 없습니다 — 의도한 중단인지 확인.`; }
    else if (a.clk < 50 || b.clk < 50) { 등급 = '참고'; 평가 = `${nums} — 클릭이 적어 효율 판정은 보류.`; }
    else if (sp >= 15 && cp != null && cp >= 20) { 등급 = cp >= 50 ? '심각' : '주의'; 평가 = `${nums} — 돈은 더 쓰는데 클릭이 그만큼 안 늘었습니다(같은 돈으로 덜 들어옴) → 입찰가 · 소재 · 노출 지면 점검.`; }
    else if (sp <= -30) { 등급 = '주의'; 평가 = `${nums} — 집행이 크게 줄었습니다. 의도한 축소가 아니면 예산 · 잔액 확인.`; }
    else if (cp != null && cp <= -15) 평가 = `${nums} — 같은 돈으로 클릭이 더 들어옵니다(효율 개선).`;
    else if (sp >= 30 && ck != null && ck >= sp - 25) 평가 = `${nums} — 집행을 늘린 만큼 클릭도 따라 늘었습니다.`;
    else if (cp != null && cp >= 20) { 등급 = '주의'; 평가 = `${nums} — 클릭 단가가 올랐습니다(경쟁 심화 또는 소재 반응 하락) → 입찰가 · 소재 점검.`; }
    else 평가 = `${nums} — 전달과 비슷한 효율.`;
    // 집행액이 작은 매체(이번 달 10만 원 미만이면서 전체의 5% 미만)는 단가가 튀어도 참고로만 — 매출에 주는 영향이 작다
    if ((등급 === '심각' || 등급 === '주의') && !gap && !stopped.includes(p) && a.spend < 100000 && a.spend < cur.total.spend * 0.05) { 등급 = '참고'; 평가 += ' (집행액이 작아 참고)'; }
    if (early && !gap && !stopped.includes(p) && (등급 === '심각' || 등급 === '주의' || 등급 === '양호')) { 등급 = '참고'; 평가 = `${nums} — 월초(3일 미만)라 효율 판정은 보류.`; }
    return { 매체: p, 등급, 평가, 광고비: a.spend, 전달광고비: b.spend, 링크: 등급 === '심각' || 등급 === '주의' ? GO.ads() : null,
      수치: { 광고비: a.spend, 전달광고비: b.spend, 클릭: a.clk, 전달클릭: b.clk, CPC: a.cpc || null, 전달CPC: b.cpc || null, CPC변화: gap ? null : r1(cp), 끊김: !!gap } };
  }).sort((x, y) => (RANK[x.등급] - RANK[y.등급]) || (y.광고비 - x.광고비));

  // 합계 — 온라인 매출 대비 광고비 비중(실제 오간 돈끼리)
  const rev = (a, b) => (series || []).filter((r) => r.Date >= a && r.Date <= b).reduce((s, r) => s + N(r.자사몰) + N(r.스마트스토어) + N(r.외부채널), 0);
  const rc = series ? rev(ms, d) : null, rp = series ? rev(pm.start, pm.same) : null;
  const t = cur.total, tp = prev.total;
  const share = (s, r) => (r > 0 ? (s / r) * 100 : null);
  let 합계 = `광고비 ${man(t.spend)}(전달 같은 기간 ${man(tp.spend)}, ${sgn(chg(t.spend, tp.spend))}) · 클릭 ${comma(t.clk)}(${sgn(chg(t.clk, tp.clk))})`;
  if (t.cpc && tp.cpc) 합계 += ` · CPC ${comma(tp.cpc)}→${comma(t.cpc)}원(${sgn(chg(t.cpc, tp.cpc))})`;
  const 주석 = gaps.length ? `${gaps.map((g) => g.매체).join(' · ')} 실적은 수집이 끊긴 날부터 빠져 있어 이번 달 광고비 · 클릭이 실제보다 적게 잡혔습니다.` : null;
  if (rc != null && share(t.spend, rc) != null) 합계 += ` · 온라인 매출 ${man(rc)}(${sgn(chg(rc, rp))}) 대비 광고비 ${share(t.spend, rc).toFixed(1)}%` + (share(tp.spend, rp) != null ? `(전달 ${share(tp.spend, rp).toFixed(1)}%)` : '');
  // 한 줄 풀이 — 광고비가 는 만큼 매출이 따라왔나
  let 풀이 = null;
  if (!early && rc != null && rp > 0 && tp.spend > 0) {
    const ds = chg(t.spend, tp.spend), dr = chg(rc, rp);
    풀이 = ds >= 10 && dr < ds - 15 ? `광고비는 ${sgn(ds)} 늘었는데 온라인 매출은 ${sgn(dr)} — 늘린 광고비만큼 매출이 따라오지 않았습니다.`
      : ds <= -10 && dr <= -10 ? `광고비 ${sgn(ds)} · 온라인 매출 ${sgn(dr)} — 광고를 줄인 만큼 매출도 줄었습니다.`
        : ds >= 10 && dr >= ds - 15 ? `광고비 ${sgn(ds)} · 온라인 매출 ${sgn(dr)} — 늘린 광고비가 매출로 이어지고 있습니다.`
          : `광고비 ${sgn(ds)} · 온라인 매출 ${sgn(dr)}.`;
  }
  return {
    기간: `${md(ms)}~${md(d)} vs ${md(pm.start)}~${md(pm.same)}`, 합계, 풀이, 주석, 매체: rows, 끊김: gaps,
    기준: '매체 API 집계(광고 통합) · 전환 · 전환매출은 매체끼리 겹쳐 판정에 쓰지 않음 · 온라인 매출 = 자사몰 + 스마트스토어 + 외부채널(공동구매 제외)',
  };
}

// 기준일 클릭 vs 직전 7일 평균 — 기준일에 수집된 매체끼리만 견준다(끊긴 매체를 넣으면 광고가 줄어든 것처럼 보인다)
function adDayChange(recent, d) {
  const idx = adIndex(recent), day = d8(d);
  const prior = Array.from({ length: 7 }, (_, i) => d8(addDays(d, -(i + 1))));
  const rows = [], skipped = [];
  for (const [p, days] of Object.entries(idx)) {
    const base = prior.filter((k) => days[k]);
    if (!days[day]) { if (base.some((k) => days[k].spend > 0)) skipped.push(p); continue; }
    if (base.filter((k) => days[k].spend > 0).length < 4) continue; // 매일 쓰는 매체만 — 발송일 하루만 쓰는 메시지형(카카오)은 클릭 비교를 흔든다
    rows.push({ 매체: p, cur: days[day].clk, avg: base.reduce((s, k) => s + days[k].clk, 0) / base.length, spend: days[day].spend, avgSpend: base.reduce((s, k) => s + days[k].spend, 0) / base.length });
  }
  const group = (list) => {
    const cur = list.reduce((s, r) => s + r.cur, 0), avg = list.reduce((s, r) => s + r.avg, 0);
    const movers = list.filter((r) => r.avg >= 10 && Math.abs(chg(r.cur, r.avg)) >= 20).sort((a, b) => Math.abs(b.cur - b.avg) - Math.abs(a.cur - a.avg))
      .map((r) => ({ 매체: r.매체, 변화: r1(chg(r.cur, r.avg)), 광고비변화: r1(chg(r.spend, r.avgSpend)) }));
    return { 클릭: cur, 평균: r1(avg), 변화: avg >= 20 ? r1(chg(cur, avg)) : null, movers };
  };
  const out = { mall: group(rows.filter((r) => !isStoreAd(r.매체))), ss: group(rows.filter((r) => isStoreAd(r.매체))), 제외: skipped };
  out.mall.제외 = skipped.filter((p) => !isStoreAd(p)); out.ss.제외 = skipped.filter(isStoreAd);
  return out;
}

// ── ③ 어제 매출 진단 — 순매출(7일평균 대비) ← 유입 · 광고 클릭 · 전환 ───────────────
//   순매출이 7일평균보다 15% 이상 낮으면 주의(40% 이상 심각). 유입과 광고 클릭이 같이 10% 이상 줄었으면 "광고 유입 부족",
//   유입만 줄었으면 "광고 밖 유입", 유입이 유지됐으면 "광고가 아니라 전환 쪽"으로 가른다(퍼널 판정은 AI 분석 카드와 같은 계산).
async function diagnose(d, recentP) {
  const recent = await recentP;
  const ad = adDayChange(recent, d);
  const one = async (ch, name) => {
    const { cards } = await funnelAiCard.computeRange(d, d, ch);
    const c = cards[0];
    if (!c || (c.status !== 'ok' && c.status !== 'data_error')) return { 채널: name, 등급: '참고', 글: (c && c.note) || '어제 값이 아직 없어 판정을 보류합니다.', 링크: c && c.status === 'pending_input' ? (ch === 'ss' ? GO.biz : GO.funnel) : null };
    if (c.status === 'data_error') return { 채널: name, 등급: '참고', 글: '데이터 이상으로 판정을 보류합니다 — 🤖 AI 분석 화면의 데이터 상태를 확인하세요.' };
    const st = c.steps || [], nr = c.net_revenue || {};
    const net = c.headline && c.headline.net_vs_avg7_pct, inflow = st[0] ? st[0].vs_avg7_pct : null;
    // 전환 = 마지막 단계 비율(자사몰 주문완료 ÷ 유입 · 스토어 구매율)의 7일평균 대비 변화 · 객단가도 7일평균 대비
    const lastStep = st.length > 1 ? st[st.length - 1] : null, convName = ch === 'ss' ? '구매율' : '구매전환';
    const conv = lastStep && !lastStep.hold && lastStep.cur_pct != null && lastStep.avg7_pct > 0 ? r1((lastStep.cur_pct / lastStep.avg7_pct - 1) * 100) : null;
    const aov = nr.aov != null && nr.aov_avg7 > 0 ? r1((nr.aov / nr.aov_avg7 - 1) * 100) : null;
    const ret = ch === 'ss' ? Math.abs(N(nr.returns)) : 0, retShare = ret > 0 && nr.sales > 0 ? ret / nr.sales : 0;
    const a = ad[ch], adTxt = (a.변화 == null ? '광고 클릭은 비교 표본 부족' : `광고 클릭 ${sgn(a.변화)}`) + (a.제외.length ? `(${a.제외.join(' · ')} 제외 — 수집 끊김)` : '');
    const mover = a.movers.find((m) => m.변화 < 0), moverTxt = mover ? `(${mover.매체} ${sgn(mover.변화)}${mover.광고비변화 != null ? `, 광고비 ${sgn(mover.광고비변화)}` : ''})` : '';
    const head = `순매출 ${man(nr.actual)}(7일평균 대비 ${sgn(net)}) · 유입 ${sgn(inflow)} · ${convName} ${sgn(conv)} · 객단가 ${sgn(aov)} · ${adTxt}`;
    const 수치 = { 순매출: net, 유입: inflow, 전환: conv, 객단가: aov, 광고클릭: a.변화, 전환이름: convName, 금액: nr.actual };
    if (net == null) return { 채널: name, 등급: '참고', 글: `${head} — 7일평균 기준선이 부족해 판정을 보류합니다.`, 수치 };
    const g = net <= -40 ? '심각' : net <= -15 ? '주의' : '양호';
    if (g === '양호') return { 채널: name, 등급: '양호', 글: `${head} — ${net >= 15 ? '평소보다 좋은 날입니다.' : '평소 범위입니다.'}`, 수치 };
    const inflowDown = inflow != null && inflow <= -10, adDown = a.변화 != null && a.변화 <= -10;
    const adNote = inflowDown ? (adDown ? `유입도 줄었고 광고 클릭이 같이 줄었습니다${moverTxt} — 광고 집행 점검도 함께.` : '유입도 줄었지만 광고 클릭은 유지됐습니다(광고 밖 유입 감소).')
      : (adDown ? '광고 클릭은 줄었지만 유입은 평소 수준을 지켜 광고 부족이 아닙니다.' : '유입은 평소 수준이라 광고 부족이 아닙니다.');
    let 글;
    if (retShare >= 0.3) {
      // 스토어 순매출 = 판매 − 그날 잡힌 반품. 반품이 판매분의 30% 이상이면 광고 · 유입보다 반품이 원인이다
      글 = `${head} — 그날 잡힌 반품 ${man(ret)}이 판매분(${man(nr.sales)})을 깎았습니다. 광고 · 유입 문제가 아닙니다 → 반품 건의 원주문과 사유를 확인하세요.`;
    } else {
      const f = [['유입', inflow], [convName, conv], ['객단가', aov]].filter((x) => x[1] != null).sort((x, y) => x[1] - y[1]);
      const top = f[0];
      if (!top || top[1] > -5) 글 = `${head} — 한 곳이 크게 빠진 것이 아니라 유입 · 전환 · 객단가가 조금씩 같이 내려간 날입니다.`;
      else if (top[0] === '유입') {
        글 = adDown ? `${head} — 매출이 안 나온 출발점은 유입 감소이고, 광고 클릭도 같이 줄었습니다${moverTxt}. → 광고 집행(예산 · 입찰 · 잔액)부터 채우세요.`
          : `${head} — 가장 크게 빠진 것은 유입인데 광고 클릭은 유지됐습니다. 줄어든 것은 광고 밖 유입(검색 · 직접 방문 · 프로모션 종료)입니다.`;
      } else {
        const stepTxt = ch === 'mall' && c.bottleneck ? `, 막힌 단계는 ${c.bottleneck}` : '';
        글 = `${head} — 가장 크게 빠진 것은 ${top[0]}(${sgn(top[1])})${stepTxt}입니다. ${adNote} → ${top[0] === '객단가' ? '어떤 상품이 팔렸는지(저단가 위주인지) 확인' : '상세 · 혜택 · 가격 점검'}.`;
      }
    }
    return { 채널: name, 등급: g, 글, 수치 };
  };
  const res = await Promise.all([one('mall', '자사몰').catch((e) => ({ 채널: '자사몰', 등급: '참고', 글: '진단 실패 — ' + String(e.message).slice(0, 80) })),
    one('ss', '스마트스토어').catch((e) => ({ 채널: '스마트스토어', 등급: '참고', 글: '진단 실패 — ' + String(e.message).slice(0, 80) }))]);
  return {
    항목: res, 제외매체: ad.제외,
    기준: '순매출 · 유입은 직전 7일 평균 대비(AI 분석 카드와 같은 계산) · 광고 클릭은 기준일에 수집된 매체끼리 · 매체 연결: 네이버 쇼핑 → 스마트스토어, 그 외 → 자사몰',
  };
}

// ── ④ 실시간 광고 — 오늘 지금까지 ──────────────────────────────────────────────
//   광고 통합(mkboard)의 /api/summary 가 매체 API 를 그 자리에서 읽는다. 오전에는 표본이 작아 양(광고비 · 클릭)은 판정하지 않고,
//   "숫자를 못 읽는 매체 · 잔액 · 집행 0 · 단가/반응률"만 본다. 잔액 = 최근 7일 하루 평균 광고비 기준 1일분 미만 심각 · 3일분 미만 주의.
const ADS_BASE = () => String(process.env.ADS_ZONE_URL || 'https://mkt-sage.vercel.app').replace(/\/+$/, '');
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
async function realtime(d, recentP) {
  const today = todayKST(), now = kstNow(), hhmm = now.toISOString().slice(11, 16), hour = now.getUTCHours();
  const [res, recent] = await Promise.all([
    fetch(`${ADS_BASE()}/api/summary?date=${d8(today)}`, { signal: AbortSignal.timeout(20000) }).then((r) => r.json()),
    recentP,
  ]);
  if (!res || !res.ok) throw new Error('광고 통합이 응답하지 않습니다' + (res && res.error ? ' — ' + String(res.error).slice(0, 80) : ''));
  const idx = adIndex(recent);
  const prior = Array.from({ length: 7 }, (_, i) => d8(addDays(d, -i))); // 어제까지 7일
  const avgOf = (match) => { // 매체(이름 판별 함수) 묶음의 하루 평균 광고비 · CPC · CTR
    let spend = 0, clk = 0, imp = 0; const days = new Set();
    for (const [p, byDay] of Object.entries(idx)) if (match(p)) for (const k of prior) if (byDay[k]) { spend += byDay[k].spend; clk += byDay[k].clk; imp += byDay[k].imp; days.add(k); }
    return { 하루: days.size ? spend / days.size : 0, cpc: clk ? spend / clk : null, ctr: imp ? (clk / imp) * 100 : null };
  };
  const items = [];
  // 숫자를 못 읽는 매체
  for (const e of res.errors || []) {
    const msg = String(e.error || '');
    let why = '실적 조회 오류 — ' + msg.replace(/[A-Za-z0-9_\-]{30,}/g, '…').slice(0, 90);
    if (/expired|access token|OAuth|\b190\b/i.test(msg)) {
      const m = /expired on \w+, (\d{2})-(\w{3})-(\d{2})/.exec(msg);
      why = `접속 토큰이 만료돼${m && MON[m[2]] ? `(${MON[m[2]]}/${+m[1]})` : ''} 실적을 못 읽고 있습니다 → 광고 통합에서 다시 연결해야 숫자가 들어옵니다(광고 자체는 돌고 있을 수 있음).`;
    }
    items.push({ 등급: '심각', 매체: e.platform, 글: why, 벤더: adEfficiency.vendorOf(e.platform) });
  }
  const rows = (res.rows || []).map((r) => ({ 매체: adEfficiency.canonPlatform(r.platform), spend: N(r.spend), clk: N(r.clk), imp: N(r.imp), cart: N(r.cartCnt), balance: r.balance == null ? null : N(r.balance), note: String(r.note || '') }));
  // 잔액 — 광고 통합이 주는 balance 의 뜻이 매체마다 다르다(providers/*.js 확인, 2026-10-12):
  //   · 네이버 = 비즈머니(계정 공통 잔액, note 에 "공통잔액") → 네이버 전체 하루 평균과 견준다
  //   · META = 지출 한도(spend_cap) − 누적 지출 = 한도 잔여, 계정별 → 그 계정 하루 평균과 견준다. 한도를 올려야 풀린다(충전이 아님)
  //   · META 한도 미설정이면 미청구액(note 에 "미청구액") — 남은 돈이 아니라 낼 돈이라 잔액 점검에서 뺀다
  const seen = new Set(), balances = [];
  for (const r of rows) {
    if (r.balance == null || /미청구/.test(r.note)) continue;
    const v = adEfficiency.vendorOf(r.매체), shared = /공통/.test(r.note), key = shared ? v : r.매체;
    if (seen.has(key)) continue; seen.add(key);
    const a = avgOf(shared ? (p) => adEfficiency.vendorOf(p) === v : (p) => p === r.매체);
    if (!(a.하루 > 0)) continue;
    const left = r.balance / a.하루, cap = v === '메타';
    balances.push({ 이름: (shared ? v : r.매체) + (cap ? ' 한도 잔여' : ' 잔액'), 잔액: r.balance, 하루평균: Math.round(a.하루), 일수: +left.toFixed(1), 등급: left < 1 ? '심각' : left < 3 ? '주의' : '양호' });
    if (left < 3) items.push({ 등급: left < 1 ? '심각' : '주의', 매체: (shared ? v : r.매체) + (cap ? ' 한도' : ' 잔액'),
      글: `${cap ? '지출 한도 잔여' : '잔액'} ${won(r.balance)} — 최근 7일 하루 평균 ${man(a.하루)} 기준 약 ${left.toFixed(1)}일분입니다 → ${cap ? '지출 한도를 올리지 않으면' : '충전하지 않으면'} 광고가 멈춥니다.` });
  }
  // 집행 0 · 단가/반응률
  for (const r of rows) {
    const a = avgOf((p) => p === r.매체);
    if (/집계 대기/.test(r.note)) continue;
    if (r.spend === 0 && r.imp === 0) {
      if (hour >= 10 && a.하루 >= 5000) items.push({ 등급: '주의', 매체: r.매체, 글: `오늘 ${hhmm}까지 집행이 0입니다 — 어제까지 하루 평균 ${man(a.하루)}을 쓰던 매체 → 광고 꺼짐 · 예산 소진 · 심사 반려 확인.` });
      continue;
    }
    if (r.clk >= 30 && a.cpc) {
      const cpc = r.spend / r.clk, ctr = r.imp ? (r.clk / r.imp) * 100 : null;
      if (chg(cpc, a.cpc) >= 40) items.push({ 등급: '주의', 매체: r.매체, 글: `오늘 CPC ${won(cpc)} — 7일 평균(${won(a.cpc)})보다 ${sgn(chg(cpc, a.cpc))} → 입찰 경쟁이 세졌는지 확인.` });
      else if (ctr != null && a.ctr && chg(ctr, a.ctr) <= -40) items.push({ 등급: '주의', 매체: r.매체, 글: `오늘 CTR ${ctr.toFixed(2)}% — 7일 평균(${a.ctr.toFixed(2)}%)보다 ${sgn(chg(ctr, a.ctr))} → 소재 반응이 떨어졌습니다.` });
    }
  }
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  items.sort((a, b) => RANK[a.등급] - RANK[b.등급]);
  for (const x of items) x.링크 = GO.ads();
  return {
    시각: hhmm, 항목: items, 잔액: balances,
    합계: `오늘 ${hhmm}까지 광고비 ${won(sum('spend'))} · 클릭 ${comma(sum('clk'))} · 장바구니 ${comma(sum('cart'))}건`,
    매체수: rows.filter((r) => r.spend > 0).length,
    기준: '광고 통합(mkboard)이 매체 API 를 그 자리에서 읽은 값 · 오전에는 표본이 작아 광고비 · 클릭의 많고 적음은 판정하지 않음 · 클릭 30 이상인 매체만 CPC · CTR 비교',
  };
}

// ── ⑤ 온라인 프로모션 — 진행 중 · 곧 시작 · 막 끝남 · 없음 ─────────────────────────
//   기준 = MD 제출 정의(promo_defs) + 대상 상품 실적(promoPerformance — 이카운트 원장). 프로모션 목표 매출은 등록돼 있지 않아(2026-10 확인,
//   promo_targets 는 7월 이후 없음 · 값도 0) "목표 대비"가 아니라 ① 프로모션 전 대비 하루 평균(리프트) ② 전년 같은 프로모션 대비
//   ③ 첫 3일 대비 최근 3일(힘이 빠지는지) ④ 프로모션 전 대비 광고비로 본다.
//   등급: 리프트 −20% 이하 심각 · 0% 미만 주의(비교 기간이 다른 프로모션과 겹치면 주의까지만) / 최근 3일이 첫 3일보다 40% 이상 낮고
//   2일 이상 남았으면 주의 / 끝난 뒤 하루 평균이 프로모션 전의 80% 미만이면 주의(반동). 온라인 = 자사몰 · 스마트스토어 행만.
const ONLINE_MALLS = ['자사몰', '스마트스토어'];
const maxDiscount = (dc) => Math.max(0, ...['S', 'P', 'PP', 'accessory', 'cover', 'bead'].map((k) => N(dc && dc[k])));
const dayCount = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400e3) + 1;
const pctOrX = (v) => (v > 200 ? (1 + v / 100).toFixed(1) + '배' : sgn(v)); // +435.7% → 5.4배
const shortRange = (s) => String(s || '').split('~').map((x) => md(x.trim())).join('~'); // 2026-08-25~2026-09-10 → 8/25~9/10

async function promo(d) {
  const defs = (await promoDefs.listDefs({ start: addDays(d, -90), end: addDays(d, 8) })).filter((p) => ONLINE_MALLS.includes(p.mall));
  const groups = new Map();
  for (const p of defs) {
    const g = groups.get(p.promo_id) || { id: p.promo_id, 이름: p.name, 유형: p.promo_type || '', start: p.start, end: p.end, 원래끝: p.original_end || null, malls: [], 할인: 0, 범위: (p.target && p.target.scope) || '' };
    g.malls.push(p.mall); g.할인 = Math.max(g.할인, maxDiscount(p.discount)); groups.set(p.promo_id, g);
  }
  const all = [...groups.values()];
  const active = all.filter((g) => g.start <= d && g.end >= d).sort((a, b) => (a.start < b.start ? -1 : 1));
  const upcoming = all.filter((g) => g.start > d && g.start <= addDays(d, 8)).sort((a, b) => (a.start < b.start ? -1 : 1));
  const recent = all.filter((g) => g.end < d && g.end >= addDays(d, -7)).sort((a, b) => (a.end < b.end ? 1 : -1));
  const last = all.filter((g) => g.end < d && g.범위 === '전제품').sort((a, b) => (a.end < b.end ? 1 : -1))[0] || null;

  // 채널 일별 매출(원장) — 흐름 · 끝난 뒤 반동 계산용. 전제품 프로모션만 채널 매출 = 프로모션 매출로 볼 수 있다
  const starts = [...active, ...recent, ...(last ? [last] : [])].map((g) => g.start).sort();
  const series = starts.length ? await dailyReport.dailyChannelSeries(addDays(starts[0], -14)).catch(() => null) : null;
  const byDate = new Map((series || []).map((r) => [r.Date, r]));
  const avgCh = (mall, a, b) => { if (!series || a > b) return null; let s = 0; for (let x = a; x <= b; x = addDays(x, 1)) s += N((byDate.get(x) || {})[mall]); return s / dayCount(a, b); };
  const head = (g) => `${g.할인 ? ` · 최대 ${g.할인}% 할인` : ''}${g.범위 && g.범위 !== '전제품' ? ` · ${g.범위} 대상` : ''}${g.원래끝 && g.원래끝 !== g.end ? ` · ${md(g.원래끝)}에서 연장` : ''}`;
  // 끝난 뒤 하루 평균 — 프로모션 기간 · 프로모션 전 14일과 견준다
  const after = (g, mall) => {
    const post = avgCh(mall, addDays(g.end, 1), d), during = avgCh(mall, g.start, g.end), pre = avgCh(mall, addDays(g.start, -14), addDays(g.start, -1));
    if (post == null || !(during > 0) || !(pre > 0)) return null;
    const n = dayCount(g.end, d) - 1, low = post < pre * 0.8;
    return { low, 글: `끝난 뒤 ${n}일 하루 평균 ${man(post)} = 프로모션 기간(${man(during)})의 ${((post / during) * 100).toFixed(0)}% · 프로모션 전(${man(pre)})의 ${((post / pre) * 100).toFixed(0)}%${low ? ' — 끝난 뒤가 평소보다 낮습니다(프로모션이 수요를 앞당긴 반동) → 다음 프로모션 전까지 메울 기획 확인.' : '.'}` };
  };

  const out = [];
  // 진행 중
  if (active.length) {
    const from = active[0].start;
    const [perf, trend] = await Promise.all([
      promoPerformance.allForPeriod(from, d),
      adEfficiency.dailyTrend(d8(addDays(from, -14)), d8(d)).catch(() => []),
    ]);
    for (const g of active) {
      const idx = dayCount(g.start, d), total = dayCount(g.start, g.end), left = total - idx, whole = g.범위 === '전제품';
      const items = [];
      for (const mall of ONLINE_MALLS.filter((m) => g.malls.includes(m))) {
        const row = (perf.promotions || []).find((x) => x.promo_id === g.id && x.mall === mall);
        if (!row) continue;
        const days = dayCount(row.periodStart, row.periodEnd), avg = row.sales / days;
        const cmp = row.비교 || {}, base = cmp.직전기간 || null;
        const lift = base && base.리프트_pct != null ? +base.리프트_pct : null, yoy = cmp.전년동기 && cmp.전년동기.증감_pct != null ? +cmp.전년동기.증감_pct : null;
        let t = `${whole ? '' : `대상 상품(${row.대상상품수}개) `}매출 ${man(row.sales)} · 주문 ${comma(row.orders)}건 · 하루 평균 ${man(avg)}`;
        t += lift != null ? ` — 프로모션 전(${shortRange(base.기간)}) 하루 평균 대비 ${pctOrX(lift)}` : ' — 프로모션 전과 견줄 자료 없음';
        if (yoy != null) t += ` · 전년 같은 프로모션 대비 ${pctOrX(yoy)}`;
        t += '.';
        let 등급 = lift == null ? '참고' : lift <= -20 ? '심각' : lift < 0 ? '주의' : '양호';
        if (등급 === '심각' && base && base.주의) 등급 = '주의';
        if (lift != null && lift < 0) t += ` 프로모션 중인데 프로모션 전보다 하루 평균이 낮습니다${base && base.주의 ? '(비교 기간 일부가 다른 프로모션과 겹쳐 낮게 나올 수 있음)' : ''}.`;
        if (whole && idx >= 6) {
          const first3 = avgCh(mall, g.start, addDays(g.start, 2)), last3 = avgCh(mall, addDays(d, -2), d), mom = first3 > 0 ? chg(last3, first3) : null;
          if (mom != null && mom <= -40 && left >= 2) { if (등급 === '양호') 등급 = '주의'; t += ` 최근 3일 하루 평균 ${man(last3)} — 첫 3일(${man(first3)})보다 ${sgn(mom)}, 힘이 빠지고 있습니다 → 남은 ${left}일 리마인드(알림 · 배너 · 광고 소재) 필요.`; }
          else if (mom != null) t += ` 최근 3일 하루 평균 ${man(last3)}(첫 3일 대비 ${sgn(mom)}).`;
        }
        items.push({ 등급, 채널: mall, 글: t });
      }
      // 광고 — 프로모션 기간 하루 평균 광고비 vs 프로모션 전 14일
      let 요약 = null;
      const sp = (a, b) => { const rows = trend.filter((r) => r.date >= d8(a) && r.date <= d8(b)); return rows.length ? rows.reduce((s, r) => s + r.spend, 0) / rows.length : null; };
      const during = sp(g.start, d), before = sp(addDays(g.start, -14), addDays(g.start, -1));
      if (whole && during != null && before > 0) {
        const c = chg(during, before);
        요약 = `광고비 하루 평균 ${man(during)} — 프로모션 전 14일(${man(before)}) 대비 ${sgn(c)}: ${c <= -10 ? '프로모션 중인데 광고는 줄었습니다.' : c >= 10 ? '프로모션에 맞춰 광고를 늘렸습니다.' : '광고는 평소 수준입니다.'}`;
      }
      out.push({ 상태: '진행', 이름: g.이름, 유형: g.유형, 머리: `${md(g.start)}~${md(g.end)} · ${idx}일째 / 총 ${total}일 · ${left > 0 ? `남은 ${left}일${left <= 2 ? '(종료 임박)' : ''}` : '어제가 마지막 날'}${head(g)}`, 요약, 항목: items });
    }
  }
  // 곧 시작(오늘 포함 7일 안)
  for (const g of upcoming) {
    const dn = dayCount(addDays(d, 1), g.start) - 1, total = dayCount(g.start, g.end);
    const items = [];
    if (last && series) {
      const ref = ONLINE_MALLS.filter((m) => last.malls.includes(m)).map((m) => `${m} ${man(avgCh(m, last.start, addDays(last.start, 2)))}`).join(' · ');
      items.push({ 등급: '참고', 채널: '기준선', 글: `직전 전제품 프로모션(${last.이름}) 첫 3일 하루 평균 — ${ref}. 시작 3일은 이 숫자와 견줍니다.` });
    }
    out.push({ 상태: '예정', 이름: g.이름, 유형: g.유형, 머리: `${md(g.start)} 시작(${dn <= 0 ? '오늘' : 'D-' + dn}) ~ ${md(g.end)} · 총 ${total}일${head(g)}`, 요약: null, 항목: items });
  }
  // 막 끝남(7일 안) — 결과와 끝난 뒤 반동
  for (const g of recent) {
    const perf = await promoPerformance.allForPeriod(g.start, g.end).catch(() => null);
    const items = [];
    for (const mall of ONLINE_MALLS.filter((m) => g.malls.includes(m))) {
      const row = perf && (perf.promotions || []).find((x) => x.promo_id === g.id && x.mall === mall);
      if (!row) continue;
      const cmp = row.비교 || {}, lift = cmp.직전기간 && cmp.직전기간.리프트_pct != null ? +cmp.직전기간.리프트_pct : null, yoy = cmp.전년동기 && cmp.전년동기.증감_pct != null ? +cmp.전년동기.증감_pct : null;
      let t = `결과: ${g.범위 === '전제품' ? '' : `대상 상품(${row.대상상품수}개) `}매출 ${man(row.sales)} · 주문 ${comma(row.orders)}건 · 하루 평균 ${man(row.sales / dayCount(row.periodStart, row.periodEnd))}${lift != null ? ` · 프로모션 전 대비 ${sgn(lift)}` : ''}${yoy != null ? ` · 전년 대비 ${sgn(yoy)}` : ''}.`;
      const af = g.범위 === '전제품' ? after(g, mall) : null;
      items.push({ 등급: af && af.low ? '주의' : '참고', 채널: mall, 글: t + (af ? ' ' + af.글 : '') });
    }
    out.push({ 상태: '종료', 이름: g.이름, 유형: g.유형, 머리: `${md(g.start)}~${md(g.end)} · 끝난 뒤 ${dayCount(g.end, d) - 1}일째${head(g)}`, 요약: null, 항목: items });
  }
  // 프로모션 미등록 — 진행 중인 것도 7일 안에 시작하는 것도 등록돼 있지 않으면 온라인 쪽 "심각"으로 남긴다(사용자 지정 2026-10-12:
  //   "프로모션 등록을 진행하지 않으면 프로모션 피드백을 받을 수 없다"). 곧 시작하는 프로모션이 등록돼 있으면 올리지 않는다.
  //   막 끝난 프로모션만 있고 다음 것이 없을 때도 올린다.
  const 경고 = [];
  if (!active.length && !upcoming.length) {
    const lastAny = all.filter((g) => g.end < d).sort((x, y) => (x.end < y.end ? 1 : -1))[0] || null;
    경고.push({ 등급: '심각', 채널: '프로모션 미등록', 글: '등록된 프로모션이 없습니다 — 프로모션 등록을 진행하지 않으면 프로모션 피드백을 받을 수 없습니다.' +
      (lastAny ? ` 마지막 등록은 ${lastAny.이름}(${md(lastAny.start)}~${md(lastAny.end)})이고 끝난 뒤 ${dayCount(lastAny.end, d) - 1}일째입니다.` : '') +
      ' → 진행 중이거나 예정인 행사를 프로모션 등록(📣)에 올려 주세요.', 링크: GO.promo });
    // 막 끝난 것도 없으면 — 마지막 전제품 프로모션 이후 상태(끝난 지 30일 안일 때만)
    if (!out.length && last && dayCount(last.end, d) - 1 <= 30) {
      const items = ONLINE_MALLS.filter((m) => last.malls.includes(m)).map((m) => { const af = after(last, m); return af ? { 등급: af.low ? '주의' : '참고', 채널: m, 글: af.글 } : null; }).filter(Boolean);
      if (items.length) out.push({ 상태: '없음', 이름: last.이름, 유형: last.유형, 머리: `${md(last.start)}~${md(last.end)} · 끝난 뒤 ${dayCount(last.end, d) - 1}일째`, 요약: null, 항목: items });
    }
  }
  // 그래프용 일별 흐름 — 기준 프로모션의 전 14일부터 기준일까지 자사몰 · 스마트스토어 매출. 기준 프로모션이 없으면 최근 30일.
  const ref = active.find((g) => g.범위 === '전제품') || recent.find((g) => g.범위 === '전제품') || (last && dayCount(last.end, d) - 1 <= 30 ? last : null);
  const from = ref ? addDays(ref.start, -14) : addDays(d, -29);
  const flowRows = series && ref ? series : await dailyReport.dailyChannelSeries(from).catch(() => null);
  let 흐름 = null;
  if (flowRows) {
    const m = new Map(flowRows.map((r) => [r.Date, r])), 날짜 = [], 자사몰 = [], 스마트스토어 = [];
    for (let x = from; x <= d; x = addDays(x, 1)) { const r = m.get(x) || {}; 날짜.push(x); 자사몰.push(Math.round(N(r.자사몰))); 스마트스토어.push(Math.round(N(r.스마트스토어))); }
    흐름 = { 날짜, 자사몰, 스마트스토어, 구간: ref ? { 이름: ref.이름, start: ref.start, end: ref.end } : null };
  }
  return {
    경고, 프로모션: out, 흐름,
    기준: '프로모션 = MD 제출 정의(promo_defs) · 실적 = 대상 상품 매출(이카운트 원장) · 프로모션 전 대비 = 하루 평균끼리(MD 가 지정한 비교 기간, 없으면 자동) · 목표 매출은 등록돼 있지 않아 쓰지 않음',
  };
}

// 팀별 심각만 한 줄씩 — 일일 모니터링의 전사 점검과 dash 첫 화면 "오늘 챙길 것" 카드가 같은 목록을 쓴다(사용자 요청 2026-10-12).
//   순서: 오프라인(매장) → 온라인(프로모션 · 어제 매출 진단) → 광고(실시간 · 전달 대비).
function criticals(r) {
  const out = [], ok = (x) => x && x.ok;
  if (ok(r.오프라인)) for (const s of r.오프라인.data.매장) if (s.등급 === '심각') out.push({ 팀: '오프라인', 이름: s.매장, 글: s.지시, 링크: null });
  const online = [].concat(ok(r.프로모션) ? r.프로모션.data.경고 : [], ok(r.프로모션) ? r.프로모션.data.프로모션.flatMap((p) => p.항목) : [], ok(r.진단) ? r.진단.data.항목 : []);
  for (const x of online) if (x.등급 === '심각') out.push({ 팀: '온라인', 이름: x.채널, 글: x.글, 링크: x.링크 || null });
  const ads = [].concat(ok(r.실시간) ? r.실시간.data.항목.filter((x) => !x.중복) : [], ok(r.광고) ? r.광고.data.매체 : []);
  for (const x of ads) if (x.등급 === '심각') out.push({ 팀: '광고', 이름: x.매체, 글: x.글 || x.평가, 링크: x.링크 || null });
  return out;
}

/**
 * 전체 — jwasuP: dailyMail.jwasuDay(date) 의 Promise(같은 좌수 API 를 두 번 부르지 않게 넘겨받는다)
 * 실시간 광고는 기준일이 어제일 때만(과거 날짜를 볼 때는 오늘 광고가 의미 없다).
 */
async function build({ date, jwasuP }) {
  const d = date;
  const wrap = (p) => Promise.resolve(p).then((data) => ({ ok: true, data })).catch((e) => ({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
  const recentP = adEfficiency.rows(d8(addDays(d, -13)), d8(d));
  recentP.catch(() => {}); // 아래 구역들이 각자 실패를 받는다
  const [off, ad, diag, rt, pr] = await Promise.all([
    wrap(Promise.resolve(jwasuP).then((jw) => offline(d, jw))),
    wrap(adsVsPrev(d, recentP)),
    wrap(diagnose(d, recentP)),
    d === yesterdayKST() ? wrap(realtime(d, recentP)) : Promise.resolve(null),
    wrap(promo(d)),
  ]);
  // 수집이 끊긴 매체에 실시간 오류의 이유를 붙인다(같은 벤더) — "끊겼다"와 "왜"를 한 줄에서 보게
  if (ad.ok && rt && rt.ok) {
    for (const row of ad.data.매체) {
      const e = rt.data.항목.find((x) => x.벤더 && x.벤더 === adEfficiency.vendorOf(row.매체));
      if (e && ad.data.끊김.some((g) => g.매체 === row.매체)) { row.평가 += ' 원인: ' + e.글; e.중복 = true; } // 심각 목록에는 한 번만(끊김 줄에 이유까지 들어 있다)
    }
  }
  const all = [];
  if (off.ok) all.push(...off.data.매장);
  if (ad.ok) all.push(...ad.data.매체);
  if (diag.ok) all.push(...diag.data.항목);
  if (rt && rt.ok) all.push(...rt.data.항목);
  if (pr.ok) { all.push(...pr.data.경고); for (const p of pr.data.프로모션) all.push(...p.항목); }
  const result = { 기준일: d, 오프라인: off, 프로모션: pr, 광고: ad, 진단: diag, 실시간: rt, 개수: { 심각: all.filter((x) => x.등급 === '심각').length, 주의: all.filter((x) => x.등급 === '주의').length } };
  result.심각목록 = criticals(result);
  return result;
}

module.exports = { build, offline, adsVsPrev, diagnose, realtime, promo, criticals, prevMonth };
