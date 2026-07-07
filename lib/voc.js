'use strict';

/**
 * VOC — 자사몰(Cafe24) 게시판 글 조회: 상품후기(REVIEW)·Q&A·A/S문의.
 *   "최근 리뷰 뭐 올라왔어?", "요즘 문의 뭐가 많아?" 질문용.
 *   ⚠️ 개인정보 보호: 작성자 이름 마스킹, 이메일/회원ID 미반환. 본문은 HTML 제거 후 200자 요약.
 */

const c = require('./cafe24');

const BOARDS = { review: 4, qna: 6, as: 31 }; // REVIEW · Q&A · A/S문의
const BOARD_KO = { review: '상품후기', qna: 'Q&A', as: 'A/S문의' };

const mask = (name) => {
  const s = String(name || '').trim();
  if (!s) return '';
  if (s.length <= 2) return s[0] + '*';
  return s[0] + '*'.repeat(Math.min(s.length - 2, 4)) + s[s.length - 1];
};
const stripHtml = (t) => String(t || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function articles(board = 'review', { days = 14, limit = 40 } = {}) {
  const key = String(board || 'review').toLowerCase();
  const bno = BOARDS[key] || Number(board) || 4;
  const end = fmt(new Date());
  const startD = new Date(); startD.setDate(startD.getDate() - Math.max(1, Math.min(90, days)));
  const start = fmt(startD);
  const rows = await c.adminPaginate('/boards/' + bno + '/articles',
    { shop_no: 1, start_date: start, end_date: end }, 'articles', { limit: 100, maxPages: 3 }).catch(() => []);

  const items = rows
    .filter((a) => !a.reply_depth || a.reply_depth === 0 || a.reply_sequence === 1) // 답글 제외(원글 위주)
    .map((a) => ({
      작성일: String(a.created_date || '').slice(0, 10),
      제목: stripHtml(a.title).slice(0, 80),
      내용요약: stripHtml(a.content).slice(0, 200),
      평점: a.rating || null,
      상품번호: a.product_no || null,
      작성자: mask(a.writer),
    }))
    .sort((x, y) => y.작성일.localeCompare(x.작성일))
    .slice(0, limit);

  const out = { 게시판: BOARD_KO[key] || `board_${bno}`, 기간: `${start} ~ ${end}`, 건수: items.length, 목록: items };
  if (key === 'review') {
    const dist = {};
    for (const i of items) if (i.평점) dist[i.평점 + '점'] = (dist[i.평점 + '점'] || 0) + 1;
    const rated = items.filter((i) => i.평점);
    out.평점분포 = dist;
    out.평균평점 = rated.length ? +(rated.reduce((a, i) => a + i.평점, 0) / rated.length).toFixed(2) : null;
  }
  out.주의 = '작성자 마스킹·이메일/회원ID 미제공. 본문 200자 요약(원문은 쇼핑몰 관리자에서).';
  return out;
}

module.exports = { articles, BOARDS };
