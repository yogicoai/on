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

/**
 * 일일 리포트용 — 프로모션×몰 행을 (이름+기간) 단위로 묶어 "채널별 목표" 형태로 변환.
 *   리포트는 온라인(자사몰·스마트스토어·외부채널) 기준이라 오프라인 몰은 목표에 합산하지 않는다(진행 여부만 표시).
 *   목표는 MD가 엑셀에 넣은 target_sales 에서 온다(과거 promo_targets 대체).
 */
async function reportPromotions({ from } = {}) {
  const defs = await listDefs();
  const by = new Map();
  for (const d of defs) {
    if (from && d.start < from) continue;
    const k = `${d.name}|${d.start}|${d.end}`;
    if (!by.has(k)) {
      by.set(k, {
        id: d.promo_id, name: d.name, start: d.start, end: d.end, promoNameMatch: d.name,
        scope: (d.target && d.target.scope) || '', // 전제품 · 제품군 · 품목
        malls: [], trafficTargets: null, // 트래픽 목표는 엑셀에 없음
        channels: { 자사몰: { target: 0 }, 스마트스토어: { target: 0 }, 외부채널: { target: 0 } },
      });
    }
    const o = by.get(k);
    if (!o.malls.includes(d.mall)) o.malls.push(d.mall);
    if (o.channels[d.mall]) o.channels[d.mall].target += Number(d.target_sales) || 0;
  }
  return [...by.values()].sort((a, b) => String(a.start).localeCompare(String(b.start)));
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

module.exports = { listDefs, getDef, reportPromotions, status };
