'use strict';

/**
 * 프로모션 엑셀 → 표준 구조 변환. MD가 자기 방식으로 정리한 엑셀도 받도록 **헤더 이름 기반**으로 유연하게 읽는다.
 *   · 컬럼 순서 무관, 여분 컬럼 무시, 한/영 별칭 허용
 *   · 대상상품은 "커버 전품목; 비즈 전품목; 트레이보 엑스" 같은 세미콜론 텍스트 → 품목맵의 규칙/별칭으로 해석
 *   · 필수 시트는 프로모션 1개. 가격·이벤트 시트는 있으면 반영.
 *   · 품목 카탈로그(471품목)는 엑셀에 없으므로 DB 기존값 유지, 없으면 이카운트 원장에서 자동 생성.
 */

const ExcelJS = require('exceljs');
const store = require('./store');
const { PRODUCT_GROUPS } = require('./promoTarget');

// ── 헤더 별칭 (소문자·공백/기호 제거 후 비교) ──────────────────────────────
const H = {
  promo_id: ['promo_id', 'promoid', '프로모션id', '프로모션아이디', 'id'],
  campaign_id: ['campaign_id', 'campaignid', '캠페인id'],
  mall: ['mall', '몰', '채널', '판매처'],
  name: ['name', '프로모션명', '이름', '명칭'],
  promo_type: ['promo_type', 'promotype', '유형', '프로모션유형'],
  start: ['start', '시작일', '시작', 'startdate'],
  end: ['end', '종료일', '종료', 'enddate'],
  original_end: ['original_end', '원종료일', '연장전종료일'],
  method: ['method', '집계방식', '방식'],
  discount_apply_mode: ['discount_apply_mode', '할인방식', '할인적용방식'],
  target_scope: ['target_scope', '대상범위', '범위', 'scope'],
  target_include: ['target_include', '대상상품', '포함상품', '포함', 'include'],
  target_exclude: ['target_exclude', '제외상품', '제외', 'exclude'],
  target_sales: ['target_sales', '목표매출', '목표', '매출목표', 'goal'],
  disc_S: ['disc_s', '할인율s', '스탠다드'], disc_P: ['disc_p', '할인율p', '프리미엄'],
  disc_PP: ['disc_pp', '할인율pp', '프리미엄플러스'], disc_acc: ['disc_acc', '악세서리할인'],
  disc_cover: ['disc_cover', '커버할인'], disc_bead: ['disc_bead', '비즈할인'],
  special_price: ['special_price', '특가'],
  note: ['note', '비고', '메모'],
  mcp_existing_name: ['mcp_existing_name', '기존등록명'],
  // 비교창(선택) — 비우면 성과 조회 때 자동 계산(전년 같은 날짜 / 직전 동일 일수).
  //   작년에 같은 프로모션이 날짜만 다르게 진행됐을 때 MD가 직접 짝을 지어줄 수 있다.
  yoy_start: ['yoy_start', '전년비교시작', '전년시작'],
  yoy_end: ['yoy_end', '전년비교종료', '전년종료'],
  baseline_start: ['baseline_start', '직전비교시작', '베이스라인시작'],
  baseline_end: ['baseline_end', '직전비교종료', '베이스라인종료'],
  baseline_clean_pct: ['baseline_clean_pct', '직전기간신뢰도', '베이스라인신뢰도'],
  confounder: ['confounder', '교란요인', '동시진행'],
  // 캠페인 대표·할인대역 — 한 캠페인에 전제품 프로모션이 여러 건 병행될 때(전제품 10% + 사은쿠폰 + 조건부특가)
  //   합계를 한 번만 세기 위한 기준. 비우면 최대할인율이 가장 큰 건을 대표로 본다.
  rep_promo: ['rep_promo', '대표프로모션', '대표프로모션id', '캠페인대표'],
  max_discount: ['max_discount', '최대할인율', '대표할인율'],
  discount_band: ['discount_band', '할인대역', '할인구간'],
};
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\s_\-().]/g, '');
const MALL_SET = new Set(['자사몰', '스마트스토어', '오프라인']);
const cellText = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
};
const toDate = (v) => {
  const s = cellText(v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!isNaN(d)) return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return s;
};
// 빈 셀은 null(0이 아님) — Number('')===0 이라 그냥 쓰면 "할인 0%·목표 0원"으로 잘못 들어간다.
const toNum = (v) => { const s = String(cellText(v)).replace(/[^0-9.\-]/g, '').trim(); if (!s || s === '-') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const splitList = (v) => cellText(v).split(/[;\n]|,(?![0-9])/).map((x) => x.trim()).filter(Boolean);

// 시트에서 헤더행을 찾아 {키:열번호} 매핑
function mapHeaders(ws) {
  for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
    const row = ws.getRow(r);
    const cells = {};
    row.eachCell((cell, col) => { cells[norm(cellText(cell.value))] = col; });
    const idx = {};
    for (const [key, aliases] of Object.entries(H)) {
      for (const a of aliases) { if (cells[norm(a)] != null) { idx[key] = cells[norm(a)]; break; } }
    }
    if (idx.promo_id && idx.mall && idx.name) return { headerRow: r, idx };
  }
  return null;
}

