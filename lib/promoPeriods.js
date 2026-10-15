'use strict';

/**
 * 전사 프로모션 기간 목록 — 판매분석의 프로모션 기간 칩 · 상품태그 화면 · 기간 비교 · 일일 동기화가 쓴다.
 *   2026-10-15부터 MD 제출 프로모션 정의(promo_defs)에서 만든다. 예전 promo_periods(월별 수기 입력, 6건)는
 *   "옛 온라인 프로모션 설정은 지우고 MD 자료를 기준으로" 결정에 따라 백업(promo_backup_20261015) 후 지웠다.
 *   전사 = promo_type '전사'. 몰마다 한 행씩 있으므로 promo_id 하나에 한 줄(자사몰 행 우선 → 없으면 스마트스토어)로 묶는다.
 *   { month:'YYYY-MM'(시작 월), promo_id, name, start:'YYYY-MM-DD', end:'YYYY-MM-DD' } — 최신이 앞
 */

const store = require('./store');
const ONLINE = ['자사몰', '스마트스토어'];

async function listPromos() {
  if (!store.configured()) return [];
  try {
    const c = await store.collection('promo_defs');
    const rows = await c.find({ promo_type: '전사', mall: { $in: ONLINE } }, { projection: { _id: 0, promo_id: 1, mall: 1, name: 1, start: 1, end: 1 } }).toArray();
    const by = new Map();
    for (const r of rows) {
      const cur = by.get(r.promo_id);
      if (!cur || (cur.mall !== '자사몰' && r.mall === '자사몰')) by.set(r.promo_id, r);
    }
    return [...by.values()]
      .map((r) => ({ month: String(r.start).slice(0, 7), promo_id: r.promo_id, name: r.name, start: r.start, end: r.end }))
      .sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : String(b.promo_id).localeCompare(String(a.promo_id))))
      .slice(0, 60);
  } catch (_) { return []; }
}

async function getPromo(month) {
  return (await listPromos()).find((p) => p.month === month || p.promo_id === month) || null;
}

// 화면에서 직접 고치던 기능은 없앴다 — 프로모션은 [📣 프로모션 등록](MD 엑셀 · 정의 파일)으로만 올린다
const RETIRED = '월별 전사 프로모션 기간은 더 이상 따로 저장하지 않습니다 — 프로모션 등록(MD 엑셀)으로 올려 주세요.';
async function setPromo() { throw new Error(RETIRED); }
async function deletePromo() { throw new Error(RETIRED); }

module.exports = { setPromo, listPromos, getPromo, deletePromo, RETIRED };
