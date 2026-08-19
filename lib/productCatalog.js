'use strict';

/**
 * 제품/색상 카탈로그 조회 — catalog_products·catalog_colors (scripts/sync-catalog.js 로 적재).
 *   제품 70종(제품+색상 단위): 이름·카테고리·색상·hex·다각도 이미지. 표준 색상칩 25종.
 *   매출/재고가 아니라 "제품 사양·색상·이미지 참고"용 마스터 데이터.
 */

const store = require('./store');
const esc = (s) => String(s || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 제품 검색 — 이름/id/색상 부분일치 + 카테고리 필터. withImages=true면 이미지 URL 포함.
async function products({ search, category, withImages } = {}) {
  const c = await store.collection('catalog_products');
  const q = {};
  if (search) { const rx = { $regex: esc(search), $options: 'i' }; q.$or = [{ name: rx }, { id: rx }, { 'colors.color': rx }]; }
  if (category) q.category = { $regex: esc(category), $options: 'i' };
  const rows = await c.find(q).limit(60).toArray();
  if (!rows.length) {
    return { 검색어: search || null, 카테고리: category || null, 매칭: 0, 안내: '매칭 제품 없음 — 더 짧은 키워드로 재검색하거나 categories로 분류 확인. 데이터가 없으면 sync-catalog.js 적재 필요.' };
  }
  const items = rows.map((p) => {
    const col = (p.colors || [])[0] || {};
    const o = { 제품명: p.name, 카테고리: p.category || '', 색상: col.color || '', hex: col.hex || '' };
    if (p.spec) o.규격 = p.spec;
    if (withImages) o.이미지 = { '360': col.sprite360 || null, 정면: (col.views && col.views.front) || null, 측면: (col.views && col.views.side) || null, 후면: (col.views && col.views.back) || null };
    return o;
  });
  return { 검색어: search || null, 카테고리: category || null, 매칭: items.length, 제품: items, ...(items.length >= 60 ? { 주의: '상위 60건만 표시 — 검색어를 좁히세요' } : {}) };
}

// 표준 색상칩 25종
async function colors() {
  const c = await store.collection('catalog_colors');
  const rows = await c.find({}, { projection: { _id: 0, _syncedAt: 0 } }).toArray();
  if (!rows.length) return { 색상수: 0, 안내: '색상칩 데이터 없음 — sync-catalog.js 적재 필요.' };
  return { 색상수: rows.length, 색상칩: rows.map((r) => ({ 이름: r.name, hex: r.hex, id: r.id, 비고: r.note || '' })) };
}

// 전속 모델 조회 — 카테고리(여성/남성/아동)·이름·외모·등록상태. withImages=true면 참조/시트 URL.
async function models({ category, search, withImages } = {}) {
  const c = await store.collection('catalog_models');
  const q = {};
  if (category) q.카테고리 = { $regex: esc(category), $options: 'i' };
  if (search) { const rx = { $regex: esc(search), $options: 'i' }; q.$or = [{ 이름: rx }, { 외모: rx }, { code: rx }]; }
  const rows = await c.find(q, { projection: { _id: 0, _syncedAt: 0 } }).toArray();
  if (!rows.length) return { 매칭: 0, 안내: '모델 데이터 없음 — sync-catalog.js 적재 필요(또는 필터 확인).' };
  const items = rows.map((m) => {
    const o = { 카테고리: m.카테고리, 코드: m.code, 이름: m.이름, 키: m.키, 외모: m.외모, 등록상태: m.상태 };
    if (m.영상) o.영상 = { 포스터: m.영상, 메모: m.영상메모 || '' };
    if (withImages) o.이미지 = { 대표: m.참조이미지, 시트: m.시트 };
    return o;
  });
  const byCat = {}; for (const m of items) byCat[m.카테고리] = (byCat[m.카테고리] || 0) + 1;
  return { 매칭: items.length, 카테고리별인원: byCat, 모델: items, 안내: '등록상태=시트 완성도·착석 제품 등 제작 진행상태. 영상 테스트가 있는 모델엔 영상 포스터 포함.' };
}

// 카테고리별 제품 수
async function categories() {
  const c = await store.collection('catalog_products');
  const cats = await c.aggregate([{ $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
  return { 카테고리: cats.filter((x) => x._id).map((x) => ({ 카테고리: x._id, 제품수: x.n })) };
}

module.exports = { products, colors, categories, models };