// "커버 전품목; 트레이보 엑스" → [{raw, mode, ...}] (품목맵 규칙/별칭으로 해석)
//   띄어쓰기 차이("코지보트래블" ↔ "코지보 트래블")는 무시하고 찾는다 — MD 표기가 제각각이라.
const nospace = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
function toEntries(list, pmap) {
  const rules = (pmap && pmap.rules) || {};
  const aliases = (pmap && pmap.aliases) || {};
  const products = (pmap && pmap.products) || {};
  // 공백무시 역인덱스 (1회 구축)
  const rIdx = {}; for (const k of Object.keys(rules)) rIdx[nospace(k)] = k;
  const aIdx = {}; for (const k of Object.keys(aliases)) aIdx[nospace(k)] = k;
  const pIdx = {}; for (const k of Object.keys(products)) pIdx[nospace(k)] = k;

  return list.map((raw) => {
    const key = nospace(raw);
    const rk = rules[raw] ? raw : rIdx[key];
    if (rk) {
      const r = rules[rk];
      if (r.mode === 'set') return { raw, mode: 'set', components: r.components || [], note: r.note || '' };
      return { raw, mode: 'rule', match: r.match || {}, note: r.note || '' };
    }
    const ak = aliases[raw] ? raw : aIdx[key];
    let canon = raw;
    if (ak) { const v = aliases[ak]; canon = typeof v === 'string' ? v : (v && v.item) || raw; }
    else if (pIdx[key]) canon = pIdx[key]; // 품목명 자체(띄어쓰기만 다름)
    return { raw, mode: 'item', item: canon, ...(products[canon] ? {} : { unresolved: true }) };
  });
}

// 이카운트 원장에서 품목 카탈로그 자동 생성(엑셀엔 없음) — productName → {groups}
async function catalogFromLedger() {
  const out = {};
  for (const db of ['on', 'off']) {
    const c = await store.namedCollection(db, 'orders');
    const rows = await c.aggregate([
      { $match: { group1: { $in: PRODUCT_GROUPS }, amount: { $gt: 0 } } },
      { $group: { _id: { n: '$productName', g: '$group1' } } },
    ]).toArray();
    for (const r of rows) {
      const n = String(r._id.n || '').replace(/\((EPP|HRF)\)/gi, ' ').replace(/\s+/g, ' ').trim();
      if (!n) continue;
      out[n] = out[n] || { groups: [] };
      if (!out[n].groups.includes(r._id.g)) out[n].groups.push(r._id.g);
    }
  }
  return out;
}

/**
 * 엑셀(버퍼/경로) → { promotions[], price_detail[], events[], product_map }
 *   기존 품목맵(DB)을 넘겨주면 대상상품 해석에 사용하고, 없으면 원장에서 카탈로그 생성.
 */
