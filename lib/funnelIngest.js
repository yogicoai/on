'use strict';

/**
 * 일일 퍼널 — 업로드 적재(미리보기 · 반영 · 되돌리기).
 *
 *   프로모션 업로드와 다른 점: **전체 교체가 아니라 날짜 단위 덮어쓰기**다.
 *   MD가 이번 주치만 올려도 지난 데이터가 남아야 하고, 밀린 날짜를 한 번에 올리는 것도 같은 경로다.
 *   그래서 되돌리기도 "직전 전체 스냅샷"이 아니라 **이번에 건드린 날짜의 이전 값**만 보관한다.
 */

const store = require('./store');
const funnel = require('./funnelDaily');
const dailyReport = require('./dailyReport');

const BACKUP = 'funnel_backup';
const R = (n) => Math.round(n || 0);
const pct = (a, b) => (a ? +(((b - a) / a) * 100).toFixed(1) : null);
const sq = (s) => String(s || '').replace(/\s/g, '');
// 월목표 한 줄의 저장 위치 — 자사몰=cafe24 · 스마트스토어=smartstore · 외부 몰=byMall.<몰 이름>
const tgField = (t) => (t.channel === '스마트스토어' ? 'smartstore' : t.channel === '자사몰' ? 'cafe24' : `byMall.${t.mall}`);
const tgLabel = (t) => t.mall || t.channel;
const tgBefore = (doc, t) => {
  if (!doc) return 0;
  if (t.channel !== '외부몰') return Number(doc[tgField(t)] || 0);
  const bm = doc.byMall || {};
  const k = Object.keys(bm).find((x) => sq(x) === sq(t.mall)); // 띄어쓰기만 다르게 저장된 기존 값도 같은 몰로 본다
  return k ? Number(bm[k] || 0) : 0;
};

/**
 * 월 목표 양식에 미리 채울 행 — 자사몰·스마트스토어 + 지금 운영 중인 외부 몰.
 *   운영 중 = 직전 3개월 또는 이번 달에 이카운트 온라인 매출이 있는 몰(공동구매 제외), 직전 3개월 매출 큰 순.
 *   그 달 목표가 이미 있으면 값을 채워 두고, 목표만 있고 최근 매출이 없는 몰도 빠뜨리지 않는다.
 *   참고 칸: 최근 3개월 월평균 · 지난달 매출(이카운트 출고 순매출).
 */
async function templateRows(ym) {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  const mon = (k) => new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 7); // ym 기준 k달 뒤(음수=앞)
  const from = mon(-3) + '-01', to = mon(1) + '-01';
  const on = await store.namedCollection('on', 'orders');
  const [rows, doc] = await Promise.all([
    on.aggregate([
      { $match: { date: { $gte: from, $lt: to } } },
      { $group: { _id: { s: '$store', ym: { $substrCP: ['$date', 0, 7] } }, amt: { $sum: '$amount' } } },
    ]).toArray(),
    store.collection('targets').then((c) => c.findOne({ month: ym })).catch(() => null),
  ]);
  const past = [mon(-3), mon(-2), mon(-1)];
  const by = new Map(); // 몰 → { ch, p3, last, cur }
  for (const r of rows) {
    const name = r._id.s || '';
    const ch = dailyReport.classifyChannel(name);
    if (ch === '공동구매') continue;
    const key = ch === '외부채널' ? name : ch; // 자사몰·스마트스토어는 채널 하나로
    const o = by.get(key) || { ch, p3: 0, last: 0, cur: 0 };
    if (past.includes(r._id.ym)) o.p3 += r.amt || 0;
    if (r._id.ym === mon(-1)) o.last += r.amt || 0;
    if (r._id.ym === ym) o.cur += r.amt || 0;
    by.set(key, o);
  }
  const bm = (doc && doc.byMall) || {};
  for (const k of Object.keys(bm)) if (![...by.keys()].some((x) => sq(x) === sq(k))) by.set(k, { ch: '외부채널', p3: 0, last: 0, cur: 0 });
  const line = (name, kind, o, tgt) => ({ 채널: name, 연월: ym, 순매출목표: tgt > 0 ? tgt : null, 구분: kind, '최근 3개월 월평균 매출': R((o.p3 || 0) / 3), '지난달 매출': R(o.last || 0) });
  const out = [
    line('자사몰', '채널 목표', by.get('자사몰') || {}, doc && Number(doc.cafe24)),
    line('스마트스토어', '채널 목표', by.get('스마트스토어') || {}, doc && Number(doc.smartstore)),
  ];
  const ext = [...by.entries()].filter(([, o]) => o.ch === '외부채널')
    .sort((a, b) => b[1].p3 - a[1].p3 || b[1].cur - a[1].cur);
  for (const [name, o] of ext) out.push(line(name, '외부 몰', o, tgBefore(doc, { channel: '외부몰', mall: name })));
  return out;
}

