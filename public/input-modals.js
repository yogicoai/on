/**
 * 입력 창 — 전사 프로모션 등록 · 전사 월 목표 · 일일 퍼널 입력 · 스마트스토어 유입 입력.
 *
 *   판매분석(app.js) · 일일매출보고(report-template.html) · 일일 퍼널 점검(dashboards/funnel_daily.html)이 같은 창을 쓴다.
 *   예전엔 app.js 안에만 있어서 일일매출보고의 버튼이 판매분석(/?openfn=1 …)으로 넘어가 창을 열었다
 *   → 이 파일로 옮겨 어느 페이지에서든 그 페이지 안에서 바로 뜨게 했다(2026-10-02 사용자 요청).
 *   모양(CSS)도 이 파일이 넣는다 — 페이지마다 스타일이 달라도 같은 창으로 보이게, 클래스는 imx- 로 시작한다.
 *
 *   열기: window.InputModals.open('promo' | 'targets' | 'funnel' | 'biz')
 *         예전 이름(openPromoUpload · openFunnelUpload(mode) · openBizInflow)도 그대로 둔다 — 퍼널 점검 iframe 이 부모에서 찾는다.
 *   반영 뒤: 페이지 안의 #funnelFrame(퍼널 점검)을 다시 그리고 window 에 'input-modals:applied' 이벤트를 보낸다.
 */