async function parse(input, { productMap } = {}) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(input)) await wb.xlsx.load(input); else await wb.xlsx.readFile(input);

  // 프로모션 시트 찾기 — 이름 무관, 헤더로 판정
  let ws = null, hdr = null;
  for (const sheet of wb.worksheets) { const h = mapHeaders(sheet); if (h) { ws = sheet; hdr = h; break; } }
  if (!ws) {
    const names = wb.worksheets.map((s) => s.name).join(', ');
    throw new Error(`프로모션 시트를 찾지 못했습니다 — 최소 "프로모션ID·몰·프로모션명" 컬럼이 있어야 합니다. (시트: ${names})`);
  }

  let pmap = productMap;
  if (!pmap || !Object.keys(pmap.products || {}).length) {
    const cur = await store.collection('promo_product_map').then((c) => c.findOne({ _id: 'product_map' }));
    pmap = cur && Object.keys(cur.products || {}).length ? cur : { products: await catalogFromLedger(), aliases: (cur && cur.aliases) || {}, rules: (cur && cur.rules) || {} };
  }

  const { idx } = hdr;
  const get = (row, key) => (idx[key] ? row.getCell(idx[key]).value : null);
  const promotions = [];
  for (let r = hdr.headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const promo_id = cellText(get(row, 'promo_id')).trim();
    const mall = cellText(get(row, 'mall')).trim();
    const name = cellText(get(row, 'name')).trim();
    if (!promo_id && !mall && !name) continue; // 빈 행
    // 설명·안내·구분 행 건너뛰기 — 몰도 날짜도 유효하지 않으면 데이터 행이 아니다.
    //   (오타 난 실제 데이터는 남겨서 검증 단계에서 잡히게 한다)
    const looksData = MALL_SET.has(mall) || /^\d{4}-\d{2}-\d{2}/.test(toDate(get(row, 'start'))) || /^\d{4}-\d{2}-\d{2}/.test(toDate(get(row, 'end')));
    if (!looksData) continue;

    // 비교창(선택) — 하나라도 채워져 있을 때만 campaign/tags 를 만든다(빈 객체는 지문 비교를 흔든다).
    const cmpWindows = (r) => {
      const c = {};
      const ys = toDate(get(r, 'yoy_start')), ye = toDate(get(r, 'yoy_end'));
      const bs = toDate(get(r, 'baseline_start')), be = toDate(get(r, 'baseline_end'));
      const cp = toNum(get(r, 'baseline_clean_pct'));
      if (ys && ye) { c.yoy_start = ys; c.yoy_end = ye; }
      if (bs && be) { c.baseline_start = bs; c.baseline_end = be; }
      if (cp != null) c.baseline_clean_pct = cp;
      const rep = cellText(get(r, 'rep_promo')).trim();
      if (rep) c.rep_promo = rep;
      const conf = splitList(get(r, 'confounder')).filter(Boolean);
      const md = toNum(get(r, 'max_discount'));
      const band = cellText(get(r, 'discount_band')).trim();
      const t = {};
      if (conf.length) t.confounder = conf;
      if (md != null) t.max_discount = md;
      if (band) t.discount_band = band;
      const out = {};
      if (Object.keys(c).length) out.campaign = c;
      if (Object.keys(t).length) out.tags = t;
      return out;
    };
    const scope = cellText(get(row, 'target_scope')).trim() || '품목';
    const include = toEntries(splitList(get(row, 'target_include')), pmap);
    const exclude = toEntries(splitList(get(row, 'target_exclude')), pmap);
    // 할인율 — 표준 키로 통일(acc→accessory). 키가 어긋나면 같은 내용도 "변경됨"으로 잡힌다.
    const DISC_KEY = { disc_S: 'S', disc_P: 'P', disc_PP: 'PP', disc_acc: 'accessory', disc_cover: 'cover', disc_bead: 'bead' };
    const disc = {};
    for (const [col, key] of Object.entries(DISC_KEY)) { const v = toNum(get(row, col)); if (v != null) disc[key] = v; }
    promotions.push({
      promo_id, campaign_id: cellText(get(row, 'campaign_id')).trim() || null, mall, name,
      promo_type: cellText(get(row, 'promo_type')).trim() || null,
      start: toDate(get(row, 'start')), end: toDate(get(row, 'end')),
      original_end: toDate(get(row, 'original_end')) || null,
      method: cellText(get(row, 'method')).trim() || '상품매칭',
      discount_apply_mode: cellText(get(row, 'discount_apply_mode')).trim() || null,
      target: { scope, include, exclude },
      discount: Object.keys(disc).length ? disc : null,
      special_price: cellText(get(row, 'special_price')).trim() || null,
      target_sales: toNum(get(row, 'target_sales')),
      mcp_existing_name: cellText(get(row, 'mcp_existing_name')).trim() || null,
      note: cellText(get(row, 'note')).trim() || null,
      ...cmpWindows(row),
    });
  }

  const unresolved = [];
  for (const p of promotions) for (const e of [...(p.target.include || []), ...(p.target.exclude || [])]) {
    if (e.unresolved) unresolved.push(`${p.promo_id}(${p.mall}) "${e.raw}"`);
  }

  return {
    promotions, price_detail: [], events: [],
    product_map: pmap,
    _meta: { sheet: ws.name, headerRow: hdr.headerRow, columns: Object.keys(idx), unresolved },
  };
}

