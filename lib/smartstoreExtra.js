'use strict';

/**
 * 스마트스토어 확장 — 네이버 커머스 API 추가 활용 (주문 외).
 *   · products(): 상품 목록/검색 — 판매상태·재고·판매가·할인가 (POST /v1/products/search)
 *   · settlements(): 일별 정산 내역 — 정산액·수수료·정산예정/완료일 (GET /v1/pay-settle/settle/daily)
 *   ※ 네이버 IP 허용목록 필요(로컬/cloudtype 허용 IP에서 동작). 문의/리뷰 API는 권한(scope) 밖 — 미제공.
 */

const ss = require('./smartstore');

const N = (v) => (Number.isFinite(+v) ? +v : 0);
const STATUS_KO = { SALE: '판매중', SUSPENSION: '판매중지', OUTOFSTOCK: '품절', CLOSE: '판매종료', PROHIBITION: '판매금지', WAIT: '판매대기', UNADMISSION: '승인대기', REJECTION: '승인거부', DELETE: '삭제' };

// 전 상품 페이지네이션 수집 → 검색어/상태 필터
async function products({ search, status, lowStock } = {}) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const j = await ss.apiPost('/external/v1/products/search', { page, size: 100 });
    for (const c of (j.contents || [])) for (const p of (c.channelProducts || [])) all.push(p);
    if (page >= (j.totalPages || 1)) break;
  }
  let rows = all.map((p) => ({
    상품명: p.name, 상태: STATUS_KO[p.statusType] || p.statusType,
    판매가: N(p.salePrice), 할인가: N(p.discountedPrice) || null,
    재고: N(p.stockQuantity),
    브랜드: p.brandName || null, 상품번호: p.channelProductNo,
  }));
  if (search) { const q = String(search).trim(); rows = rows.filter((r) => (r.상품명 || '').includes(q)); }
  if (status) { const q = String(status).trim(); rows = rows.filter((r) => r.상태.includes(q)); }
  if (lowStock != null) rows = rows.filter((r) => r.상태 === '판매중' && r.재고 <= N(lowStock));
  const dist = {};
  for (const r of rows) dist[r.상태] = (dist[r.상태] || 0) + 1;
  rows.sort((a, b) => a.재고 - b.재고);
  return {
    총상품: all.length, 필터후: rows.length, 상태분포: dist,
    목록: rows.slice(0, 60),
    주의: '스마트스토어 채널상품 기준(실시간 API). 재고=스토어 등록 재고(이카운트 실물재고와 다를 수 있음 — 실물은 stock_list).',
  };
}

// 일별 정산 — 기간 합계 + 일별 상세
async function settlements(start, end) {
  const j = await ss.apiGet('/external/v1/pay-settle/settle/daily', { startDate: start, endDate: end });
  const els = j.elements || [];
  const rows = els.map((e) => ({
    정산기준일: e.settleBasisStartDate,
    정산예정일: e.settleExpectDate, 정산완료일: e.settleCompleteDate || null,
    정산액: N(e.settleAmount), 결제정산: N(e.paySettleAmount),
    수수료: N(e.commissionSettleAmount), 혜택정산: N(e.benefitSettleAmount),
  })).sort((a, b) => String(a.정산기준일).localeCompare(String(b.정산기준일)));
  const t = rows.reduce((a, r) => { a.정산액 += r.정산액; a.결제정산 += r.결제정산; a.수수료 += r.수수료; a.혜택정산 += r.혜택정산; return a; }, { 정산액: 0, 결제정산: 0, 수수료: 0, 혜택정산: 0 });
  return {
    start, end, 건수: rows.length,
    합계: { ...t, 수수료율_pct: t.결제정산 ? +((Math.abs(t.수수료) / t.결제정산) * 100).toFixed(2) : null },
    일별: rows,
    주의: '네이버 정산 기준(정산기준일=구매확정일 기준). 정산액=실입금 예정액(수수료·혜택 차감 후).',
  };
}

module.exports = { products, settlements };
