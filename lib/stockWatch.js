'use strict';

/**
 * 재고 주의 — 품번(품목코드) 기준 "3개월 뒤 재고가 마이너스가 되는 품목".
 *   일일 메일 페이지(daily_mail.html) ④ 재고 현황. MD 요청 양식 그대로:
 *     품목코드 · 상품명 · 색상명 · 현재고 · 3개월예상판매량 · 3개월이후 재고수량 · 발주판단
 *   · 현재고      = 물류센터 실시간 재고(forecast.stockList — realtime API)
 *   · 3개월 예상  = 최근 90일 판매수량(이카운트 출고 기준, 반품 차감) — 다음 3개월도 같은 속도로 팔린다고 본다.
 *                   작년 실측상 4분기 판매량이 3분기와 비슷해(온라인 +22%·오프라인 -11%, 합계 -1%) 계절 보정은 하지 않는다.
 *   · 발주판단    = 주의(재고는 있는데 3개월 안에 모자람) / 품절(재고 0 이하인데 계속 팔림 — 목록 대신 건수만)
 *   · 판매 기준   = 'all' 온라인+오프라인(기본) · 'online' 온라인만(기존 발주 도구 reorderPlan 과 같은 기준)
 *       오프라인 판매(최근 3개월 수량의 약 65%)도 물류센터 재고에서 나가므로 기본은 합산.
 *       기준은 MD 결정 사항이라 DEFAULT_BASIS 한 곳에서 바꾼다(화면은 ?basis=online 으로 비교 가능).
 *
 *   ── 품번 잇기 ──
 *   · 커버: 같은 숫자 품번 계열을 한 줄로. 200308(커버 단품)과 200308S·SPre·SPre+·SHPre(같은 색 본품)가 모두
 *     200308 커버를 쓴다. 재고 쪽 등급·EPP 커버 품번(200308SHPre 등, 대부분 0)도 같은 줄에 합친다
 *     — 발주 도구의 '등급·EPP 통합'과 같은 규칙. 계열 합이 실제 소진과 맞는다는 실측은 skuSales.js 머리말 참고.
 *   · 이너: 사이즈별 한 줄(forecast.innerBase). 같은 사이즈 본품 판매(전 색상·등급) + 이너 단품 판매가 수요,
 *     재고는 등급별 이너(스탠다드·프리미엄·EPP)를 합산 — 발주 도구와 같다.
 *   · 그 외(리빙·인형 등): 품번 그대로. 재고에 없는 접미 품번은 같은 숫자 계열의 재고 품번으로 잇는다.
 *   · 리필 비즈·부직포백·배송비처럼 물류센터 재고 목록에 없는 품번은 표에 나오지 않는다(연결률로만 보고).
 */

const store = require('./store');
const forecast = require('./forecast');
const { baseOf } = require('./skuSales');

const DEFAULT_BASIS = 'all';
const DAYS = 90;
const BODY_CATS = new Set(['소파', '바디필로우', '리퍼']); // 빈백 본품(커버 1장 + 이너 1개를 쓴다) — forecast.reorderPlan 과 같은 판정
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const yesterdayKST = () => addDays(new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), -1);
const startsDigit = (code) => /^\d/.test(code);
const plainDigits = (code) => /^\d+$/.test(code);

// 기간 내 품번별 순판매수량(반품 차감) — 원장별 병렬
async function salesByCode(ledgers, start, end) {
  const per = await Promise.all(ledgers.map(async (db) => {
    const c = await store.namedCollection(db, 'orders');
    return c.aggregate([
      { $match: { date: { $gte: start, $lte: end }, itemCode: { $nin: [null, ''] } } },
      { $group: { _id: '$itemCode', qty: { $sum: '$qty' }, name: { $last: '$productName' }, cat: { $last: '$category' } } },
    ]).toArray();
  }));
  const out = new Map();
  for (const rows of per) for (const x of rows) {
    const o = out.get(x._id) || { qty: 0, name: x.name || '', cat: x.cat || '' };
    o.qty += x.qty || 0;
    out.set(x._id, o);
  }
  return out;
}

