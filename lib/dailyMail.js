'use strict';

/**
 * 일일 모니터링 메일 — 페이지 데이터. public/dashboards/daily_mail.html 이 그리고,
 *   매일 이 페이지를 통째로 캡처해 메일로 보낸다(대표 요청: 매크로 정리 → 모니터링 대시보드를 메일로).
 *
 *   ① 온오프 매출·샐리필 = 기존 메일(다른 PC photo.js) 그대로. 여기엔 맨 위 "어제 한눈에"에
 *      어제 매출·경보(server.js 가 alerts 를 붙인다) + 목표 대비 매출(온라인 몰별 · 오프라인 매장별, salesVsTarget).
 *   ② 자사몰 / 스마트스토어 KPI — funnelDaily 와 같은 계산(일일 퍼널 점검 화면과 숫자가 같아야 한다)
 *   ③ 오프라인 좌수 일일 체크 — realtime 좌수 + off.orders 매장 매출
 *   ④ 재고 주의 — stockWatch(품번 기준, MD 양식)
 *   섹션마다 따로 잡는다 — 한 원천이 죽어도 나머지 섹션은 나온다(실패 섹션은 error 문구).
 */

const store = require('./store');
const dailyReport = require('./dailyReport');
const target = require('./target');
const funnelDaily = require('./funnelDaily');
const jl = require('./jwasuLeague');
const stockWatch = require('./stockWatch');
const adEfficiency = require('./adEfficiency');
const fallbackTargets = require('../config/fallbackTargets'); // 등록 안 된 목표의 예비값(MD 공유 목표표)

const R = (n) => Math.round(n || 0);
const N = (v) => (Number.isFinite(+v) ? +v : 0);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const yesterdayKST = () => addDays(new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), -1);
const pct = (a, b) => (b > 0 && a != null ? +((a / b) * 100).toFixed(1) : null);

// 지표 한 줄 — 실적·목표·달성률. 목표가 없으면 달성률 없음, 실적이 없으면(미입력) act=null.
const line = (name, act, tgt, unit = '') => ({ 지표: name, 실적: act, 목표: tgt != null ? +(+tgt).toFixed(unit === '%' ? 2 : 0) : null, 달성률: act != null && tgt ? pct(act, tgt) : null, 단위: unit });

