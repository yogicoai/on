'use strict';

/**
 * CS 응답 지원 — Claude가 답변 초안을 쓸 때 근거로 쓰는 재료 2종 (전부 Cafe24/스마트스토어 API).
 *   · knowledge(): 정책/FAQ 지식 검색 — Cafe24 정책성 게시판(FAQ·배송안내·교환/환불·세탁방법·제품정보)에서 키워드 검색.
 *   · answerExamples(): 과거 "문의→답변" 사례 검색 — Cafe24 Q&A/A/S 답글 페어 + 스마트스토어 문의 답변. 톤/포맷 참고용.
 *   ⚠️ 작성자 마스킹 · 조회 전용(답변 등록은 사람이 관리자에서).
 */

const c = require('./cafe24');
const ss = require('./smartstore');

const strip = (t) => String(t || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const mask = (s) => { const t = String(s || '').trim(); return t.length <= 1 ? t : t[0] + '*'.repeat(Math.min(t.length - 1, 3)); };
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 정책성 게시판 (지식베이스)
const KNOW_BOARDS = [
  { no: 22, name: '자주하는질문 BEST10' }, { no: 3, name: 'FAQ' },
  { no: 30, name: '배송안내' }, { no: 32, name: '교환/환불' }, { no: 28, name: '제품정보' },
  { no: 23, name: '세탁방법[소파]' }, { no: 24, name: '세탁방법[바디필로우]' }, { no: 25, name: '세탁방법[캐릭터인형]' },
  { no: 26, name: '세탁방법[악세사리]' }, { no: 27, name: '세탁방법[기타]' },
];

// 게시판 글 캐시(정책 글은 거의 안 바뀜) — 프로세스 내 10분
let _knowCache = null, _knowAt = 0;
async function loadKnowledge() {
  if (_knowCache && Date.now() - _knowAt < 10 * 60 * 1000) return _knowCache;
  const all = [];
  for (const b of KNOW_BOARDS) {
    const arts = await c.adminPaginate('/boards/' + b.no + '/articles', { shop_no: 1 }, 'articles', { limit: 100, maxPages: 2 }).catch(() => []);
    for (const a of arts) all.push({ 게시판: b.name, 제목: strip(a.title), 내용: strip(a.content) });
  }
  _knowCache = all; _knowAt = Date.now();
  return all;
}

// 지식 검색 — 키워드(공백 구분 AND)로 제목+내용 매칭
async function knowledge(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('검색어가 필요합니다 — 예: "반품 쿠폰", "세탁"');
  const terms = q.split(/\s+/).filter(Boolean);
  const all = await loadKnowledge();
  const hits = all.filter((a) => terms.every((t) => (a.제목 + ' ' + a.내용).includes(t)));
  return {
    검색어: q, 지식문서총: all.length, 매칭: hits.length,
    결과: hits.slice(0, 12).map((h) => ({ 게시판: h.게시판, 제목: h.제목.slice(0, 60), 내용: h.내용.slice(0, 600) })),
    ...(hits.length ? {} : { 안내: '매칭 없음 — 더 짧은 키워드로 재검색 (예: "반품", "세탁", "배송기간")' }),
    용도: '이 내용은 공식 정책/FAQ — CS 답변 초안 작성 시 이 근거를 기반으로 작성할 것.',
  };
}

// 과거 문의→답변 사례 — Cafe24(Q&A/AS 답글 페어) + 스마트스토어(answerContent)
async function answerExamples(query, { days = 60 } = {}) {
  const q = String(query || '').trim();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const end = fmt(new Date());
  const sd = new Date(); sd.setDate(sd.getDate() - Math.max(7, Math.min(180, days)));
  const start = fmt(sd);
  const pairs = [];

  // Cafe24 Q&A(6)·A/S(31) — 원글+답글 페어
  for (const bno of [6, 31]) {
    const arts = await c.adminPaginate('/boards/' + bno + '/articles', { shop_no: 1, start_date: start, end_date: end }, 'articles', { limit: 100, maxPages: 2 }).catch(() => []);
    const byNo = {}; for (const a of arts) byNo[a.article_no] = a;
    for (const a of arts) {
      if (!(a.reply_depth > 0 && a.parent_article_no)) continue;
      const parent = byNo[a.parent_article_no]; if (!parent) continue;
      pairs.push({
        출처: bno === 6 ? '자사몰 Q&A' : '자사몰 A/S', 일자: String(parent.created_date || '').slice(0, 10),
        문의: strip(parent.title + ' ' + parent.content).slice(0, 200),
        답변: strip(a.content).slice(0, 400),
      });
    }
  }
  // 스마트스토어 고객문의 (답변 완료건)
  try {
    const j = await ss.apiGet('/external/v1/pay-user/inquiries', { startSearchDate: start, endSearchDate: end, page: 1, size: 100 });
    for (const x of (j.content || [])) {
      if (!x.answered || !x.answerContent) continue;
      pairs.push({
        출처: '스마트스토어', 일자: String(x.inquiryRegistrationDateTime || '').slice(0, 10),
        문의: strip((x.title || '') + ' ' + (x.inquiryContent || '')).slice(0, 200),
        답변: strip(x.answerContent).slice(0, 400),
      });
    }
  } catch (_) {}

  const hits = terms.length ? pairs.filter((p) => terms.every((t) => (p.문의 + ' ' + p.답변).includes(t))) : pairs;
  hits.sort((a, b) => String(b.일자).localeCompare(String(a.일자)));
  return {
    검색어: q || '(전체)', 기간: `${start} ~ ${end}`, 전체사례: pairs.length, 매칭: hits.length,
    사례: hits.slice(0, 10),
    용도: '과거 실제 답변 사례 — 새 답변 초안 작성 시 톤·인사말·구성("안녕하세요, 고객님 최고를 위한 최상의 휴식 Yogibo 입니다…")을 이 사례와 일치시킬 것.',
  };
}

module.exports = { knowledge, answerExamples };
