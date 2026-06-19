'use strict';

/**
 * AI 채팅 대화 내역 저장소 — onlinedata DB의 ai_chats 컬렉션.
 *   문서: { id, title, start, end, messages:[{role,content,ts,model?}], createdAt, updatedAt }
 *   create()는 메모리 객체만 만들고, 첫 save()에서 upsert 적재(이중 쓰기 방지).
 */

const store = require('./store');
const COLL = 'ai_chats';

async function coll() {
  const c = await store.collection(COLL);
  try { await c.createIndex({ id: 1 }, { unique: true }); } catch (_) {}
  return c;
}

function newId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

async function create(start, end) {
  const now = new Date().toISOString();
  return { id: newId(), title: '새 대화', start: start || '', end: end || '', messages: [], createdAt: now, updatedAt: now };
}

async function get(id) {
  if (!id) return null;
  const c = await coll();
  return c.findOne({ id }, { projection: { _id: 0 } });
}

async function save(conv) {
  const c = await coll();
  const doc = { ...conv };
  delete doc._id;
  doc.updatedAt = new Date().toISOString();
  await c.replaceOne({ id: doc.id }, doc, { upsert: true });
  return doc;
}

async function list() {
  const c = await coll();
  const rows = await c.find({}, { projection: { _id: 0, id: 1, title: 1, start: 1, end: 1, updatedAt: 1, messages: 1 } })
    .sort({ updatedAt: -1 }).limit(200).toArray();
  return rows.map((r) => ({
    id: r.id, title: r.title, start: r.start, end: r.end, updatedAt: r.updatedAt,
    turns: (r.messages || []).filter((m) => m.role === 'user').length,
  }));
}

async function remove(id) {
  const c = await coll();
  const r = await c.deleteOne({ id });
  return r.deletedCount || 0;
}

module.exports = { create, get, save, list, remove };