function validate(parsed) {
  const errors = [], warnings = [];
  const { mall = [], store: st = [], targets = [] } = parsed || {};
  if (!mall.length && !st.length && !targets.length) errors.push('읽어들인 데이터가 없습니다 — 일자와 값이 채워져 있는지 확인해 주세요.');

  const seen = new Set();
  for (const r of mall) {
    if (seen.has(r.date)) errors.push(`자사몰퍼널 ${r.date}: 같은 날짜가 두 번 있습니다`);
    seen.add(r.date);
    for (const k of ['상품조회', '장바구니조회', '주문서작성']) {
      if (r[k] == null) warnings.push(`자사몰퍼널 ${r.date}: ${k} 비어 있음`);
      else if (r[k] < 0) errors.push(`자사몰퍼널 ${r.date}: ${k}가 음수입니다(${r[k]})`);
    }
    // 단계 역전은 오류가 아니라 경고 — 장바구니를 거치지 않는 바로구매가 있어 주문서>장바구니가 정상적으로 나온다
    if (r.상품조회 != null && r.이프두_방문시작 != null && r.상품조회 > r.이프두_방문시작) {
      warnings.push(`자사몰퍼널 ${r.date}: 상품조회(${r.상품조회})가 방문시작(${r.이프두_방문시작})보다 많습니다 — 확인 필요`);
    }
  }
  const seenS = new Set();
  for (const r of st) {
    if (seenS.has(r.date)) errors.push(`스마트스토어 ${r.date}: 같은 날짜가 두 번 있습니다`);
    seenS.add(r.date);
    if (r.주문건수 != null && r.주문건수 < 0) errors.push(`스마트스토어 ${r.date}: 주문건수가 음수입니다`);
  }
  for (const t of targets) {
    if (!(t.net >= 0)) errors.push(`월목표 ${tgLabel(t)} ${t.ym}: 목표가 숫자가 아닙니다`);
    // 몰 이름은 DB 필드 경로(byMall.<이름>)가 된다 — 점(.)이나 $로 시작하면 저장이 깨진다
    if (t.channel === '외부몰' && (/\./.test(t.mall) || /^\$/.test(t.mall))) errors.push(`월목표 ${t.mall}: 몰 이름에 점(.)이나 $ 로 시작하는 글자는 쓸 수 없습니다`);
  }
  return {
    // 파일 읽기 단계 경고(시트 없음·월목표 중복 합침 등)도 화면에 보이도록 함께 돌려준다
    ok: errors.length === 0, errors, warnings: [...new Set([...((parsed && parsed.warnings) || []), ...warnings])],
    counts: { 자사몰퍼널: mall.length, 스마트스토어: st.length, 월목표: targets.length },
  };
}