// ── ① 목표 대비 매출 — 온라인 몰별 · 오프라인 매장별 ──────────────────────────
//   원장 = 이카운트 출고(on.orders / off.orders, 반품 차감) — 일일매출보고와 같은 숫자.
//   온라인 목표: 자사몰 = targets.cafe24 · 스마트스토어 = targets.smartstore · 외부 몰 = targets.byMall.<몰 이름>(없으면 미등록)
//   온라인 합계 = 자사몰 + 스마트스토어 + 외부채널 — 공동구매는 일일매출보고 KPI 처럼 합계에서 빼고 따로 보인다.
//   오프라인 목표: jwasu_monthly_targets 의 매장 목표(Y리그 스토어와 같은 값, 매장당 같은 값이 복제돼 있어 max).
//   오프라인 '요기보매니저영업' 주문은 담당 매니저의 등록 매장 매출로 넘긴다(jwasuLeague.proxyStoreResolver — Y리그 화면과 같은 규칙).
async function salesVsTarget(date) {
  const ym = date.slice(0, 7), from = ym + '-01';
  const days = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
  // 매장(+매니저)별 월 누적·어제. 오프라인은 매니저까지 묶어 '요기보매니저영업' 주문을 담당 매니저의 등록 매장으로 옮긴다.
  const byStore = async (db, withManager) => (await store.namedCollection(db, 'orders')).aggregate([
    { $match: { date: { $gte: from, $lte: date } } },
    { $group: { _id: withManager ? { s: '$store', m: '$manager' } : '$store', mtd: { $sum: '$amount' }, yday: { $sum: { $cond: [{ $eq: ['$date', date] }, '$amount', 0] } } } },
  ]).toArray();
  const offByStore = async () => {
    const [rows, resolve] = await Promise.all([byStore('off', true), jl.proxyStoreResolver()]);
    const m = new Map();
    for (const r of rows) {
      const s = resolve(r._id.s, r._id.m) || '(미지정)';
      const o = m.get(s) || { _id: s, mtd: 0, yday: 0 };
      o.mtd += N(r.mtd); o.yday += N(r.yday);
      m.set(s, o);
    }
    return [...m.values()];
  };
  // 샐리필 — 온라인 파이프라인 STEP 2b 가 이카운트에서 따로 받아 on.sallyfeel_orders 에 넣는다(거래처 = 샐리필 거래처 전부)
  //   건수가 적어(9월 9행) 이번 달 주문을 통째로 읽어 거래처 합계·일별·주문 내역(화면 "+ 일별" 팝업)을 한 번에 만든다.
  const sfOrders = async () => (await store.namedCollection('on', 'sallyfeel_orders'))
    .find({ date: { $gte: from, $lte: date } }, { projection: { _id: 0, date: 1, store: 1, orderNo: 1, productName: 1, color: 1, qty: 1, amount: 1, itemCode: 1 } })
    .sort({ date: 1, orderNo: 1 }).limit(2000).toArray().catch(() => []);
  const sfByStore = async () => {
    const list = await sfOrders();
    const m = new Map();
    for (const o of list) {
      const s = o.store || '(미지정)';
      const x = m.get(s) || { _id: s, mtd: 0, yday: 0 };
      x.mtd += N(o.amount); if (o.date === date) x.yday += N(o.amount);
      m.set(s, x);
    }
    const days = new Map();
    for (const o of list) {
      const d = days.get(o.date) || { 날짜: o.date, 거래처: {}, 합계: 0, 수량: 0 };
      d.거래처[o.store || '(미지정)'] = (d.거래처[o.store || '(미지정)'] || 0) + N(o.amount);
      d.합계 += N(o.amount); d.수량 += N(o.qty);
      days.set(o.date, d);
    }
    const rows = [...m.values()];
    rows.일별 = [...days.values()].map((d) => ({ ...d, 합계: R(d.합계) }));
    rows.내역 = list.map((o) => ({ 날짜: o.date, 거래처: o.store, 주문번호: o.orderNo, 품목코드: o.itemCode || '', 상품명: o.productName, 색상: o.color || '', 수량: N(o.qty), 금액: R(o.amount) }));
    return rows;
  };
  const [onRows, offRows, tg, tDoc, offT, sfRows] = await Promise.all([
    byStore('on'), offByStore(),
    target.getTargets(ym).catch(() => ({})),
    store.collection('targets').then((c) => c.findOne({ month: ym })).catch(() => null),
    store.namedCollection('yogibo', 'jwasu_monthly_targets').then((c) => c.find({ month: ym }).toArray()).catch(() => []),
    sfByStore(),
  ]);
  // 목표 출처 — 그 달 등록값(DB)이 있으면 그것, 없으면 그 달 MD 공유 목표표(config/fallbackTargets, 화면에 * 표시), 둘 다 없으면 미등록.
  //   지난달 값·예전 기본값은 이어 쓰지 않는다 — 그 달에 안 올렸으면 0(사용자 확인 2026-10-01).
  //   오프라인은 매장 목표 시스템(jwasu_monthly_targets) 값만 쓴다 — 예비값 없음(사용자: "그쪽에서 끌어오면 되고").
  const pickT = (reg, fb) => (reg > 0 ? [reg, '등록'] : fb > 0 ? [fb, '예비'] : [0, null]);
  const row = (name, yday, mtd, tgt, src) => ({ 이름: name, 어제: R(yday), 누적: R(mtd), 목표: tgt > 0 ? R(tgt) : null, 달성률: tgt > 0 ? pct(mtd, tgt) : null, ...(tgt > 0 && src ? { 목표출처: src } : {}) });
  const sfList = sfRows.map((r) => row(r._id || '(미지정)', r.yday, r.mtd, 0)).sort((a, b) => b.누적 - a.누적);
  const sfSum = (k) => sfList.reduce((a, s) => a + (s[k] || 0), 0);
  const FB = fallbackTargets[ym] || {};
  const fbOn = FB.online || {};

  // 온라인 — 채널 합 + 외부 몰별
  const byMall = (tDoc && tDoc.byMall) || {};
  // 몰별 목표 — 띄어쓰기 무시하고 이카운트 거래처명과 맞춘다(MD가 "삼성카드쇼핑"처럼 붙여 적어도 이어지게)
  const sq = (s) => String(s || '').replace(/\s/g, '');
  const mallReg = new Map(Object.entries(byMall).map(([k, v]) => [sq(k), N(v)]));
  const mallFb = new Map(Object.entries(fbOn.몰 || {}).map(([k, v]) => [sq(k), N(v)]));
  const mallT = (name) => pickT(mallReg.get(sq(name)) || 0, mallFb.get(sq(name)) || 0);
  const ch = { 자사몰: [0, 0], 스마트스토어: [0, 0], 외부채널: [0, 0], 공동구매: [0, 0] };
  const malls = [];
  for (const r of onRows) {
    const c = dailyReport.classifyChannel(r._id);
    ch[c][0] += N(r.yday); ch[c][1] += N(r.mtd);
    if (c === '외부채널') malls.push(row(r._id || '(미지정)', r.yday, r.mtd, ...mallT(r._id)));
  }
  // 목표는 있는데 이번 달 매출이 아직 없는 몰도 줄로 보인다(월초)
  const seenMall = new Set(malls.map((x) => sq(x.이름)));
  const targetMalls = new Map();
  for (const [k] of Object.entries(byMall)) if (dailyReport.classifyChannel(k) === '외부채널') targetMalls.set(sq(k), k);
  for (const k of Object.keys(fbOn.몰 || {})) if (!targetMalls.has(sq(k))) targetMalls.set(sq(k), k);
  for (const [key, name] of targetMalls) if (!seenMall.has(key) && mallT(name)[0] > 0) malls.push(row(name, 0, 0, ...mallT(name)));
  const extTarget = [...targetMalls.values()].reduce((a, name) => a + mallT(name)[0], 0);
  const [tC, srcC] = pickT(N(tDoc && tDoc.cafe24), N(fbOn.자사몰));
  const [tS, srcS] = pickT(N(tDoc && tDoc.smartstore), N(fbOn.스마트스토어));
  const extSrc = malls.some((x) => x.목표출처 === '예비') ? '예비' : '등록';
  const onYday = ch.자사몰[0] + ch.스마트스토어[0] + ch.외부채널[0], onMtd = ch.자사몰[1] + ch.스마트스토어[1] + ch.외부채널[1];

  // 오프라인 — 매장별(목표만 있고 매출이 없는 매장도 보인다). 목표 = 매장 목표 시스템 값만.
  const offReg = {};
  for (const t of offT) offReg[t.storeName] = Math.max(offReg[t.storeName] || 0, N(t.targetMonthlySales));
  const stores = offRows.map((r) => row(r._id || '(미지정)', r.yday, r.mtd, offReg[r._id] || 0, '등록'));
  for (const sn of Object.keys(offReg)) if (!offRows.some((r) => r._id === sn)) stores.push(row(sn, 0, 0, offReg[sn], '등록'));
  stores.sort((a, b) => b.누적 - a.누적);
  // 월 목표가 없는 매장은 뺀다 — 아직 오픈 전이거나 운영하지 않는 매장일 수 있다(사용자 요청 2026-10-01).
  //   단 그 달 매장 목표가 하나도 없으면(월초 등록 전) 전부 보인다 — 표가 통째로 비지 않게.
  const hasTargets = stores.some((s) => s.목표 != null);
  const live = hasTargets ? stores.filter((s) => s.목표 != null) : stores;
  const skipped = hasTargets ? stores.filter((s) => s.목표 == null) : [];
  const offSum = (k) => live.reduce((a, s) => a + (s[k] || 0), 0);

  return {
    월경과율: +((+date.slice(8, 10) / days) * 100).toFixed(1),
    온라인: {
      채널: [
        row('자사몰', ch.자사몰[0], ch.자사몰[1], tC, srcC),
        row('스마트스토어', ch.스마트스토어[0], ch.스마트스토어[1], tS, srcS),
        { ...row('외부채널', ch.외부채널[0], ch.외부채널[1], extTarget, extSrc), 몰: malls.sort((a, b) => b.누적 - a.누적 || (b.목표 || 0) - (a.목표 || 0)) },
      ],
      공동구매: ch.공동구매[1] || ch.공동구매[0] ? row('공동구매', ch.공동구매[0], ch.공동구매[1], 0) : null,
      합계: row('온라인 합계', onYday, onMtd, tC + tS + extTarget),
      예비목표사용: [srcC, srcS, extSrc].includes('예비') || malls.some((x) => x.목표출처 === '예비'),
    },
    오프라인: {
      매장: live, 합계: row('오프라인 합계', offSum('어제'), offSum('누적'), offSum('목표')),
      목표미등록: hasTargets ? null : '이번 달 매장 목표가 아직 등록되지 않아 전체 매장을 보입니다',
      // 뺀 매장 — 개수만 알리고, 매출이 있는 곳만 이름·금액을 적는다(맨 위 오프라인 매출 타일과의 차이 설명).
      //   요기보매니저영업은 매장이 아니라 위에서 이미 담당 매장으로 옮겼으므로 목록에서 뺀다.
      제외: (() => {
        const list = skipped.filter((s) => s.이름 !== jl.SALES_PROXY_STORE);
        if (!list.length) return null;
        return { 매장수: list.length, 매출있음: list.filter((s) => s.누적 || s.어제).map((s) => ({ 이름: s.이름, 어제: s.어제, 누적: s.누적 })) };
      })(),
    },
    // 샐리필 — 거래처별 어제·월 누적(목표 없음). 매출이 적어 거래처가 0곳일 수 있다.
    // 샐리필 목표는 통합 하나뿐(거래처별 없음) — 합계 줄에만 목표·달성률
    샐리필: { 거래처: sfList, 합계: row('샐리필 합계', sfSum('어제'), sfSum('누적'), ...pickT(0, N(FB.sallyfeel))), 일별: sfRows.일별 || [], 내역: sfRows.내역 || [] },
    기준: '이카운트 출고 기준(반품 차감) · 온라인 합계는 공동구매 제외(일일매출보고와 같음) · 목표: 온라인 = 월 목표 설정, 오프라인 = 매장 월 목표 · 요기보매니저영업 주문은 담당 매니저의 등록 매장 매출로 집계(Y리그와 같은 규칙)',
  };
}