// ── 예제 양식 생성 (MD 배포용) ─────────────────────────────────────────────
//   "이 형식으로 만들어서 올려주세요" — 강제 템플릿이 아니라 예시. 헤더 이름만 맞으면 순서·여분컬럼 자유.
//   2026-10-15부터 예제 = **지금 등록된 프로모션 전부**를 MD 대시보드 등록 파일(전사프로모션_대시보드등록_261015.xlsx)과 같은 모양으로 내려준다
//   (사용자 요청). 받은 파일을 고쳐 그대로 올리면 된다 — 17열에 없는 칸은 업로드 때 기존 값을 이어받는다(promoIngest.withCurrent).
const TEMPLATE_COLS = [
  ['promo_id', '프로모션ID (예: 202607-01) — 필수', 14],
  ['mall', '몰 (자사몰/스마트스토어/오프라인) — 필수', 14],
  ['name', '프로모션명 — 필수', 38],
  ['start', '시작일 YYYY-MM-DD — 필수', 12],
  ['end', '종료일 YYYY-MM-DD — 필수', 12],
  ['target_sales', '목표매출(원)', 14],
  ['target_scope', '대상범위 (전제품/제품군/품목)', 14],
  ['target_include', '대상상품 — 세미콜론(;) 구분. 예: 커버 전품목; 트레이보 엑스', 34],
  ['target_exclude', '제외상품 — 세미콜론 구분', 24],
  ['promo_type', '유형 (전사/단기특가/IP기획전/액세서리/시즌)', 16],
  ['disc_S', '할인율 스탠다드(%)', 12], ['disc_P', '할인율 프리미엄(%)', 12], ['disc_PP', '할인율 프리미엄플러스(%)', 14],
  ['disc_cover', '커버 할인율(%)', 12], ['disc_bead', '비즈 할인율(%)', 12], ['disc_acc', '악세서리 할인율(%)', 12],
  ['note', '비고', 90],
];
const SAMPLE = [
  { promo_id: '202607-01', mall: '자사몰', name: '요기보 위크 | 홈캉스', start: '2026-07-03', end: '2026-07-12', target_sales: 50000000, target_scope: '전제품', target_include: '', target_exclude: '', promo_type: '전사', disc_S: 10, disc_P: 10, disc_PP: 10, note: '전 제품 10% — 대상범위가 전제품이면 대상상품은 비워둡니다' },
  { promo_id: '202607-01', mall: '스마트스토어', name: '요기보 위크 | 홈캉스', start: '2026-07-03', end: '2026-07-12', target_sales: 30000000, target_scope: '전제품', promo_type: '전사', disc_S: 10, disc_P: 10, disc_PP: 10, note: '같은 프로모션이라도 몰마다 한 행씩' },
  { promo_id: '202607-02', mall: '자사몰', name: '커버·비즈 특가', start: '2026-07-17', end: '2026-07-31', target_sales: 8000000, target_scope: '품목', target_include: '커버 전품목; 비즈 전품목; 트레이보 엑스', target_exclude: '', promo_type: '액세서리', disc_cover: 30, disc_bead: 30, note: '대상상품은 품목맵의 규칙명 또는 ERP 품목명' },
];

