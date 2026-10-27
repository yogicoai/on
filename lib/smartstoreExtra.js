'use strict';

/**
 * 스마트스토어 확장 — 네이버 커머스 API 추가 활용 (주문 외).
 *   · products(): 상품 목록/검색 — 판매상태·재고·판매가·할인가 (POST /v1/products/search)
 *   · settlements(): 일별 정산 내역 — 정산액·수수료·정산예정/완료일 (GET /v1/pay-settle/settle/daily)
 *   · inquiries(): 고객문의 미답변 모니터링 / inquiryList()·answerInquiry(): cs-self-guide '게시판 관리'용 목록·답변 등록
 *   ※ 네이버 IP 허용목록 필요(로컬/cloudtype 허용 IP에서 동작). 상품문의(Q&A)·리뷰 API는 권한(scope) 밖(403) — 미제공.
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
    목록: rows.slice(0, 25),
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
    미답변: { 건수: unanswered.length, 목록: unanswered.slice(0, 15) },
    평균답변소요_시간: answered.length ? +((answered.reduce((a, r) => a + r.답변소요시간_시간, 0) / answered.length)).toFixed(1) : null,
    카테고리분포: catDist,
    목록: rows.slice(0, 20),
    주의: '스마트스토어 고객문의(문의게시판) 기준 — 상품 Q&A·톡톡 상담은 별도(권한 밖). 고객명 마스킹.',
  };
}

// ── 게시판 관리(cs-self-guide)용 — 고객문의 목록(답변 포함)·답변 등록 ─────────────────
//   응답 필드(2026-10-27 실제 응답으로 확인): inquiryNo·category·title·inquiryContent·inquiryRegistrationDateTime·
//   answered·answerContentId·answerContent·answerRegistrationDateTime·orderId·productName·productOrderOption·customerName
const kstMinute = (s) => (s ? String(s).slice(0, 16).replace('T', ' ') : '');
const httpError = (httpStatus, message) => Object.assign(new Error(message), { httpStatus });

async function rawInquiries(start, end) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const j = await ss.apiGet('/external/v1/pay-user/inquiries', { startSearchDate: start, endSearchDate: end, page, size: 100 });
    all.push(...(j.content || []));
    if (j.last || page >= (j.totalPages || 1)) break;
  }
  return all;
}

function toInquiryItem(x) {
  return {
    inquiryNo: x.inquiryNo,
    category: x.category || '',
    title: x.title || '',
    content: x.inquiryContent || '',
    createdAt: kstMinute(x.inquiryRegistrationDateTime),
    customer: maskName(x.customerName),
    productName: x.productName || '',
    productOption: x.productOrderOption || '',
    orderId: x.orderId || '',
    answered: !!x.answered,
    answer: x.answered ? { id: x.answerContentId ?? null, content: x.answerContent || '', createdAt: kstMinute(x.answerRegistrationDateTime) } : null,
  };
}

async function inquiryList(start, end) {
  const seen = new Set();
  return (await rawInquiries(start, end))
    .filter((x) => !seen.has(x.inquiryNo) && seen.add(x.inquiryNo))
    .map(toInquiryItem)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// 고객문의 답변 등록 — POST /v1/pay-merchant/inquiries/{inquiryNo}/answer { answerComment }
//   (공식 문서 페이지는 자동으로 열리지 않아 공개 SDK 구현으로 맞춤 — 첫 실제 등록 때 확인)
//   고객에게 바로 보이는 글이라, 등록 직전에 그날 목록에서 다시 찾아 이미 답변됐으면(판매자센터에서 먼저 단 경우) 막는다.
// 문의 번호·답변·문의한 날을 확인하고, 그날(+1일) 목록에서 그 문의를 다시 찾는 함수를 돌려준다.
function inquiryTarget(inquiryNo, text, date) {
  const no = String(inquiryNo || '').replace(/\D/g, '');
  const answer = String(text || '').trim();
  if (!no) throw httpError(400, '문의 번호가 필요합니다');
  if (!answer) throw httpError(400, '답변 내용이 필요합니다');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw httpError(400, '문의한 날(YYYY-MM-DD)이 필요합니다');
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const find = async () => (await rawInquiries(date, next)).find((x) => String(x.inquiryNo) === no);
  return { no, answer, find };
}

async function answerInquiry(inquiryNo, text, date) {
  const { no, answer, find } = inquiryTarget(inquiryNo, text, date);
  const current = await find();
  if (!current) throw httpError(404, '그날 고객문의에서 이 문의를 찾지 못했습니다');
  if (current.answered) throw Object.assign(httpError(409, '이미 답변된 문의입니다'), { inquiry: toInquiryItem(current) });
  await ss.apiPost(`/external/v1/pay-merchant/inquiries/${no}/answer`, { answerComment: answer });
  // 응답 본문이 비어 올 수 있어 등록된 답변(번호·시각)은 다시 읽어 돌려준다.
  const after = await find().catch(() => null);
  return { inquiry: after ? toInquiryItem(after) : null };
}

// 고객문의 답변 고치기 — PUT /v1/pay-merchant/inquiries/{inquiryNo}/answer/{answerContentId} { answerComment }
//   고치기 직전에 다시 찾아, 그사이 답변이 바뀌었으면(판매자센터에서 고친 경우 등) 막는다.
async function updateInquiryAnswer(inquiryNo, answerId, text, date) {
  const { no, answer, find } = inquiryTarget(inquiryNo, text, date);
  const aid = String(answerId || '').replace(/\D/g, '');
  if (!aid) throw httpError(400, '답변 번호가 필요합니다');
  const current = await find();
  if (!current) throw httpError(404, '그날 고객문의에서 이 문의를 찾지 못했습니다');
  if (!current.answered || String(current.answerContentId) !== aid) {
    throw Object.assign(httpError(409, '그사이 답변이 바뀌었습니다'), { inquiry: toInquiryItem(current) });
  }
  await ss.apiPut(`/external/v1/pay-merchant/inquiries/${no}/answer/${aid}`, { answerComment: answer });
  const after = await find().catch(() => null);
  return { inquiry: after ? toInquiryItem(after) : null };
}

// ── 상품문의(Q&A) — 목록 GET /v1/contents/qnas · 답변 등록과 수정은 같은 PUT /v1/contents/qnas/{questionId} { commentContent }
//   ('문의' API 그룹 — 2026-10-27 추가). 응답(실제 확인): contents[{questionId·question·answer·answers[{answer,createDate}]·
//   answered·productId·productName·maskedWriterId·createDate}] 최신순, 한 번에 100건까지.
async function rawQnas(start, end) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const j = await ss.apiGet('/external/v1/contents/qnas', {
      fromDate: `${start}T00:00:00.000+09:00`, toDate: `${end}T23:59:59.999+09:00`, page, size: 100,
    });
    all.push(...(j.contents || []));
    if (j.last || page >= (j.totalPages || 1)) break;
  }
  return all;
}

function toQnaItem(x) {
  const latest = (x.answers || [])[0];
  return {
    questionId: x.questionId,
    content: x.question || '',
    createdAt: kstMinute(x.createDate),
    customer: x.maskedWriterId || '',
    productName: x.productName || '',
    answered: !!x.answered,
    answer: x.answered ? { content: x.answer || (latest && latest.answer) || '', createdAt: kstMinute(latest && latest.createDate) } : null,
  };
}

async function qnaList(start, end) {
  const seen = new Set();
  return (await rawQnas(start, end))
    .filter((x) => !seen.has(x.questionId) && seen.add(x.questionId))
    .map(toQnaItem)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// 답변 등록(mode=answer: 아직 답이 없을 때만) · 고치기(mode=edit: 답이 있을 때만) — 직전에 그날 목록에서 다시 확인한다.
async function saveQnaAnswer(questionId, text, date, mode) {
  const id = String(questionId || '').replace(/\D/g, '');
  const answer = String(text || '').trim();
  if (!id) throw httpError(400, '문의 번호가 필요합니다');
  if (!answer) throw httpError(400, '답변 내용이 필요합니다');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw httpError(400, '문의한 날(YYYY-MM-DD)이 필요합니다');
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const find = async () => (await rawQnas(date, next)).find((x) => String(x.questionId) === id);

  const current = await find();
  if (!current) throw httpError(404, '그날 상품문의에서 이 문의를 찾지 못했습니다');
  if (mode === 'answer' && current.answered) throw Object.assign(httpError(409, '이미 답변된 문의입니다'), { qna: toQnaItem(current) });
  if (mode === 'edit' && !current.answered) throw Object.assign(httpError(409, '아직 답변이 없는 문의입니다'), { qna: toQnaItem(current) });
  await ss.apiPut(`/external/v1/contents/qnas/${id}`, { commentContent: answer });
  const after = await find().catch(() => null);
  return { qna: after ? toQnaItem(after) : null };
}

module.exports = { products, settlements, inquiries, inquiryList, answerInquiry, updateInquiryAnswer, qnaList, saveQnaAnswer };