// ── ① 상단 타일 — 전사·온라인·오프라인 매출 · 자사몰 방문 · 광고비 (기간 합계) ─────────────
//   예전엔 경보 스캔(어제 고정)에서 가져와 다른 날짜를 보면 사라졌다 → 원장에서 직접, 어떤 날짜·기간이든.
//   비교: 하루면 전주 동요일(매출은 요일 영향이 커서), 이틀 이상이면 바로 앞 같은 길이 기간.
//   온라인 = 자사몰 + 스마트스토어 + 외부채널(공동구매 제외 — 일일매출보고·경보와 같은 정의) · 오프라인 = 매장 주문서
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);
async function tiles(start, end) {
  const s = start, e = end && end >= start ? end : start;
  const days = dayDiff(s, e) + 1;
  if (days > 366) throw new Error('기간은 1년(366일)까지 볼 수 있습니다');
  // 달 하나를 통째로 고르면(1일 ~ 말일) 전월 전체와 — "직전 30일"보다 읽기 쉽다
  const lastDay = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
  const fullMonth = s.endsWith('-01') && s.slice(0, 7) === e.slice(0, 7) && +e.slice(8, 10) === lastDay(s.slice(0, 7));
  let ps, pe, cmpName;
  if (fullMonth) {
    const pm = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 2, 1)).toISOString().slice(0, 7);
    ps = pm + '-01'; pe = `${pm}-${String(lastDay(pm)).padStart(2, '0')}`; cmpName = '전월';
  } else {
    const shift = days === 1 ? 7 : days;
    ps = addDays(s, -shift); pe = addDays(e, -shift); cmpName = days === 1 ? '전주 동요일' : `직전 ${days}일`;
  }
  const sumOn = async (a, b) => {
    const r = await (await store.namedCollection('on', 'orders')).aggregate([
      { $match: { date: { $gte: a, $lte: b } } }, { $group: { _id: '$store', amt: { $sum: '$amount' } } }]).toArray();
    return r.reduce((t, x) => t + (dailyReport.classifyChannel(x._id) === '공동구매' ? 0 : N(x.amt)), 0);
  };
  const sumOff = async (a, b) => {
    const r = await (await store.namedCollection('off', 'orders')).aggregate([
      { $match: { date: { $gte: a, $lte: b } } }, { $group: { _id: null, amt: { $sum: '$amount' } } }]).toArray();
    return r[0] ? N(r[0].amt) : 0;
  };
  // 자사몰 방문 = KPI 표와 같은 값(이프두, 업로드 전인 날만 Cafe24 — funnelDaily.mallBaseMap). 가입은 Cafe24.
  //   Cafe24로 채운 날이 있으면 개수를 알린다(이프두보다 15~20% 많게 나와 비교 % 가 부풀 수 있다).
  const traffic = async (a, b) => {
    const [r, base] = await Promise.all([
      (await store.collection('traffic_daily')).aggregate([
        { $match: { date: { $gte: a, $lte: b } } }, { $group: { _id: null, s: { $sum: '$signups' } } }]).toArray(),
      funnelDaily.mallBaseMap(a, b),
    ]);
    let v = 0, sysDays = 0;
    for (const x of base.values()) { v += x.visits; if (x.src === '시스템' && x.visits > 0) sysDays++; }
    return { 방문: R(v), 신규가입: r[0] ? N(r[0].s) : 0, 일수: base.size, cafe24일수: sysDays };
  };
  const adSpend = async (a, b) => { try { return N((await adEfficiency.efficiency(a.replace(/-/g, ''), b.replace(/-/g, ''))).total.spend); } catch (_) { return null; } };
  if (e >= addDays(yesterdayKST(), -5)) await dailyReport.trafficSeries(addDays(e, -6)).catch(() => null); // 최근 날 방문 0 자가치유
  const [on, off, pOn, pOff, tr, pTr, ad, pAd] = await Promise.all([sumOn(s, e), sumOff(s, e), sumOn(ps, pe), sumOff(ps, pe), traffic(s, e), traffic(ps, pe), adSpend(s, e), adSpend(ps, pe)]);
  const chg = (a, b) => (b > 0 ? +(((a - b) / b) * 100).toFixed(1) : null);
  return {
    시작: s, 종료: e, 일수: days,
    비교: { 시작: ps, 종료: pe, 이름: cmpName },
    매출: { 전사: R(on + off), 온라인: R(on), 오프라인: R(off), 전사_변화_pct: chg(on + off, pOn + pOff), 온라인_변화_pct: chg(on, pOn), 오프라인_변화_pct: chg(off, pOff) },
    트래픽: { 방문: tr.방문, 신규가입: tr.신규가입, 방문_변화_pct: chg(tr.방문, pTr.방문), cafe24일수: tr.cafe24일수, 비교_cafe24일수: pTr.cafe24일수 },
    광고: { 광고비: ad == null ? null : R(ad), 광고비_변화_pct: ad == null || pAd == null ? null : chg(ad, pAd), 온라인매출대비_pct: ad != null && on > 0 ? +((ad / on) * 100).toFixed(1) : null },
  };
}