// 비고 앞머리 — 커버 · 비즈 · 악세사리 할인율 칸이 왜 비었는지(0%가 아니라 "해당 없음"). MD 파일과 같은 문구를 기입 근거(discount_fill)에서 만든다.
//   업로드할 때는 이 머리말을 떼고 저장한다(promoIngest.withCurrent) — 내려받을 때마다 다시 붙으므로 겹치지 않는다.
function displayNote(d) {
  const body = String(d.note || '').replace(/^\[[^\]]*\]\s*/, '').trim();
  const f = d.discount_fill || {}, blank = f.blank || [];
  if (!blank.length) return body;
  let tag;
  if (d.promo_type && d.promo_type !== '전사') tag = '커버·비즈·악세사리 빈칸: 대상 품목 지정 프로모션으로 해당 없음';
  else if (blank.length >= 3) tag = '할인율 없음: 사은품·증정 중심 프로모션';
  else if (f.era === 'B') tag = '커버·비즈 빈칸: 2026-04 전환 구간으로 판정 보류 — 0% 아님';
  else if (f.era === 'C') tag = '커버·비즈 빈칸: 전제품 할인 제외 — 회원가입 20% 쿠폰만, 0% 아님';
  else tag = blank.map((k) => ({ cover: '커버', bead: '비즈', accessory: '악세사리' }[k] || k)).join('·') + ' 빈칸: ' + (f.blank_reason || '해당 없음');
  return ('[' + tag + '] ' + body).trim();
}
const MALL_ORDER = { 자사몰: 0, 스마트스토어: 1, 오프라인: 2 };
const entryText = (arr) => (arr || []).map((e) => (e && (e.raw != null ? e.raw : e.item)) || '').filter(Boolean).join('; ');
// 지금 등록된 프로모션 → 17열 행. 없으면 예제 3행
async function templateRows() {
  let defs = [];
  try { defs = await store.collection('promo_defs').then((c) => c.find({}, { projection: { _id: 0 } }).toArray()); } catch (_) {}
  if (!defs.length) return { rows: SAMPLE, defs };
  defs.sort((a, b) => String(a.promo_id).localeCompare(String(b.promo_id)) || (MALL_ORDER[a.mall] ?? 9) - (MALL_ORDER[b.mall] ?? 9));
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const rows = defs.map((d) => {
    const t = d.target || {}, x = d.discount || {};
    return { promo_id: d.promo_id, mall: d.mall, name: d.name, start: d.start, end: d.end, target_sales: num(d.target_sales),
      target_scope: t.scope || null, target_include: entryText(t.include) || null, target_exclude: entryText(t.exclude) || null, promo_type: d.promo_type || null,
      disc_S: num(x.S), disc_P: num(x.P), disc_PP: num(x.PP), disc_cover: num(x.cover), disc_bead: num(x.bead), disc_acc: num(x.accessory), note: displayNote(d) || null };
  });
  return { rows, defs };
}

