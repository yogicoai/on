'use strict';

/**
 * 일일 퍼널 — 엑셀 양식 생성 · 파싱.
 *
 *   MD가 이프두에서 받은 표를 **컬럼을 지우지 않고 그대로 붙여넣을 수 있게** 5단계를 다 받는다.
 *   그중 저장하는 것은 우리가 못 얻는 3개(상품조회·장바구니조회·주문서작성)뿐이고,
 *   방문시작·주문완료는 우리 값과 **대조**해서 정의가 벌어지는지 알려준다.
 *
 *   헤더는 이름으로 찾는다 — 컬럼 순서가 달라도, 필요 없는 컬럼이 더 있어도 된다.
 *   날짜만 맞으면 되고, 파일에 있는 날짜만 덮어쓴다(나머지 보존).
 */

const ExcelJS = require('exceljs');

// 헤더 별칭 — 공백·괄호·대소문자 무시하고 포함 여부로 찾는다(이프두 표기 변형 흡수)
const H = {
  date: ['일자', '날짜', 'date'],
  방문시작: ['방문시작', '방문수', '방문자', 'visit'],
  상품조회: ['상품조회', '상품상세', '제품조회', 'productview'],
  장바구니조회: ['장바구니조회', '장바구니', 'cart'],
  주문서작성: ['주문서작성', '주문서', 'checkout'],
  주문완료: ['주문완료', '구매완료', 'order'],
  // 스마트스토어
  유입수: ['유입수', '유입', '방문'],
  주문건수: ['주문건수', '결제건수', '건수'],
  매출: ['매출', '결제금액', '금액'],
  // 월 목표
  채널: ['채널', '몰', 'channel'],
  연월: ['연월', '월', 'ym', 'month'],
  순매출목표: ['순매출목표', '목표', 'target', 'net'],
};