// ── ② KPI ──────────────────────────────────────────────────────────────────
async function kpi(date) {
  const ym = date.slice(0, 7);
  // 자사몰 방문수 자가치유 먼저 — 야간 동기화가 최근 날의 visits 를 0 으로 덮어쓰는 일이 있다.
  //   dailyReport.trafficSeries 가 최근 5일 중 0 인 날을 라이브 Cafe24 값으로 채우고 DB 까지 고친다(2026-10-01: 9/30 이 0 이었음).
  await dailyReport.trafficSeries(addDays(date, -6)).catch(() => null);
  const db = await funnelDaily.buildDb({ from: ym + '-01', to: date });
  const cfg = { targets: db.cfg.targets, benchMall: db.cfg.benchMall, benchSS: db.cfg.benchSS };
  const net = new Map(db.cfg.netDaily.map((x) => [x[0], x]));

  // 월 진척 — 퍼널 점검 화면 renderPace 와 같은 식(값이 있는 날 수로 페이스·착지를 낸다)
  const pace = (T, idx) => {
    const rows = db.cfg.netDaily.filter((x) => x[0] <= date && x[idx] != null);
    const mtd = rows.reduce((a, x) => a + x[idx], 0), el = rows.length;
    if (!T) return { 누적순매출: R(mtd), 집계일수: el, 월목표: null };
    const expect = (T.mNet * el) / T.days, landing = el ? (mtd / el) * T.days : null;
    return { 누적순매출: R(mtd), 집계일수: el, 월일수: T.days, 월목표: R(T.mNet), 달성률: pct(mtd, T.mNet), 페이스기대: R(expect), 페이스대비: pct(mtd, expect), 월말예상: R(landing), 월말예상_달성률: pct(landing, T.mNet) };
  };

  // 자사몰 — 방문·주문완료·상품조회·장바구니·주문서는 MD 업로드(이프두), 순매출은 자동(Cafe24).
  //   그날 이프두가 아직 안 올라왔으면 방문·주문완료는 Cafe24 값으로 채우고 표시한다(sys — 목표는 이프두 기준이라 섞인 값임을 알린다).
  const Tm = funnelDaily.targetsFor(cfg, 'mall', ym), Bm = cfg.benchMall;
  const m = db.mall.find((x) => x[0] === date);
  const mNet = net.get(date) ? net.get(date)[1] : null;
  const md = (v) => (m && v > 0 ? v : null); // 0 = 미입력(이프두 파일이 아직 안 올라옴)
  const sys = (db.cfg.mallSysDates || []).includes(date);
  const tagSys = (x) => (sys && x.실적 != null ? { ...x, 출처: 'Cafe24' } : x);
  const mall = {
    입력: { 자동: !!(m && m[1] > 0), 이프두: !!(m && (m[2] || m[3] || m[4])) },
    방문출처: m && m[1] > 0 ? (sys ? 'Cafe24' : '이프두') : null,
    지표: m ? [
      tagSys(line('유입(방문)', m[1] > 0 ? m[1] : null, Tm && Tm.visit)), // 0 = 아직 수집 전 — 0 으로 보이면 급락처럼 읽힌다
      line('상품조회', md(m[2]), Tm && Tm.view),
      line('장바구니', md(m[3]), Tm && Tm.cart),
      line('주문서작성', md(m[4]), Tm && Tm.order),
      tagSys(line('주문완료', m[5], Tm && Tm.done)),
      line('순매출', mNet, Tm && Tm.net, '원'),
      tagSys(line('구매전환율', m[1] ? +((m[5] / m[1]) * 100).toFixed(2) : null, Bm.doneRate, '%')),
      tagSys(line('객단가', m[5] && mNet != null ? R(mNet / m[5]) : null, Bm.aov, '원')),
    ] : [],
    월진척: pace(Tm, 1),
  };

  // 스마트스토어 — 유입은 MD 입력(비즈어드바이저), 주문·매출은 이카운트 원장
  const Ts = funnelDaily.targetsFor(cfg, 'ss', ym), Bs = cfg.benchSS;
  const s = db.ss.find((x) => x[0] === date);
  const sIn = s && s[1] > 0 ? s[1] : null;
  const ssSale = net.get(date) ? net.get(date)[2] : null;
  const sOrders = s ? s[2] : null;
  const ss = {
    입력: { 유입: !!sIn },
    지표: [
      line('유입', sIn, Ts && Ts.visit),
      line('주문건수', sOrders, Ts && Ts.orders),
      line('순매출', ssSale, Ts && Ts.net, '원'),
      line('구매율', sIn && sOrders != null ? +((sOrders / sIn) * 100).toFixed(2) : null, Bs.rate, '%'),
      line('건당 매출', sOrders && ssSale != null ? R(ssSale / sOrders) : null, Bs.perOrder, '원'),
    ],
    월진척: pace(Ts, 2),
  };
  return { mall, ss, 기준: db.cfg.기준, 업로드: await uploadStatus().catch(() => null) };
}