async function template() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Yogibo 판매분석';
  const ws = wb.addWorksheet('프로모션');
  ws.columns = TEMPLATE_COLS.map(([key, , width]) => ({ key, width }));
  // 1행 = 헤더(파서가 읽는 이름), 2행 = 설명
  ws.addRow(Object.fromEntries(TEMPLATE_COLS.map(([k]) => [k, k])));
  ws.addRow(Object.fromEntries(TEMPLATE_COLS.map(([k, desc]) => [k, desc])));
  const { rows, defs } = await templateRows();
  rows.forEach((s) => ws.addRow(s));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
  ws.getRow(2).font = { italic: true, size: 9, color: { argb: 'FF888888' } };
  ws.views = [{ state: 'frozen', ySplit: 2 }];

  const guide = wb.addWorksheet('작성안내');
  guide.columns = [{ width: 100 }];
  [
    '전사 프로모션 등록 — 작성 안내',
    '',
    '1. "프로모션" 시트에 한 행 = 한 프로모션 × 한 몰. 같은 프로모션이 3개 몰에서 진행되면 3행입니다.',
    '2. 필수: promo_id · mall · name · start · end. 나머지는 비워도 됩니다.',
    '3. 목표매출(target_sales)을 넣으면 성과 조회 시 달성률이 함께 나옵니다.',
    '4. 대상범위(target_scope):',
    '     전제품 → 대상상품은 비워둡니다(전 상품 대상). 특정 상품만 빼려면 제외상품에 적으세요.',
    '     품목/제품군 → 대상상품에 세미콜론(;)으로 나열. 예) 커버 전품목; 비즈 전품목; 트레이보 엑스',
    '5. 대상상품에는 "커버 전품목" 같은 묶음 표현 또는 ERP 품목명을 적습니다. 띄어쓰기는 달라도 됩니다.',
    '6. 2행(회색 설명줄)은 지우고 올리셔도 되고, 그대로 두셔도 무시됩니다.',
    '7. 컬럼 순서가 달라도, 필요 없는 컬럼이 더 있어도 괜찮습니다. 헤더 이름으로 읽습니다.',
    '',
    '업로드: 판매분석 대시보드 → 프로모션 등록 → 엑셀 올리기 → 변경내용 확인 → 적용',
    '적용하면 Claude(MCP)에서 바로 성과를 조회할 수 있습니다.',
  ].forEach((t) => guide.addRow([t]));
  // 이 파일에 대한 안내 — 지금 등록분을 내려받은 것이라 고쳐서 그대로 올리면 된다(MD 대시보드 등록 파일 안내를 따름)
  if (defs.length) {
    const byMall = {}; defs.forEach((d) => { byMall[d.mall] = (byMall[d.mall] || 0) + 1; });
    const ids = new Set(defs.map((d) => d.promo_id)).size;
    const min = defs.reduce((m, d) => (d.start < m ? d.start : m), defs[0].start), max = defs.reduce((m, d) => (d.end > m ? d.end : m), defs[0].end);
    const kst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    [
      '',
      '─────────────────────────────────────────',
      '이 파일에 대한 안내 (' + kst + ' 내려받음 · 지금 등록된 프로모션 그대로)',
      '· ' + min + ' ~ ' + max + ' 프로모션 ' + ids + '건을 몰별로 전개한 ' + defs.length + '행입니다(' + Object.entries(byMall).sort((a, b) => (MALL_ORDER[a[0]] ?? 9) - (MALL_ORDER[b[0]] ?? 9)).map(([k, v]) => k + ' ' + v).join(' · ') + ').',
      '· 고칠 행만 고치고 새 프로모션은 아래에 행을 추가해 그대로 올리면 됩니다. 올리면 먼저 "신규 · 수정 · 삭제"를 보여 주고, 확인해야 반영됩니다.',
      '★ 이 파일에서 행을 지우고 올리면 그 프로모션은 등록에서 빠집니다(전체 교체). 지울 게 아니면 행을 남겨 두세요.',
      '· 이 양식에 없는 칸(전년 · 직전 비교 기간, 조건 태그, 할인율 기입 근거, 가격표, 교란요인)은 다시 올려도 지금 값이 그대로 유지됩니다.',
      '· 비고(note) 앞머리의 대괄호는 할인율 빈칸 사유입니다. 그대로 두셔도 되고 지우셔도 됩니다(내려받을 때마다 다시 붙습니다).',
      '★ 커버 · 비즈 할인율 빈칸은 "0%"가 아니라 "해당 없음"입니다. 0으로 채우지 마십시오.',
      '  2026-05-01 이후 전사 프로모션은 오프라인만 커버 · 비즈에 전제품 할인율이 들어갑니다.',
      '  자사몰 · 스마트스토어는 커버 · 비즈가 전제품 할인에서 빠지고 회원가입 20% 쿠폰으로만 운영되기 때문에 빈칸입니다.',
      '  이 쿠폰은 프로모션 할인이 아니라 상시 쿠폰이라 할인율 칸에 넣지 않습니다.',
      '  구간별 적용:',
      '   2025-01-01 ~ 2026-03-31 : 온 · 오프 모두 전제품 할인율 적용',
      '   2026-04-01 ~ 2026-04-30 : 오프라인만 적용 / 온라인은 전환 구간이라 판정 보류',
      '   2026-05-01 ~          : 오프라인만 적용 / 온라인은 해당 없음',
      '· 악세사리 할인율은 전 구간 · 전 몰 공통으로 전제품 할인율을 적용합니다.',
      '· 목표매출(target_sales)은 비어 있으면 달성률 없이 성과만 나옵니다. 필요하면 담당자가 직접 입력하면 됩니다.',
    ].forEach((t) => guide.addRow([t]));
  }
  guide.getRow(1).font = { bold: true, size: 13 };

  return wb.xlsx.writeBuffer();
}

module.exports = { parse, template, templateRows, displayNote, catalogFromLedger };
