'use strict';

// ── 포맷터 ──
const won = (n) => '₩' + Math.round(+n || 0).toLocaleString('ko-KR');
const num = (n) => (+n || 0).toLocaleString('ko-KR');
const pct = (n) => ((+n || 0) * 100).toFixed(1) + '%';
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const el = (id) => document.getElementById(id);

function yesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return d; }
function rangeFor(key) {
  const y = yesterday();
  if (key === 'today') { const t = new Date(); return [ymd(t), ymd(t)]; }
  if (key === 'yesterday') return [ymd(y), ymd(y)];
  if (key === '7d') { const s = new Date(y); s.setDate(s.getDate() - 6); return [ymd(s), ymd(y)]; }
  if (key === '30d') { const s = new Date(y); s.setDate(s.getDate() - 29); return [ymd(s), ymd(y)]; }
  if (key === 'month') { const t = new Date(); return [ymd(new Date(t.getFullYear(), t.getMonth(), 1)), ymd(y)]; }
  return [ymd(y), ymd(y)];
}

// 상단 토픽바 / 통합비교 / 스마트스토어 날짜 입력을 한 값으로 동기화 (헷갈림 방지)
function syncDateInputs(s, e) {
  if (!s || !e) return;
  for (const id of ['start', 'cmpStart', 'ssStart']) { const x = el(id); if (x) x.value = s; }
  for (const id of ['end', 'cmpEnd', 'ssEnd']) { const x = el(id); if (x) x.value = e; }
}
// 날짜 입력을 수동 변경(change)해도 즉시 다른 곳에 반영
function wireDateMirror(sId, eId) {
  const sx = el(sId), ex = el(eId);
  const mirror = () => syncDateInputs((el(sId) || {}).value, (el(eId) || {}).value);
  if (sx) sx.addEventListener('change', mirror);
  if (ex) ex.addEventListener('change', mirror);
}

let lastData = null;

// ── 전역 로딩 스피너 — 400ms 넘는 fetch에만 상단 "불러오는 중…" 표시(빠른 요청은 깜빡임 방지) ──
let _inflight = 0, _spinTimer = null;
function _spinUpdate() {
  if (_inflight > 0) {
    if (!_spinTimer && !document.body.classList.contains('spinning')) {
      _spinTimer = setTimeout(() => { document.body.classList.add('spinning'); _spinTimer = null; }, 400);
    }
  } else {
    if (_spinTimer) { clearTimeout(_spinTimer); _spinTimer = null; }
    document.body.classList.remove('spinning');
  }
}
(function () {
  const _fetch = window.fetch.bind(window);
  window.fetch = function (...args) {
    _inflight++; _spinUpdate();
    return _fetch(...args).finally(() => { _inflight = Math.max(0, _inflight - 1); _spinUpdate(); });
  };
})();