(function () {
  'use strict';
  if (window.InputModals) return; // 두 번 불러도 한 번만

  const num = (n) => (+n || 0).toLocaleString('ko-KR');
  const el = (id) => document.getElementById(id);
  const ae = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  // 판매분석(style.css) 토스 라이트 테마와 같은 값 — 창 안에서만 쓰도록 .imx 에 변수를 다시 둔다
  const CSS = `
.imx{--txt:#191F28;--sub:#4E5968;--muted:#8B95A1;--line:#EBEEF1;--line2:#E5E8EB;--panel2:#F9FAFB;--accent:#3182F6;--accent-weak:#E8F3FF;--green:#00C896;--warn:#FF8A00;
  position:fixed;inset:0;z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding:48px 16px;overflow:auto;background:rgba(17,24,39,.45);
  font-family:"Pretendard",-apple-system,"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;font-size:14px;line-height:1.5;color:var(--txt);text-align:left;letter-spacing:normal}
.imx *{box-sizing:border-box}
.imx-box{background:#fff;border-radius:20px;width:min(760px,100%);box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden}
.imx-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 22px;border-bottom:1px solid var(--line);font-size:16px}
.imx-head strong{font-weight:700}
.imx-sub{margin-top:2px}
.imx-body{padding:14px 22px 22px}
.imx-muted{color:var(--muted)}
.imx-btn{display:inline-flex;align-items:center;gap:4px;height:auto;background:var(--accent);border:1px solid var(--accent);color:#fff;border-radius:10px;padding:8px 16px;font:inherit;font-size:13px;font-weight:700;line-height:1.4;cursor:pointer;text-decoration:none;transition:all .12s}
.imx-btn:hover{background:#2272eb}
.imx-btn.ghost{background:#fff;border-color:var(--line2);color:var(--sub)}
.imx-btn.ghost:hover{background:var(--panel2);color:var(--txt)}
.imx-btn.mini{padding:4px 11px;font-size:12px;border-radius:8px}
.imx-btn:disabled{opacity:.5;cursor:progress}
.imx-line{margin-top:14px;padding:12px 14px;background:var(--accent-weak);border-left:3px solid transparent;border-radius:12px;font-size:13px;color:var(--sub);line-height:1.6}
.imx-line b{color:var(--txt)}
.imx textarea,.imx select{font:inherit;color:var(--txt);background:#fff}
.imx ul,.imx ol{padding-left:20px}
@media (max-width:600px){.imx{padding:16px 8px}.imx-head,.imx-body{padding-left:16px;padding-right:16px}}
`;
  (function injectCss() {
    const st = document.createElement('style');
    st.id = 'imx-style'; st.textContent = CSS;
    document.head.appendChild(st);
  })();

  // ══════════════════════════════════════════════
  //  전사 프로모션 등록 — 엑셀 업로드 (정의 + 목표를 한 파일로)
  //    MD가 정리한 엑셀을 올리면: 파싱·검증 → 변경 미리보기 → 확인 후 반영 → MCP 즉시 조회 가능.
  //    반영은 전량 교체(엑셀이 기준)이고 직전 버전은 자동 백업되어 되돌릴 수 있다.
  // ══════════════════════════════════════════════
  let _promoFile = null; // 선택된 엑셀(미리보기 후 적용에 재사용)

  function buildPromoUploadUi() {
    if (el('promoUpModal')) return;
    const m = document.createElement('div');
    m.id = 'promoUpModal'; m.className = 'imx'; m.style.display = 'none';
    m.innerHTML = `<div class="imx-box" style="max-width:860px">
      <div class="imx-head">
        <div><strong>전사 프로모션 등록</strong>
          <div class="imx-sub" style="font-size:12px;color:var(--muted)">엑셀 하나로 프로모션 정의 + 목표매출을 등록합니다 · 올리면 Claude(MCP)에서 바로 성과 조회</div></div>
        <button id="puClose" class="imx-btn ghost mini" type="button">닫기 ✕</button>
      </div>
      <div class="imx-body">
        <div id="puStatus" class="imx-muted" style="font-size:12px;margin-bottom:10px">현황 확인 중…</div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
          <a id="puTpl" class="imx-btn ghost" href="/api/promo-defs/template" download>⤓ 예제 양식 받기</a>
          <label class="imx-btn" style="cursor:pointer;margin:0">
            📄 엑셀 선택<input id="puFile" type="file" accept=".xlsx" style="display:none">
          </label>
          <span id="puFileName" class="imx-muted" style="font-size:12px"></span>
        </div>

        <div id="puDrop" style="border:2px dashed var(--line,#3a3a3a);border-radius:10px;padding:22px;text-align:center;color:var(--muted);font-size:13px;margin-bottom:12px">
          여기에 엑셀 파일을 끌어다 놓으셔도 됩니다
        </div>

        <div id="puResult"></div>
      </div></div>`;
    document.body.appendChild(m);

    el('puClose').addEventListener('click', closePromoUpload);
    m.addEventListener('click', (ev) => { if (ev.target === m) closePromoUpload(); });
    el('puFile').addEventListener('change', (ev) => { const f = ev.target.files && ev.target.files[0]; if (f) pickPromoFile(f); });

    const drop = el('puDrop');
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.style.borderColor = 'var(--accent,#7E57C2)'; }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.style.borderColor = ''; }));
    drop.addEventListener('drop', (ev) => { const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]; if (f) pickPromoFile(f); });
  }

  function openPromoUpload() {
    buildPromoUploadUi();
    el('promoUpModal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    el('puResult').innerHTML = ''; el('puFileName').textContent = ''; _promoFile = null;
    loadPromoDefStatus();
  }
  function closePromoUpload() { if (el('promoUpModal')) el('promoUpModal').style.display = 'none'; document.body.style.overflow = ''; }

  async function loadPromoDefStatus() {
    const box = el('puStatus'); if (!box) return;
    try {
      const j = await (await fetch('/api/promo-defs/status')).json();
      if (!j.적재) { box.innerHTML = '<b>등록된 프로모션이 없습니다</b> — 예제 양식을 받아 작성 후 올려주세요.'; return; }
      const malls = Object.entries(j.몰별 || {}).map(([k, v]) => `${k} ${v}`).join(' · ');
      box.innerHTML = `현재 <b>${num(j.적재)}건</b> 등록됨 (${malls}) · 기간 ${j.기간 || '-'} · 최종 갱신 ${String(j.갱신시각 || '').slice(0, 16).replace('T', ' ')}`;
    } catch (e) { box.textContent = '현황 조회 오류: ' + e.message; }
  }

  function pickPromoFile(file) {
    _promoFile = file;
    el('puFileName').textContent = file.name;
    uploadPromoExcel(false); // 먼저 미리보기
  }

  async function uploadPromoExcel(apply) {
    const box = el('puResult'); if (!_promoFile) return;
    box.innerHTML = `<div class="imx-muted">${apply ? '반영 중…' : '파일 확인 중…'}</div>`;
    try {
      const buf = await _promoFile.arrayBuffer();
      const r = await fetch('/api/promo-defs/upload' + (apply ? '?apply=1' : ''), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
      });
      const j = await r.json();

      if (!j.ok) {
        box.innerHTML = `<div class="imx-line" style="border-left-color:var(--warn,#e6c86a)">
          <b>오류 ${j.errors ? j.errors.length : 1}건 — 반영되지 않았습니다.</b> 고쳐서 다시 올려주세요.
          <ul style="margin:8px 0 0 16px;font-size:12px">${(j.errors || [j.error]).slice(0, 12).map((e) => `<li>${ae(e)}</li>`).join('')}</ul></div>`;
        return;
      }

      if (j.applied) {
        box.innerHTML = `<div class="imx-line" style="border-left-color:var(--green,#66BB6A)">
          <b>✅ 반영 완료</b> — 프로모션 ${num(j.counts.promotions)}건 (목표매출 입력 ${num(j.counts.withTarget || 0)}건)<br>
          <span class="imx-muted" style="font-size:12px">이제 Claude에서 "이번 달 프로모션 성과" 처럼 물어보면 바로 나옵니다.</span>
          <div style="margin-top:8px"><button id="puUndo" class="imx-btn ghost mini" type="button">↺ 직전 상태로 되돌리기</button></div></div>`;
        el('puUndo').addEventListener('click', rollbackPromoDefs);
        loadPromoDefStatus();
        afterApply('promo', box);
        return;
      }

      // 미리보기
      const p = j.preview || {};
      const chip = (label, n, color) => `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:${color};color:#111;font-weight:700;font-size:12px;margin-right:6px">${label} ${num(n)}</span>`;
      const rows = (arr, cols) => (arr || []).slice(0, 8).map((x) => `<li>${cols.map((c) => ae(x[c] || '')).filter(Boolean).join(' · ')}</li>`).join('');
      const warn = (j.warnings || []).length ? `<div class="imx-muted" style="font-size:12px;margin-top:8px">⚠️ ${(j.warnings || []).slice(0, 5).map(ae).join('<br>⚠️ ')}</div>` : '';
      const unres = (j.미해석 || []).length ? `<div class="imx-muted" style="font-size:12px;margin-top:6px">품목맵에 없는 대상상품 ${j.미해석.length}건 — 해당 프로모션은 매출이 0으로 잡힐 수 있습니다: ${j.미해석.slice(0, 3).map(ae).join(', ')}</div>` : '';

      box.innerHTML = `<div class="imx-line">
        <b>변경 내용 미리보기</b> <span class="imx-muted" style="font-size:12px">— 아직 반영되지 않았습니다</span><br>
        <div style="margin:10px 0">
          ${chip('신규', p.신규 || 0, '#A5D6A7')}${chip('수정', p.수정 || 0, '#FFE082')}${chip('삭제', p.삭제 || 0, '#EF9A9A')}${chip('변동없음', p.변동없음 || 0, '#CFD8DC')}
        </div>
        <div style="font-size:12px;color:var(--muted)">총 ${num(j.counts.promotions)}행 · ${Object.entries(j.counts.byMall || {}).map(([k, v]) => `${k} ${v}`).join(' · ')} · 목표매출 입력 ${num(j.counts.withTarget || 0)}건</div>
        ${p.신규 ? `<div style="margin-top:8px;font-size:12px"><b>신규</b><ul style="margin:4px 0 0 16px">${rows(p.added, ['promo_id', 'mall', 'name'])}</ul></div>` : ''}
        ${p.수정 ? `<div style="margin-top:8px;font-size:12px"><b>수정</b><ul style="margin:4px 0 0 16px">${rows(p.changed, ['promo_id', 'mall', 'name'])}</ul></div>` : ''}
        ${p.삭제 ? `<div style="margin-top:8px;font-size:12px"><b>삭제(엑셀에 없음)</b><ul style="margin:4px 0 0 16px">${rows(p.removed, ['promo_id', 'mall', 'name'])}</ul></div>` : ''}
        ${warn}${unres}
        <div style="margin-top:12px;display:flex;gap:8px">
          <button id="puApply" class="imx-btn" type="button">이대로 반영하기</button>
          <button id="puCancel" class="imx-btn ghost" type="button">취소</button>
        </div></div>`;
      el('puApply').addEventListener('click', () => {
        if ((p.삭제 || 0) > 0 && !confirm(`${p.삭제}건이 삭제됩니다. 진행할까요?\n(되돌리기 가능)`)) return;
        uploadPromoExcel(true);
      });
      el('puCancel').addEventListener('click', () => { box.innerHTML = ''; _promoFile = null; el('puFileName').textContent = ''; });
    } catch (e) {
      box.innerHTML = `<div class="imx-line" style="border-left-color:var(--warn,#e6c86a)">오류: ${ae(e.message)}</div>`;
    }
  }

  // ── 일일 퍼널 입력(엑셀 업로드) ─────────────────────────────────────────────
  //   MD가 이프두 표(방문시작·상품조회·장바구니조회·주문서작성·주문완료)를 올린다.
  //   방문시작·주문완료도 이프두 값으로 계산한다(2026-10-02~, lib/funnelDaily mallBase). 순매출·스토어 매출은 시스템이 자동으로 갖는다.
  //   스토어 유입수(비즈어드바이저)는 MD가 [📈 스토어 유입 입력]으로 직접 가져온다(아래 buildBizInflowUi).
  //   저장은 **파일에 있는 날짜만 덮어쓰기** — 이번 주치만 올려도 지난 데이터가 남는다.
  let _funnelFile = null;

  function buildFunnelUploadUi() {
    if (el('fnUpModal')) return;
    const m = document.createElement('div');
    m.id = 'fnUpModal'; m.className = 'imx'; m.style.display = 'none';
    m.innerHTML = `<div class="imx-box" style="max-width:880px">
      <div class="imx-head">
        <div><strong id="fnTitle">일일 퍼널 데이터 등록</strong>
          <div id="fnSub" class="imx-sub" style="font-size:12px;color:var(--muted)">이프두 표(방문시작 ~ 주문완료)를 올리면 됩니다 · 순매출·스토어 매출은 매일 자동으로 채워집니다</div></div>
        <button id="fnClose" class="imx-btn ghost mini" type="button">닫기 ✕</button>
      </div>
      <div class="imx-body">
        <div id="fnStatusWrap"><div id="fnStatus" class="imx-muted" style="font-size:12px;margin-bottom:10px">현황 확인 중…</div></div>

        <div id="fnGuide" class="imx-line" style="font-size:12px;margin-bottom:12px"></div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
          <a id="fnTpl" class="imx-btn ghost" href="/api/funnel/template" download>⤓ 예제 양식 받기</a>
          <label class="imx-btn" style="cursor:pointer;margin:0">
            📄 엑셀 선택<input id="fnFile" type="file" accept=".xlsx" style="display:none">
          </label>
          <span id="fnFileName" class="imx-muted" style="font-size:12px"></span>
        </div>

        <div id="fnDrop" style="border:2px dashed var(--line,#3a3a3a);border-radius:10px;padding:22px;text-align:center;color:var(--muted);font-size:13px;margin-bottom:12px">
          여기에 엑셀 파일을 끌어다 놓으셔도 됩니다
        </div>

        <div id="fnResult"></div>
      </div></div>`;
    document.body.appendChild(m);

    el('fnClose').addEventListener('click', closeFunnelUpload);
    m.addEventListener('click', (ev) => { if (ev.target === m) closeFunnelUpload(); });
    el('fnFile').addEventListener('change', (ev) => { const f = ev.target.files && ev.target.files[0]; if (f) pickFunnelFile(f); });

    const drop = el('fnDrop');
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.style.borderColor = 'var(--accent,#7E57C2)'; }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.style.borderColor = ''; }));
    drop.addEventListener('drop', (ev) => { const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]; if (f) pickFunnelFile(f); });
  }

  // mode: 'funnel'(기본) | 'targets' — 같은 업로드 경로를 쓰되 제목·양식·안내만 바꾼다.
  //   목표만 올리는 사람에게 퍼널 3단계 설명을 보여주면 헷갈린다.
  let _funnelMode = 'funnel';
  function openFunnelUpload(mode) {
    _funnelMode = mode === 'targets' ? 'targets' : 'funnel';
    buildFunnelUploadUi();
    const tg = _funnelMode === 'targets';
    el('fnTitle').textContent = tg ? '전사 월 목표 등록' : '일일 퍼널 데이터 등록';
    el('fnSub').textContent = tg
      ? '자사몰 · 스마트스토어 · 외부 몰별 월 목표 · 매출보고·퍼널·모니터링 메일 목표가 이 값으로 계산됩니다'
      : '이프두 표(방문시작 ~ 주문완료)를 올리면 됩니다 · 순매출·스토어 매출은 매일 자동으로 채워집니다';
    el('fnTpl').setAttribute('href', tg ? '/api/funnel/template?only=targets' : '/api/funnel/template');
    el('fnGuide').innerHTML = tg
      ? '<b>예제 양식에 노란 칸(순매출목표)만 채워 올리시면 됩니다</b><br>'
        + '<span class="imx-muted">양식에는 이번 달 기준으로 <b>자사몰 · 스마트스토어 · 지금 운영 중인 외부 몰</b>(최근 3개월 매출 있는 곳)이 미리 들어 있고, '
        + '이미 등록된 목표와 최근 3개월 월평균 매출이 같이 적혀 있습니다. 목표를 안 정할 몰은 비워 두세요 — 빈 줄은 반영하지 않습니다. '
        + '자사몰·스마트스토어 값은 <b>매출보고의 월 목표</b>(퍼널 단계별 목표도 여기서 역산), 외부 몰 값은 <b>몰별 목표</b>로 저장됩니다. '
        + '적지 않은 달·몰은 그대로 남습니다.</span>'
      : '<b>이프두 표 그대로</b> — 방문시작 · 상품조회 · 장바구니조회 · 주문서작성 · 주문완료<br>'
        + '<span class="imx-muted">방문시작·주문완료도 이 값으로 계산합니다(퍼널 목표가 이프두 기준). 아직 안 올린 날만 Cafe24 값으로 채워 둡니다. '
        + '순매출 · 스토어 매출은 시스템이 자동으로 가져옵니다(스토어 유입수는 📈 스토어 유입 입력).</span>';
    el('fnStatusWrap').style.display = tg ? 'none' : '';
    el('fnUpModal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    el('fnResult').innerHTML = ''; el('fnFileName').textContent = ''; _funnelFile = null;
    if (!tg) loadFunnelStatus();
  }
  function closeFunnelUpload() { if (el('fnUpModal')) el('fnUpModal').style.display = 'none'; document.body.style.overflow = ''; }

  async function loadFunnelStatus() {
    const box = el('fnStatus'); if (!box) return;
    try {
      const j = await (await fetch('/api/funnel/status')).json();
      const f = j.자사몰퍼널 || {};
      if (!f.적재) { box.innerHTML = '<b>등록된 퍼널 데이터가 없습니다</b> — 예제 양식을 받아 작성 후 올려주세요.'; return; }
      const miss = (j.최근7일_미입력 || []);
      const warn = miss.length
        ? `<span style="color:var(--warn,#e6c86a)">최근 7일 중 <b>${miss.length}일 미입력</b> (${miss.slice(0, 3).join(', ')}${miss.length > 3 ? ' 외' : ''})</span>`
        : '<span style="color:var(--green,#66BB6A)">최근 7일 모두 입력됨</span>';
      box.innerHTML = `현재 <b>${num(f.적재)}일</b> 등록됨 · 기간 ${f.기간 || '-'} · 최종 갱신 ${String(f.갱신 || '').slice(0, 16).replace('T', ' ')}<br>${warn}`;
    } catch (e) { box.textContent = '현황 조회 오류: ' + e.message; }
  }

  function pickFunnelFile(file) {
    _funnelFile = file;
    el('fnFileName').textContent = file.name;
    uploadFunnelExcel(false); // 먼저 미리보기
  }

  async function uploadFunnelExcel(apply) {
    const box = el('fnResult'); if (!_funnelFile) return;
    box.innerHTML = `<div class="imx-muted">${apply ? '반영 중…' : '파일 확인 중…'}</div>`;
    try {
      const buf = await _funnelFile.arrayBuffer();
      const r = await fetch('/api/funnel/upload' + (apply ? '?apply=1' : ''), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
      });
      const j = await r.json();

      if (!j.ok) {
        box.innerHTML = `<div class="imx-line" style="border-left-color:var(--warn,#e6c86a)">
          <b>오류 ${j.errors ? j.errors.length : 1}건 — 반영되지 않았습니다.</b> 고쳐서 다시 올려주세요.
          <ul style="margin:8px 0 0 16px;font-size:12px">${(j.errors || [j.error]).slice(0, 12).map((e) => `<li>${ae(e)}</li>`).join('')}</ul></div>`;
        return;
      }

      if (j.applied) {
        const sv = j.saved || {};
        const done = _funnelMode === 'targets'
          ? `월 목표 ${num(sv.월목표 || 0)}건`
          : `자사몰 ${num(sv.자사몰퍼널 || 0)}일 · 스마트스토어 ${num(sv.스마트스토어 || 0)}일${sv.월목표 ? ` · 월목표 ${num(sv.월목표)}건` : ''}`;
        box.innerHTML = `<div class="imx-line" style="border-left-color:var(--green,#66BB6A)">
          <b>✅ 반영 완료</b> — ${done}<br>
          <span class="imx-muted" style="font-size:12px">${_funnelMode === 'targets' ? '매출보고의 월 목표와 퍼널 단계 목표에 바로 반영됩니다.' : '퍼널 점검 화면에 바로 반영됩니다.'}</span>
          <div style="margin-top:8px"><button id="fnUndo" class="imx-btn ghost mini" type="button">↺ 직전 업로드 되돌리기</button></div></div>`;
        el('fnUndo').addEventListener('click', rollbackFunnel);
        loadFunnelStatus();
        afterApply(_funnelMode, box);
        return;
      }

      const p = j.preview || {};
      const chip = (label, n, color) => `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:${color};color:#111;font-weight:700;font-size:12px;margin-right:6px">${label} ${num(n)}</span>`;
      const warn = (j.warnings || []).length ? `<div class="imx-muted" style="font-size:12px;margin-top:8px">⚠️ ${(j.warnings || []).slice(0, 5).map(ae).join('<br>⚠️ ')}</div>` : '';
      const cmp = (p.대조 || []).length
        ? `<div style="margin-top:10px;font-size:12px"><b>시스템(Cafe24) 값과 대조</b> <span class="imx-muted">(참고 — 계산은 이프두 값으로 합니다)</span>
            <ul style="margin:4px 0 0 16px">${(p.대조 || []).slice(0, 6).map((x) => `<li>${ae(x.date)} ${ae(x.항목 || x.비고 || '')} — 이프두 ${num(x.이프두 || 0)} vs 시스템 ${num(x.시스템 || 0)} <b>(${x.차이_pct > 0 ? '+' : ''}${x.차이_pct}%)</b></li>`).join('')}</ul>
            <div class="imx-muted" style="margin-top:4px">${ae(p.대조요약 || '')}</div></div>`
        : `<div class="imx-muted" style="font-size:12px;margin-top:8px">시스템 값과 대조: ${ae(p.대조요약 || '이상 없음')}</div>`;
      const tgWarn = (p.월목표경고 || []).length
        ? `<ul style="margin:4px 0 0 16px;color:#b45309">${p.월목표경고.map((w) => `<li>⚠ ${ae(w)}</li>`).join('')}</ul>` : '';
      const tgt = (p.월목표변경 || []).length || tgWarn
        ? `<div style="margin-top:10px;font-size:12px"><b>월 목표 변경</b> <span class="imx-muted">(매출보고 목표도 함께 바뀝니다)</span>
            <ul style="margin:4px 0 0 16px">${(p.월목표변경 || []).map((x) => `<li>${ae(x.연월)} ${ae(x.채널)} — ${num(x.이전)} → <b>${num(x.변경)}</b></li>`).join('')}</ul>${tgWarn}</div>`
        : '';
      const chg = (p.수정상세 || []).length
        ? `<div style="margin-top:8px;font-size:12px"><b>수정되는 날짜</b> <span class="imx-muted">(상품조회/장바구니/주문서 · 방문·주문완료)</span>
            <ul style="margin:4px 0 0 16px">${p.수정상세.slice(0, 8).map((x) => `<li>${ae(x.date)} — ${ae(x.이전)} → <b>${ae(x.변경)}</b></li>`).join('')}</ul></div>`
        : '';

      box.innerHTML = `<div class="imx-line">
        <b>변경 내용 미리보기</b> <span class="imx-muted" style="font-size:12px">— 아직 반영되지 않았습니다</span><br>
        <div style="margin:10px 0">
          ${chip('신규', p.신규 || 0, '#A5D6A7')}${chip('수정', p.수정 || 0, '#FFE082')}${chip('변동없음', p.변동없음 || 0, '#CFD8DC')}
        </div>
        <div style="font-size:12px;color:var(--muted)">${ae(p.기간 || '')} · 자사몰 ${num(j.counts.자사몰퍼널 || 0)}행 · 스마트스토어 ${num(j.counts.스마트스토어 || 0)}행</div>
        ${chg}${tgt}${cmp}${warn}
        <div style="margin-top:12px;display:flex;gap:8px">
          <button id="fnApply" class="imx-btn" type="button">이대로 반영하기</button>
          <button id="fnCancel" class="imx-btn ghost" type="button">취소</button>
        </div></div>`;
      el('fnApply').addEventListener('click', () => uploadFunnelExcel(true));
      el('fnCancel').addEventListener('click', () => { box.innerHTML = ''; _funnelFile = null; el('fnFileName').textContent = ''; });
    } catch (e) {
      box.innerHTML = `<div class="imx-line" style="border-left-color:var(--warn,#e6c86a)">오류: ${ae(e.message)}</div>`;
    }
  }

  async function rollbackFunnel() {
    if (!confirm('직전 업로드 상태로 되돌릴까요?\n(그때 올린 날짜만 이전 값으로 복구됩니다)')) return;
    try {
      const j = await (await fetch('/api/funnel/rollback', { method: 'POST' })).json();
      const box = el('fnResult');
      if (!j.ok) { box.innerHTML = `<div class="imx-line" style="border-left-color:var(--warn,#e6c86a)">${ae(j.error || '되돌리기 실패')}</div>`; return; }
      const r = j.restored || {};
      box.innerHTML = `<div class="imx-line">↺ 되돌렸습니다 — 자사몰 ${num(r.자사몰퍼널 || 0)}일 · 스마트스토어 ${num(r.스마트스토어 || 0)}일${r.월목표 ? ` · 월목표 ${num(r.월목표)}건` : ''}</div>`;
      loadFunnelStatus();
    } catch (e) { alert('되돌리기 오류: ' + e.message); }
  }

  async function rollbackPromoDefs() {
    if (!confirm('직전 업로드 상태로 되돌릴까요?')) return;
    try {
      const j = await (await fetch('/api/promo-defs/rollback', { method: 'POST' })).json();
      el('puResult').innerHTML = j.ok
        ? `<div class="imx-line">↺ 되돌렸습니다 — ${num(j.restored)}건 복원 (${String(j.at || '').slice(0, 16).replace('T', ' ')} 시점)</div>`
        : `<div class="imx-line" style="border-left-color:var(--warn,#e6c86a)">${ae(j.error || '복원 실패')}</div>`;
      loadPromoDefStatus();
    } catch (e) { el('puResult').innerHTML = `<div class="imx-line">오류: ${ae(e.message)}</div>`; }
  }

  // ── 스마트스토어 유입 입력(비즈어드바이저) ──────────────────────────────────
  //   MD가 비즈어드바이저에서 "Copy as cURL" 한 텍스트를 붙여넣으면 서버(/api/bizadvisor/refresh)가 그 로그인 토큰으로
  //   일별 × 채널 유입수를 가져와 on.bizInflow 에 반영한다 → 퍼널 점검의 스토어 유입·마케팅 분석에 쓰인다.
  //   cURL 에는 네이버 로그인 토큰이 들어 있다 — 브라우저·서버 어디에도 저장하지 않고, 보내자마자 입력칸을 비운다.
  //   다 쓰면 비즈어드바이저 로그아웃 → 재로그인으로 토큰을 폐기하도록 안내한다.
  function buildBizInflowUi() {
    if (el('bizInModal')) return;
    const m = document.createElement('div');
    m.id = 'bizInModal'; m.className = 'imx'; m.style.display = 'none';
    const kst = new Date(Date.now() + 9 * 3600e3);
    const opt = (back, label) => {
      const d = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() - back, 1));
      const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1;
      return `<option value="${y}-${mo}"${back === 1 ? ' selected' : ''}>${label} (${y}년 ${mo}월부터)</option>`;
    };
    m.innerHTML = `<div class="imx-box" style="max-width:760px">
      <div class="imx-head">
        <div><strong>스마트스토어 유입 입력</strong>
          <div class="imx-sub" style="font-size:12px;color:var(--muted)">비즈어드바이저 유입수(일별 × 채널)를 가져옵니다 · 퍼널 점검의 스토어 유입에 바로 반영</div></div>
        <button id="biClose" class="imx-btn ghost mini" type="button">닫기 ✕</button>
      </div>
      <div class="imx-body">
        <div id="biStatus" class="imx-muted" style="font-size:12px;margin-bottom:10px">현황 확인 중…</div>
        <div class="imx-line" style="font-size:12.5px;line-height:1.75;margin-bottom:12px">
          <b>가져오는 방법</b> (1~2분)<br>
          ① 크롬에서 <b>비즈어드바이저</b>에 로그인하고, 채널별 유입수가 보이는 <b>마케팅 분석</b> 화면을 엽니다<br>
          ② <b>F12</b> → <b>Network</b> 탭 → 필터 칸에 <b>report</b> 입력 → 화면을 한 번 새로고침<br>
          ③ 목록의 <b>report?…</b> 요청을 오른쪽 클릭 → <b>Copy → Copy as cURL (bash)</b> → 아래 칸에 붙여넣고 <b>가져오기</b><br>
          <span style="color:var(--warn,#e6c86a)">붙여넣는 내용에는 로그인 정보가 들어 있습니다. 저장하지 않고 바로 지우며, 끝나면 비즈어드바이저에서 <b>로그아웃 → 다시 로그인</b>해 주세요.</span>
        </div>
        <textarea id="biCurl" rows="5" spellcheck="false" autocomplete="off" style="width:100%;box-sizing:border-box;font-family:Consolas,monospace;font-size:11.5px;border:1px solid var(--line2);border-radius:8px;padding:8px;resize:vertical" placeholder="curl 'https://bizadvisor.naver.com/api/v3/sites/s_…/report?…' -H 'authorization: Bearer …' …"></textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0 12px">
          <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px">가져올 기간
            <select id="biFrom" style="font:inherit;font-size:12.5px;padding:6px 8px;border:1px solid var(--line2);border-radius:8px">
              ${opt(0, '이번 달')}${opt(1, '지난달부터')}${opt(3, '최근 3개월')}<option value="2025-1">전체 (2025년 1월부터 · 1분 정도)</option>
            </select></label>
          <button id="biGo" class="imx-btn" type="button">가져오기</button>
        </div>
        <div id="biResult"></div>
      </div></div>`;
    document.body.appendChild(m);
    el('biClose').addEventListener('click', closeBizInflow);
    m.addEventListener('click', (ev) => { if (ev.target === m) closeBizInflow(); });
    el('biGo').addEventListener('click', runBizInflow);
  }
  function openBizInflow() {
    buildBizInflowUi();
    el('bizInModal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    el('biResult').innerHTML = ''; el('biCurl').value = '';
    loadBizInflowStatus();
  }
  function closeBizInflow() {
    if (el('bizInModal')) el('bizInModal').style.display = 'none';
    if (el('biCurl')) el('biCurl').value = '';
    document.body.style.overflow = '';
  }

  async function loadBizInflowStatus() {
    const box = el('biStatus'); if (!box) return;
    try {
      const from = new Date(Date.now() + 9 * 3600e3 - 45 * 86400e3).toISOString().slice(0, 10);
      const j = await (await fetch('/api/bizadvisor/inflow?start=' + from)).json();
      if (!j.ok) throw new Error(j.error || '조회 실패');
      if (!j.latestDate) { box.innerHTML = '최근 45일 안에 들어온 유입수가 없습니다 — 아래 방법으로 가져와 주세요.'; return; }
      const yst = new Date(Date.now() + 9 * 3600e3 - 86400e3).toISOString().slice(0, 10);
      const gap = Math.round((new Date(yst) - new Date(j.latestDate)) / 86400e3);
      const state = gap > 0
        ? `<span style="color:var(--warn,#e6c86a)">어제까지 <b>${gap}일</b> 비어 있습니다</span>`
        : '<span style="color:var(--green,#66BB6A)">어제까지 모두 들어와 있습니다</span>';
      box.innerHTML = `현재 반영된 마지막 날짜 <b>${ae(j.latestDate)}</b> · ${state}`;
    } catch (e) { box.textContent = '현황 조회 오류: ' + e.message; }
  }

  async function runBizInflow() {
    const ta = el('biCurl'), box = el('biResult'), btn = el('biGo');
    const curl = ta.value.trim();
    if (!/bizadvisor/i.test(curl) || !/bearer/i.test(curl)) {
      box.innerHTML = '<div class="imx-line" style="border-left-color:var(--warn,#e6c86a)">비즈어드바이저 요청의 cURL이 아닌 것 같습니다 — <b>Copy as cURL (bash)</b>로 복사한 전체 텍스트를 붙여넣어 주세요.</div>';
      return;
    }
    const [fy, fm] = el('biFrom').value.split('-').map(Number);
    ta.value = ''; // 로그인 정보가 화면에 남지 않게 바로 지운다
    btn.disabled = true;
    box.innerHTML = '<div class="imx-muted">가져오는 중… (기간에 따라 몇 초~1분)</div>';
    try {
      const r = await fetch('/api/bizadvisor/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curl, fromYear: fy, fromMonth: fm }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        const msg = j.error || `HTTP ${r.status}`;
        const hint = /인증 실패|토큰|Bearer|사이트ID/.test(msg) ? ' — 비즈어드바이저 화면을 새로고침한 뒤 cURL을 다시 복사해 주세요.' : '';
        box.innerHTML = `<div class="imx-line" style="border-left-color:var(--warn,#e6c86a)">가져오지 못했습니다: ${ae(msg)}${hint}</div>`;
        return;
      }
      const months = (j.months || []).map((x) => (x.error ? `${x.ym} 오류` : `${x.ym} ${num(x.rows)}건`)).join(' · ');
      box.innerHTML = `<div class="imx-line">✅ 가져왔습니다 — ${num(j.totalRows)}건 반영 (${ae(months)})<br>`
        + '<span class="imx-muted" style="font-size:12px">이제 비즈어드바이저에서 <b>로그아웃 → 다시 로그인</b>해 주세요(붙여넣은 로그인 정보 폐기).</span></div>';
      loadBizInflowStatus();
      afterApply('biz');
    } catch (e) {
      box.innerHTML = `<div class="imx-line" style="border-left-color:var(--warn,#e6c86a)">오류: ${ae(e.message)}</div>`;
    } finally { btn.disabled = false; }
  }

  // 반영 뒤 — 같은 페이지의 퍼널 점검(iframe)을 다시 그리고, 페이지가 필요하면 받아 쓰도록 이벤트를 보낸다.
  //   목표·프로모션은 화면의 숫자(매출보고·판매분석)가 열 때 계산된 값이라 새로고침 버튼을 같이 둔다.
  function afterApply(kind, box) {
    const f = el('funnelFrame');
    if (f && f.contentWindow && (kind === 'funnel' || kind === 'biz' || kind === 'targets')) { try { f.contentWindow.location.reload(); } catch (_) {} }
    try { window.dispatchEvent(new CustomEvent('input-modals:applied', { detail: { kind } })); } catch (_) {}
    if (box && (kind === 'promo' || kind === 'targets')) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'imx-btn ghost mini'; b.style.marginLeft = '6px';
      b.textContent = '↻ 이 화면 새로고침해서 보기';
      b.addEventListener('click', () => location.reload());
      const row = box.querySelector('.imx-line div:last-child');
      (row || box).appendChild(b);
    }
  }

  // Esc 로 닫기 — 열려 있는 창만
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (el('bizInModal') && el('bizInModal').style.display !== 'none') closeBizInflow();
    else if (el('fnUpModal') && el('fnUpModal').style.display !== 'none') closeFunnelUpload();
    else if (el('promoUpModal') && el('promoUpModal').style.display !== 'none') closePromoUpload();
  });

  const OPEN = { promo: openPromoUpload, targets: () => openFunnelUpload('targets'), funnel: () => openFunnelUpload('funnel'), biz: openBizInflow };
  window.InputModals = {
    open(kind) { const fn = OPEN[kind]; if (!fn) throw new Error('알 수 없는 입력 창: ' + kind); fn(); },
  };
  window.openPromoUpload = openPromoUpload;
  window.openFunnelUpload = openFunnelUpload;
  window.openBizInflow = openBizInflow;
})();
