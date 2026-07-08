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

// 고객문의 조회 — GET /v1/pay-user/inquiries (기간·답변여부). "답변 안 남긴 문의 있나?" 모니터링용.
//   ⚠️ customerName 은 마스킹, customerId 미반환.
const maskName = (s) => { const t = String(s || '').trim(); return t.length <= 1 ? t : t[0] + '*'.repeat(Math.min(t.length - 1, 3)); };

async function inquiries(start, end) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const j = await ss.apiGet('/external/v1/pay-user/inquiries', { startSearchDate: start, endSearchDate: end, page, size: 100 });
    all.push(...(j.content || []));
    if (j.last || page >= (j.totalPages || 1)) break;
  }
  const strip = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const rows = all.map((x) => {
    const asked = x.inquiryRegistrationDateTime ? new Date(x.inquiryRegistrationDateTime) : null;
    const answeredAt = x.answerRegistrationDateTime ? new Date(x.answerRegistrationDateTime) : null;
    return {
      문의일시: x.inquiryRegistrationDateTime ? String(x.inquiryRegistrationDateTime).slice(0, 16).replace('T', ' ') : '',
      카테고리: x.category || '', 제목: strip(x.title).slice(0, 60),
      문의요약: strip(x.inquiryContent).slice(0, 150),
      답변완료: !!x.answered,
      답변일시: answeredAt ? String(x.answerRegistrationDateTime).slice(0, 16).replace('T', ' ') : null,
      답변소요시간_시간: asked && answeredAt ? +(((answeredAt - asked) / 3600000)).toFixed(1) : null,
      상품: x.productName || '', 고객: maskName(x.customerName),
    };
  }).sort((a, b) => b.문의일시.localeCompare(a.문의일시));
  const unanswered = rows.filter((r) => !r.답변완료);
  const catDist = {};
  for (const r of rows) catDist[r.카테고리 || '(미분류)'] = (catDist[r.카테고리 || '(미분류)'] || 0) + 1;
  const answered = rows.filter((r) => r.답변소요시간_시간 != null);
  return {
    start, end, 총문의: rows.length,
    미답변: { 건수: unanswered.length, 목록: unanswered.slice(0, 20) },
    평균답변소요_시간: answered.length ? +((answered.reduce((a, r) => a + r.답변소요시간_시간, 0) / answered.length)).toFixed(1) : null,
    카테고리분포: catDist,
    목록: rows.slice(0, 40),
    주의: '스마트스토어 고객문의(문의게시판) 기준 — 상품 Q&A·톡톡 상담은 별도(권한 밖). 고객명 마스킹.',
  };
}

module.exports = { products, settlements, inquiries };
