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
const TEMPLATE_COLS = [
  ['promo_id', '프로모션ID (예: 202607-01) — 필수', 14],
  ['mall', '몰 (자사몰/스마트스토어/오프라인) — 필수', 14],
  ['name', '프로모션명 — 필수', 30],
  ['start', '시작일 YYYY-MM-DD — 필수', 12],
  ['end', '종료일 YYYY-MM-DD — 필수', 12],
  ['target_sales', '목표매출(원)', 14],
  ['target_scope', '대상범위 (전제품/제품군/품목)', 14],
  ['target_include', '대상상품 — 세미콜론(;) 구분. 예: 커버 전품목; 트레이보 엑스', 40],
  ['target_exclude', '제외상품 — 세미콜론 구분', 24],
  ['promo_type', '유형 (전사/단기특가/IP기획전/액세서리/시즌)', 16],
  ['disc_S', '할인율 스탠다드(%)', 12], ['disc_P', '할인율 프리미엄(%)', 12], ['disc_PP', '할인율 프리미엄플러스(%)', 14],
  ['disc_cover', '커버 할인율(%)', 12], ['disc_bead', '비즈 할인율(%)', 12], ['disc_acc', '악세서리 할인율(%)', 12],
  ['note', '비고', 24],
];
const SAMPLE = [
  { promo_id: '202607-01', mall: '자사몰', name: '요기보 위크 | 홈캉스', start: '2026-07-03', end: '2026-07-12', target_sales: 50000000, target_scope: '전제품', target_include: '', target_exclude: '', promo_type: '전사', disc_S: 10, disc_P: 10, disc_PP: 10, note: '전 제품 10% — 대상범위가 전제품이면 대상상품은 비워둡니다' },
  { promo_id: '202607-01', mall: '스마트스토어', name: '요기보 위크 | 홈캉스', start: '2026-07-03', end: '2026-07-12', target_sales: 30000000, target_scope: '전제품', promo_type: '전사', disc_S: 10, disc_P: 10, disc_PP: 10, note: '같은 프로모션이라도 몰마다 한 행씩' },
  { promo_id: '202607-02', mall: '자사몰', name: '커버·비즈 특가', start: '2026-07-17', end: '2026-07-31', target_sales: 8000000, target_scope: '품목', target_include: '커버 전품목; 비즈 전품목; 트레이보 엑스', target_exclude: '', promo_type: '액세서리', disc_cover: 30, disc_bead: 30, note: '대상상품은 품목맵의 규칙명 또는 ERP 품목명' },
];

async function template() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Yogibo 판매분석';
  const ws = wb.addWorksheet('프로모션');
  ws.columns = TEMPLATE_COLS.map(([key, , width]) => ({ key, width }));
  // 1행 = 헤더(파서가 읽는 이름), 2행 = 설명
  ws.addRow(Object.fromEntries(TEMPLATE_COLS.map(([k]) => [k, k])));
  ws.addRow(Object.fromEntries(TEMPLATE_COLS.map(([k, desc]) => [k, desc])));
  SAMPLE.forEach((s) => ws.addRow(s));
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
  guide.getRow(1).font = { bold: true, size: 13 };

  return wb.xlsx.writeBuffer();
}

module.exports = { parse, template, catalogFromLedger };