// MD 업로드 현황 — 비어 있는 칸이 "시스템 오류"가 아니라 "MD 업로드 전"임을 메일에 적기 위해(사용자 요청 2026-10-01).
//   스토어 유입 = on.bizInflow(📈 스토어 유입 입력 · 비즈어드바이저) · 이프두 3단계 = funnel_mall_daily(📊 퍼널 입력)
//   마지막업로드 = 가장 최근 저장 시각, 반영까지 = 값이 들어 있는 마지막 날짜
async function uploadStatus() {
  const biz = await store.namedCollection('on', 'bizInflow');
  const mallC = await store.collection('funnel_mall_daily');
  const [bLast, bMax, mLast, mMax] = await Promise.all([
    biz.find({}, { projection: { _id: 0, updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).toArray(),
    biz.aggregate([{ $match: { inflow: { $gt: 0 } } }, { $group: { _id: null, mx: { $max: '$date' } } }]).toArray(),
    mallC.find({}, { projection: { _id: 0, _at: 1 } }).sort({ _at: -1 }).limit(1).toArray(),
    mallC.aggregate([{ $match: { $or: [{ 상품조회: { $gt: 0 } }, { 장바구니조회: { $gt: 0 } }, { 주문서작성: { $gt: 0 } }] } }, { $group: { _id: null, mx: { $max: '$date' } } }]).toArray(),
  ]);
  return {
    스토어유입: { 이름: '스마트스토어 유입(📈 스토어 유입 입력 · 비즈어드바이저)', 마지막업로드: (bLast[0] && bLast[0].updatedAt) || null, 반영까지: (bMax[0] && bMax[0].mx) || null },
    이프두: { 이름: '자사몰 상품조회·장바구니·주문서(📊 퍼널 입력 · 이프두)', 마지막업로드: (mLast[0] && mLast[0]._at) || null, 반영까지: (mMax[0] && mMax[0].mx) || null },
  };
}

// ── ② 광고 — 매체별 어제 · 월 누적 (adboard.daily_stats, mkboard 가 매체 API 에서 적재) ─────────
//   매체 전환매출·ROAS 는 매체끼리 같은 주문을 중복으로 잡아 부풀려진다(dash 홈 원칙) — 실제 효율은
//   화면에서 "광고비 ÷ 온라인 매출(이카운트)"로 보이고, 전환매출은 참고로만 둔다.
async function ads(date) {
  const d8 = date.replace(/-/g, ''), m8 = date.slice(0, 7).replace('-', '') + '01';
  const [day, mtd] = await Promise.all([adEfficiency.efficiency(d8, d8), adEfficiency.efficiency(m8, d8)]);
  const mtdBy = new Map((mtd.platforms || []).map((p) => [p.platform, p]));
  const names = [...new Set([...(day.platforms || []).map((p) => p.platform), ...(mtd.platforms || []).map((p) => p.platform)])];
  const rows = names.map((n) => {
    const a = (day.platforms || []).find((p) => p.platform === n) || {};
    const m = mtdBy.get(n) || {};
    return { 매체: n, 어제광고비: R(a.spend), 클릭: N(a.clk), CPC: a.cpc || null, 전환: N(a.conv), 전환매출: R(a.convValue), 누적광고비: R(m.spend) };
  }).filter((r) => r.어제광고비 || r.누적광고비 || r.전환)
    .sort((a, b) => b.어제광고비 - a.어제광고비 || b.누적광고비 - a.누적광고비);
  const t = day.total || {}, tm = mtd.total || {};
  return {
    매체: rows,
    합계: { 매체: '합계', 어제광고비: R(t.spend), 클릭: N(t.clk), CPC: t.cpc || null, 전환: N(t.conv), 전환매출: R(t.convValue), 누적광고비: R(tm.spend) },
    기준: '매체 API 집계(adboard) · 전환·전환매출은 매체가 잡은 값(매체 간 중복 포함 — 참고용)',
  };
}

// ── ③ 오프라인 좌수 ────────────────────────────────────────────────────────
//   realtime 좌수 API 는 시작일을 무시하고 "그 달 1일~조회일 누적"을 준다(2026-10-01 실측) → 어제 좌수 = 누적(어제) − 누적(그제).
async function jwasuDay(date) {
  const ym = date.slice(0, 7), first = date.endsWith('-01');
  const off = await store.namedCollection('off', 'orders');
  const [cur, prev, dayRows, league, resolve] = await Promise.all([
    jl.jwasu(date, date),
    first ? Promise.resolve([]) : jl.jwasu(addDays(date, -1), addDays(date, -1)),
    off.aggregate([{ $match: { date } }, { $group: { _id: { s: '$store', m: '$manager' }, amt: { $sum: '$amount' }, ord: { $addToSet: '$orderNo' } } }]).toArray(),
    jl.storeLeague(ym + '-01', date).catch(() => []), // 매니저영업 → 등록 매장 귀속은 storeLeague 안에서
    jl.proxyStoreResolver(),
  ]);
  // 어제 매출·주문 — 매니저영업 주문은 담당 매니저의 등록 매장으로
  const daySales = [];
  { const m = new Map();
    for (const r of dayRows) {
      const s = resolve(r._id.s, r._id.m) || '(미지정)';
      const o = m.get(s) || { _id: s, amt: 0, ord: [] };
      o.amt += N(r.amt); o.ord.push(...(r.ord || []));
      m.set(s, o);
    }
    for (const o of m.values()) daySales.push({ ...o, ord: [...new Set(o.ord)] });
  }
  const by = {};
  const S = (name) => (by[name] = by[name] || { 매장: name, 인원: 0, 누적좌수: 0, 목표좌수: 0, 전일누적: 0, 어제매출: 0, 어제주문: 0, 누적매출: 0, 목표매출: 0 });
  for (const r of cur) { const o = S(r.매장 || '(미상)'); o.인원++; o.누적좌수 += N(r.실적_좌수); o.목표좌수 += N(r.목표_좌수); }
  for (const r of prev) S(r.매장 || '(미상)').전일누적 += N(r.실적_좌수);
  for (const r of daySales) { const o = S(r._id || '(미지정)'); o.어제매출 += N(r.amt); o.어제주문 += (r.ord || []).filter(Boolean).length; }
  for (const r of league) { const o = S(r.매장); o.누적매출 = N(r.매출); o.목표매출 = N(r.목표매출); }

  const days = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
  const elapsedPct = +((+date.slice(8, 10) / days) * 100).toFixed(1);
  // 월 매출 목표가 없는 매장은 뺀다(오픈 전·미운영일 수 있음) — 그 달 목표가 하나도 없으면(월초 등록 전) 좌수·매출이 있는 매장 전부
  const hasTargets = Object.values(by).some((o) => o.목표매출 > 0);
  const rows = Object.values(by)
    .filter((o) => (hasTargets ? o.목표매출 > 0 : (o.인원 || o.어제매출 || o.누적매출)))
    .map((o) => ({
      매장: o.매장, 인원: o.인원,
      어제좌수: Math.max(0, o.누적좌수 - o.전일누적), 어제매출: R(o.어제매출), 어제주문: o.어제주문,
      누적좌수: o.누적좌수, 목표좌수: o.목표좌수, 좌수달성률: pct(o.누적좌수, o.목표좌수),
      누적매출: R(o.누적매출), 목표매출: R(o.목표매출), 매출달성률: pct(o.누적매출, o.목표매출),
    }))
    .sort((a, b) => b.누적매출 - a.누적매출);
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const total = {
    매장: '합계', 인원: sum('인원'), 어제좌수: sum('어제좌수'), 어제매출: sum('어제매출'), 어제주문: sum('어제주문'),
    누적좌수: sum('누적좌수'), 목표좌수: sum('목표좌수'), 좌수달성률: pct(sum('누적좌수'), sum('목표좌수')),
    누적매출: sum('누적매출'), 목표매출: sum('목표매출'), 매출달성률: pct(sum('누적매출'), sum('목표매출')),
  };
  // 직원별 — 좌수 API 행이 곧 직원(매니저) 단위. 어제 좌수 = 누적(어제) − 누적(그제), 매장 표에 나오는 매장의 직원만.
  //   매장 순서는 매장 표와 같게, 매장 안에서는 월 누적 좌수 큰 순. 좌수도 목표도 0 인 직원은 뺀다.
  const storeOrder = new Map(rows.map((r, i) => [r.매장, i]));
  const prevBy = new Map(prev.map((r) => [`${r.매장}\t${r.매니저}`, N(r.실적_좌수)]));
  const staff = cur
    .filter((r) => storeOrder.has(r.매장 || '(미상)') && (N(r.실적_좌수) || N(r.목표_좌수)))
    .map((r) => ({
      매장: r.매장 || '(미상)', 직원: r.매니저, 역할: r.역할 || '',
      어제좌수: Math.max(0, N(r.실적_좌수) - (prevBy.get(`${r.매장}\t${r.매니저}`) || 0)),
      누적좌수: N(r.실적_좌수), 목표좌수: N(r.목표_좌수), 달성률: pct(N(r.실적_좌수), N(r.목표_좌수)),
    }))
    .sort((a, b) => (storeOrder.get(a.매장) - storeOrder.get(b.매장)) || (b.누적좌수 - a.누적좌수));

  return {
    월경과율: elapsedPct, 매장: rows, 합계: total, 직원: staff,
    기준: '좌수 = Y리그 실적 좌수(realtime, 월 누적을 하루씩 차분) · 매출 = 오프라인 주문서(off.orders) · 목표 = 매장 월 목표(좌수: 매니저 목표 합, 매출: 매장 목표)',
  };
}

// ── 데이터 적재 시각 — 원장별 마지막 적재(system_metadata) ─────────────────────
//   ① 페이지 맨 위에 보인다 — PC(다운로드)가 꺼진 날 "숫자가 언제 것인지" 받는 사람이 알게.
//   ② 서버 PC 발송 스크립트가 적재 사이 빈 시간에 캡처하려고 본다 — 오프라인 적재는 그 달을 지웠다 다시 넣어
//      그 몇 초 사이에 계산하면 오프라인 매출이 0/일부로 찍힌다(10분 주기). /api/daily-mail/status
async function loadStatus() {
  const meta = async (db) => (await store.namedCollection(db, 'system_metadata')).find({}, { projection: { _id: 0, key: 1, timestamp: 1 } }).toArray();
  const [on, off] = await Promise.all([meta('on'), meta('off')]);
  const ts = (rows, key) => { const r = rows.find((x) => x.key === key); return r && r.timestamp ? new Date(r.timestamp).toISOString() : null; };
  return {
    온라인: ts(on, 'last_update_time'),
    샐리필: ts(on, 'last_update_time:sallyfeel_orders'),
    오프라인: ts(off, 'last_update_time'),
    지금: new Date().toISOString(),
  };
}

// ── 전체 ───────────────────────────────────────────────────────────────────
async function build({ date, basis } = {}) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : yesterdayKST();
  const t0 = Date.now();
  const wrap = (p) => p.then((data) => ({ ok: true, data })).catch((e) => ({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
  const [tl, m, k, a, j, s] = await Promise.all([tiles(d, d), salesVsTarget(d), kpi(d), ads(d), jwasuDay(d), stockWatch.watch({ basis, end: d })].map(wrap));
  const 적재 = await loadStatus().catch(() => null);
  return { 기준일: d, 생성시각: new Date().toISOString(), 소요_ms: Date.now() - t0, 적재, 타일: tl, 매출: m, kpi: k, 광고: a, 좌수: j, 재고: s };
}

module.exports = { build, tiles, salesVsTarget, kpi, ads, jwasuDay, loadStatus };