/** 미리보기 — 신규/수정/변동없음 + 우리 값과의 대조 */
async function diff(parsed) {
  const { mall = [], store: st = [], targets = [] } = parsed || {};
  const dates = mall.map((r) => r.date).sort();
  const from = dates[0], to = dates[dates.length - 1];

  const cur = new Map((await funnel.rowsIn('mall', from, to)).map((r) => [r.date, r]));
  const same = (a, b) => ['상품조회', '장바구니조회', '주문서작성'].every((k) => R(a[k]) === R(b[k]));
  const added = [], changed = [], unchanged = [];
  for (const r of mall) {
    const o = cur.get(r.date);
    if (!o) added.push(r.date);
    else if (same(o, r)) unchanged.push(r.date);
    else changed.push({ date: r.date, 이전: `${R(o.상품조회)}/${R(o.장바구니조회)}/${R(o.주문서작성)}`, 변경: `${R(r.상품조회)}/${R(r.장바구니조회)}/${R(r.주문서작성)}` });
  }

  // 대조 — 이프두 방문시작·주문완료 vs 우리 traffic_daily
  const 대조 = [];
  if (from && to) {
    const td = await store.collection('traffic_daily');
    const T = new Map((await td.find({ date: { $gte: from, $lte: to } }, { projection: { _id: 0, date: 1, visits: 1, orders: 1 } }).toArray()).map((x) => [x.date, x]));
    for (const r of mall) {
      const t = T.get(r.date);
      if (!t) { 대조.push({ date: r.date, 비고: '우리 쪽 방문 데이터 없음' }); continue; }
      if (r.이프두_방문시작 != null && t.visits > 0) {
        const d = pct(t.visits, r.이프두_방문시작);
        if (Math.abs(d) >= 15) 대조.push({ date: r.date, 항목: '방문시작', 이프두: r.이프두_방문시작, 시스템: t.visits, 차이_pct: d });
      }
      if (r.이프두_주문완료 != null && t.orders > 0) {
        const d = pct(t.orders, r.이프두_주문완료);
        if (Math.abs(d) >= 15) 대조.push({ date: r.date, 항목: '주문완료', 이프두: r.이프두_주문완료, 시스템: t.orders, 차이_pct: d });
      }
    }
  }

  // 월 목표 변경 미리보기 — 외부 몰은 몰별 목표(byMall). 이카운트 매출에 없는 몰 이름이면 철자 경고.
  const tgPrev = [], tgWarn = [];
  if (targets.length) {
    const c = await store.collection('targets');
    const malls = targets.filter((t) => t.channel === '외부몰');
    let known = null;
    if (malls.length) {
      const since = new Date(Date.now() - 400 * 86400e3).toISOString().slice(0, 10); // 최근 1년여 거래처명
      known = new Set((await (await store.namedCollection('on', 'orders')).distinct('store', { date: { $gte: since } })).map(sq));
    }
    for (const t of targets) {
      const d = await c.findOne({ month: t.ym });
      const before = tgBefore(d, t);
      if (before !== t.net) tgPrev.push({ 연월: t.ym, 채널: tgLabel(t) + (t.channel === '외부몰' ? ' (외부 몰)' : ''), 이전: before, 변경: t.net });
      if (known && t.channel === '외부몰' && !known.has(sq(t.mall))) tgWarn.push(`"${t.mall}" — 최근 1년 이카운트 매출에 없는 몰 이름입니다. 철자를 확인하세요(저장은 되지만 실적과 이어지지 않습니다).`);
    }
  }

  return {
    기간: from && to ? `${from} ~ ${to}` : null,
    신규: added.length, 수정: changed.length, 변동없음: unchanged.length,
    수정상세: changed.slice(0, 20),
    스마트스토어: st.length,
    월목표변경: tgPrev,
    월목표경고: [...new Set(tgWarn)],
    대조: 대조.slice(0, 20),
    대조요약: 대조.length ? `${대조.length}일에서 15% 이상 차이 — 정의가 벌어지고 있는지 확인이 필요합니다.` : '이상 없음',
  };
}