// ── 범용 상세 드릴다운 모달 ──
const ae = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// 클릭 시 상세 드릴다운을 여는 셀 버튼 (스마트스토어 detail kind/value)
const dlink = (kind, value, text) => `<button class="linklike" data-dk="${kind}" data-dv="${ae(value)}" data-dl="${ae(text != null ? text : value)}">${text != null ? text : value} ▸</button>`;
function openDetailModal(titleHtml, bodyHtml) {
  el('dmTitle').innerHTML = titleHtml; el('dmBody').innerHTML = bodyHtml;
  el('detailModal').style.display = 'flex';
  document.body.style.overflow = 'hidden'; // 팝업 열림 동안 배경 스크롤 잠금
}
function closeDetailModal() { el('detailModal').style.display = 'none'; document.body.style.overflow = ''; }
function initDetailModal() {
  if (initDetailModal._done) return; initDetailModal._done = true;
  el('dmClose').addEventListener('click', closeDetailModal);
  el('detailModal').addEventListener('click', (ev) => { if (ev.target.id === 'detailModal') closeDetailModal(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeDetailModal(); });
}
// 스마트스토어: (kind,value) 조건의 주문·상품 상세를 모달로
async function openSSDetail(kind, value, label) {
  const s = el('ssStart').value, e = el('ssEnd').value;
  openDetailModal(label || '상세', '<div class="empty">상세 불러오는 중…</div>');
  try {
    const j = await (await fetch(`/api/smartstore/detail?kind=${enc(kind)}&value=${enc(value)}&start=${s}&end=${e}`)).json();
    if (!j.ok) throw new Error(j.error);
    // ── 상품 집계: 상품명=좌측/줄바꿈/2줄클램프(+title 전체명), 등급=가운데 태그, 주문/수량/매출=우측 ──
    const prodRows = (j.products || []).map((r) => `
      <tr>
        <td class="c-prod"><div class="pname" title="${ae(r.name)}">${ae(r.name)}</div></td>
        <td class="c-mid"><span class="tag">${ae(r.tier)}</span></td>
        <td class="c-num">${num(r.orders)}</td>
        <td class="c-num">${num(r.qty)}<span class="muted" style="font-weight:500">개</span></td>
        <td class="c-num">${won(r.sales)}</td>
      </tr>`).join('');
    const prodTbl = (j.products && j.products.length)
      ? `<div class="tablewrap"><table><thead><tr>
          <th class="c-prod">상품</th><th class="c-mid">등급</th>
          <th class="c-num">주문</th><th class="c-num">수량</th><th class="c-num">매출</th>
        </tr></thead><tbody>${prodRows}</tbody></table></div>`
      : '<div class="empty">상품 없음</div>';
    // ── 주문 목록: 주문일=1줄고정, 구매상품=좌측/줄바꿈(결제·기기·유입·쿠폰을 아래 칩 메타로 통합), 매출=우측 ──
    const ordRows = (j.orders || []).map((r) => {
      const names = (r.products || []).map(ae).join(', ') || '<span class="muted">상품 정보 없음</span>';
      const meta = [];
      if (r.means) meta.push(`<span class="m"><b>결제</b> ${ae(r.means)}</span>`);
      if (r.inflow) meta.push(`<span class="m"><b>유입</b> ${ae(r.inflow)}</span>`);
      if (r.device) meta.push(`<span class="m"><b>기기</b> ${ae(r.device)}</span>`);
      (r.coupons || []).forEach((c) => meta.push(`<span class="m cpn">🎟 ${ae(c)}</span>`));
      const metaHtml = meta.length ? `<div class="ordmeta">${meta.join('')}</div>` : '';
      return `
      <tr>
        <td class="c-date">${ae(r.order_date)}</td>
        <td class="c-prod"><div class="pname" style="-webkit-line-clamp:3">${names}</div>${metaHtml}</td>
        <td class="c-num amt">${won(r.sales)}</td>
      </tr>`;
    }).join('');
    const ordTbl = (j.orders && j.orders.length)
      ? `<div class="tablewrap"><table><thead><tr>
          <th class="c-date">주문일</th><th class="c-prod">구매 상품 · 결제/유입/쿠폰</th><th class="c-num">매출</th>
        </tr></thead><tbody>${ordRows}</tbody></table></div>`
      : '<div class="empty">주문 없음</div>';
    openDetailModal(`${ae(label)} <span class="muted" style="font-size:13px;font-weight:500">· 주문 ${num(j.orderCount)}건 · 매출 ${won(j.totalSales)} · 수량 ${num(j.totalQty)}개</span>`,
      `<div class="dmcols ssdetail">
        <div><h4>📦 상품 집계 <span class="muted">상위 ${(j.products || []).length}</span></h4>${prodTbl}</div>
        <div><h4>🧾 주문 목록 <span class="muted">상위 ${(j.orders || []).length}</span></h4>${ordTbl}</div>
      </div>`);
  } catch (err) { el('dmBody').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}

// ── 데이터 로드 ──
async function load(force, funnel) {
  const start = el('start').value, end = el('end').value;
  if (!start || !end) return;
  syncDateInputs(start, end);
  setStatus(funnel ? '쿠폰 집계 중… (1~2분 소요될 수 있어요)' : '불러오는 중…', '');
  document.body.classList.add('loading');
  try {
    const url = `/api/overview?start=${start}&end=${end}${force ? '&force=1' : ''}${funnel ? '&funnel=1' : ''}`;
    const r = await fetch(url);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '실패');
    lastData = j;
    render(j);
    const cache = j._cache && j._cache.hit ? `캐시 (${new Date(j._cache.computedAt).toLocaleString('ko-KR')} 집계)` : `라이브 집계 ${j.elapsedMs}ms`;
    setStatus(`${start} ~ ${end} · 주문 ${num(j.ordersCount)}건 · ${cache}`, 'ok');
  } catch (e) {
    // '지금 집계'(funnel) 실패는 친절하게 — 라이브 쿠폰 스캔은 토큰/타임아웃에 민감. 0시 자동 집계로 반영됨을 안내.
    if (funnel) setStatus('쿠폰 즉시 집계를 못 했어요(서버 인증 만료/지연 등) — 0시 자동 집계 후 반영되며, ‘어제’ 이전 구간은 바로 조회됩니다.', 'err');
    else setStatus('오류: ' + e.message, 'err');
  } finally {
    document.body.classList.remove('loading');
  }
}
function setStatus(msg, cls) { el('status').innerHTML = `<span class="${cls}">${msg}</span>`; }

// ── 렌더 ──
function render(d) {
  renderKpis(d);
  renderInflow(d.inflow);
  renderMembers(d.members);
  renderPromo(d.productPromo, d.funnel);
}

function renderKpis(d) {
  const t = d.inflow.totals, m = d.members.total, f = d.funnel.totals;
  const dp = d.directPromo || { sales: 0, orders: 0, directDiscount: 0 };
  const funnelPending = d.funnel && d.funnel.pending; // 아직 워밍 안 된 구간 → 쿠폰 집계 준비중
  const cards = [
    { label: '방문수', val: num(t.visits), sub: `신규 ${pct(t.newRatio)} · 일평균 ${num(t.avgDaily)}`, cls: 'accent', act: 'tab:inflow' },
    { label: '총 매출', val: won(m.revenue), sub: `결제 ${num(m.paidOrders)}건 · 객단가 ${won(m.aov)} · 클릭=카테고리×등급`, cls: 'green', act: 'sales' },
    { label: '회원 매출비중', val: pct(m.memberRevenueShare), sub: `회원주문 ${pct(m.memberOrderShare)}`, act: 'tab:members' },
    { label: '프로모션 구매(다이렉트)', val: won(dp.sales), sub: `주문 ${num(dp.orders)} · 기간할인 ${won(dp.directDiscount)}`, cls: 'pink', act: 'tab:buyers' },
    { label: '쿠폰 사용(프로모션)',
      val: funnelPending ? '집계 전' : num(f.used),
      sub: funnelPending
        ? '쿠폰 집계는 매일 0시 자동 (오늘분은 익일 반영) · <button id="funnelNow" class="linklike" data-stop="1">지금 집계 ▸</button>'
        : `발급 ${num(f.issued)} · 사용률 ${pct(f.useRate)} · 매출 ${won(f.revenue)}`,
      cls: 'pink', act: funnelPending ? '' : 'tab:buyers' },
  ];
  el('kpis').innerHTML = cards.map((c) =>
    `<div class="kpi clickable ${c.cls || ''}" data-act="${c.act}"><div class="label">${c.label}</div><div class="val num">${c.val}</div><div class="sub">${c.sub}</div></div>`).join('');
  el('kpis').querySelectorAll('.kpi[data-act]').forEach((k) =>
    k.addEventListener('click', () => {
      const a = k.dataset.act;
      if (a === 'sales') toggleSalesBreakdown();
      else if (a.startsWith('tab:')) document.querySelector(`.tab[data-tab="${a.slice(4)}"]`).click();
    }));
  // '지금 집계' — 무거운 쿠폰 funnel 을 이 구간에 대해 즉시 스캔(1~2분). 카드 클릭 이벤트와 분리.
  const fn = el('funnelNow');
  if (fn) fn.addEventListener('click', (ev) => { ev.stopPropagation(); load(true, true); });
}

// 총매출 → 카테고리 × 등급(스탠다드/프리미엄/프리미엄플러스) 분해
let salesOpen = false;
function toggleSalesBreakdown() {
  salesOpen = !salesOpen;
  const box = el('kpiDetail');
  if (!salesOpen) { box.innerHTML = ''; return; }
  const b = lastData && lastData.salesBreakdown;
  if (!b) { box.innerHTML = '<div class="empty">분해 데이터 없음 — ↻ 갱신 후 다시 시도</div>'; return; }
  const T = b.TIERS || ['스탠다드', '프리미엄', '프리미엄플러스', '기타'];
  const cell = (tobj, t) => `${won(tobj[t].sales)}<br><span class="muted" style="font-size:11px">${num(tobj[t].qty)}개</span>`;
  box.innerHTML = `
  <div class="card">
    <h3>충전재(비즈)별 판매 비중 <span class="hint">총 ${num(b.grandQty)}개 · 매출 ${won(b.grand)} · 등급 클릭 시 판매 제품</span></h3>
    ${tableHtml(['충전재 등급', '판매수량', '수량비중', '매출', '매출비중'], b.tiers,
      (x) => [x.qty ? `<button class="linklike" data-tier="${enc(x.tier)}">${x.tier} ▸</button>` : x.tier,
        num(x.qty)+'개', pct(x.qtyShare), won(x.sales), pct(x.share)])}
    <div id="fillerDetail" style="margin-top:12px"></div>
    <div class="insightline">💡 충전재 등급: 스탠다드(기본) / 프리미엄 / 프리미엄플러스 / 기타(커버·비즈 등). 예) "맥스"=스탠다드, "맥스 프리미엄"=프리미엄</div>
  </div>
  <div class="card" style="margin-top:16px">
    <h3>카테고리 × 충전재 <span class="hint">매출(수량)</span></h3>
    ${tableHtml(['카테고리', ...T, '합계', '비중'], b.rows,
      (r) => [r.cat, ...T.map((t) => cell(r.tiers, t)), won(r.total), pct(r.share)])}
  </div>`;
  box.querySelectorAll('button[data-tier]').forEach((btn) =>
    btn.addEventListener('click', () => loadTierProducts(decodeURIComponent(btn.dataset.tier))));
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 충전재 등급 클릭 → 그 등급의 판매 제품 상세 (제품라인 무관 전체)
async function loadTierProducts(tier) {
  openDetailModal(`${ae(tier)} 판매 제품`, '<div class="empty">판매 제품 불러오는 중…</div>');
  const s = (lastData && lastData.start) || el('start').value, e = (lastData && lastData.end) || el('end').value;
  try {
    const j = await (await fetch(`/api/line-tier?tier=${enc(tier)}&start=${s}&end=${e}`)).json();
    if (!j.ok) throw new Error(j.error);
    el('dmTitle').innerHTML = `${ae(tier)} 판매 제품 <span class="muted" style="font-size:13px;font-weight:500">· ${num(j.count)}종</span>`;
    el('dmBody').innerHTML = `${tableHtml(['판매 제품', '매출', '수량', '주문'], j.rows, (r) => [r.product_name, won(r.sales), num(r.qty), num(r.orders)])}`;
  } catch (err) { el('dmBody').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}

// 라벨 정리: 'YYYY-MM-DD' → 'MM-DD', 그 외(요일 등)는 그대로
function shortLabel(v) { const s = String(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(5, 10) : s; }
// 막대 추이 (단일 시리즈) — 막대 많으면 라벨 솎아냄
function barsHtml(rows, valKey, labelKey) {
  if (!rows.length) return '<div class="empty">데이터 없음</div>';
  const max = Math.max(1, ...rows.map((r) => r[valKey]));
  const step = Math.ceil(rows.length / 16); // 최대 ~16개 라벨만 표시
  const bars = rows.map((r) => `<div class="bar" style="height:${(r[valKey] / max * 100).toFixed(1)}%" title="${shortLabel(r[labelKey])}: ${num(r[valKey])}"></div>`).join('');
  const labels = rows.map((r, i) => `<span>${i % step === 0 ? shortLabel(r[labelKey]) : ''}</span>`).join('');
  return `<div class="bars">${bars}</div><div class="barlabels">${labels}</div>`;
}

// 누적막대 추이 (2시리즈)
function stackHtml(rows, k1, k2, c1, c2) {
  if (!rows.length) return '<div class="empty">데이터 없음</div>';
  const max = Math.max(1, ...rows.map((r) => (r[k1] || 0) + (r[k2] || 0)));
  const cols = rows.map((r) => {
    const h1 = ((r[k1] || 0) / max * 100).toFixed(1), h2 = ((r[k2] || 0) / max * 100).toFixed(1);
    return `<div class="col" title="${r.date}\n회원 ${won(r[k1])}\n비회원 ${won(r[k2])}">
      <div class="bar ${c2}" style="height:${h2}%"></div><div class="bar ${c1}" style="height:${h1}%"></div></div>`;
  }).join('');
  const labels = rows.map((r) => `<span>${String(r.date).slice(5)}</span>`).join('');
  return `<div class="bars stack">${cols}</div><div class="barlabels">${labels}</div>`;
}

function tableHtml(cols, rows, rowFn) {
  if (!rows.length) return '<div class="empty">데이터 없음</div>';
  const head = '<tr>' + cols.map((c) => `<th>${c}</th>`).join('') + '</tr>';
  const body = rows.map(rowFn).map((cells) => '<tr>' + cells.map((v, i) => `<td class="${i ? 'num' : ''}">${v}</td>`).join('') + '</tr>').join('');
  return `<div class="tablewrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function renderInflow(f) {
  const t = f.totals;
  el('tab-inflow').innerHTML = `
    <div class="grid two">
      <div class="card">
        <h3>일별 방문수 추이 <span class="hint">${f.daily.length}일 · 총 ${num(t.visits)}</span></h3>
        ${barsHtml(f.daily, 'visits', 'date')}
        <div class="legend"><span><i style="background:var(--accent)"></i>방문수</span>
          <span>일평균 ${num(t.avgDaily)}</span></div>
      </div>
      <div class="card">
        <h3>디바이스 · 신규/재방문</h3>
        ${splitHtml([['PC', t.pcVisits, 'var(--accent)'], ['모바일', t.mobileVisits, 'var(--accent2)']])}
        <div style="height:10px"></div>
        ${splitHtml([['신규방문', t.newVisits, 'var(--pink)'], ['재방문', t.reVisits, 'var(--warn)']])}
      </div>
    </div>`;
}

function splitHtml(parts) {
  const total = parts.reduce((a, p) => a + (p[1] || 0), 0) || 1;
  const segs = parts.map((p) => {
    const w = (p[1] / total * 100);
    return w < 1 ? '' : `<div class="seg" style="width:${w}%;background:${p[2]}" title="${p[0]} ${num(p[1])}">${w > 8 ? p[0] + ' ' + pct(p[1] / total) : ''}</div>`;
  }).join('');
  return `<div class="splitbar">${segs}</div>
    <div class="legend">${parts.map((p) => `<span><i style="background:${p[2]}"></i>${p[0]} ${num(p[1])}</span>`).join('')}</div>`;
}

function renderMembers(m) {
  const mk = (title, g, cls) => `
    <div class="card">
      <h3>${title}</h3>
      <div class="grid two" style="gap:10px">
        <div><div class="muted">매출</div><div class="val num" style="font-size:22px;font-weight:700">${won(g.revenue)}</div></div>
        <div><div class="muted">객단가</div><div class="val num" style="font-size:22px;font-weight:700">${won(g.aov)}</div></div>
        <div><div class="muted">주문 / 결제</div><div class="num">${num(g.orders)} / ${num(g.paidOrders)}</div></div>
        <div><div class="muted">신규주문 / 쿠폰할인</div><div class="num">${num(g.firstOrders)} / ${won(g.couponDiscount)}</div></div>
        <div><div class="muted">적립금 사용</div><div class="num">${won(g.pointsUsed)} <span class="muted" style="font-size:11px">(${num(g.pointsOrders)}건)</span></div></div>
      </div>
    </div>`;
  el('tab-members').innerHTML = `
    <div class="card">
      <h3>회원 vs 비회원 매출 비중 <span class="hint">총 ${won(m.total.revenue)} · 결제 ${num(m.total.paidOrders)}건 · 적립금 사용 ${won(m.total.pointsUsed)}(${num(m.total.pointsOrders)}건)</span></h3>
      ${splitHtml([['회원', m.member.revenue, 'var(--accent)'], ['비회원', m.guest.revenue, 'var(--muted)']])}
    </div>
    <div class="grid two" style="margin-top:16px">
      ${mk('회원 (member_id 보유)', m.member, 'accent')}
      ${mk('비회원 (게스트 주문)', m.guest, '')}
    </div>
    <div class="card" style="margin-top:16px">
      <h3>일별 회원/비회원 매출 추이</h3>
      ${stackHtml(m.daily, 'memberRevenue', 'guestRevenue', '', 'b2')}
      <div class="legend"><span><i style="background:var(--accent)"></i>회원</span><span><i style="background:var(--accent2)"></i>비회원</span></div>
    </div>`;
}

function renderPromo(pp, funnel) {
  el('tab-promo').innerHTML = `
    <div class="card">
      <h3>상품별 프로모션 성과 <span class="hint">실거래 기준(쿠폰 적용된 주문 아이템) · 상위 ${pp.products.length} / ${pp.productCount}종</span></h3>
      ${tableHtml(['상품', '주문', '수량', '쿠폰매출', '쿠폰할인', '할인율'], pp.products,
        (r) => [r.product_name, num(r.orders), num(r.quantity), won(r.sales), won(r.discount), pct(r.discountRate)])}
    </div>
    <div class="card" style="margin-top:16px">
      <h3>쿠폰별 발급 → 사용 깔때기 <span class="hint">기간 내 발급 코호트 · 스캔 ${funnel.scanned}개 중 ${funnel.coupons.length}개 발급 · 총 ${num(funnel.totals.issued)}발급→${num(funnel.totals.used)}사용(${pct(funnel.totals.useRate)})</span></h3>
      ${tableHtml(['쿠폰', '타깃', '혜택', '발급', '사용', '사용률', '연결매출'], funnel.coupons,
        (r) => [r.coupon_name, `<span class="tag">${r.target.label}</span>`, r.benefit.text, num(r.issued), num(r.used), pct(r.useRate), won(r.revenue)])}
    </div>`;
}

function shorten(u) { try { const x = new URL(u, 'https://yogibo.kr'); return (x.pathname + x.search).slice(0, 60); } catch (_) { return String(u).slice(0, 60); } }

// ── 이벤트 ──
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  el('tab-' + b.dataset.tab).classList.add('active');
}));
document.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  if (b.dataset.range === 'promo') { applyCurrentMonthPromo(); return; }
  const [s, e] = rangeFor(b.dataset.range);
  el('start').value = s; el('end').value = e;
  load(false);
}));
// 🎯 프로모션 기간 칩 — 이번 달(또는 오늘이 포함된) 등록 전사 프로모션 기간만 조회
async function applyCurrentMonthPromo() {
  const t = new Date(); const ym = `${t.getFullYear()}-${pad(t.getMonth() + 1)}`; const today = ymd(t);
  setStatus(`${ym} 전사 프로모션 기간 조회 중…`, '');
  try {
    const j = await (await fetch('/api/promo-periods/list')).json();
    const items = (j.ok && j.items) || [];
    let promo = items.find((r) => r.month === ym)
      || items.find((r) => r.start <= today && r.end >= today)
      || items.filter((r) => r.start <= today).sort((a, b) => (a.start < b.start ? 1 : -1))[0];
    if (!promo) { setStatus(`${ym} 등록된 전사 프로모션이 없습니다 — ⚙ 설정에서 먼저 등록하세요`, 'err'); return; }
    el('start').value = promo.start; el('end').value = promo.end;
    load(false);
    setStatus(`🎯 프로모션 기간: ${promo.name} (${promo.start} ~ ${promo.end})`, 'ok');
  } catch (e) { setStatus('프로모션 조회 오류: ' + e.message, 'err'); }
}
el('apply').addEventListener('click', () => { document.querySelectorAll('.chip').forEach((x) => x.classList.remove('active')); load(false); });
el('refresh').addEventListener('click', () => load(true));
wireDateMirror('start', 'end');

// 오늘 재취합: 오늘 주문(Cafe24+스마트스토어) 적재 후 현재 구간만 빠르게 갱신(쿠폰 funnel 은 캐시 유지).
//  최근 1주일 전체 동기화는 매일 00시 자동 스케줄러가 담당.
el('refreshWeek').addEventListener('click', async () => {
  const btn = el('refreshWeek');
  btn.disabled = true;
  setStatus('오늘 주문 재취합 중… (Cafe24·스마트스토어 적재)', '');
  document.body.classList.add('loading');
  try {
    const r = await fetch('/api/sync-today');
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '실패');
    // 적재 후 현재 선택 구간을 캐시 무시하고 다시 불러오기 (주문 반영, funnel 은 캐시)
    await load(true);
    setStatus(`오늘 재취합 완료 (${j.day}) · ${j.elapsedMs}ms — 현재 구간 갱신됨`, 'ok');
  } catch (e) {
    setStatus('재취합 오류: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    document.body.classList.remove('loading');
  }
});

// ══════════════════════════════════════════════
//  ④ 프로모션 구매고객  /  ⑤ 고객 세그먼트
// ══════════════════════════════════════════════
function monthStart() { const t = new Date(); return ymd(new Date(t.getFullYear(), t.getMonth(), 1)); }
const enc = encodeURIComponent;

// ── ④ 프로모션 구매고객 (상품태그 / 쿠폰 토글) ──
let buyersInit = false;
let promoMode = 'tag'; // 'tag' | 'coupon'
function initBuyers() {
  if (buyersInit) return; buyersInit = true;
  el('tab-buyers').innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="panelctl">
        <div class="ranges">
          <button id="mTag" class="chip active">상품태그 프로모션</button>
          <button id="mCoupon" class="chip">쿠폰 프로모션</button>
        </div>
        <label>전사 프로모션 <select id="bPromo"><option value="">(기간 직접 선택)</option></select></label>
        <label>시작 <input type="date" id="bStart"></label>
        <label>종료 <input type="date" id="bEnd"></label>
        <button id="bLoad" class="btn">조회</button>
        <button id="bIngest" class="btn ghost" title="주문 거울(orders_raw) 최신화">⟲ 주문 거울 갱신</button>
        <span id="bStatus" class="muted" style="font-size:12px"></span>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px">상품태그 = 상품명 <code>[클리어런스]</code>·<code>[공동구매]</code> 등으로 묶은 프로모션 (기간할인 포함) · 쿠폰 = 다운로드→구매</div>
    </div>
    <div id="bResult"></div>
    <div id="bBuyers" style="margin-top:16px"></div>`;
  el('bStart').value = monthStart(); el('bEnd').value = rangeFor('yesterday')[1];
  el('bLoad').addEventListener('click', loadBuyers);
  el('bIngest').addEventListener('click', runIngest);
  el('mTag').addEventListener('click', () => { promoMode = 'tag'; el('mTag').classList.add('active'); el('mCoupon').classList.remove('active'); loadBuyers(); });
  el('mCoupon').addEventListener('click', () => { promoMode = 'coupon'; el('mCoupon').classList.add('active'); el('mTag').classList.remove('active'); loadBuyers(); });
  el('bPromo').addEventListener('change', () => {
    const o = el('bPromo').selectedOptions[0]; if (o && o.dataset.start) { el('bStart').value = o.dataset.start; el('bEnd').value = o.dataset.end; loadBuyers(); }
  });
  loadBuyersPromos();
}
async function loadBuyersPromos() {
  try {
    const j = await (await fetch('/api/promo-periods/list')).json();
    const items = (j.ok && j.items) || [];
    el('bPromo').innerHTML = '<option value="">(기간 직접 선택)</option>' +
      items.map((r) => `<option value="${r.month}" data-start="${r.start}" data-end="${r.end}">${r.name} (${r.start}~${r.end})</option>`).join('');
    // 1차: 그달(현재 월) 전사 프로모션 자동 선택
    const cm = monthStart().slice(0, 7);
    const opt = [...el('bPromo').options].find((o) => o.value === cm);
    if (opt) { el('bPromo').value = cm; el('bStart').value = opt.dataset.start; el('bEnd').value = opt.dataset.end; }
  } catch (_) {}
  loadBuyers();
}
async function runIngest() {
  const btn = el('bIngest'); btn.disabled = true;
  el('bStatus').textContent = '주문 거울 적재 중… (1년, 수십 초)';
  try {
    const j = await (await fetch('/api/ingest?months=12')).json();
    if (!j.ok) throw new Error(j.error);
    el('bStatus').textContent = `거울 갱신 완료: ${num(j.count)}건 (${j.from}~${j.to})`;
    loadBuyers();
  } catch (e) { el('bStatus').textContent = '오류: ' + e.message; }
  finally { btn.disabled = false; }
}
function loadBuyers() { return promoMode === 'tag' ? loadTagPromos() : loadCouponPromos(); }

const kpiCard = (l, v, sub, cls) => `<div class="kpi ${cls||''}"><div class="label">${l}</div><div class="val num">${v}</div><div class="sub">${sub}</div></div>`;

// 상품태그 프로모션 ([클리어런스]/[공동구매]...) — 집계
async function loadTagPromos() {
  const s = el('bStart').value, e = el('bEnd').value;
  el('bResult').innerHTML = '<div class="empty">불러오는 중…</div>'; el('bBuyers').innerHTML = '';
  try {
    const j = await (await fetch(`/api/tag-promotions?start=${s}&end=${e}`)).json();
    if (!j.ok) throw new Error(j.error);
    const t = j.totals;
    el('bResult').innerHTML = `
      <section class="kpis" style="padding:0 0 14px">
        ${kpiCard('프로모션 태그', num(t.tags)+'개', `${s} ~ ${e}`, 'accent')}
        ${kpiCard('태그 매출 합', won(t.sales), `수량 ${num(t.qty)} · 주문 ${num(t.orders)}`, 'green')}
        ${kpiCard('기간할인 합', won(t.directDiscount), '상품 직접할인', 'pink')}
        ${kpiCard('쿠폰할인 합', won(t.couponDiscount), '태그상품 내', '')}
      </section>
      <div class="card"><h3>상품태그별 프로모션 매출 <span class="hint">행 클릭 시 상품별·일별 상세 · 다중태그 상품은 각 태그에 귀속</span>
        <a class="btn mini" href="/api/tag-promotions.csv?start=${s}&end=${e}">⤓ CSV</a></h3>
      ${tableHtml(['프로모션 태그', '매출', '수량', '주문', '기간할인', '쿠폰할인', '총할인', '상품'], j.tags,
        (r) => [`<button class="linklike" data-tag="${encodeURIComponent(r.tag)}">[${r.tag}]</button>`, won(r.sales), num(r.qty), num(r.orders),
          won(r.directDiscount), won(r.couponDiscount), won(r.totalDiscount), num(r.productCount)+'종'])}
      </div>`;
    el('bResult').querySelectorAll('button[data-tag]').forEach((b) =>
      b.addEventListener('click', () => loadTagDetail(decodeURIComponent(b.dataset.tag), s, e)));
  } catch (err) { el('bResult').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}
async function loadTagDetail(tag, s, e) {
  openDetailModal(`[${ae(tag)}] 프로모션 상세`, '<div class="empty">상세 불러오는 중…</div>');
  try {
    const [j, jb] = await Promise.all([
      (await fetch(`/api/tag-detail?tag=${enc(tag)}&start=${s}&end=${e}`)).json(),
      (await fetch(`/api/tag-buyers?tag=${enc(tag)}&start=${s}&end=${e}`)).json(),
    ]);
    if (!j.ok) throw new Error(j.error);
    const csv = `/api/tag-buyers.csv?tag=${enc(tag)}&start=${s}&end=${e}`;
    el('dmTitle').innerHTML = `[${ae(tag)}] 프로모션 상세 <span class="muted" style="font-size:13px;font-weight:500">· 매출 ${won(j.sales)} · 주문 ${num(j.orders)}</span>`;
    el('dmBody').innerHTML = `
      <div class="grid two">
        <div class="card"><h3>[${tag}] 일별 매출 <span class="hint">매출 ${won(j.sales)} · 주문 ${num(j.orders)} · 수량 ${num(j.qty)} · 기간할인 ${won(j.directDiscount)}</span></h3>
          ${barsHtml(j.daily, 'sales', 'date')}</div>
        <div class="card"><h3>[${tag}] 상품별 매출 <span class="hint">${j.products.length}종</span></h3>
          ${tableHtml(['상품', '매출', '수량', '주문'], j.products, (r) => [r.name, won(r.sales), num(r.qty), num(r.orders)])}</div>
      </div>
      <div class="card" style="margin-top:16px"><h3>[${tag}] 구매 고객 <span class="hint">${jb.ok?num(jb.count):0}명</span><a class="btn mini" href="${csv}">⤓ CSV</a></h3>
        ${jb.ok ? tableHtml(['이름', '연락처', '이메일', '가입일', '가입개월', '등급', '구분', '구매액', '구매상품'], jb.rows,
          (r) => [r.name||'-', r.cellphone||'-', r.email||'-', r.created_date||'-', r.tenureMonths!=null?r.tenureMonths:'-',
            r.group_no, `<span class="tag ${r.isNew?'tag-new':''}">${r.segment}</span>`, won(r.amount), (r.products||[]).slice(0,3).join(', ')]) : '<div class="empty">고객 정보를 불러오지 못했습니다</div>'}
      </div>`;
  } catch (err) { el('dmBody').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}

// 쿠폰 프로모션 (다운로드→구매, 집계)
let couponCache = [];
async function loadCouponPromos() {
  const s = el('bStart').value, e = el('bEnd').value;
  el('bResult').innerHTML = '<div class="empty">불러오는 중…</div>'; el('bBuyers').innerHTML = '';
  try {
    const j = await (await fetch(`/api/promotions?start=${s}&end=${e}`)).json();
    if (!j.ok) throw new Error(j.error);
    couponCache = j.coupons;
    const t = j.totals; const promo = j.promo || { byRate: [], revenue: 0, share: 0 };
    el('bResult').innerHTML = `
      <section class="kpis" style="padding:0 0 14px">
        ${kpiCard('다운로드', num(t.downloaded), `활성 쿠폰 ${j.coupons.length}개`, 'accent')}
        ${kpiCard('사용(구매)', num(t.purchased), `사용률 ${pct(t.purchaseRate)}`, 'green')}
        ${kpiCard('전사 프로모션 매출', won(promo.revenue), `%쿠폰 사용 · 전체쿠폰의 ${pct(promo.share)}`, 'pink')}
        ${kpiCard('쿠폰 연결 매출', won(t.revenue), `${s} ~ ${e}`, '')}
      </section>
      <div class="card"><h3>🎯 전사 프로모션 성과 (할인율 %별) <span class="hint">그달 고객이 사용한 % 쿠폰으로 유추 · ${s} ~ ${e}</span></h3>
        ${promo.byRate.length ? tableHtml(['할인율', '쿠폰수', '다운로드', '구매(고객)', '구매율', '매출', '객단가', '주요 상품 Top3'], promo.byRate,
          (r) => [`<strong>${r.rate}%</strong>`, num(r.coupons), num(r.downloaded), num(r.purchased),
            pct(r.downloaded ? r.purchased/r.downloaded : 0), won(r.revenue), won(r.aov),
            (r.topProducts||[]).map((p)=>`${p.name}(${num(p.qty)})`).join(', ')]) : '<div class="empty">이 기간 %할인 프로모션 쿠폰 사용 없음</div>'}
      </div>
      <div class="card" style="margin-top:16px"><h3>쿠폰별 다운로드 → 사용 → 매출 <span class="hint">행 클릭 시 구매 상품(집계)</span></h3>
      ${tableHtml(['쿠폰', '타깃', '혜택', '다운로드', '사용', '사용률', '신규/기존', '매출', '상품'], j.coupons,
        (r, i) => [`<button class="linklike" data-i="${i}">${r.coupon_name}</button>`, `<span class="tag">${r.target.label}</span>`, r.benefit.text, num(r.downloaded), num(r.purchased),
          pct(r.purchaseRate), `${num(r.newBuyers)}/${num(r.returningBuyers)}`, won(r.revenue), num(r.productCount)+'종'])}
      </div>`;
    el('bResult').querySelectorAll('button[data-i]').forEach((b) =>
      b.addEventListener('click', () => showCouponProducts(+b.dataset.i)));
  } catch (err) { el('bResult').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}
async function showCouponProducts(i) {
  const c = couponCache[i]; if (!c) return;
  const s = el('bStart').value, e = el('bEnd').value;
  const csv = `/api/coupon-buyers.csv?coupon_no=${enc(c.coupon_no)}&start=${s}&end=${e}`;
  openDetailModal(`${ae(c.coupon_name)} <span class="muted" style="font-size:13px;font-weight:500">· 사용 ${num(c.purchased)} · 매출 ${won(c.revenue)}</span>`,
    `<div class="card">
      <h3>구매 상품 <span class="hint">사용 ${num(c.purchased)} · 매출 ${won(c.revenue)}</span></h3>
      ${tableHtml(['상품', '매출', '수량', '구매수'], c.products, (r) => [r.name, won(r.amount), num(r.qty), num(r.buyers)])}
      </div>
      <div class="card" style="margin-top:16px" id="cpnBuyers"><div class="empty">쿠폰 사용 고객 불러오는 중…</div></div>`);
  try {
    const jb = await (await fetch(`/api/coupon-buyers?coupon_no=${enc(c.coupon_no)}&start=${s}&end=${e}`)).json();
    const cb = el('cpnBuyers'); if (!cb) return;
    cb.innerHTML = `<h3>쿠폰 사용 고객 <span class="hint">${jb.ok?num(jb.count):0}명</span><a class="btn mini" href="${csv}">⤓ CSV</a></h3>
      ${jb.ok ? tableHtml(['이름', '연락처', '이메일', '가입일', '가입개월', '등급', '구분', '구매액', '구매상품'], jb.rows,
        (r) => [r.name||'-', r.cellphone||'-', r.email||'-', r.created_date||'-', r.tenureMonths!=null?r.tenureMonths:'-',
          r.group_no, `<span class="tag ${r.isNew?'tag-new':''}">${r.segment}</span>`, won(r.amount), (r.products||[]).slice(0,3).join(', ')]) : '<div class="empty">-</div>'}`;
  } catch (err) { const cb = el('cpnBuyers'); if (cb) cb.innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}
async function loadCouponBuyers(cpn, s, e) {
  openDetailModal('쿠폰 구매 고객 명단', '<div class="empty">구매 고객 명단 불러오는 중…</div>');
  try {
    const j = await (await fetch(`/api/coupon-buyers?coupon_no=${enc(cpn)}&start=${s}&end=${e}`)).json();
    if (!j.ok) throw new Error(j.error);
    const csv = `/api/coupon-buyers.csv?coupon_no=${enc(cpn)}&start=${s}&end=${e}`;
    el('dmTitle').innerHTML = `쿠폰 구매 고객 명단 <span class="muted" style="font-size:13px;font-weight:500">· ${num(j.count)}명</span>`;
    el('dmBody').innerHTML = `<div class="card">
      <h3>구매 고객 명단 <span class="hint">${num(j.count)}명</span>
        <a class="btn mini" href="${csv}">⤓ CSV</a></h3>
      ${tableHtml(['이름', '연락처', '이메일', '가입일', '가입개월', '등급', '구분', '구매액', '구매상품'], j.rows,
        (r) => [r.name||'-', r.cellphone||'-', r.email||'-', r.created_date||'-', r.tenureMonths!=null?r.tenureMonths:'-',
          r.group_no, `<span class="tag ${r.isNew?'tag-new':''}">${r.segment}</span>`, won(r.amount), (r.products||[]).slice(0,3).join(', ')])}
    </div>`;
  } catch (err) { el('dmBody').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}

// ── ⑤ 적립금 · 쿠폰 ──
let segInit = false;
function initSegment() {
  if (segInit) return; segInit = true;
  el('tab-segment').innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="panelctl">
        <label>시작 <input type="date" id="pStart"></label>
        <label>종료 <input type="date" id="pEnd"></label>
        <button id="pLoad" class="btn">조회</button>
        <button id="pCpnSync" class="btn ghost" title="이 기간에 사용된 쿠폰명을 주문별로 적재(드릴다운 '사용 쿠폰' 표시용)">⤓ 쿠폰명 적재</button>
        <span id="pCpnMsg" class="muted" style="font-size:12px">orders_raw 기준 · 결제완료 주문 · 주문 단위 쿠폰/적립금 사용</span>
      </div>
    </div>
    <div id="pResult"></div>`;
  el('pStart').value = monthStart(); el('pEnd').value = rangeFor('yesterday')[1];
  el('pLoad').addEventListener('click', loadBenefit);
  el('pCpnSync').addEventListener('click', async () => {
    const s = el('pStart').value, e = el('pEnd').value;
    const msg = el('pCpnMsg'); msg.textContent = '쿠폰명 적재 중… (기간 길면 수십 초)';
    try {
      const r = await (await fetch(`/api/sync-coupon-names?start=${s}&end=${e}`)).json();
      if (!r.ok) throw new Error(r.error);
      msg.textContent = `✓ 쿠폰 ${num(r.scanned)}종 스캔 · 주문 ${num(r.mappedOrders)}건에 쿠폰명 매핑됨. 구분 클릭 시 '사용 쿠폰' 표시`;
    } catch (err) { msg.textContent = `적재 오류: ${err.message}`; }
  });
  loadBenefit();
}
async function loadBenefit() {
  const s = el('pStart').value, e = el('pEnd').value;
  el('pResult').innerHTML = '<div class="empty">분석 중…</div>';
  try {
    const bf = await (await fetch(`/api/benefit?start=${s}&end=${e}`)).json();
    if (!bf.ok) throw new Error(bf.error);
    el('pResult').innerHTML = `
      <section class="kpis" style="padding:0 0 14px">
        ${kpiCard('적립금 사용 주문', num(bf.pointOrders), `전체의 ${pct(bf.pointRatio)}`, 'pink')}
        ${kpiCard('적립금 사용액', won(bf.pointSum), `${num(bf.pointOrders)}건`, 'pink')}
        ${kpiCard('쿠폰 사용 주문', num(bf.couponOrders), `전체의 ${pct(bf.couponRatio)}`, 'accent')}
        ${kpiCard('쿠폰 할인액', won(bf.couponSum), `${num(bf.couponOrders)}건`, 'accent')}
      </section>
      <div class="card"><h3>적립금 · 쿠폰 사용 분류 <span class="hint">구분 클릭 시 주문별 상품·사용액 · 전체 ${num(bf.total)}주문${bf.groupBuyExcluded?` (공동구매 ${num(bf.groupBuyExcluded)}건 제외)`:''}</span></h3>
        ${tableHtml(['구분', '주문수', '비중', '매출', '쿠폰할인', '적립금 사용'], bf.rows,
          (r) => [`<button class="linklike" data-type="${r.type}">${r.key} ▸</button>`, num(r.orders), pct(bf.total ? r.orders/bf.total : 0), won(r.revenue), won(r.coupon), won(r.points)])}
        <div id="bfDetail" style="margin-top:12px"></div>
        <div class="insightline">💡 적립금 사용 주문 <strong>${num(bf.pointOrders)}건(${pct(bf.pointRatio)})</strong> · 쿠폰 사용 <strong>${num(bf.couponOrders)}건(${pct(bf.couponRatio)})</strong> — 구분을 클릭하면 그 주문들의 상품·사용액이 나옵니다</div>
      </div>`;
    el('pResult').querySelectorAll('button[data-type]').forEach((b) => b.addEventListener('click', () => loadBenefitOrders(b.dataset.type, s, e)));
  } catch (err) { el('pResult').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}
// ── ⑥ 공동구매 ──
let gbInit = false;
function initGroupbuy() {
  if (gbInit) return; gbInit = true;
  el('tab-groupbuy').innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="panelctl">
        <label>시작 <input type="date" id="gbStart"></label>
        <label>종료 <input type="date" id="gbEnd"></label>
        <button id="gbLoad" class="btn">조회</button>
        <span class="muted" style="font-size:12px">상품명에 [공동구매] 포함 주문 = 공동구매 건 (Cafe24)</span>
      </div>
    </div>
    <div id="gbResult"></div>`;
  el('gbStart').value = monthStart(); el('gbEnd').value = rangeFor('yesterday')[1];
  el('gbLoad').addEventListener('click', loadGroupbuy);
  loadGroupbuy();
}
async function loadGroupbuy() {
  const s = el('gbStart').value, e = el('gbEnd').value;
  el('gbResult').innerHTML = '<div class="empty">분석 중…</div>';
  try {
    const gb = await (await fetch(`/api/groupbuy?start=${s}&end=${e}`)).json();
    if (!gb.ok) throw new Error(gb.error);
    el('gbResult').innerHTML = `
      <section class="kpis" style="padding:0 0 14px">
        ${kpiCard('공동구매 주문', num(gb.orders), `${s} ~ ${e}`, 'green')}
        ${kpiCard('공동구매 매출', won(gb.sales), `수량 ${num(gb.qty)} · ${gb.productCount}종`, 'green')}
        ${kpiCard('객단가', won(gb.aov), `구매 고객 ${num(gb.members)}`, 'accent')}
        ${kpiCard('신규 주문', num(gb.newOrders), '첫 구매', 'pink')}
      </section>
      <div class="card"><h3>🤝 공동구매 상품별 성과 <span class="hint">상품명 [공동구매] 기준 · ${gb.productCount}종</span></h3>
        ${gb.products.length ? tableHtml(['상품', '주문', '수량', '매출'], gb.products, (r) => [r.name, num(r.orders), num(r.qty), won(r.sales)]) : '<div class="empty">이 기간 공동구매 주문 없음</div>'}
      </div>`;
  } catch (err) { el('gbResult').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}
async function loadBenefitOrders(type, s, e) {
  openDetailModal('적립금·쿠폰 주문 상세', '<div class="empty">주문 상세 불러오는 중…</div>');
  try {
    const j = await (await fetch(`/api/benefit-orders?type=${enc(type)}&start=${s}&end=${e}`)).json();
    if (!j.ok) throw new Error(j.error);
    const showCpn = (type === 'both' || type === 'couponOnly');
    const cols = showCpn
      ? ['주문일', '고객', '구매 상품', '사용 쿠폰', '결제액', '쿠폰할인', '적립금']
      : ['주문일', '고객', '구매 상품', '결제액', '쿠폰할인', '적립금'];
    const cpnCell = (r) => { const cs = r.coupons || []; return cs.length ? cs.map((n) => `<span class="tag">${n}</span>`).join(' ') : '<span class="muted">미상</span>'; };
    el('dmTitle').innerHTML = `${ae(j.label)} <span class="muted" style="font-size:13px;font-weight:500">· 주문 ${num(j.count)}건</span>`;
    el('dmBody').innerHTML = `<div class="insightline" style="border-left-color:var(--pink)">구매상품 · ${showCpn ? '사용 쿠폰 · ' : ''}쿠폰/적립금 사용액${showCpn ? ' <span class="muted" style="font-size:11px">(쿠폰명은 order_coupons 적재분 기준 — "미상"은 ⚙에서 쿠폰명 적재 필요)</span>' : ''}</div>
      ${tableHtml(cols, j.rows,
        (r) => showCpn
          ? [r.order_date, r.name || (r.member_id ? r.member_id : '-'), (r.products || []).join(', '), cpnCell(r), won(r.payment_amount), won(r.coupon_discount), won(r.points_used)]
          : [r.order_date, r.name || (r.member_id ? r.member_id : '-'), (r.products || []).join(', '), won(r.payment_amount), won(r.coupon_discount), won(r.points_used)])}`;
  } catch (err) { el('dmBody').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}

// ── ⑥ 상품 분석 ──
let prodInit = false;
function initProduct() {
  if (prodInit) return; prodInit = true;
  el('tab-product').innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="panelctl">
        <label>시작 <input type="date" id="paStart"></label>
        <label>종료 <input type="date" id="paEnd"></label>
        <button id="paLoad" class="btn">조회</button>
        <span class="muted" style="font-size:12px">orders_raw 기준 · CVR=구매건수/전체방문</span>
      </div>
    </div>
    <div id="paResult"></div>`;
  el('paStart').value = monthStart(); el('paEnd').value = rangeFor('yesterday')[1];
  el('paLoad').addEventListener('click', loadProduct);
  loadProduct();
}
function distTable(title, rows, labelKey, hint) {
  return `<div class="card"><h3>${title} <span class="hint">${hint||''}</span></h3>
    ${tableHtml([labelKey, '수량', '비중', '매출'], rows, (r) => [r[Object.keys(r)[0]], num(r.qty)+'개', pct(r.share||0), won(r.sales)])}</div>`;
}
async function loadProduct() {
  const s = el('paStart').value, e = el('paEnd').value;
  el('paResult').innerHTML = '<div class="empty">분석 중…</div>';
  try {
    const j = await (await fetch(`/api/product-analysis?start=${s}&end=${e}`)).json();
    if (!j.ok) throw new Error(j.error);
    const k = j.kpis;
    const kc = (l, v, sub, cls) => `<div class="kpi ${cls||''}"><div class="label">${l}</div><div class="val num">${v}</div><div class="sub">${sub}</div></div>`;
    el('paResult').innerHTML = `
      <section class="kpis" style="padding:0 0 14px">
        ${kc('구매 건수', num(k.orders), `${s} ~ ${e}`, 'accent')}
        ${kc('소파 / 바디필로우', num(k.sofaQty)+' / '+num(k.bodyQty), `총 ${num(k.totalQty)}개`, '')}
        ${kc('세트 구매', num(k.setOrders), `복수상품 ${pct(k.setRatio)}`, 'green')}
        ${kc('커버 동시구매', num(k.coverAttachOrders), `${pct(k.coverAttachRatio)}`, 'pink')}
        ${kc('객단가', won(k.aov), `매출 ${won(k.revenue)}`, '')}
        ${kc('전환율(CVR)', pct(k.cvr), `방문 ${num(k.visits)}`, 'green')}
        ${kc('적립금 사용', won(k.pointsUsed), `${num(k.pointsOrders)}건 사용`, 'pink')}
      </section>
      <div class="grid two">
        ${distTable('카테고리 분포', j.categoryDist, '카테고리', '판매수량 기준')}
        ${distTable('충전재(비즈)별 비중', j.fillerDist, '충전재 등급', '스탠다드/프리미엄/프리미엄플러스/기타')}
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card"><h3>제품 TOP <span class="hint">상위 ${j.productTop.length}</span></h3>
          ${tableHtml(['제품', '등급', '수량', '비중', '매출'], j.productTop,
            (r) => [r.name, `<span class="tag">${r.tier}</span>`, num(r.qty)+'개', pct(r.share), won(r.sales)])}</div>
        <div class="card"><h3>인기 색상 <span class="hint">상위 ${j.colorTop.length}</span></h3>
          ${tableHtml(['색상', '수량', '매출'], j.colorTop, (r) => [r.color, num(r.qty)+'개', won(r.sales)])}</div>
      </div>
      <div class="card" style="margin-top:16px"><h3>요일별 패턴 <span class="hint">주문수</span></h3>
        ${barsHtml(j.weekday.map((w) => ({ label: w.label, orders: w.orders })), 'orders', 'label')}
        <div class="legend">${j.weekday.map((w) => `<span>${w.label} ${num(w.orders)}건</span>`).join(' · ')}</div></div>`;
  } catch (err) { el('paResult').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}

// 탭 활성화 시 지연 초기화
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab === 'buyers') initBuyers();
  if (b.dataset.tab === 'segment') initSegment();
  if (b.dataset.tab === 'groupbuy') initGroupbuy();
  if (b.dataset.tab === 'product') initProduct();
  if (b.dataset.tab === 'bizpromote') initBizPromote();
}));

// ══════════════════════════════════════════════
//  채널 전환 (Cafe24 / 스마트스토어)
// ══════════════════════════════════════════════
let ssInit = false;
document.querySelectorAll('.chtab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.chtab').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  const ch = b.dataset.ch;
  el('view-cafe24').style.display = ch === 'cafe24' ? '' : 'none';
  el('view-smartstore').style.display = ch === 'smartstore' ? '' : 'none';
  el('view-compare').style.display = ch === 'compare' ? '' : 'none';
  // 헤더 컨트롤 바는 항상 노출 (목표·프로모션 설정은 공통). 날짜/갱신은 Cafe24 전용 동작.
  if (ch === 'smartstore') initSmartstore();
  if (ch === 'compare') initCompare();
}));

let ssData = null, ssTab = 'product', ssBreakOpen = false;
function initSmartstore() {
  if (ssInit) return; ssInit = true;
  el('ssMain').innerHTML = `
    <div id="ssTargetBar" style="margin:14px 0 0"></div>
    <div class="card" style="margin:14px 0">
      <div class="panelctl">
        <div class="ranges">
          <button id="ssMonthBtn" class="chip active">이번 달</button>
          <button id="ssYBtn" class="chip">어제</button>
        </div>
        <label>시작 <input type="date" id="ssStart"></label>
        <label>종료 <input type="date" id="ssEnd"></label>
        <button id="ssLoad" class="btn">조회</button>
        <button id="ssSync" class="btn warn" title="최근 7일 주문만 네이버 커머스 API로 재수집(월 단위보다 호출 적음)">⟲ 최근 7일 동기화(API)</button>
        <span id="ssStatus" class="muted" style="font-size:12px"></span>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px">smartstore_orders 기준 · 결제완료(대기/취소 제외) · 정산액·수수료·유입경로는 네이버 제공값</div>
    </div>
    <section class="kpis" id="ssKpis"></section>
    <div id="ssKpiDetail" style="padding:0 0 4px"></div>
    <nav class="tabs" id="ssTabs">
      <button class="tab" data-sstab="inflow">① 유입경로</button>
      <button class="tab active" data-sstab="product">② 상품 분석</button>
      <button class="tab" data-sstab="pattern">③ 구매 패턴</button>
      <button class="tab" data-sstab="discount">④ 할인 · 정산</button>
      <button class="tab" data-sstab="payment">⑤ 결제 · 혜택</button>
      <button class="tab" data-sstab="bizpromote">⑥ 비즈 유도</button>
    </nav>
    <div id="ssPanel"></div>`;
  el('ssStart').value = monthStart(); el('ssEnd').value = rangeFor('yesterday')[1]; // 활성 칩(이번 달)과 일치하는 기본 구간(데이터 있는 범위)
  el('ssLoad').addEventListener('click', loadSmartstore);
  wireDateMirror('ssStart', 'ssEnd');
  el('ssSync').addEventListener('click', syncSmartstore);
  el('ssMonthBtn').addEventListener('click', () => { el('ssStart').value = monthStart(); el('ssEnd').value = rangeFor('yesterday')[1]; loadSmartstore(); });
  el('ssYBtn').addEventListener('click', () => { const y = rangeFor('yesterday'); el('ssStart').value = y[0]; el('ssEnd').value = y[1]; loadSmartstore(); });
  el('ssTabs').querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    el('ssTabs').querySelectorAll('.tab').forEach((x) => x.classList.remove('active')); b.classList.add('active');
    ssTab = b.dataset.sstab; renderSSPanel();
  }));
  // 모든 카드/행 클릭 → 상세 드릴다운 (위임)
  initDetailModal();
  el('ssPanel').addEventListener('click', (ev) => {
    const card = ev.target.closest('.kpi[data-act^="detail:"]');
    if (card) { const a = card.dataset.act.split(':'); openSSDetail(a[1], a[2], card.querySelector('.label') ? card.querySelector('.label').textContent : a[1]); return; }
    const b = ev.target.closest('[data-dk]');
    if (b) { openSSDetail(b.dataset.dk, b.dataset.dv, b.dataset.dl || b.dataset.dv); }
  });
  loadSmartstore();
  loadTarget();
}
async function syncSmartstore() {
  const b = el('ssSync'); b.disabled = true;
  el('ssStatus').textContent = '네이버 커머스 API에서 최근 7일 수집 중… (변경주문→상세)';
  try {
    const j = await (await fetch('/api/smartstore/sync-week?days=7')).json();
    if (!j.ok) throw new Error(j.error);
    el('ssStatus').textContent = `수집 완료: ${j.from}~${j.to} · 변경 ${num(j.changed)} → 저장 ${num(j.stored)}건`;
    loadSmartstore();
  } catch (e) { el('ssStatus').textContent = '오류: ' + e.message; }
  finally { b.disabled = false; }
}
async function loadSmartstore() {
  const s = el('ssStart').value, e = el('ssEnd').value;
  syncDateInputs(s, e);
  el('ssPanel').innerHTML = '<div class="empty">분석 중…</div>'; el('ssKpiDetail').innerHTML = ''; ssBreakOpen = false;
  try {
    const j = await (await fetch(`/api/smartstore/analysis?start=${s}&end=${e}`)).json();
    if (!j.ok) throw new Error(j.error);
    ssData = j; renderSSKpis(); renderSSPanel();
  } catch (err) { el('ssPanel').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}
function ssKc(l, v, sub, cls, act) { return `<div class="kpi clickable ${cls||''}" data-act="${act||''}"><div class="label">${l}</div><div class="val num">${v}</div><div class="sub">${sub}</div></div>`; }
function renderSSKpis() {
  const k = ssData.kpis;
  const discRate = (k.revenue + k.discount) ? k.discount / (k.revenue + k.discount) : 0;
  el('ssKpis').innerHTML = [
    ssKc('매출(결제)', won(k.revenue), `주문 ${num(k.orders)} · 상품 ${num(k.lines)} · 클릭=충전재 분해`, 'green', 'break'),
    ssKc('정산액(예상)', won(k.settlement), `수수료 ${won(k.commission)} (${pct(k.commissionRate)})`, 'accent', 'tab:discount'),
    ssKc('객단가', won(k.aov), `수량 ${num(k.qty)}개`, '', ''),
    ssKc('소파 / 바디필로우', num(k.sofaQty) + ' / ' + num(k.bodyQty), `총 ${num(k.totalQty)}개`, 'pink', 'tab:product'),
    ssKc('할인', won(k.discount), `할인율 ${pct(discRate)}`, 'pink', 'tab:discount'),
  ].join('');
  el('ssKpis').querySelectorAll('.kpi[data-act]').forEach((kk) => kk.addEventListener('click', () => {
    const a = kk.dataset.act;
    if (a === 'break') toggleSSBreakdown();
    else if (a.startsWith('tab:')) { const t = a.slice(4); el('ssTabs').querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.sstab === t)); ssTab = t; renderSSPanel(); }
  }));
}
function renderSSPanel() {
  const j = ssData, p = el('ssPanel'); if (!j) return;
  if (ssTab === 'inflow') {
    p.innerHTML = `<div class="card"><h3>유입경로별 주문·매출 <span class="hint">네이버 제공 유입경로 · 상위 ${j.inflow.length} · 클릭 시 상세</span></h3>
      ${tableHtml(['유입경로', '주문', '매출', '비중'], j.inflow, (r) => [dlink('inflow', r.inflow), num(r.orders), won(r.sales), pct(j.kpis.revenue ? r.sales / j.kpis.revenue : 0)])}
      <div class="insightline">💡 스마트스토어는 사이트 방문수 통계가 별도라, 주문 단위 <strong>유입경로(검색/광고/장바구니 등)</strong>로 분석합니다. 방문수 API 제공 여부 확인 중 — 가능하면 추가합니다.</div></div>`;
  } else if (ssTab === 'product') {
    p.innerHTML = `
      <div class="grid two">
        <div class="card"><h3>카테고리 분포 <span class="hint">판매수량 · 클릭 시 상세</span></h3>
          ${tableHtml(['카테고리', '수량', '비중', '매출'], j.categoryDist, (r) => [dlink('category', r.cat), num(r.qty)+'개', pct(r.share||0), won(r.sales)])}</div>
        <div class="card"><h3>충전재(비즈)별 비중 <span class="hint">스탠다드/프리미엄/프리미엄플러스/기타 · 클릭 시 상세</span></h3>
          ${tableHtml(['충전재 등급', '수량', '비중', '매출'], j.fillerDist, (r) => [dlink('tier', r.tier), num(r.qty)+'개', pct(r.share||0), won(r.sales)])}</div>
      </div>
      <div class="grid two" style="margin-top:16px">
        <div class="card"><h3>제품 TOP <span class="hint">상위 ${j.productTop.length} · 클릭 시 상세</span></h3>
          ${tableHtml(['제품', '등급', '수량', '비중', '매출'], j.productTop, (r) => [dlink('product', r.name), `<span class="tag">${r.tier}</span>`, num(r.qty)+'개', pct(r.share), won(r.sales)])}</div>
        <div class="card"><h3>인기 색상 <span class="hint">상위 ${j.colorTop.length} · 클릭 시 상세</span></h3>
          ${tableHtml(['색상', '수량', '매출'], j.colorTop, (r) => [dlink('color', r.color), num(r.qty)+'개', won(r.sales)])}</div>
      </div>
      <div class="card" style="margin-top:16px"><h3>요일별 패턴 <span class="hint">주문수</span></h3>
        ${barsHtml(j.weekday.map((w) => ({ label: w.label, orders: w.orders })), 'orders', 'label')}
        <div class="legend">${j.weekday.map((w) => `<span>${w.label} ${num(w.orders)}</span>`).join(' · ')}</div></div>`;
  } else if (ssTab === 'pattern') {
    const cp = j.patterns.composition, ca = j.patterns.coverAttach;
    p.innerHTML = `
      <section class="kpis" style="padding:0 0 14px">
        ${ssKc('커버 동시구매율', pct(ca.attachRate), `본품주문 ${num(ca.mainOrders)} 중 ${num(ca.attachOrders)}건`, 'accent', 'detail:pattern:coverAttach')}
        ${ssKc('커버 단독구매', num(ca.coverOnlyOrders), '커버만 구매', 'pink', 'detail:pattern:coverOnly')}
        ${ssKc('단품 주문', num(cp.single.orders), pct(cp.single.ratio), '', 'detail:pattern:single')}
        ${ssKc('묶음(복수상품)', num(cp.multi.orders), `${pct(cp.multi.ratio)} · ${won(cp.multi.sales)}`, 'green', 'detail:pattern:multi')}
      </section>
      <div class="card"><h3>주문 구성 <span class="hint">단품 vs 묶음(복수상품) · 행 클릭 시 주문 상세</span></h3>
        ${tableHtml(['구분', '주문수', '매출', '비중'], [
          { k: '단품(1종)', kind: 'single', o: cp.single.orders, v: cp.single.sales, r: cp.single.ratio },
          { k: '묶음(2종+)', kind: 'multi', o: cp.multi.orders, v: cp.multi.sales, r: cp.multi.ratio },
        ], (x) => [dlink('pattern', x.kind, x.k), num(x.o), won(x.v), pct(x.r)])}</div>`;
  } else if (ssTab === 'discount') {
    const k = j.kpis; const discRate = (k.revenue + k.discount) ? k.discount / (k.revenue + k.discount) : 0;
    const de = j.discountEvents || [];
    p.innerHTML = `
      <section class="kpis" style="padding:0 0 14px">
        ${ssKc('총 할인', won(k.discount), `할인율 ${pct(discRate)}`, 'pink', '')}
        ${ssKc('정산액(예상)', won(k.settlement), '네이버 정산 예정액', 'accent', '')}
        ${ssKc('수수료', won(k.commission), `수수료율 ${pct(k.commissionRate)}`, '', '')}
        ${ssKc('매출(결제)', won(k.revenue), `주문 ${num(k.orders)}`, 'green', '')}
      </section>
      <div class="card"><h3>🎯 할인 이벤트 (즉시할인 진행 상품) <span class="hint">즉시할인이 적용된 상품 = 할인 이벤트 · ${de.length}종 · 클릭 시 상세</span></h3>
        ${de.length ? tableHtml(['상품', '등급', '주문', '수량', '매출', '할인액', '할인율'], de,
          (r) => [dlink('discountEvent', r.name), `<span class="tag">${r.tier}</span>`, num(r.orders), num(r.qty), won(r.sales), won(r.total), pct(r.discountRate)]) : '<div class="empty">이 기간 즉시할인 진행 상품 없음</div>'}</div>
      <div style="height:16px"></div>
      <div class="grid two">
        <div class="card"><h3>할인 유형별 <span class="hint">즉시할인 / 상품쿠폰 / 스토어쿠폰 / 배송</span></h3>
          ${tableHtml(['할인 유형', '금액', '비중'], (k.discountTypes||[]).filter((t)=>t.amount>0).length ? (k.discountTypes||[]) : [{type:'(없음)',amount:0}],
            (t) => [t.type, won(t.amount), pct(k.discount ? t.amount / k.discount : 0)])}</div>
        <div class="card"><h3>할인 · 정산 요약</h3>
          ${tableHtml(['항목', '금액'], [
            { k: '결제 매출', v: k.revenue }, { k: '총 할인', v: k.discount },
            { k: '수수료(결제+판매+채널)', v: k.commission }, { k: '예상 정산액', v: k.settlement },
          ], (x) => [x.k, won(x.v)])}</div>
      </div>
      <div class="card" style="margin-top:16px"><h3>적용 쿠폰 <span class="hint">쿠폰 적용 주문 ${num(k.couponOrders||0)}건 · 네이버는 쿠폰 마스터 API 미제공 → 주문에 적용된 쿠폰 집계</span></h3>
        ${(j.coupons && j.coupons.length) ? tableHtml(['쿠폰', '적용 주문', '할인액'], j.coupons, (c) => [dlink('coupon', c.name), num(c.orders), won(c.discount)]) : '<div class="empty">이 기간 적용된 쿠폰 정보 없음 (재수집 필요하거나 쿠폰 미사용)</div>'}
        <div class="insightline">💡 네이버 커머스 API는 쿠폰 발급/마스터 조회를 제공하지 않습니다(공식 확인). 대신 <strong>주문에 적용된 할인 유형·금액·쿠폰</strong>을 집계해 분석합니다. 방문수 통계도 API 미제공(셀러센터 비즈어드바이저 전용).</div></div>`;
  } else if (ssTab === 'payment') {
    p.innerHTML = '<div class="empty">결제·혜택 분석 중…</div>';
    loadSSPayment();
  } else if (ssTab === 'bizpromote') {
    p.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="panelctl">
          <label>본품 구매 후 <select id="ssBzMonths"><option value="3">3개월↑ 경과</option><option value="6">6개월↑ 경과</option><option value="12">12개월↑ 경과</option></select></label>
          <button id="ssBzLoad" class="btn">찾기</button>
          <a class="btn ghost" id="ssBzCsv" href="/api/smartstore/biz-promote.csv?months=3">⤓ CSV 다운로드</a>
          <span id="ssBzStatus" class="muted" style="font-size:12px"></span>
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px">본품(소파·바디필로우·메이트) 구매 후 N개월 경과 · <strong>리필(비즈) 미구매</strong> 주문자 = 리필 유도 대상. 네이버 주문자 <strong>이름·연락처</strong>가 제공되어 알림톡/직접연락 모두 가능합니다. <strong>과거 수집분엔 주문자 정보가 없어</strong> 정확한 집계를 위해 <strong>⟲ 최근 7일 동기화</strong> 또는 전체 재수집이 필요합니다.</div>
      </div>
      <div id="ssBzResult"><div class="empty">조건을 선택하고 <strong>찾기</strong>를 누르세요.</div></div>`;
    el('ssBzLoad').addEventListener('click', loadSSBizPromote);
    el('ssBzMonths').addEventListener('change', () => { const m = el('ssBzMonths').value; el('ssBzCsv').href = `/api/smartstore/biz-promote.csv?months=${m}`; el('ssBzResult').innerHTML = `<div class="empty">${m}개월↑ 조건으로 <strong>찾기</strong>를 눌러주세요.</div>`; });
  }
}
async function loadSSBizPromote() {
  const m = el('ssBzMonths').value;
  el('ssBzCsv').href = `/api/smartstore/biz-promote.csv?months=${m}`;
  el('ssBzResult').innerHTML = '<div class="empty">추출 중…</div>';
  try {
    const j = await (await fetch(`/api/smartstore/biz-promote?months=${m}`)).json();
    if (!j.ok) throw new Error(j.error);
    el('ssBzStatus').textContent = `${j.months}개월↑ · ${num(j.count)}명 · 주문자ID 적재율 ${pct(j.ordererCoverage)}`;
    const cov = j.ordererCoverage < 0.5
      ? `<div class="insightline" style="border-left-color:var(--pink)">⚠ 주문자ID 적재율이 낮습니다(${pct(j.ordererCoverage)}). 이 기능은 주문자ID가 필요해요 — <strong>⟲ 이번 달 동기화</strong> 또는 전체 재수집 후 정확해집니다. (이미 수집된 과거 주문엔 주문자ID가 없어 재수집 필요)</div>` : '';
    el('ssBzResult').innerHTML = `${cov}<div class="card">
      <h3>🟢 스마트스토어 비즈 유도 대상 <span class="hint">본품 구매 ${j.months}개월↑ 경과 · 리필 미구매 · ${num(j.count)}명</span>
        <a class="btn mini" href="/api/smartstore/biz-promote.csv?months=${m}">⤓ CSV</a></h3>
      ${tableHtml(['주문자ID', '이름', '연락처', '본품 구매일', '경과', '구매 본품'], j.rows,
        (r) => [r.orderer_id || '-', r.name || '-', r.tel || '-', r.mainDate || '-', r.monthsSince + '개월', (r.products || []).slice(0, 2).join(', ')])}
    </div>`;
  } catch (err) { el('ssBzResult').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}
async function loadSSPayment() {
  const s = el('ssStart').value, e = el('ssEnd').value;
  try {
    const j = await (await fetch(`/api/smartstore/payment?start=${s}&end=${e}`)).json();
    if (!j.ok) throw new Error(j.error);
    el('ssPanel').innerHTML = `
      <section class="kpis" style="padding:0 0 14px">
        ${ssKc('네이버 마일리지 사용', won(j.mileage.sum), `${num(j.mileage.orders)}건 (${pct(j.mileage.ratio)}) · 적립금 대응`, 'pink', '')}
        ${ssKc('네이버플러스 멤버십', num(j.membership.orders), `구매 ${pct(j.membership.ratio)}`, 'green', '')}
        ${ssKc('총 주문', num(j.total), `${s} ~ ${e}`, 'accent', '')}
        ${ssKc('충전금/후불', won(j.charge.sum), `후불 ${num(j.payLater.orders)}건`, '', '')}
      </section>
      <div class="grid two">
        <div class="card"><h3>결제수단별 <span class="hint">주문 단위 · 네이버페이 결제수단 · 클릭 시 상세</span></h3>
          ${tableHtml(['결제수단', '주문', '비중', '매출'], j.byMeans, (r) => [dlink('means', r.means), num(r.orders), pct(r.share), won(r.sales)])}</div>
        <div class="card"><h3>PC / 모바일 <span class="hint">payLocationType · 클릭 시 상세</span></h3>
          ${tableHtml(['디바이스', '주문', '비중', '매출'], j.byDevice, (r) => [dlink('device', r.device), num(r.orders), pct(r.share), won(r.sales)])}</div>
      </div>
      <div class="insightline">💡 네이버는 적립금 대신 <strong>네이버 마일리지(포인트)</strong>로 결제 — ${num(j.mileage.orders)}건에서 ${won(j.mileage.sum)} 사용. 결제수단(간편결제/카드)·디바이스·멤버십 비중은 스마트스토어 MD가 보는 핵심 지표입니다.</div>`;
  } catch (err) { el('ssPanel').innerHTML = `<div class="empty">오류: ${err.message} <br><span class="muted">결제 필드 재수집 중일 수 있습니다 — 잠시 후 다시 조회</span></div>`; }
}
// 충전재 분해 (Cafe24 총매출 분해와 동일 양식) — ssData.salesBreakdown
function toggleSSBreakdown() {
  ssBreakOpen = !ssBreakOpen; const box = el('ssKpiDetail');
  if (!ssBreakOpen || !ssData) { box.innerHTML = ''; return; }
  const b = ssData.salesBreakdown; const T = b.TIERS;
  const cell = (tobj, t) => `${won(tobj[t].sales)}<br><span class="muted" style="font-size:11px">${num(tobj[t].qty)}개</span>`;
  box.innerHTML = `
    <div class="card" style="margin:0 0 12px">
      <h3>충전재(비즈)별 판매 비중 <span class="hint">총 ${num(b.grandQty)}개 · 매출 ${won(b.grand)} · 등급 클릭 시 판매 제품</span></h3>
      ${tableHtml(['충전재 등급', '판매수량', '수량비중', '매출', '매출비중'], b.tiers,
        (x) => [x.qty ? `<button class="linklike" data-sstier="${enc(x.tier)}">${x.tier} ▸</button>` : x.tier, num(x.qty)+'개', pct(x.qtyShare), won(x.sales), pct(x.share)])}
      <div id="ssFillerDetail" style="margin-top:12px"></div>
    </div>
    <div class="card" style="margin:0">
      <h3>카테고리 × 충전재 <span class="hint">매출(수량)</span></h3>
      ${tableHtml(['카테고리', ...T, '합계', '비중'], b.rows, (r) => [r.cat, ...T.map((t) => cell(r.tiers, t)), won(r.total), pct(r.share)])}
    </div>`;
  box.querySelectorAll('button[data-sstier]').forEach((btn) => btn.addEventListener('click', () => loadSSTier(decodeURIComponent(btn.dataset.sstier))));
}
async function loadSSTier(tier) {
  openDetailModal(`${ae(tier)} 판매 제품 <span class="muted" style="font-size:12px;font-weight:500">· 스마트스토어</span>`, '<div class="empty">판매 제품 불러오는 중…</div>');
  const s = el('ssStart').value, e = el('ssEnd').value;
  try {
    const j = await (await fetch(`/api/smartstore/line-tier?tier=${enc(tier)}&start=${s}&end=${e}`)).json();
    if (!j.ok) throw new Error(j.error);
    el('dmTitle').innerHTML = `${ae(tier)} 판매 제품 <span class="muted" style="font-size:13px;font-weight:500">· 스마트스토어 · ${num(j.count)}종</span>`;
    el('dmBody').innerHTML = `${tableHtml(['판매 제품', '매출', '수량', '주문'], j.rows, (r) => [r.product_name, won(r.sales), num(r.qty), num(r.orders)])}`;
  } catch (err) { el('dmBody').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}

// ── 월 목표 달성률 배너 ──
function targetBannerHtml(label, c, info) {
  const rate = c.rate, w = Math.min(100, rate * 100), over = rate >= 1;
  const pace = info.totalDays ? (info.elapsedDays / info.totalDays * 100) : 0;
  const ahead = c.vsPace >= 0;
  return `<div class="targetcard">
    <div class="tlabel">${label}<br><span class="muted" style="font-weight:500">${info.month} · ${info.elapsedDays}/${info.totalDays}일</span></div>
    <div class="tmain">
      <div class="trow"><span>누적 ${won(c.actual)}</span><span>목표 ${won(c.target)}</span></div>
      <div class="tbar"><div class="fill ${over?'over':''}" style="width:${w}%"></div><div class="pace" style="left:${pace}%" title="목표 페이스"></div><div class="tnum">${pct(rate)}</div></div>
      <div class="trow" style="margin-top:6px"><span>월말 예상 ${won(c.forecast)}</span><span class="${ahead?'pos':'neg'}">페이스 ${ahead?'+':''}${won(c.vsPace)}</span></div>
    </div>
    <div class="tstat ${ahead?'ahead':'behind'}"><div class="big">${pct(rate)}</div><div class="muted" style="font-size:11px;font-weight:600">잔여 ${info.remainingDays}일 · 일 ${won(c.needPerDay)} 필요</div></div>
  </div>`;
}
async function loadTarget() {
  try {
    const j = await (await fetch('/api/target')).json();
    if (!j.ok) return;
    if (el('caTarget')) el('caTarget').innerHTML = targetBannerHtml('자사몰 월 목표', j.cafe24, j);
    if (el('ssTargetBar')) el('ssTargetBar').innerHTML = targetBannerHtml('스마트스토어 월 목표', j.smartstore, j);
  } catch (_) {}
}

// ── ⑧ 비즈 유도 고객 ──
let bzInit = false;
function initBizPromote() {
  if (bzInit) return; bzInit = true;
  el('tab-bizpromote').innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="panelctl">
        <label>본품 구매 후 <select id="bzMonths"><option value="3">3개월↑ 경과</option><option value="6">6개월↑ 경과</option><option value="12">12개월↑ 경과</option></select></label>
        <button id="bzLoad" class="btn">찾기</button>
        <a id="bzCsv" class="btn ghost" href="#">⤓ CSV 다운로드</a>
        <span id="bzStatus" class="muted" style="font-size:12px"></span>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px">본품(소파·바디필로우·메이트) 구매 후 N개월 경과했는데 <strong>비즈(리필) 미구매</strong> 회원 = 비즈 구매 유도 대상 (리필 재구매 캠페인용)</div>
    </div>
    <div id="bzResult"><div class="empty">조건을 선택하고 <strong>찾기</strong>를 누르면 대상 고객을 추출합니다. (회원 개인정보 조회 포함 — 첫 조회는 다소 시간이 걸릴 수 있어요)</div></div>`;
  el('bzLoad').addEventListener('click', loadBizPromote);
  // 최초 진입/개월수 변경 시 자동 추출하지 않음 — '찾기' 클릭 시에만 조회
  el('bzMonths').addEventListener('change', () => {
    const m = el('bzMonths').value;
    el('bzCsv').href = `/api/biz-promote.csv?months=${m}`;
    el('bzStatus').textContent = '';
    el('bzResult').innerHTML = `<div class="empty">${m}개월↑ 조건으로 <strong>찾기</strong>를 눌러주세요.</div>`;
  });
}
async function loadBizPromote(fresh) {
  const m = el('bzMonths').value;
  el('bzCsv').href = `/api/biz-promote.csv?months=${m}`;
  el('bzResult').innerHTML = `<div class="empty">${fresh ? '최신 재계산 중… (회원 정보 조회 포함)' : '불러오는 중…'}</div>`;
  try {
    const j = await (await fetch(`/api/biz-promote?months=${m}${fresh ? '&fresh=1' : ''}`)).json();
    if (!j.ok) throw new Error(j.error);
    el('bzStatus').textContent = `${j.months}개월↑ · ${num(j.count)}명${j.cached ? (j.stale ? ' · 캐시(갱신가능)' : ' · 캐시') : ' · 최신'}`;
    const when = j.builtAt ? new Date(j.builtAt).toLocaleString('ko-KR') : '';
    const barColor = j.stale ? 'var(--orange, #e8a33d)' : (j.cached ? 'var(--muted)' : 'var(--green)');
    const barText = j.stale
      ? `🟠 이전 저장 데이터(캐시) · ${when} 집계 — <b>새 주문 데이터가 있습니다.</b> 최신으로 보려면 재계산하세요`
      : (j.cached ? `🗄 이전 저장 데이터(캐시) · ${when} 집계 — 클릭 시 저장된 데이터를 먼저 보여줍니다` : `🟢 방금 새로 계산 · ${when}`);
    const cacheBar = `<div class="insightline" style="border-left-color:${barColor}">
      ${barText} <button id="bzFresh" class="btn mini ghost">↻ 최신 재계산</button></div>`;
    el('bzResult').innerHTML = `${cacheBar}<div class="card">
      <h3>🛒 비즈 구매 유도 대상 <span class="hint">본품 구매 ${j.months}개월↑ 경과 · 비즈 미구매 · ${num(j.count)}명 (상위 ${j.rows.length} 표시)</span>
        <a class="btn mini" href="/api/biz-promote.csv?months=${m}">⤓ CSV</a></h3>
      ${tableHtml(['회원ID', '이름', '연락처', '이메일', '마케팅', 'SMS', '이메일수신', '본품 구매일', '경과', '구매 본품'], j.rows,
        (r) => [r.member_id||'-', r.name||'-', r.cellphone||'-', r.email||'-',
          `<span class="${r.marketing==='동의'?'agree':'deny'}">${r.marketing||'-'}</span>`,
          r.smsAgree?'✓':'✕', r.mailAgree?'✓':'✕', r.mainDate||'-', r.monthsSince+'개월', (r.products||[]).slice(0,2).join(', ')])}
    </div>`;
    const fb = el('bzFresh'); if (fb) fb.addEventListener('click', () => loadBizPromote(true));
  } catch (err) { el('bzResult').innerHTML = `<div class="empty">오류: ${err.message}</div>`; }
}

// ══════════════════════════════════════════════
//  📊 통합 비교 (자사몰 + 스마트스토어)
// ══════════════════════════════════════════════
// 고정 헤더(KPI + 전년/전월/전주 비교표) + 서브탭 5개. 탭 전환은 재호출 없이 cmpCache 사용.
let cmpInit = false;
let cmpCache = null;        // loadCompare가 받은 6개 응답 보관 { s, e, per, best, cat, promos, extra, prod }
let cmpTab = 'promo';       // promo | traffic | best | product | tier
let cmpCh = 'all';          // all | cafe24 | smartstore — 베스트/상품별/충전재 몰별 필터
const CMP_CH_NAME = { total: '전체', cafe24: '자사몰', smartstore: '스마트스토어' };
const CMP_CH_OPT = [['all', '전체 (자사몰+스마트스토어)'], ['cafe24', '🛒 자사몰'], ['smartstore', '🟢 스마트스토어']];
// 몰 선택창 + 재렌더 배선
function chSelectBar(hint) {
  return `<div class="card" style="margin-bottom:14px"><div class="panelctl">
    <label>몰 선택 <select id="cmpCh">${CMP_CH_OPT.map(([v, l]) => `<option value="${v}" ${v === cmpCh ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <span class="muted" style="font-size:12px">${hint || '몰별로 데이터를 좁혀 볼 수 있어요'}</span></div></div>`;
}
function wireCmpCh() { const s = el('cmpCh'); if (s) s.addEventListener('change', () => { cmpCh = s.value; renderCmpTab(); }); }
const chPick = (r, key) => (cmpCh === 'cafe24' ? r.cafe24[key] : cmpCh === 'smartstore' ? r.smartstore[key] : r.total[key]);
const chLabel = () => (cmpCh === 'cafe24' ? '자사몰' : cmpCh === 'smartstore' ? '스마트스토어' : '전체');

function initCompare() {
  if (cmpInit) return; cmpInit = true;
  el('cmpMain').innerHTML = `
    <div class="card" style="margin:14px 0">
      <div class="panelctl">
        <div class="ranges"><button id="cmpMonthBtn" class="chip active">이번 달</button><button id="cmp30" class="chip">최근 30일</button></div>
        <label>월 선택 <span class="ymsel"><select id="cmpYear"></select><select id="cmpMon"></select></span></label>
        <label id="cmpPromoWrap">전사 프로모션 <select id="cmpPromo"><option value="">(기간 직접 선택)</option></select></label>
        <label>시작 <input type="date" id="cmpStart"></label>
        <label>종료 <input type="date" id="cmpEnd"></label>
        <button id="cmpLoad" class="btn">조회</button>
        <span class="muted" style="font-size:12px">자사몰+스마트스토어 통합 · 기간을 선택해 조회 (전사 프로모션 선택은 ① 프로모션 매출용)</span>
      </div>
    </div>
    <div id="cmpFixed"></div>
    <nav class="tabs cmptabs" id="cmpTabs">
      <button class="tab active" data-cmptab="promo">① 프로모션 매출</button>
      <button class="tab" data-cmptab="traffic">② 트래픽 현황</button>
      <button class="tab" data-cmptab="best">③ 베스트 상품</button>
      <button class="tab" data-cmptab="product">④ 상품별 판매량</button>
      <button class="tab" data-cmptab="tier">⑤ 충전재별 판매량</button>
    </nav>
    <div id="cmpPanel"><div class="empty">분석 중…</div></div>`;
  el('cmpStart').value = el('start').value || monthStart(); el('cmpEnd').value = el('end').value || rangeFor('yesterday')[1];
  fillYM('cmpYear', 'cmpMon');
  el('cmpYear').addEventListener('change', applyCmpMonth);
  el('cmpMon').addEventListener('change', applyCmpMonth);
  el('cmpLoad').addEventListener('click', loadCompare);
  wireDateMirror('cmpStart', 'cmpEnd');
  el('cmpMonthBtn').addEventListener('click', () => { el('cmpStart').value = monthStart(); el('cmpEnd').value = rangeFor('yesterday')[1]; loadCompare(); });
  el('cmp30').addEventListener('click', () => { const [s, e] = rangeFor('30d'); el('cmpStart').value = s; el('cmpEnd').value = e; loadCompare(); });
  el('cmpPromo').addEventListener('change', () => { const o = el('cmpPromo').selectedOptions[0]; if (o && o.dataset.start) { el('cmpStart').value = o.dataset.start; el('cmpEnd').value = o.dataset.end; loadCompare(); } });
  // 서브탭 전환 — 데이터 재호출 없이 cmpCache로 렌더
  el('cmpTabs').querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    el('cmpTabs').querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); cmpTab = b.dataset.cmptab; syncCmpControls(); renderCmpTab();
  }));
  loadCmpPromos();
  syncCmpControls();
  loadCompare();
}
// 전사 프로모션 선택기는 ① 프로모션 매출 탭에서만 노출 (나머지 탭은 기간만 사용)
function syncCmpControls() {
  const w = el('cmpPromoWrap'); if (w) w.style.display = (cmpTab === 'promo') ? '' : 'none';
}
// 월 선택 → 해당 월 1일~말일(미래면 오늘까지)로 기간 설정 후 조회
function applyCmpMonth() {
  const ym = getYM('cmpYear', 'cmpMon');
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  const last = new Date(y, m, 0), today = new Date();
  el('cmpStart').value = `${ym}-01`;
  el('cmpEnd').value = ymd(last > today ? today : last);
  document.querySelectorAll('#cmpMain .chip').forEach((x) => x.classList.remove('active'));
  loadCompare();
}
async function loadCmpPromos() {
  try {
    const j = await (await fetch('/api/promo-periods/list')).json();
    const items = (j.ok && j.items) || [];
    el('cmpPromo').innerHTML = '<option value="">(기간 직접 선택)</option>' +
      items.map((r) => `<option value="${r.month}" data-start="${r.start}" data-end="${r.end}">${r.name} (${r.start}~${r.end})</option>`).join('');
  } catch (_) {}
}

// 등락률 표기 (정수% / 소수1자리%)
function cmpRt(r) { return r == null ? '<span class="muted">-</span>' : `<span class="${r >= 0 ? 'pos' : 'neg'}">${r >= 0 ? '+' : ''}${(r * 100).toFixed(0)}%</span>`; }
function cmpRtBig(r) { return r == null ? '<span class="muted">-</span>' : `<span class="${r >= 0 ? 'pos' : 'neg'}">${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%</span>`; }

// 6개 엔드포인트 1회 병렬 fetch → cmpCache 저장 → 고정헤더 + 활성탭 렌더
async function loadCompare() {
  const s = el('cmpStart').value, e = el('cmpEnd').value;
  if (!s || !e) return;
  syncDateInputs(s, e);
  el('cmpFixed').innerHTML = '';
  el('cmpPanel').innerHTML = '<div class="empty">분석 중…</div>';
  try {
    const [per, best, cat, promos, extra, prod, mon, montier] = await Promise.all([
      (await fetch(`/api/compare/period?start=${s}&end=${e}`)).json(),
      (await fetch(`/api/compare/best?start=${s}&end=${e}`)).json(),
      (await fetch(`/api/compare/category-promo?start=${s}&end=${e}`)).json(),
      (await fetch('/api/compare/promos')).json(),
      (await fetch(`/api/compare/extra?start=${s}&end=${e}`)).json(),
      (await fetch(`/api/compare/product-by-channel?start=${s}&end=${e}&limit=50`)).json(),
      (await fetch('/api/compare/monthly')).json(),
      (await fetch('/api/compare/monthly-tier')).json(),
    ]);
    cmpCache = { s, e, per, best, cat, promos, extra, prod, mon, montier };
    renderCmpFixed();
    renderCmpTab();
  } catch (err) {
    el('cmpPanel').innerHTML = `<div class="empty">오류: ${err.message}</div>`;
  }
}

// 고정 헤더: KPI 4장 + 전년/전월/전주 동기간 비교표 (탭 전환과 무관하게 항상 표시)
function renderCmpFixed() {
  const c = cmpCache; if (!c) return;
  const { s, e, per } = c;
  const rows = (per.ok && per.rows) || [];
  const T = rows.find((r) => r.channel === 'total') || null;
  const kc = (l, v, sub, cls) => `<div class="kpi ${cls || ''}"><div class="label">${l}</div><div class="val num">${v}</div><div class="sub">${sub}</div></div>`;
  el('cmpFixed').innerHTML = `
    ${T ? `<section class="kpis" style="padding:0 0 14px">
      ${kc('전체 매출', won(T.cur.revenue), `${s} ~ ${e} · 자사몰+스마트스토어`, 'accent')}
      ${kc('전월 대비', cmpRtBig(T.mom.rate), `전월 동기간 ${won(T.mom.revenue)}`, '')}
      ${kc('전년 대비', cmpRtBig(T.yoy.rate), `전년 동기간 ${won(T.yoy.revenue)}`, '')}
      ${kc('객단가', won(T.cur.aov), `전주 대비 ${cmpRtBig(T.wow.rate)}`, 'green')}
    </section>` : ''}
    <div class="card"><h3>전년 / 전월 / 전주 동기간 비교 <span class="hint">${s} ~ ${e} · 채널별 매출·객단가</span></h3>
      ${tableHtml(['채널', '현재 매출', '객단가', '전주비', '전월비', '전년비'], rows,
        (r) => [`<strong>${CMP_CH_NAME[r.channel] || r.channel}</strong>`, won(r.cur.revenue), won(r.cur.aov), cmpRt(r.wow.rate), cmpRt(r.mom.rate), cmpRt(r.yoy.rate)])}
    </div>`;
}

// 활성 서브탭만 렌더 (cmpCache 사용, fetch 없음)
function renderCmpTab() {
  const c = cmpCache; const p = el('cmpPanel'); if (!c) { p.innerHTML = '<div class="empty">먼저 조회하세요</div>'; return; }
  if (cmpTab === 'promo') renderCmpPromo();
  else if (cmpTab === 'traffic') renderCmpTraffic();
  else if (cmpTab === 'best') renderCmpBest();
  else if (cmpTab === 'product') renderCmpProduct();
  else if (cmpTab === 'tier') renderCmpTier();
}

// ① 프로모션 매출 = 전사 프로모션 기간별 매출 비교표(행클릭 기간전환) + 카테고리별 프로모션 성과
function renderCmpPromo() {
  const { s, e, promos, cat } = cmpCache; const p = el('cmpPanel');
  const promoRows = (promos.ok && promos.promos) || [];
  const catRows = (cat.ok && cat.rows) || [];
  p.innerHTML = `
    <div class="card"><h3>전사 프로모션 기간별 매출 비교 <span class="hint">행 클릭 시 그 기간으로 전환(전체 비교 반영) · 자사몰+스마트스토어</span></h3>
      ${promoRows.length ? tableHtml(['프로모션', '기간', '일수', '총매출', '일평균', '자사몰', '스마트스토어', '객단가', '전7일', '후7일'], promoRows,
        (q) => [`<button class="linklike" data-ps="${q.start}" data-pe="${q.end}">${q.name} ▸</button>`, `${q.start}~${q.end}`, q.days + '일', won(q.total.revenue), won(q.dailyAvg), won(q.cafe24.revenue), won(q.smartstore.revenue), won(q.aov), won(q.before7.revenue), won(q.after7.revenue)]) : '<div class="empty">저장된 전사 프로모션 없음 — ⚙ 목표·프로모션 설정에서 기간을 입력하세요</div>'}
    </div>
    <div class="card" style="margin-top:16px"><h3>카테고리별 프로모션 성과 <span class="hint">전월 동기간 대비 (자사몰) · ${s} ~ ${e}</span></h3>
      ${tableHtml(['카테고리', '매출', '비중', '전월비'], catRows, (r) => [r.cat, won(r.sales), pct(r.share), cmpRt(r.momRate)])}
    </div>`;
  p.querySelectorAll('button[data-ps]').forEach((b) => b.addEventListener('click', () => { el('cmpStart').value = b.dataset.ps; el('cmpEnd').value = b.dataset.pe; loadCompare(); }));
}

// ② 트래픽 현황 = 자사몰 방문/PV/구매/가입 풀세트(일별·월별YoY·요일평균·Top10). 별도 API(느려서 탭 진입 시 fetch+캐시)
let cmpTrafficCache = {};
async function renderCmpTraffic() {
  const { s, e } = cmpCache; const p = el('cmpPanel');
  const key = s + '|' + e;
  let data = cmpTrafficCache[key];
  if (!data) {
    p.innerHTML = '<div class="empty">트래픽 데이터 집계 중… (방문·PV·가입, 첫 조회는 다소 시간이 걸려요)</div>';
    try {
      const [dj, mj] = await Promise.all([
        (await fetch(`/api/traffic/daily?start=${s}&end=${e}`)).json(),
        (await fetch('/api/traffic/monthly')).json(),
      ]);
      if (!dj.ok) throw new Error(dj.error || '실패');
      data = { dj, mj }; cmpTrafficCache[key] = data;
    } catch (err) { p.innerHTML = `<div class="empty">트래픽 오류: ${err.message}</div>`; return; }
  }
  if (cmpTab !== 'traffic') return; // 로딩 중 다른 탭으로 이동했으면 렌더 취소
  const t = data.dj.totals, daily = data.dj.daily || [], wk = data.dj.weekday || [], top = data.dj.top || [];
  const mrows = (data.mj && data.mj.ok && data.mj.rows) || [];
  const monRows = (cmpCache.mon && cmpCache.mon.ok && cmpCache.mon.rows) || []; // 채널별 월 매출/주문
  const kc = (l, v, sub, cls) => `<div class="kpi ${cls || ''}"><div class="label">${l}</div><div class="val num">${v}</div><div class="sub">${sub}</div></div>`;
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  p.innerHTML = `
    <div class="insightline" style="border-left-color:var(--accent)">ℹ️ <strong>방문수·페이지뷰·가입수는 자사몰(Cafe24) 기준</strong>입니다. 네이버 커머스 API는 방문수·회원가입 통계를 제공하지 않아(셀러센터 비즈어드바이저 전용) 스마트스토어 트래픽은 분리할 수 없습니다. 대신 <strong>구매·매출은 아래에서 자사몰 vs 스마트스토어로 비교</strong>합니다.</div>
    <section class="kpis" style="padding:0 0 14px">
      ${kc('방문수 (자사몰)', num(t.visits), `${s} ~ ${e} · 일평균 ${num(Math.round(t.visits / (t.days || 1)))}`, 'accent')}
      ${kc('페이지뷰(PV)', num(t.pv), `PV/방문 ${t.pvPerVisit.toFixed(2)}`, '')}
      ${kc('구매 / 구매율', num(t.orders) + '건', `구매율 ${pct(t.cvr)}`, 'green')}
      ${kc('가입 / 가입률', num(t.signups) + '명', `가입률 ${pct(t.signupRate)}`, 'pink')}
    </section>
    <div class="grid two">
      <div class="card"><h3>📊 자사몰 월별 방문수 (연도별 · 전년비)<span class="hint">전년 동월 비교 · 자사몰 한정</span></h3>${monthlyYoy(mrows, (r) => r.visits, num)}</div>
      <div class="card"><h3>📊 자사몰 월별 가입수 (연도별 · 전년비)<span class="hint">전년 동월 비교 · 자사몰 한정</span></h3>${monthlyYoy(mrows, (r) => r.signups, num)}</div>
    </div>
    <div class="grid two" style="margin-top:16px">
      <div class="card"><h3>🛒 월별 매출 (자사몰 vs 스마트스토어) <span class="hint">2025-01 ~ 현재</span></h3>${monthlyChannel(monRows, (o) => o.sales, won)}</div>
      <div class="card"><h3>🧾 월별 구매건수 (자사몰 vs 스마트스토어) <span class="hint">2025-01 ~ 현재</span></h3>${monthlyChannel(monRows, (o) => o.orders, num)}</div>
    </div>
    <div class="grid two" style="margin-top:16px">
      <div class="card"><h3>요일별 평균 방문 / 가입 <span class="hint">${s} ~ ${e}</span></h3>
        ${tableHtml(['요일', '평균 방문', '평균 가입'], wk, (w) => [w.label, num(w.avgVisits), num(w.avgSignups)])}</div>
      <div class="card"><h3>상위 트래픽 일자 Top10 <span class="hint">방문수 기준</span></h3>
        ${tableHtml(['일자', '방문', 'PV', '구매', '구매율', '가입'], top, (r) => [r.date, num(r.visits), num(r.pv), num(r.orders), pct(r.cvr), num(r.signups)])}</div>
    </div>
    <div class="card" style="margin-top:16px"><h3>일별 트래픽 상세 <span class="hint">${s} ~ ${e} · 방문/PV/구매/가입</span></h3>
      ${tableHtml(['일자', '요일', '방문', 'PV', 'PV/방문', '구매', '구매율', '구매액(자사몰)', '가입', '가입률'], daily,
        (r) => [r.date, DOW[r.dow], num(r.visits), num(r.pv), r.pvPerVisit.toFixed(2), num(r.orders), pct(r.cvr), won(r.revenue), num(r.signups), pct(r.signupRate)])}</div>
    <div class="insightline">💡 데이터 출처 — 방문·PV: Cafe24 통계 API · 가입: 회원 가입일(<code>/customersprivacy</code>) · 구매·매출: 주문 DB(자사몰+스마트스토어).</div>`;
}

// ── 전체기간 월별 추이 + 전년비(YoY) 헬퍼 ──
// rows: [{ym:'YYYY-MM', ...}], pick(row)->수치, fmtv(v)->표시
function monthlyYoy(rows, pick, fmtv) {
  const years = {}; let max = 0;
  (rows || []).forEach((r) => { const y = String(r.ym).slice(0, 4), m = +String(r.ym).slice(5, 7); const v = pick(r) || 0; (years[y] = years[y] || {})[m] = v; if (v > max) max = v; });
  const yrs = Object.keys(years).sort();
  if (!yrs.length) return '<div class="empty">월별 데이터 없음</div>';
  const MO = Array.from({ length: 12 }, (_, i) => i + 1);
  const barsHtml = MO.map((m) => {
    const bars = yrs.map((y, idx) => { const v = years[y][m] || 0; const h = max ? Math.max(1, Math.round(v / max * 100)) : 0; return `<div class="yb yb-${idx}" style="height:${h}%" title="${y}.${m}월 ${fmtv(v)}"></div>`; }).join('');
    return `<div class="ybcol"><div class="ybbars">${bars}</div><div class="yblbl">${m}월</div></div>`;
  }).join('');
  const legend = yrs.map((y, idx) => `<span class="yleg yleg-${idx}">${y}</span>`).join('');
  const yPrev = yrs[yrs.length - 2], yCur = yrs[yrs.length - 1];
  const tbl = tableHtml(['월', yPrev || '-', yCur || '-', '전년비'], MO.map((m) => ({ m })), (x) => {
    const a = (years[yPrev] || {})[x.m] || 0, b = (years[yCur] || {})[x.m] || 0; const r = a ? (b - a) / a : null;
    return [`${x.m}월`, a ? fmtv(a) : '-', b ? fmtv(b) : '-', r == null ? '<span class="muted">-</span>' : `<span class="${r >= 0 ? 'pos' : 'neg'}">${r >= 0 ? '+' : ''}${(r * 100).toFixed(0)}%</span>`];
  });
  return `<div class="yoybars">${barsHtml}</div><div class="yleglist">${legend}</div>${tbl}`;
}
// 월별 채널 비교 막대 (자사몰 vs 스마트스토어) — rows: [{ym, cafe24:{...}, smartstore:{...}}], pick(obj)->수치
function monthlyChannel(rows, pick, fmtv) {
  rows = rows || [];
  let max = 0; rows.forEach((r) => { const a = pick(r.cafe24) || 0, b = pick(r.smartstore) || 0; if (a > max) max = a; if (b > max) max = b; });
  const cols = rows.map((r) => {
    const a = pick(r.cafe24) || 0, b = pick(r.smartstore) || 0;
    const ha = max ? Math.max(1, Math.round(a / max * 100)) : 0, hb = max ? Math.max(1, Math.round(b / max * 100)) : 0;
    return `<div class="ybcol"><div class="ybbars"><div class="yb yb-1" style="height:${ha}%" title="자사몰 ${r.ym} ${fmtv(a)}"></div><div class="yb yb-3" style="height:${hb}%" title="스마트스토어 ${r.ym} ${fmtv(b)}"></div></div><div class="yblbl">${String(r.ym).slice(2)}</div></div>`;
  }).join('');
  const legend = '<span class="yleg yleg-1">자사몰</span><span class="yleg yleg-3">스마트스토어</span>';
  const tbl = tableHtml(['월', '자사몰', '스마트스토어', '합산'], rows, (r) => {
    const a = pick(r.cafe24) || 0, b = pick(r.smartstore) || 0;
    return [r.ym, fmtv(a), fmtv(b), fmtv(a + b)];
  });
  return `<div class="yoybars">${cols}</div><div class="yleglist">${legend}</div>${tbl}`;
}
// 충전재 등급별 전년비 (연 합계) — channel: cafe24|smartstore|total
function tierYoy(montier, channel) {
  channel = channel || 'total';
  const rows = (montier && montier.ok && montier.rows) || [];
  const TIERS = (montier && montier.TIERS) || ['스탠다드', '프리미엄', '프리미엄플러스', '기타'];
  const byYear = {};
  rows.forEach((r) => { const y = String(r.ym).slice(0, 4); const src = r[channel] || r.total || {}; (byYear[y] = byYear[y] || {}); for (const t of TIERS) byYear[y][t] = (byYear[y][t] || 0) + ((src[t] || {}).sales || 0); });
  const yrs = Object.keys(byYear).sort(); const yPrev = yrs[yrs.length - 2], yCur = yrs[yrs.length - 1];
  return tableHtml(['충전재 등급', yPrev || '-', yCur || '-', '전년비'], TIERS.map((t) => ({ t })), (x) => {
    const a = (byYear[yPrev] || {})[x.t] || 0, b = (byYear[yCur] || {})[x.t] || 0; const r = a ? (b - a) / a : null;
    return [`<span class="tag">${x.t}</span>`, won(a), won(b), r == null ? '<span class="muted">-</span>' : `<span class="${r >= 0 ? 'pos' : 'neg'}">${r >= 0 ? '+' : ''}${(r * 100).toFixed(0)}%</span>`];
  });
}

// ③ 베스트 상품 = 채널별 베스트 Top10 (몰 선택) + 전체기간 월별 추이
function renderCmpBest() {
  const { s, e, best, mon } = cmpCache; const p = el('cmpPanel');
  const monRows = (mon && mon.ok && mon.rows) || [];
  const showCa = cmpCh !== 'smartstore', showSs = cmpCh !== 'cafe24';
  const cards = [];
  if (showCa) cards.push(`<div class="card"><h3>🛒 자사몰 베스트 Top10 <span class="hint">${s} ~ ${e} · 매출순</span></h3>${tableHtml(['상품', '수량', '매출'], (best.ok && best.cafe24) || [], (q) => [q.name, num(q.qty), won(q.sales)])}</div>`);
  if (showSs) cards.push(`<div class="card"><h3>🟢 스마트스토어 베스트 Top10 <span class="hint">${s} ~ ${e} · 매출순</span></h3>${tableHtml(['상품', '수량', '매출'], (best.ok && best.smartstore) || [], (q) => [q.name, num(q.qty), won(q.sales)])}</div>`);
  const grid = cards.length > 1 ? `<div class="grid two">${cards.join('')}</div>` : (cards[0] || '');
  p.innerHTML = chSelectBar('베스트 상품을 몰별로 확인') + grid +
    `<div class="card" style="margin-top:16px"><h3>📈 ${chLabel()} 월별 매출 추이 (연도별 · 전년비)<span class="hint">전년 동월 비교</span></h3>
      ${monthlyYoy(monRows, (r) => chPick(r, 'sales'), won)}</div>`;
  wireCmpCh();
}

// ④ 상품별 판매량 = /api/compare/product-by-channel, 채널별 상품 판매 리스트(수량/매출/비중) 좌우 2열
function renderCmpProduct() {
  const { s, e, prod } = cmpCache; const p = el('cmpPanel');
  const ca = (prod.ok && prod.cafe24) || [];
  const ss = (prod.ok && prod.smartstore) || [];
  const monRows = (cmpCache.mon && cmpCache.mon.ok && cmpCache.mon.rows) || [];
  const showCa = cmpCh !== 'smartstore', showSs = cmpCh !== 'cafe24';
  const tCards = [], yCards = [];
  if (showCa) { tCards.push(`<div class="card"><h3>🛒 자사몰 상품별 판매량 <span class="hint">${s} ~ ${e} · 매출순 상위 ${ca.length}종</span></h3>${tableHtml(['상품', '수량', '매출', '비중'], ca, (r) => [r.name, num(r.qty), won(r.sales), pct(r.share)])}</div>`); yCards.push(`<div class="card"><h3>📈 자사몰 월별 매출 (연도별 · 전년비)<span class="hint">전년 동월 비교</span></h3>${monthlyYoy(monRows, (r) => r.cafe24.sales, won)}</div>`); }
  if (showSs) { tCards.push(`<div class="card"><h3>🟢 스마트스토어 상품별 판매량 <span class="hint">${s} ~ ${e} · 매출순 상위 ${ss.length}종</span></h3>${tableHtml(['상품', '수량', '매출', '비중'], ss, (r) => [r.name, num(r.qty), won(r.sales), pct(r.share)])}</div>`); yCards.push(`<div class="card"><h3>📈 스마트스토어 월별 매출 (연도별 · 전년비)<span class="hint">전년 동월 비교</span></h3>${monthlyYoy(monRows, (r) => r.smartstore.sales, won)}</div>`); }
  const grid = (cs) => cs.length > 1 ? `<div class="grid two">${cs.join('')}</div>` : (cs[0] || '');
  p.innerHTML = chSelectBar('상품별 판매량을 몰별로 확인') + grid(tCards) + `<div style="margin-top:16px">${grid(yCards)}</div>`;
  wireCmpCh();
}

// ⑤ 충전재별 판매량 = tiers 몰별 2열
function renderCmpTier() {
  const { extra, montier } = cmpCache; const p = el('cmpPanel');
  const ti = (extra.ok && extra.tiers) || null;
  if (!ti) { p.innerHTML = chSelectBar('충전재를 몰별로 확인') + '<div class="empty">충전재 데이터 없음</div>'; wireCmpCh(); return; }
  const showCa = cmpCh !== 'smartstore', showSs = cmpCh !== 'cafe24';
  const cards = [];
  if (showCa) cards.push(`<div class="card"><h3>충전재별 판매량 · 자사몰 <span class="hint">스탠다드/프리미엄/프리미엄플러스/기타</span></h3>${tableHtml(['충전재 등급', '수량', '수량비중', '매출', '매출비중'], ti.cafe24 || [], (r) => [`<span class="tag">${r.tier}</span>`, num(r.qty) + '개', pct(r.qtyShare), won(r.sales), pct(r.share)])}</div>`);
  if (showSs) cards.push(`<div class="card"><h3>충전재별 판매량 · 스마트스토어 <span class="hint">스탠다드/프리미엄/프리미엄플러스/기타</span></h3>${tableHtml(['충전재 등급', '수량', '수량비중', '매출', '매출비중'], ti.smartstore || [], (r) => [`<span class="tag">${r.tier}</span>`, num(r.qty) + '개', pct(r.qtyShare), won(r.sales), pct(r.share)])}</div>`);
  const grid = cards.length > 1 ? `<div class="grid two">${cards.join('')}</div>` : (cards[0] || '');
  const ch = cmpCh === 'all' ? 'total' : cmpCh;
  p.innerHTML = chSelectBar('충전재를 몰별로 확인') + grid +
    `<div class="card" style="margin-top:16px"><h3>📈 ${chLabel()} 충전재 등급별 전년비 (연도별 · 전년비)<span class="hint">연 누적 매출 비교</span></h3>${tierYoy(montier, ch)}</div>`;
  wireCmpCh();
}

// ══════════════════════════════════════════════
//  설정 모달 (월별 목표 매출 · 전사 프로모션 기간)
// ══════════════════════════════════════════════
function fillYM(yearId, monId) {
  const now = new Date(), cy = now.getFullYear();
  const ys = []; for (let y = cy - 2; y <= cy + 1; y++) ys.push(`<option value="${y}">${y}년</option>`);
  el(yearId).innerHTML = ys.join('');
  el(monId).innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}월</option>`).join('');
  el(yearId).value = cy; el(monId).value = now.getMonth() + 1;
}
function getYM(yearId, monId) { return `${el(yearId).value}-${pad(el(monId).value)}`; }
function setYM(yearId, monId, ym) { el(yearId).value = ym.slice(0, 4); el(monId).value = +ym.slice(5, 7); }
function openSettings() {
  el('settingsModal').style.display = 'flex';
  if (!el('tgYear').options.length) { fillYM('tgYear', 'tgMon'); fillYM('pmYear', 'pmMon'); }
  loadTgList(); loadPmList();
}
function closeSettings() { el('settingsModal').style.display = 'none'; }
el('btnSettings').addEventListener('click', openSettings);
el('btnSettingsClose').addEventListener('click', closeSettings);
el('settingsModal').addEventListener('click', (e) => { if (e.target === el('settingsModal')) closeSettings(); });

async function loadTgList() {
  try {
    const j = await (await fetch('/api/target/list')).json();
    const items = (j.ok && j.items) || [];
    el('tgList').innerHTML = '<div class="setlist">' + (items.length ? tableHtml(['월', '자사몰', '스마트스토어', ''], items,
      (r) => [r.month, won(r.cafe24), won(r.smartstore), `<button class="linklike" data-m="${r.month}" data-ca="${r.cafe24}" data-ss="${r.smartstore}">수정</button>`]) : '<div class="empty">저장된 목표 없음</div>') + '</div>';
    el('tgList').querySelectorAll('button[data-m]').forEach((b) => b.addEventListener('click', () => {
      setYM('tgYear', 'tgMon', b.dataset.m); el('tgCafe24').value = Math.round(+b.dataset.ca / 10000); el('tgSmart').value = Math.round(+b.dataset.ss / 10000);
    }));
  } catch (_) {}
}
el('tgSave').addEventListener('click', async () => {
  const month = getYM('tgYear', 'tgMon'), cafe24 = Math.round((+el('tgCafe24').value || 0) * 10000), smartstore = Math.round((+el('tgSmart').value || 0) * 10000);
  if (!month) { el('tgMsg').textContent = '월을 선택하세요'; return; }
  el('tgMsg').textContent = '저장 중…';
  try {
    const j = await (await fetch('/api/target/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month, cafe24, smartstore }) })).json();
    el('tgMsg').textContent = j.ok ? '✅ 저장됨' : ('오류: ' + j.error);
    loadTgList(); loadTarget();
  } catch (e) { el('tgMsg').textContent = '오류: ' + e.message; }
});

async function loadPmList() {
  try {
    const j = await (await fetch('/api/promo-periods/list')).json();
    const items = (j.ok && j.items) || [];
    el('pmList').innerHTML = '<div class="setlist">' + (items.length ? tableHtml(['월', '프로모션명', '기간', ''], items,
      (r) => [r.month, r.name, `${r.start} ~ ${r.end}`, `<button class="linklike" data-m="${r.month}" data-n="${encodeURIComponent(r.name)}" data-s="${r.start}" data-e="${r.end}">수정</button> <button class="delx" data-del="${r.month}">삭제</button>`]) : '<div class="empty">저장된 프로모션 없음</div>') + '</div>';
    el('pmList').querySelectorAll('button[data-m]').forEach((b) => b.addEventListener('click', () => {
      setYM('pmYear', 'pmMon', b.dataset.m); el('pmName').value = decodeURIComponent(b.dataset.n); el('pmStart').value = b.dataset.s; el('pmEnd').value = b.dataset.e;
    }));
    el('pmList').querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('삭제할까요?')) return;
      await fetch('/api/promo-periods/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month: b.dataset.del }) });
      loadPmList();
    }));
  } catch (_) {}
}
el('pmSave').addEventListener('click', async () => {
  const month = getYM('pmYear', 'pmMon'), name = el('pmName').value, start = el('pmStart').value, end = el('pmEnd').value;
  if (!month || !start || !end) { el('pmMsg').textContent = '월·시작·종료를 입력하세요'; return; }
  el('pmMsg').textContent = '저장 중…';
  try {
    const j = await (await fetch('/api/promo-periods/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month, name, start, end }) })).json();
    el('pmMsg').textContent = j.ok ? '✅ 저장됨' : ('오류: ' + j.error);
    loadPmList();
  } catch (e) { el('pmMsg').textContent = '오류: ' + e.message; }
});

// ── 랜딩: 오늘 데이터 ──
(function init() {
  const [s, e] = rangeFor('today');
  el('start').value = s; el('end').value = e;
  initDetailModal(); // 상세 팝업 닫기/배경클릭/ESC 핸들러를 랜딩 시 항상 연결(어느 탭에서 열어도 닫기 동작)
  load(false);
  loadTarget();
})();