async function watch({ basis = DEFAULT_BASIS, end, days = DAYS } = {}) {
  const b = basis === 'online' ? 'online' : 'all';
  const e = end || yesterdayKST();
  const s = addDays(e, -(days - 1));
  const [stock, updatedAt, sales] = await Promise.all([
    forecast.stockList(),
    forecast.stockUpdatedAt().catch(() => null),
    salesByCode(b === 'online' ? ['on'] : ['on', 'off'], s, e),
  ]);

  // ── 재고 → 줄(커버=숫자 계열, 이너=사이즈, 그 외=품번) ──
  const rows = new Map();
  const keyOfStock = new Map(); // 재고 품번 → 줄 키
  for (const st of stock) {
    const key = st.category === '커버' && startsDigit(st.code) ? 'C|' + baseOf(st.code)
      : st.category === '이너' ? 'I|' + forecast.innerBase(st.name)
        : 'X|' + st.code;
    const r = rows.get(key) || { code: '', name: '', color: '', category: st.category, stock: 0, demand: 0, codes: [], plain: false };
    // 대표 표기 — 숫자만인 품번(커버 단품·스탠다드 이너)이 있으면 그것을 쓴다
    const plain = plainDigits(st.code);
    if (!r.codes.length || (plain && !r.plain)) {
      r.code = key.startsWith('C|') ? baseOf(st.code) : st.code;
      r.name = st.name; r.color = st.color; r.plain = plain;
    }
    r.codes.push(st.code);
    r.stock += st.qty;
    rows.set(key, r);
    keyOfStock.set(st.code, key);
  }

  // ── 판매 → 수요 ──
  let soldQty = 0, linkedQty = 0;
  for (const [code, x] of sales) {
    const q = x.qty;
    if (!q) continue;
    soldQty += q;
    const nm = x.name;
    const isCoverSale = nm.includes('커버'), isInnerSale = nm.includes('이너');
    const isBody = !isCoverSale && !isInnerSale && BODY_CATS.has(x.cat);
    let hit = false;
    // 커버 계열 — 커버 단품·본품 모두 숫자 계열 커버 줄로
    const ck = 'C|' + baseOf(code);
    if ((isCoverSale || isBody) && rows.has(ck)) { rows.get(ck).demand += q; hit = true; }
    // 이너 — 본품·이너 단품을 사이즈 줄로
    if (isBody || isInnerSale) {
      const ik = 'I|' + forecast.innerBase(nm);
      if (rows.has(ik)) { rows.get(ik).demand += q; hit = true; }
    }
    // 그 외 — 품번 그대로, 없으면 같은 숫자 계열의 재고 품번
    if (!hit) {
      const k = keyOfStock.get(code) || (startsDigit(code) ? keyOfStock.get(baseOf(code)) : null);
      if (k) { rows.get(k).demand += q; hit = true; }
    }
    if (hit) linkedQty += q;
  }

  const list = [...rows.values()].map((r) => {
    const f3 = Math.max(0, Math.round(r.demand));
    return { 품목코드: r.code, 상품명: r.name, 색상명: r.color, 분류: r.category, 현재고: r.stock, 예상판매_3개월: f3, 재고_3개월후: r.stock - f3, 묶은품번수: r.codes.length };
  });
  // 주의 순서 — 3개월 예상판매량이 많은 품목부터(많이 팔릴 품목이 먼저 보이게, MD 요청 2026-10-01).
  //   같으면 더 많이 모자라는 품목부터, 그다음 품목코드 순.
  const caution = list.filter((x) => x.현재고 > 0 && x.재고_3개월후 < 0)
    .sort((a, c) => (c.예상판매_3개월 - a.예상판매_3개월) || (a.재고_3개월후 - c.재고_3개월후) || String(a.품목코드).localeCompare(String(c.품목코드)));
  const soldOut = list.filter((x) => x.현재고 <= 0 && x.예상판매_3개월 > 0).sort((a, c) => c.예상판매_3개월 - a.예상판매_3개월);

  return {
    기준: {
      판매: b === 'online' ? '온라인만(이카운트 on.orders)' : '온라인 + 오프라인(이카운트 on.orders + off.orders)',
      basis: b,
      판매기간: `${s} ~ ${e} (${days}일)`,
      예상: `3개월 예상판매량 = 최근 ${days}일 판매수량(반품 차감) — 같은 속도로 팔린다고 가정`,
      묶음: '커버 = 같은 숫자 품번 계열(커버 단품 + 같은 색 본품, 등급·EPP 통합) · 이너 = 사이즈별(전 등급) · 그 외 = 품번',
    },
    재고갱신: updatedAt,
    품목수: list.length,
    주의: caution,
    품절: { 건수: soldOut.length, 수요상위: soldOut.slice(0, 10) },
    판매연결률_pct: soldQty ? +((linkedQty / soldQty) * 100).toFixed(1) : null, // 나머지는 재고 목록에 없는 품번(리필 비즈·부직포백·배송비 등)
  };
}

module.exports = { watch, DEFAULT_BASIS };
