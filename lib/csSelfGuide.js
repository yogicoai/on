'use strict';

/**
 * CS 셀프가이드 FAQ 검색 — cs-self-guide 앱의 test.faqs(published) 를 읽어 질문과 관련된 FAQ를 랭킹.
 *   DB: onlineData 광고 클러스터와 동일(yogico.dmz6oro) → ADBOARD_URI 재사용(CS_MONGODB_URI 있으면 우선).
 *   용도: Claude가 "CS 셀프가이드에서 ○○ 검색" 요청 시, 관련 FAQ(질문·답변)를 찾아 근거로 답하게 함.
 *   ※ 앱의 scoreFaq(키워드·토큰·카테고리 매칭)를 간소 복제. 한국어라 $text 대신 JS 토큰/부분일치 스코어링.
 */

const { MongoClient } = require('mongodb');
require('./env').loadEnv();

const URI = process.env.CS_MONGODB_URI || process.env.ADBOARD_URI || process.env.MONGODB_URI;
const DB_NAME = process.env.CS_MONGODB_DB || 'test';
const COLL = 'faqs';

const _g = globalThis;
_g.__csguide = _g.__csguide || { client: null, promise: null, cache: null, at: 0 };
const TTL = 60000;

async function coll() {
  if (!URI) throw new Error('CS DB 미설정 (CS_MONGODB_URI / ADBOARD_URI)');
  const g = _g.__csguide;
  if (!g.promise) {
    const c = new MongoClient(URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
    g.promise = c.connect().then((x) => { g.client = x; return x; });
  }
  return (await g.promise).db(DB_NAME).collection(COLL);
}

// published FAQ 전체(304건 규모) 캐시 — 작아서 통째로 읽어 JS 스코어링
async function loadFaqs() {
  const g = _g.__csguide;
  if (g.cache && Date.now() - g.at < TTL) return g.cache;
  const c = await coll();
  const docs = await c.find({ status: 'published' }, {
    projection: { _id: 0, category: 1, subcategory: 1, question: 1, answer: 1, keywords: 1, channelVisibility: 1 },
  }).toArray();
  g.cache = docs; g.at = Date.now();
  return docs;
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const compact = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

function scoreFaq(faq, query) {
  const q = norm(query); const qc = compact(query);
  if (!q) return 0;
  const question = norm(faq.question);
  const kw = (faq.keywords || []).map(norm);
  const title = norm(`${faq.category} ${faq.subcategory || ''} ${faq.question} ${kw.join(' ')}`);
  const answer = norm(faq.answer);
  let score = 0;

  // 질문/키워드 전체 일치(공백 무시)
  if (compact(question).includes(qc) || compact(question) === qc) score += 60;
  for (const k of kw) { if (compact(k).includes(qc) || qc.includes(compact(k))) score += 25; }

  // 토큰(2자+) 매칭 — 제목권역 강, 답변 약
  const tokens = q.split(' ').filter((t) => t.length >= 2);
  for (const t of tokens) {
    if (title.includes(t)) score += 8;
    else if (answer.includes(t)) score += 3;
  }
  // 카테고리/세부 직접 언급
  if (q.includes(norm(faq.category))) score += 10;
  if (faq.subcategory && q.includes(norm(faq.subcategory))) score += 8;
  return score;
}

// query로 FAQ 검색 → 상위 매칭. channel(ownmall/marketplace) 있으면 노출범위 필터.
async function search(query, { limit = 5, channel } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('검색어(query)가 필요합니다 — 예: "비회원 쿠폰 사용"');
  let faqs = await loadFaqs();
  if (channel) faqs = faqs.filter((f) => !Array.isArray(f.channelVisibility) || !f.channelVisibility.length || f.channelVisibility.includes(channel));
  const scored = faqs.map((f) => ({ f, s: scoreFaq(f, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, Math.min(20, Math.max(1, limit)));
  if (!scored.length) {
    return { 검색어: q, 매칭: 0, 안내: 'CS 셀프가이드 FAQ에서 매칭 없음 — 더 짧은 키워드로 재검색하거나, 없는 내용이면 CS팀 문의 안내.' };
  }
  return {
    검색어: q, 매칭: scored.length,
    결과: scored.map((x) => ({ 카테고리: x.f.category, 세부: x.f.subcategory || '', 질문: x.f.question, 답변: x.f.answer, 관련도: x.s })),
    안내: '위 답변은 CS 셀프가이드 공식 FAQ 원문입니다. 이 내용을 근거로 답하고, 원문에 없는 정책은 추측하지 말 것.',
  };
}

// 카테고리 목록(가이드 범위 파악용)
async function categories() {
  const faqs = await loadFaqs();
  const by = {};
  for (const f of faqs) { const k = f.category || '(미분류)'; by[k] = (by[k] || 0) + 1; }
  return { 총FAQ: faqs.length, 카테고리: Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ 카테고리: c, 건수: n })) };
}

module.exports = { search, categories };