const norm = (s) => String(s == null ? '' : s).replace(/[\s()\-._/]/g, '').toLowerCase();
function findKey(row, names) {
  const keys = Object.keys(row || {});
  for (const n of names) { const k = keys.find((x) => norm(x).includes(norm(n))); if (k) return k; }
  return null;
}
const toNum = (v) => {
  const s = String(v == null ? '' : v).replace(/[^0-9.\-]/g, '').trim();
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
function toDate(v) {
  if (v instanceof Date) {
    const d = new Date(v.getTime() - v.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{4})[-./년\s]*(\d{1,2})[-./월\s]*(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
}

// 워크시트 → 객체 배열(1행 헤더). 2행이 설명줄이면 자동으로 건너뛴다.
function sheetRows(ws) {
  if (!ws) return [];
  const out = [];
  let header = null;
  ws.eachRow((row, i) => {
    const vals = [];
    row.eachCell({ includeEmpty: true }, (c, n) => { vals[n - 1] = c.value && c.value.text != null ? c.value.text : c.value; });
    if (!header) { header = vals.map((v) => String(v == null ? '' : v).trim()); return; }
    const o = {};
    header.forEach((h, n) => { if (h) o[h] = vals[n]; });
    out.push(o);
  });
  return out;
}

/**
 * 월목표 채널 칸 → 저장 대상.
 *   자사몰·스마트스토어 = 채널 목표(targets.cafe24 / smartstore), 그 외 이름 = 외부 몰별 목표(targets.byMall.<몰 이름>).
 *   ⚠ 예전엔 "스토어"가 없으면 전부 자사몰로 읽어서, 외부 몰 이름(쿠팡 등)을 적으면 자사몰 목표를 덮어썼다(2026-10-01 수정).
 *   몰 이름은 이카운트 거래처명 그대로 저장한다(띄어쓰기 포함) — 실적과 잇는 쪽(dailyMail)은 띄어쓰기를 무시하고 맞춘다.
 */
function targetChannel(raw) {
  const name = String(raw == null ? '' : raw).trim();
  const s = name.replace(/\s/g, '').toLowerCase();
  if (!s) return null;
  if (s.includes('자사몰') || s === '홈페이지' || /cafe24|카페24/.test(s)) return { channel: '자사몰' };
  if (s.includes('스마트스토어') || s === '스토어' || s === 'smartstore') return { channel: '스마트스토어' };
  return { channel: '외부몰', mall: name };
}

/** 파싱 — { mall[], store[], targets[], warnings[] } */
async function parse(input) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(input)) await wb.xlsx.load(input);
  else await wb.xlsx.readFile(input);

  const pick = (re) => wb.worksheets.find((w) => re.test(String(w.name).replace(/\s/g, '')));
  const wsMall = pick(/자사몰|퍼널|mall/i) || wb.worksheets[0];
  const wsStore = pick(/스토어|스마트|store/i);
  const wsTgt = pick(/목표|target/i);

  const warnings = [];
  const mall = [];
  for (const r of sheetRows(wsMall)) {
    const kd = findKey(r, H.date);
    const date = kd ? toDate(r[kd]) : null;
    if (!date) continue;
    const g = (names) => { const k = findKey(r, names); return k ? toNum(r[k]) : null; };
    const row = { date, 상품조회: g(H.상품조회), 장바구니조회: g(H.장바구니조회), 주문서작성: g(H.주문서작성) };
    const v = g(H.방문시작), d = g(H.주문완료);
    if (v != null) row.이프두_방문시작 = v;
    if (d != null) row.이프두_주문완료 = d;
    if (row.상품조회 == null && row.장바구니조회 == null && row.주문서작성 == null) continue; // 빈 행
    mall.push(row);
  }

  const store = [];
  for (const r of sheetRows(wsStore)) {
    const kd = findKey(r, H.date);
    const date = kd ? toDate(r[kd]) : null;
    if (!date) continue;
    const g = (names) => { const k = findKey(r, names); return k ? toNum(r[k]) : null; };
    const row = { date, 주문건수: g(H.주문건수) };
    const inf = g(H.유입수), amt = g(H.매출);
    if (inf != null) row.파일_유입수 = inf;
    if (amt != null) row.파일_매출 = amt;
    if (row.주문건수 == null && inf == null && amt == null) continue;
    store.push(row);
  }

  // 같은 채널·연월이 여러 번 있으면 **아래(나중) 행이 이긴다** — 저장 결과와 미리보기가 같도록 여기서 한 줄로 합친다.
  //   (DB 쪽도 채널·연월당 값 하나를 덮어쓰므로, 여러 번 등록하면 가장 나중에 등록한 값이 남는다)
  const byKey = new Map();
  for (const r of sheetRows(wsTgt)) {
    const kc = findKey(r, H.채널), ky = findKey(r, H.연월), kt = findKey(r, H.순매출목표);
    if (!kc || !ky || !kt) continue;
    const tc = targetChannel(r[kc]);
    const ym = String(r[ky] || '').trim().replace(/[./]/g, '-').slice(0, 7);
    const net = toNum(r[kt]);
    // 목표 칸이 비어 있으면 그 줄은 건너뛴다 — 양식에 몰 이름이 미리 채워져 있어도 넣은 줄만 반영된다(빈 칸 = 기존 값 그대로)
    if (!tc || !/^\d{4}-\d{2}$/.test(ym) || net == null) continue;
    const t = { ...tc, ym, net };
    const label = t.mall || t.channel;
    const k = `${t.channel}|${(t.mall || '').replace(/\s/g, '')}|${t.ym}`;
    if (byKey.has(k)) warnings.push(`월목표 ${t.ym} ${label}: 같은 연월·채널이 여러 번 있어 아래(나중) 행 값 ${net.toLocaleString()}원으로 반영합니다`);
    byKey.set(k, t);
  }
  const targets = [...byKey.values()];

  // 목표만 올리는 경우(월목표 전용 양식)엔 퍼널 시트가 없는 게 정상이라 경고하지 않는다.
  const targetsOnly = !!targets.length && !mall.length && !store.length;
  if (!targetsOnly) {
    if (!wsStore) warnings.push('"스마트스토어" 시트를 찾지 못했습니다 — 자사몰 퍼널만 반영합니다.');
    if (!wsTgt) warnings.push('"월목표" 시트를 찾지 못했습니다 — 목표는 변경되지 않습니다.');
  }
  if (!mall.length && !store.length && !targets.length) warnings.push('읽어들인 데이터가 없습니다. 일자 컬럼과 값이 있는지 확인해 주세요.');

  return { mall, store, targets, warnings };
}

const MALL_COLS = [
  ['일자', 'YYYY-MM-DD', 13],
  ['방문시작', '이프두 값 — 대조용(저장 안 함)', 14],
  ['상품조회', '★ 필수 입력', 12],
  ['장바구니조회', '★ 필수 입력', 14],
  ['주문서작성', '★ 필수 입력', 13],
  ['주문완료', '이프두 값 — 대조용(저장 안 함)', 12],
];
const STORE_COLS = [
  ['일자', 'YYYY-MM-DD', 13],
  ['유입수', '대조용(저장 안 함)', 12],
  ['주문건수', '★ 입력 — 파일 기준', 12],
  ['매출', '대조용(저장 안 함)', 14],
];
const TGT_COLS = [['채널', '자사몰 / 스마트스토어 / 외부 몰 이름', 30], ['연월', 'YYYY-MM', 11], ['순매출목표', '★ 원 단위 숫자 — 여기에 입력', 22]];
// 월 목표 전용 양식의 참고 칸 — 읽지 않는다(목표 정할 때 보라고 붙인 숫자)
const TGT_REF_COLS = [['구분', '참고', 12], ['최근 3개월 월평균 매출', '참고 · 이카운트 순매출', 22], ['지난달 매출', '참고 · 이카운트 순매출', 16]];

/**
 * 예제 양식.
 *   기본: 자사몰퍼널 · 스마트스토어 · 월목표 3시트.
 *   only='targets': 월 목표만 — "전사 월 목표 등록"에서 퍼널 컬럼까지 보여주면 혼란스럽다.
 */
async function template(opts) {
  const only = opts && opts.only;
  if (only === 'targets') return targetTemplate(opts);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Yogibo 판매분석';
  const mk = (name, cols, samples) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map(([k, , w]) => ({ key: k, width: w }));
    ws.addRow(Object.fromEntries(cols.map(([k]) => [k, k])));
    ws.addRow(Object.fromEntries(cols.map(([k, d]) => [k, d])));
    samples.forEach((s) => ws.addRow(s));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
    ws.getRow(2).font = { italic: true, size: 9, color: { argb: 'FF888888' } };
    ws.views = [{ state: 'frozen', ySplit: 2 }];
    return ws;
  };
  mk('자사몰퍼널', MALL_COLS, [
    { 일자: '2026-08-27', 방문시작: 712, 상품조회: 451, 장바구니조회: 31, 주문서작성: 29, 주문완료: 14 },
    { 일자: '2026-08-28', 방문시작: 689, 상품조회: 438, 장바구니조회: 28, 주문서작성: 26, 주문완료: 12 },
  ]);
  mk('스마트스토어', STORE_COLS, [
    { 일자: '2026-08-27', 유입수: 402, 주문건수: 13, 매출: 2180000 },
  ]);
  // 월목표 시트는 비워 둔다 — 예시 값을 채워 두면 퍼널 데이터만 올리려던 MD가 그대로 올려 목표가 예시 값으로 덮인다
  //   (2026-09-30 16:00 퍼널 업로드에 예시 "자사몰 10월 1.25억 · 스마트스토어 10월 5,800만"이 같이 저장됨). 목표는 🎯 목표 설정 양식으로.
  mk('월목표', TGT_COLS, []);

  const g = wb.addWorksheet('작성안내');
  g.columns = [{ width: 104 }];
  [
    '일일 퍼널 점검 — 데이터 등록 안내',
    '',
    '■ 무엇을 올리나요',
    '  이프두에서만 얻을 수 있는 3개 단계만 채워주시면 됩니다.',
    '    · 상품조회 · 장바구니조회 · 주문서작성',
    '  방문시작 · 주문완료 · 순매출 · 스토어 유입수/매출은 시스템이 매일 자동으로 가져옵니다. 비워두셔도 됩니다.',
    '',
    '■ 왜 방문시작·주문완료 칸이 있나요',
    '  이프두에서 받은 표를 컬럼 지우지 말고 그대로 붙여넣으시라고 열어둔 칸입니다.',
    '  넣으시면 시스템 값과 자동으로 대조해서 차이를 보여드립니다(저장은 하지 않습니다).',
    '  실측상 이프두 방문시작은 시스템 값의 약 0.90배이고, 날에 따라 ±20%까지 벌어집니다.',
    '  차이가 계속 커지면 목표 산출 기준을 다시 맞춰야 한다는 신호입니다.',
    '',
    '■ 올리는 방법',
    '  1) 이 양식을 받아 "자사몰퍼널" 시트에 날짜별로 채웁니다(이프두 표 붙여넣기).',
    '  2) 업로드하면 신규 / 수정 / 변동없음 건수와 대조 결과를 먼저 보여드립니다.',
    '  3) 확인 후 [이대로 반영하기]를 누르면 저장됩니다. 잘못 올렸으면 [되돌리기].',
    '',
    '■ 저장 방식',
    '  파일에 있는 날짜만 덮어씁니다. 지난 데이터는 그대로 남습니다.',
    '  이번 주치만 올리셔도 되고, 밀린 날짜를 한 번에 올리셔도 됩니다.',
    '',
    '■ 월목표 시트',
    '  목표를 바꿀 때만 채우세요. 비워 두시면 기존 목표를 그대로 씁니다(퍼널 데이터만 올릴 때는 비워 두세요).',
    '  넣으시면 매출보고가 쓰는 월 목표가 함께 갱신됩니다. 몰별 목표까지 넣으려면 🎯 목표 설정의 양식(몰 이름이 미리 채워짐)을 쓰세요.',
    '',
    '■ 편하게 하셔도 되는 것',
    '  · 컬럼 순서가 달라도 됩니다 — 이름으로 읽습니다.',
    '  · 필요 없는 컬럼이 더 있어도 무시합니다.',
    '  · 2행(회색 설명줄)은 지우셔도, 그대로 두셔도 됩니다.',
    '  · 날짜는 2026-08-27 / 2026.08.27 / 2026년 8월 27일 모두 인식합니다.',
  ].forEach((t) => g.addRow([t]));
  g.getRow(1).font = { bold: true, size: 13 };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * 월 목표 전용 양식 — 채널 × 연월 × 순매출목표. 매출보고가 쓰는 targets 와 같은 값이다.
 *   opts.rows 가 오면(서버가 funnelIngest.templateRows 로 만든 것) 자사몰·스마트스토어 + 지금 운영 중인 외부 몰을
 *   미리 채운 양식 — MD는 노란 칸(순매출목표)만 채우면 된다. 이미 등록된 목표는 값이 들어가 있다.
 *   opts.rows 가 없으면 예전 예시 4줄.
 */
async function targetTemplate(opts) {
  const rows = (opts && opts.rows) || null;
  const ym = (opts && opts.ym) || '2026-10';
  const cols = rows ? [...TGT_COLS, ...TGT_REF_COLS] : TGT_COLS;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Yogibo 판매분석';
  const ws = wb.addWorksheet('월목표');
  ws.columns = cols.map(([k, , w]) => ({ key: k, width: w }));
  ws.addRow(Object.fromEntries(cols.map(([k]) => [k, k])));
  ws.addRow(Object.fromEntries(cols.map(([k, d]) => [k, d])));
  (rows || [
    { 채널: '자사몰', 연월: '2026-10', 순매출목표: 125000000 },
    { 채널: '스마트스토어', 연월: '2026-10', 순매출목표: 58000000 },
    { 채널: '자사몰', 연월: '2026-11', 순매출목표: 130000000 },
    { 채널: '스마트스토어', 연월: '2026-11', 순매출목표: 60000000 },
  ]).forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
  ws.getRow(2).font = { italic: true, size: 9, color: { argb: 'FF888888' } };
  ws.views = [{ state: 'frozen', ySplit: 2 }];
  // 입력 칸은 노랑, 참고 칸은 회색 글씨 · 숫자는 천 단위 콤마
  const last = ws.rowCount;
  for (let i = 3; i <= last; i++) {
    const row = ws.getRow(i);
    const c = row.getCell('순매출목표');
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4C2' } };
    c.numFmt = '#,##0';
    if (rows) for (const [k] of TGT_REF_COLS) { const rc = row.getCell(k); rc.font = { color: { argb: 'FF777777' } }; rc.numFmt = '#,##0'; }
    // 채널 목표(자사몰·스마트스토어)와 외부 몰 사이 구분선
    if (rows && rows[i - 3] && rows[i - 3].구분 === '채널 목표' && rows[i - 2] && rows[i - 2].구분 !== '채널 목표') {
      row.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } };
    }
  }

  const g = wb.addWorksheet('작성안내');
  g.columns = [{ width: 110 }];
  [
    '전사 월 목표 등록 — 작성 안내',
    '',
    '■ 이렇게 하시면 됩니다',
    `  "월목표" 시트에 ${ym} 기준으로 자사몰 · 스마트스토어 · 지금 운영 중인 외부 몰(최근 3개월 매출이 있는 곳)이 미리 들어 있습니다.`,
    '  노란 칸(순매출목표)에 목표 금액만 넣고 그대로 올리시면 됩니다. 이미 등록된 목표는 값이 채워져 있으니 바꿀 곳만 고치세요.',
    '  목표를 정하지 않을 몰은 노란 칸을 비워 두세요 — 빈 줄은 반영하지 않습니다(기존 값 그대로).',
    '  옆의 "최근 3개월 월평균 매출 · 지난달 매출"은 목표를 정할 때 참고하라고 붙인 숫자입니다(읽지 않습니다).',
    '',
    '■ 무엇에 쓰이나요',
    '  자사몰·스마트스토어 — 매출보고·대시보드의 월 목표가 됩니다. 일일 퍼널 점검의 단계별 목표도 이 값에서 역산합니다.',
    '  외부 몰 — 일일 모니터링 메일 "온라인 몰별 목표 대비"와 매출보고 외부채널 목표(몰별 합계)에 쓰입니다.',
    '',
    '■ 작성법',
    '  · 채널 — 자사몰 / 스마트스토어 / 외부 몰 이름(이카운트 거래처명 그대로 — 미리 채워진 이름을 쓰세요)',
    '  · 연월 — 2026-10 형식 (2026.10, 2026/10 도 인식합니다). 다음 달 목표는 연월만 바꿔서 올리면 됩니다.',
    '  · 순매출목표 — 원 단위 숫자. 125000000 처럼 적습니다(콤마 넣으셔도 됩니다).',
    '  같은 연월·채널을 여러 번 적으면 아래(나중) 줄이 반영됩니다.',
    '',
    '■ 저장 방식',
    '  파일에 있는 연월·채널만 덮어씁니다. 적지 않은 달·몰은 그대로 남습니다.',
    '  올리기 전에 "이전 → 변경" 을 먼저 보여드리고, 잘못 올리셨으면 되돌리기가 됩니다.',
    '',
    '■ 기준',
    '  순매출 = 취소·반품이 빠진 금액(이카운트 출고 기준)입니다. 공동구매는 목표·합계에서 제외됩니다.',
  ].forEach((t) => g.addRow([t]));
  g.getRow(1).font = { bold: true, size: 13 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { parse, template, targetTemplate, targetChannel, MALL_COLS, STORE_COLS, TGT_COLS };