/** 반영 — 건드리는 날짜의 이전 값만 스냅샷 후 덮어쓰기 */
async function ingest(parsed, { source = 'excel-upload' } = {}) {
  const v = validate(parsed);
  if (!v.ok) return { ok: false, ...v };
  const { mall = [], store: st = [], targets = [] } = parsed;
  const at = new Date().toISOString();

  const bk = await store.collection(BACKUP);
  // 되돌리기용 스냅샷 — 이전 값(prev)과 **이번에 건드린 날짜 목록(dates)** 을 둘 다 남긴다.
  //   dates 가 없으면 "새로 추가된 날짜"를 되돌릴 때 지울 대상을 알 수 없다.
  const snap = { at, source, mall: [], store: [], targets: [], mallDates: [], storeDates: [] };
  if (mall.length) {
    snap.mallDates = [...new Set(mall.map((r) => r.date))];
    snap.mall = await (await store.collection(funnel.COLL.mall)).find({ date: { $in: snap.mallDates } }, { projection: { _id: 0 } }).toArray();
  }
  if (st.length) {
    snap.storeDates = [...new Set(st.map((r) => r.date))];
    snap.store = await (await store.collection(funnel.COLL.store)).find({ date: { $in: snap.storeDates } }, { projection: { _id: 0 } }).toArray();
  }
  if (targets.length) {
    const c = await store.collection('targets');
    for (const t of targets) {
      const d = await c.findOne({ month: t.ym }, { projection: { _id: 0 } });
      snap.targets.push({ ym: t.ym, prev: d || null });
    }
  }
  await bk.insertOne(snap);
  // 최근 5개만 보관
  const old = await bk.find({}, { projection: { _id: 1, at: 1 } }).sort({ at: -1 }).skip(5).toArray();
  if (old.length) await bk.deleteMany({ _id: { $in: old.map((x) => x._id) } });

  const a = await funnel.saveRows('mall', mall, source);
  const b = await funnel.saveRows('store', st, source);

  // 월 목표 — 매출보고가 쓰는 targets 을 그대로 갱신(화면 두 개가 다른 목표를 보지 않게)
  let tgSaved = 0;
  if (targets.length) {
    const c = await store.collection('targets');
    for (const t of targets) {
      // 외부 몰은 byMall.<몰 이름> — 띄어쓰기만 다르게 이미 저장된 이름이 있으면 그 이름에 덮어쓴다(같은 몰이 두 줄로 갈라지지 않게)
      let field = tgField(t);
      if (t.channel === '외부몰') {
        const d = await c.findOne({ month: t.ym }, { projection: { byMall: 1 } });
        const k = Object.keys((d && d.byMall) || {}).find((x) => sq(x) === sq(t.mall));
        if (k) field = `byMall.${k}`;
      }
      // updatedAt — 다른 입력 경로(lib/target setTarget·setMallTarget)와 같은 필드. 채널·연월당 값 하나를 덮어써 최근 등록이 이긴다.
      await c.updateOne({ month: t.ym }, { $set: { month: t.ym, [field]: t.net, updatedAt: at, _at: at, _src: '퍼널 업로드' } }, { upsert: true });
      tgSaved++;
    }
  }
  return { ok: true, counts: v.counts, warnings: v.warnings, saved: { 자사몰퍼널: a.saved, 스마트스토어: b.saved, 월목표: tgSaved }, at };
}

/** 되돌리기 — 직전 업로드가 건드린 날짜만 이전 값으로 복구 */
async function rollback() {
  const bk = await store.collection(BACKUP);
  const last = await bk.find({}).sort({ at: -1 }).limit(1).toArray();
  if (!last.length) return { ok: false, error: '되돌릴 업로드 기록이 없습니다' };
  const s = last[0];
  const restore = async (collName, touched, snapRows) => {
    if (!touched || !touched.length) return 0;
    const c = await store.collection(collName);
    const had = new Set((snapRows || []).map((r) => r.date));
    // 업로드로 새로 생긴 날짜는 지우고, 원래 있던 날짜는 이전 값으로 되돌린다
    const toDelete = touched.filter((d) => !had.has(d));
    if (toDelete.length) await c.deleteMany({ date: { $in: toDelete } });
    for (const r of (snapRows || [])) await c.replaceOne({ date: r.date }, r, { upsert: true });
    return touched.length;
  };
  const n1 = await restore(funnel.COLL.mall, s.mallDates || (s.mall || []).map((r) => r.date), s.mall);
  const n2 = await restore(funnel.COLL.store, s.storeDates || (s.store || []).map((r) => r.date), s.store);
  let n3 = 0;
  if (s.targets && s.targets.length) {
    const c = await store.collection('targets');
    // 문서 통째로 되돌린다 — $set 으로 덮으면 이번 업로드가 새로 넣은 몰(byMall.<몰>)이 지워지지 않고 남는다.
    //   같은 연월이 스냅샷에 여러 번 있으면(한 파일에 채널 여러 줄) 첫 스냅샷이 업로드 전 상태다.
    const doneYm = new Set();
    for (const t of s.targets) {
      if (doneYm.has(t.ym)) continue;
      doneYm.add(t.ym);
      if (t.prev) await c.replaceOne({ month: t.ym }, t.prev, { upsert: true });
      else await c.deleteOne({ month: t.ym });
      n3++;
    }
  }
  await bk.deleteOne({ _id: s._id });
  return { ok: true, restored: { 자사몰퍼널: n1, 스마트스토어: n2, 월목표: n3 }, at: s.at, source: s.source };
}

module.exports = { validate, diff, ingest, rollback, templateRows, BACKUP };
