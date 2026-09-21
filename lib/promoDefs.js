'use strict';

/**
 * 프로모션 정의 조회 — promo_defs(MD 제출 자료 적재분). 성과 계산의 유일 기준.
 *   행 단위 = 프로모션 × 몰. PK는 (promo_id, mall) 복합키 — promo_id 단독은 고유하지 않다.
 */

const store = require('./store');

const ymd = (s) => String(s || '').slice(0, 10);

// [start,end] 와 겹치는 정의. mall 지정 시 그 몰만.
async function listDefs({ mall, start, end } = {}) {
  const c = await store.collection('promo_defs');
  const q = {};
  if (mall) q.mall = mall;
  if (start && end) { q.start = { $lte: ymd(end) }; q.end = { $gte: ymd(start) }; }
  return c.find(q, { projection: { _id: 0, _syncedAt: 0, _source: 0 } }).sort({ start: 1, promo_id: 1 }).toArray();
}

async function getDef(promo_id, mall) {
  const c = await store.collection('promo_defs');
  return c.findOne({ promo_id, ...(mall ? { mall } : {}) }, { projection: { _id: 0 } });
}

// 적재 현황(도구 안내·진단용)
async function status() {
  const c = await store.collection('promo_defs');
  const n = await c.countDocuments();
  if (!n) return { 적재: 0, 안내: '프로모션 정의 미적재 — 대시보드에서 엑셀 업로드 또는 node scripts/sync-promo-defs.js' };
  const one = await c.findOne({}, { projection: { _syncedAt: 1 } });
  const byMall = await c.aggregate([{ $group: { _id: '$mall', n: { $sum: 1 } } }]).toArray();
  const range = await c.aggregate([{ $group: { _id: null, min: { $min: '$start' }, max: { $max: '$end' } } }]).toArray();
  return {
    적재: n, 갱신시각: one && one._syncedAt,
    몰별: Object.fromEntries(byMall.map((x) => [x._id, x.n])),
    기간: range[0] ? `${range[0].min} ~ ${range[0].max}` : null,
  };
}

module.exports = { listDefs, getDef, status };
