/**
 * AI 분석 데이터 확인 — 일일 매출 대시보드(report-template.html) 맨 위 [🤖 AI 분석 데이터 확인] 버튼이 여는 화면.
 *
 *   MD 설계(md/AI분석카드_최종폼.html · AI분석시트_설계서.html, 2026-10-02)의 카드 모양으로 그린다.
 *     · 고른 기간의 날짜마다 카드 1장 + (2일 이상이면) 기간 종합 카드 1장. 처음 열면 어제 하루.
 *     · 카드의 숫자·판정·문장은 전부 데이터 기반(서버 규칙, lib/funnelAiCard ruleDay·rulePeriod) — 열자마자 보이고 비용 0.
 *     · 🤖 AI 조언은 참고 의견 — AI 가 같은 데이터를 한 번 더 보고 규칙이 놓친 점만 1~3문장. 버튼을 누를 때만, 저장 후 재사용
 *       (사용자 결정 2026-10-02: 토큰이 과하게 나가지 않게 AI 는 간략하게).
 *     · 🤖 AI 상세 분석 — MD 설계서 방식(AI 가 카드 문장 전체를 씀, Sonnet · 생각 보통, 장당 수십 원). 카드마다 버튼, 받으면 저장되고
 *       [데이터 분석 | 🤖 AI 상세 분석]으로 바꿔 본다. 이미 받은 날을 다시 누르면 "이미 받았습니다" 경고 후에만 다시 받는다(사용자 요청 2026-10-02).
 *     · 월요일엔 [지난 주말(금~일)] — 금·토·일 일자별 카드와 기간 종합을 한 번에(MD 요청).
 *   데이터: GET /api/funnel/cards · POST /api/funnel/cards/analyze(하루 AI 조언 · mode:'detail' 이면 상세 분석) · POST /api/funnel/cards/period(기간)
 */
(function () {
  'use strict';
  if (window.AiCards) return;

  var CSS = '' +
'.aic{--g:#2E7D5B;--g-bg:#E6F2EC;--r:#C0392B;--r-bg:#FBEAEA;--w:#B7791F;--w-bg:#FBF1DE;--n:#6B7280;--n-bg:#F1F2F4;--t:#1F6F80;--t-bg:#E4F0F2;--y-bg:#FBF3E2;'+
'  --ink:#1F2937;--sub:#4B5563;--mute:#9CA3AF;--line:#E6E3DB;font-family:inherit;color:var(--ink);}'+
'.aic *{box-sizing:border-box}'+
'.aic-top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:4px 0 14px}'+
'.aic-eyebrow{font-size:11px;font-weight:700;letter-spacing:.14em;color:var(--t);margin:0 0 4px}'+
'.aic-h1{font-size:22px;font-weight:800;margin:0;letter-spacing:-.02em}'+
'.aic-sub{font-size:12.5px;color:var(--sub);margin:4px 0 0}'+
'.aic-box{border:1.5px solid var(--t);border-radius:14px;background:#F7FAFA;padding:14px;margin-bottom:16px}'+
'.aic-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 12px}'+
'.aic-seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}'+
'.aic-seg button{border:0;background:#fff;padding:7px 14px;font:inherit;font-size:13px;font-weight:600;color:var(--sub);cursor:pointer}'+
'.aic-seg button.on{background:var(--ink);color:#fff}'+
'.aic-ctl input[type=date]{height:32px;border:1px solid var(--line);border-radius:8px;padding:0 8px;font:inherit;font-size:13px;background:#fff}'+
'.aic-chip{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 11px;font:inherit;font-size:12.5px;cursor:pointer;color:var(--sub)}'+
'.aic-chip.on{border-color:var(--t);color:var(--t);font-weight:700;background:var(--t-bg)}'+
'.aic-go{border:0;background:var(--ink);color:#fff;border-radius:8px;padding:7px 14px;font:inherit;font-size:13px;font-weight:700;cursor:pointer}'+
'.aic-go:disabled{opacity:.45;cursor:progress}'+
'.aic-go.light{background:#fff;color:var(--ink);border:1px solid var(--line)}'+
'.aic-stat{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 2px 4px;font-size:13px;color:var(--sub)}'+
'.aic-stat b{color:var(--ink)}'+
'.aic-stat .sp{margin-left:auto}'+
'.aic-note{font-size:12px;color:var(--w);background:var(--w-bg);border-radius:8px;padding:6px 10px;margin:6px 0 0}'+
'.aic-row{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:11px 14px;margin-top:8px;cursor:pointer}'+
'.aic-row:hover{border-color:#cfd4dc}'+
'.aic-row.period{border:1.5px solid var(--t)}'+
'.aic-row .dt{font-weight:700;font-size:14px;white-space:nowrap}'+
'.aic-row .vl{flex:1;min-width:0;font-size:12.5px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'+
'.aic-row .st{font-size:12px;color:var(--mute);white-space:nowrap}'+
'.aic-row .st.new{color:var(--w);font-weight:700}'+
'.aic-row .st.stale{color:var(--r);font-weight:700}'+
'.aic-row .tw{font-size:11px;color:var(--mute);transition:transform .15s}'+
'.aic-row.open .tw{transform:rotate(90deg)}'+
'.aic-badge{display:inline-block;border:1.5px solid;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:700;white-space:nowrap;background:#fff}'+
'.aic-badge.good{color:var(--g);border-color:var(--g);background:var(--g-bg)}'+
'.aic-badge.normal{color:var(--n);border-color:#C9CDD3}'+
'.aic-badge.warn{color:var(--w);border-color:var(--w);background:var(--w-bg)}'+
'.aic-badge.risk,.aic-badge.data_error{color:var(--r);border-color:var(--r);background:var(--r-bg)}'+
'.aic-badge.period{color:var(--t);border-color:var(--t)}'+
'.aic-badge.none{color:var(--mute);border-color:#D9DCE1}'+
'.aic-card{background:#fff;border:1px solid var(--line);border-left:6px solid var(--n);border-radius:12px;margin:8px 0 14px;overflow:hidden}'+
'.aic-card.good{border-left-color:var(--g)}.aic-card.warn{border-left-color:var(--w)}.aic-card.risk,.aic-card.data_error{border-left-color:var(--r)}.aic-card.period{border-left-color:var(--t)}'+
'.aic-ch{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--line);background:#FBFBFA}'+
'.aic-ch .tt{font-weight:800;font-size:15px}'+
'.aic-ch .kp{margin-left:auto;font-size:12.5px;color:var(--sub)}'+
'.aic-ch .kp b{color:var(--ink)}'+
'.aic-tag{font-size:11px;font-weight:600;border-radius:6px;padding:2px 7px;background:var(--n-bg);color:var(--sub)}'+
'.aic-tag.promo{background:#EEE8FA;color:#5B3FA0}.aic-tag.warn{background:var(--w-bg);color:var(--w)}.aic-tag.ex{background:var(--t-bg);color:var(--t)}'+
'.aic-blk{padding:12px 18px;border-bottom:1px solid #F0EEE8}'+
'.aic-blk:last-child{border-bottom:0}'+
'.aic-lb{font-size:10.5px;font-weight:700;letter-spacing:.12em;color:var(--mute);margin:0 0 6px}'+
'.aic-verdict{font-size:16.5px;font-weight:800;line-height:1.5;letter-spacing:-.01em}'+
'.aic-p{font-size:13.5px;line-height:1.7;margin:0}'+
'.aic-p + .aic-p{margin-top:4px}'+
'.aic-p.mute{color:var(--sub);font-size:12.5px}'+
'.aic-blk.bn-ok{background:var(--g-bg)}.aic-blk.bn-bad,.aic-blk.hold{background:var(--r-bg)}.aic-blk.gap{background:var(--y-bg)}.aic-blk.act{background:var(--t-bg)}.aic-blk.trend{background:var(--g-bg)}.aic-blk.rep{background:var(--y-bg)}'+
'.aic-pos{color:var(--g);font-weight:700}.aic-neg{color:var(--r);font-weight:700}'+
'.aic-steps{font-size:12.5px;color:var(--sub);margin:0 0 6px}'+
'.aic-steps span{white-space:nowrap}'+
'.aic-gaptop{font-size:14.5px;font-weight:800;margin:0 0 6px}'+
'.aic-bars{margin:6px 0 8px;display:grid;grid-template-columns:150px 1fr;gap:5px 10px;align-items:center;font-size:12.5px}'+
'.aic-bars .nm{color:var(--sub)}.aic-bars .nm b{color:var(--ink);font-size:13px}'+
'.aic-bar{position:relative;height:18px}'+
'.aic-bar:before{content:"";position:absolute;left:50%;top:-3px;bottom:-3px;border-left:1px solid #C9CDD3}'+
'.aic-bar i{position:absolute;top:3px;height:12px;border-radius:3px}'+
'.aic-bar i.n{background:#D0574A;right:50%}.aic-bar i.p{background:#3E9A6E;left:50%}.aic-bar i.t{background:#7B8187}'+
'.aic-bar em{position:absolute;top:0;font-style:normal;font-size:11.5px;font-weight:700;white-space:nowrap}'+
'.aic-ol{margin:0;padding:0;list-style:none}'+
'.aic-ol li{font-size:13.5px;line-height:1.65;margin:2px 0}'+
'.aic-ol li .ck{color:var(--sub)}'+
'.aic-act{display:grid;grid-template-columns:20px 54px 1fr;gap:4px 8px;align-items:start;margin:6px 0}'+
'.aic-act .no{font-weight:800;color:var(--t);font-size:13.5px;padding-top:2px}'+
'.aic-act .eta{border:1px solid #BCD7DC;background:#fff;border-radius:6px;font-size:11.5px;font-weight:700;text-align:center;padding:2px 0;color:var(--t)}'+
'.aic-act .ti{font-weight:700;font-size:13.5px;line-height:1.5}'+
'.aic-act .wy{grid-column:3;font-size:12.5px;color:var(--sub);line-height:1.55;margin-top:-2px}'+
'.aic-foot{padding:9px 18px;font-size:11.5px;color:var(--mute);font-family:ui-monospace,Consolas,monospace;letter-spacing:.02em;display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#FBFBFA}'+
'.aic-foot .sp{margin-left:auto}'+
'.aic-foot button{font-family:inherit}'+
'.aic-pending{padding:14px 18px;font-size:13px;color:var(--sub);display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#FCFCFB}'+
'.aic-pending.err{color:var(--r);background:var(--r-bg)}'+
'.aic-det{padding:0 18px 10px}'+
'.aic-det summary{cursor:pointer;font-size:12px;color:var(--sub);padding:8px 0;list-style:none}'+
'.aic-det summary::-webkit-details-marker{display:none}'+
'.aic-tblw{overflow-x:auto}'+
'.aic-tbl{width:100%;border-collapse:collapse;font-size:12px}'+
'.aic-tbl th,.aic-tbl td{padding:5px 6px;border-bottom:1px solid #F0EEE8;text-align:right;white-space:nowrap}'+
'.aic-tbl th:first-child,.aic-tbl td:first-child{text-align:left}'+
'.aic-tbl th{color:var(--mute);font-weight:600}'+
'.aic-case{display:inline-block;min-width:18px;text-align:center;border-radius:4px;font-weight:800;font-size:11px;padding:0 4px}'+
'.aic-case.A{background:var(--r-bg);color:var(--r)}.aic-case.B,.aic-case.C{background:var(--w-bg);color:var(--w)}.aic-case.D{background:#FDE7D6;color:#B4501C}.aic-case.E{background:var(--g-bg);color:var(--g)}'+
'.aic-chips{display:flex;gap:6px;flex-wrap:wrap}'+
'.aic-empty{padding:28px;text-align:center;color:var(--sub);font-size:13px}'+
'.aic-spin{display:inline-block;width:14px;height:14px;border:2px solid #D7DCE2;border-top-color:var(--t);border-radius:50%;animation:aicspin .8s linear infinite;vertical-align:-2px}'+
'@keyframes aicspin{to{transform:rotate(360deg)}}'+
'.aic-how{background:#fff;border:1px solid var(--line);border-left:4px solid var(--t);border-radius:10px;padding:10px 14px;margin:0 0 12px;font-size:12.5px;color:var(--sub);line-height:1.65}'+
'.aic-how b{color:var(--ink)}.aic-how ul{margin:4px 0 0;padding-left:18px}'+
'.aic-blk.ai{background:#F3F0FA}.aic-blk.ai .aic-lb{color:#5B3FA0}'+
'.aic-row .st.ai,.aic-row .st.det{color:#5B3FA0;font-weight:700}'+
'.aic-mode{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 18px;border-bottom:1px solid #E7E1F3;background:#FAF8FE;font-size:12.5px;color:var(--sub);line-height:1.5}'+
'.aic-mode .aic-seg button{padding:5px 12px;font-size:12.5px}'+
'.aic-mode .aic-seg button.ai.on{background:#5B3FA0}'+
'.aic-mode .sp{margin-left:auto}'+
'.aic-mode .err{color:var(--r)}'+
'.aic-go.ai{background:#5B3FA0}'+
'.aic-go.ai.light{background:#fff;color:#5B3FA0;border:1px solid #CFC3EA}'+
'.aic-card.aiv .aic-lb{color:#7A64B8}'+
'@media (max-width:700px){.aic-bars{grid-template-columns:110px 1fr}.aic-ch .kp{margin-left:0}}';

  var DOW = ['일', '월', '화', '수', '목', '금', '토'];
  var BADGE = { good: '좋음', normal: '정상', warn: '주의', risk: '위험', data_error: '데이터 이상' };
  var CASE_TXT = { A: '진짜 병목', B: '의지 목표 갭', C: '의지 목표 갭', D: '조용한 악화', E: '정상' };
  // view: 카드별 보기(rule = 데이터 분석 · ai = AI 상세 분석, 기본은 받았으면 ai) · busyKey/busyKind: 지금 받는 카드(상세 분석 진행 표시)
  var S = { ch: 'mall', start: null, end: null, data: null, open: {}, view: {}, busy: false, busyKey: null, busyKind: '', progress: '', loading: false, err: '' };

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function comma(n) { return n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('ko-KR'); }
  function won(n) { if (n == null || !isFinite(n)) return '—'; var v = Math.round(n); return (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('ko-KR') + '원'; }
  function swon(n) { if (n == null || !isFinite(n)) return '—'; var v = Math.round(n); return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('ko-KR') + '원'; }
  function spp(n) { if (n == null) return '—'; return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + '%p'; }
  function spct(n) { if (n == null) return '—'; return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1) + '%'; }
  function sgnCls(n) { return n > 0 ? 'aic-pos' : n < 0 ? 'aic-neg' : ''; }
  function kst(d) { return new Date((d ? d.getTime() : Date.now()) + 9 * 3600e3); }
  function iso(dt) { return dt.toISOString().slice(0, 10); }
  function shift(s, k) { var d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return iso(d); }
  function yday() { return shift(iso(kst()), -1); }
  function dowOf(s) { return new Date(s + 'T00:00:00Z').getUTCDay(); }
  function dlabel(s) { var p = s.split('-'); return p[1] + '.' + p[2] + ' (' + DOW[dowOf(s)] + ')'; }
  function dfull(s) { return s.replace(/-/g, '.') + ' (' + DOW[dowOf(s)] + ')'; }
  function when(s) { if (!s) return ''; var k = kst(new Date(s)); return iso(k).replace(/-/g, '.').slice(2) + ' ' + k.toISOString().slice(11, 16); }
  function root() { return document.getElementById('aiCardsRoot'); }
  // 지난 주말(금~일) — 어제 이전의 가장 가까운 일요일까지. 월요일에 열면 바로 그 금·토·일(MD 요청: 월요일에 주말 3일치를 한 번에)
  function lastWeekend() { var e = yday(); while (dowOf(e) !== 0) e = shift(e, -1); return [shift(e, -2), e]; }

  function injectCss() { if (document.getElementById('aic-style')) return; var st = document.createElement('style'); st.id = 'aic-style'; st.textContent = CSS; document.head.appendChild(st); }

  // ── 데이터 ──
  function load() {
    S.loading = true; S.err = ''; draw();
    var q = '/api/funnel/cards?start=' + S.start + '&end=' + S.end + '&ch=' + S.ch;
    return fetch(q, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      S.loading = false;
      if (!j.ok) { S.err = j.error || '불러오지 못했습니다'; S.data = null; draw(); return; }
      S.data = j;
      // 처음 열 때 — 기간 종합(있으면)과 가장 최근 날 카드를 펼친다
      if (!Object.keys(S.open).length) {
        if (j.period) S.open.P = true;
        var last = j.days[j.days.length - 1]; if (last) S.open[last.date] = true;
      }
      draw();
    }).catch(function (e) { S.loading = false; S.err = e.message; draw(); });
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error || 'AI 요청 실패'); return j; });
  }
  function replaceDay(card) { if (S.data) S.data.days = S.data.days.map(function (d) { return d.date === card.date ? card : d; }); }
  function adviceOne(date, regenerate) {
    if (S.busy) return;
    S.busy = true; S.progress = dlabel(date) + ' AI 조언 받는 중…'; S.open[date] = true; draw();
    post('/api/funnel/cards/analyze', { date: date, ch: S.ch, regenerate: !!regenerate })
      .then(function (j) { replaceDay(j.card); })
      .catch(function (e) { alert(dlabel(date) + ' AI 조언 실패 — ' + e.message); })
      .then(function () { S.busy = false; S.progress = ''; draw(); });
  }
  function advicePeriod(regenerate) {
    if (S.busy || !S.data) return;
    S.busy = true; S.progress = '기간 AI 조언 받는 중…'; S.open.P = true; draw();
    post('/api/funnel/cards/period', { start: S.start, end: S.end, ch: S.ch, regenerate: !!regenerate })
      .then(function (j) { S.data.period = j.period; })
      .catch(function (e) { alert('기간 AI 조언 실패 — ' + e.message); })
      .then(function () { S.busy = false; S.progress = ''; draw(); });
  }
  function needAdvice(d) { return (d.status === 'ok' || d.status === 'data_error') && (!d.saved || d.saved.ai_error); }
  // 한꺼번에 — 조언이 없는 날만, 오래된 날부터, 최대 7일. 기간이 7일을 넘으면 기간 조언만(설계서 §5 상한)
  function batch() {
    if (S.busy || !S.data) return;
    var max = (S.data.cfg && S.data.cfg.batchMax) || 7;
    var todo = S.data.days.length > max ? [] : S.data.days.filter(needAdvice).map(function (d) { return d.date; });
    var p = S.data.period, needP = p && (!p.saved || p.saved.ai_error);
    if (!todo.length && !needP) return;
    S.busy = true; draw();
    var i = 0;
    function next() {
      if (i < todo.length) {
        var d = todo[i]; S.progress = 'AI 조언 ' + (i + 1) + ' / ' + todo.length + ' — ' + dlabel(d); draw();
        return post('/api/funnel/cards/analyze', { date: d, ch: S.ch }).then(function (j) { replaceDay(j.card); }).catch(function (e) { console.warn(d, e.message); })
          .then(function () { i++; return next(); });
      }
      if (needP) {
        S.progress = '기간 AI 조언 받는 중…'; draw();
        return post('/api/funnel/cards/period', { start: S.start, end: S.end, ch: S.ch }).then(function (j) { S.data.period = j.period; S.open.P = true; }).catch(function (e) { console.warn('period', e.message); });
      }
    }
    Promise.resolve(next()).then(function () { S.busy = false; S.progress = ''; draw(); });
  }

  // ── 🤖 AI 상세 분석 — MD 설계서 방식(AI 가 카드 문장 전체를 씀) ──
  function hasDetail(x) { return !!(x && x.detail && x.detail.text); }
  function viewOf(x, key) { return hasDetail(x) && S.view[key] !== 'rule' ? 'ai' : 'rule'; }
  function textOf(x, key) { return viewOf(x, key) === 'ai' ? x.detail.text : x.rule || {}; }
  function needDetail(d) { return (d.status === 'ok' || d.status === 'data_error') && !hasDetail(d); }
  function cardName(key) { return key === 'P' && S.data.period ? '기간 종합(' + dlabel(S.data.period.period.start) + ' ~ ' + dlabel(S.data.period.period.end) + ')' : dlabel(key); }
  // 이미 받은 분석을 다시 누르면 — 오늘 받았으면 "오늘 HH:MM", 아니면 저장 시각을 보여 주고 비용이 한 번 더 든다고 알린다
  function warnText(x, key) {
    var dt = x.detail, at = dt.createdAt ? new Date(dt.createdAt) : null;
    var t = !at ? '' : iso(kst(at)) === iso(kst()) ? '오늘 ' + kst(at).toISOString().slice(11, 16) : when(dt.createdAt);
    return '⚠ ' + cardName(key) + ' · ' + (S.data.channel || '') + ' AI 상세 분석은 이미 받았습니다' + (t ? ' (' + t + ' 저장)' : '') + '.\n\n' +
      (x.detailStale ? '그 뒤로 데이터가 바뀌어서 다시 받아도 됩니다.\n' : '저장된 분석은 [🤖 AI 상세 분석]에서 그대로 볼 수 있습니다.\n') +
      '다시 받으면 토큰 비용이 한 번 더 듭니다. 다시 받을까요?';
  }
  function detailOne(key) {
    if (S.busy || !S.data) return;
    var isP = key === 'P', x = isP ? S.data.period : S.data.days.filter(function (d) { return d.date === key; })[0];
    if (!x) return;
    var regen = hasDetail(x);
    if (regen && !confirm(warnText(x, key))) { delete S.view[key]; draw(); return; } // 취소 — 저장된 분석을 보여 준다
    S.busy = true; S.busyKey = key; S.busyKind = 'detail'; S.progress = cardName(key) + ' AI 상세 분석 받는 중…'; S.open[key] = true; draw();
    (isP ? post('/api/funnel/cards/period', { start: S.start, end: S.end, ch: S.ch, mode: 'detail', regenerate: regen })
      : post('/api/funnel/cards/analyze', { date: key, ch: S.ch, mode: 'detail', regenerate: regen }))
      .then(function (j) { if (isP) S.data.period = j.period; else replaceDay(j.card); delete S.view[key]; })
      .catch(function (e) { alert(cardName(key) + ' AI 상세 분석 실패 — ' + e.message); })
      .then(function () { S.busy = false; S.busyKey = null; S.busyKind = ''; S.progress = ''; draw(); });
  }
  // 한꺼번에 — 아직 안 받은 날만(이미 받은 날은 건너뜀 · 비용 중복 없음), 오래된 날부터, 최대 7일 + 기간 종합. 전부 받았으면 경고만
  function batchDetail() {
    if (S.busy || !S.data) return;
    var max = (S.data.cfg && S.data.cfg.batchMax) || 7, over = S.data.days.length > max;
    var ok = S.data.days.filter(function (d) { return d.status === 'ok' || d.status === 'data_error'; });
    var todo = over ? [] : ok.filter(needDetail).map(function (d) { return d.date; });
    var skip = over ? 0 : ok.length - todo.length;
    var p = S.data.period, needP = !!(p && !hasDetail(p));
    if (!todo.length && !needP) {
      alert('⚠ 선택 기간의 AI 상세 분석은 이미 모두 받았습니다.\n\n받은 분석은 카드마다 저장돼 있어 [🤖 AI 상세 분석]으로 바로 볼 수 있습니다.\n다시 받으려면 그 카드의 [↻ 다시 받기]를 누르세요(비용이 한 번 더 듭니다).');
      return;
    }
    S.busy = true; S.busyKind = 'detail'; draw();
    var i = 0, tail = skip ? ' · 이미 받은 ' + skip + '일은 건너뜀' : '';
    function next() {
      if (i < todo.length) {
        var d = todo[i]; S.busyKey = d; S.progress = 'AI 상세 분석 ' + (i + 1) + ' / ' + todo.length + ' — ' + dlabel(d) + tail; draw();
        return post('/api/funnel/cards/analyze', { date: d, ch: S.ch, mode: 'detail' }).then(function (j) { replaceDay(j.card); delete S.view[d]; }).catch(function (e) { console.warn(d, e.message); })
          .then(function () { i++; return next(); });
      }
      if (needP) {
        S.busyKey = 'P'; S.open.P = true; S.progress = '기간 종합 AI 상세 분석 받는 중…' + tail; draw();
        return post('/api/funnel/cards/period', { start: S.start, end: S.end, ch: S.ch, mode: 'detail' }).then(function (j) { S.data.period = j.period; delete S.view.P; }).catch(function (e) { console.warn('period', e.message); });
      }
    }
    Promise.resolve(next()).then(function () { S.busy = false; S.busyKey = null; S.busyKind = ''; S.progress = ''; draw(); });
  }

  // ── 그리기 ──
  function draw() {
    var el = root(); if (!el) return;
    var h = '<div class="aic">';
    h += '<div class="aic-top"><div><p class="aic-eyebrow">AI DAILY ANALYSIS · YOGIBO</p><h2 class="aic-h1">🤖 AI 분석 데이터 확인</h2>' +
      '<p class="aic-sub">자사몰 · 스마트스토어 일일 퍼널 분석 — 고른 기간의 날짜마다 카드 1장, 2일 이상이면 기간 종합 카드가 함께 나옵니다.</p></div></div>';
    h += '<div class="aic-how"><b>이 화면은 이렇게 만들어집니다</b>' +
      '<ul><li><b>기간·일자별 분석은 데이터 기반</b>입니다 — 숫자·판정·문장 모두 우리 데이터(이카운트·Cafe24·이프두·비즈어드바이저)로 서버 규칙이 만들어 열자마자 보입니다. 비용이 들지 않습니다.</li>' +
      '<li><b>🤖 AI 조언은 참고 의견</b>입니다 — AI가 같은 데이터를 한 번 더 확인해 규칙 분석이 놓쳤을 수 있는 점만 짧게 덧붙입니다. 버튼을 누를 때만 만들고(토큰 절약을 위해 간략하게), 한 번 받은 조언은 저장됩니다.</li>' +
      '<li><b>🤖 AI 상세 분석</b>은 MD 설계서 방식입니다 — 서버가 계산한 숫자를 AI(Claude Sonnet)가 받아 카드 문장 전체(판정·병목·가설·액션)를 다시 씁니다. 카드의 버튼을 누를 때만 만들고(장당 수십 원), 받은 분석은 저장돼 <b>[데이터 분석 | 🤖 AI 상세 분석]</b>으로 바꿔 봅니다. 이미 받은 날을 다시 누르면 경고가 뜹니다.</li>' +
      '<li>월요일에는 <b>[지난 주말]</b>을 누르면 금·토·일 일자별 카드와 기간 종합을 한 번에 봅니다.</li></ul></div>';
    h += '<div class="aic-box">' + controls() + status() + list() + '</div>';
    h += '<p class="aic-p mute" style="margin:0 2px 20px">배지는 <b>순매출 7일평균 대비</b>로 매깁니다(의지 목표 달성률은 헤더에 숫자로만). 케이스 — A 진짜 병목 · B/C 의지 목표 갭(오늘의 문제 아님) · D 조용한 악화 · E 정상. 의지 목표 갭은 유입·전환·객단가 금액으로 나눠 봅니다(임원 보고용).</p>';
    el.innerHTML = h + '</div>';
    bind();
  }
  function controls() {
    var y = yday();
    var pre = [['1', '어제'], ['w', '지난 주말(금~일)'], ['3', '최근 3일'], ['7', '최근 7일'], ['m', '이번 달']];
    var cur = presetOf();
    return '<div class="aic-ctl">' +
      '<span class="aic-seg"><button type="button" data-ch="mall" class="' + (S.ch === 'mall' ? 'on' : '') + '">자사몰</button><button type="button" data-ch="ss" class="' + (S.ch === 'ss' ? 'on' : '') + '">스마트스토어</button></span>' +
      '<input type="date" id="aicS" max="' + y + '" value="' + S.start + '"> ~ <input type="date" id="aicE" max="' + y + '" value="' + S.end + '">' +
      '<button type="button" class="aic-go light" id="aicGo">조회</button>' +
      pre.map(function (p) { return '<button type="button" class="aic-chip' + (cur === p[0] ? ' on' : '') + '" data-pre="' + p[0] + '">' + p[1] + '</button>'; }).join('') +
      '</div>';
  }
  function presetOf() {
    var y = yday(), w = lastWeekend();
    if (S.start === w[0] && S.end === w[1]) return 'w';
    if (S.end !== y) return '';
    if (S.start === y) return '1';
    if (S.start === shift(y, -2)) return '3';
    if (S.start === shift(y, -6)) return '7';
    if (S.start === y.slice(0, 8) + '01') return 'm';
    return '';
  }
  function status() {
    if (S.loading) return '<div class="aic-stat"><span class="aic-spin"></span> 불러오는 중…</div>';
    if (S.err) return '<div class="aic-stat" style="color:#C0392B">불러오지 못했습니다 — ' + esc(S.err) + '</div>';
    if (!S.data) return '';
    var d = S.data.days, n = d.length, max = (S.data.cfg && S.data.cfg.batchMax) || 7;
    var ready = d.filter(function (x) { return x.rule; }).length;
    var adv = d.filter(function (x) { return x.saved && !x.saved.ai_error; }).length;
    var todo = d.filter(needAdvice).length;
    var na = d.filter(function (x) { return x.status === 'no_data' || x.status === 'pending_input'; }).length;
    var p = S.data.period, needP = p && (!p.saved || p.saved.ai_error);
    var label = n > max ? (needP ? '기간 AI 조언 받기' : '') : (todo || needP) ? ('🤖 AI 조언 받기 — ' + (todo ? todo + '일' : '') + (todo && needP ? ' + ' : '') + (needP ? '기간' : '')) : '';
    var det = d.filter(hasDetail).length, dtodo = n > max ? 0 : d.filter(needDetail).length, dneedP = !!(p && !hasDetail(p));
    var anyOk = d.some(function (x) { return x.status === 'ok' || x.status === 'data_error'; });
    var dDone = n > max ? !dneedP : !dtodo && !dneedP; // 받을 게 없으면 버튼은 연하게 — 누르면 "이미 모두 받았습니다" 경고
    var dLabel = !anyOk ? '' : dDone ? '🤖 AI 상세 분석 — 모두 받음' : n > max ? '🤖 기간 AI 상세 분석 받기'
      : '🤖 AI 상세 분석 받기 — ' + (dtodo ? dtodo + '일' : '') + (dtodo && dneedP ? ' + ' : '') + (dneedP ? '기간' : '');
    var h = '<div class="aic-stat"><span>선택 기간 <b>' + S.start + (n > 1 ? ' ~ ' + S.end : '') + '</b> (' + n + '일)</span>' +
      '<span>· 데이터 분석 <b>' + ready + '</b>일 · AI 조언 <b>' + adv + '</b>일 · AI 상세 <b>' + det + '</b>일' + (na ? ' · 입력 대기 ' + na + '일' : '') + '</span>' +
      (label ? '<button type="button" class="aic-go" id="aicBatch"' + (S.busy ? ' disabled' : '') + ' title="Claude Sonnet · 날마다 몇 초 · 받은 조언은 저장">' + label + '</button>' : '') +
      (dLabel ? '<button type="button" class="aic-go ai' + (dDone ? ' light' : '') + '" id="aicBatchD"' + (S.busy ? ' disabled' : '') + ' title="MD 설계서 방식 · Claude Sonnet(생각 보통) · 날마다 10~30초 · 장당 수십 원 · 이미 받은 날은 건너뜀">' + dLabel + '</button>' : '') +
      (S.progress ? '<span><span class="aic-spin"></span> ' + esc(S.progress) + '</span>' : '') +
      '<span class="sp" style="font-size:11.5px;color:#9CA3AF">AI 모델 ' + esc(S.data.modelDetail || S.data.model || '') + '</span></div>';
    if (n > max) h += '<p class="aic-note">' + max + '일이 넘는 기간은 기간 종합(조언·상세 분석)만 한꺼번에 받습니다 — 날짜별은 카드를 펼쳐 따로 누르세요(데이터 분석은 모든 날짜에 이미 나와 있습니다).</p>';
    return h;
  }
  function list() {
    if (!S.data || S.loading) return '';
    var h = '', p = S.data.period;
    if (p) {
      h += '<div class="aic-row period' + (S.open.P ? ' open' : '') + '" data-open="P"><span class="aic-badge period">기간 종합</span><span class="dt">' + dlabel(p.period.start) + ' ~ ' + dlabel(p.period.end) + '</span>' +
        '<span class="vl">' + esc(textOf(p, 'P').summary_line || '') + '</span>' + detTag(p) + advTag(p) + '<span class="tw">▶</span></div>';
      if (S.open.P) h += periodCard(p);
    }
    S.data.days.slice().reverse().forEach(function (d) {
      var st = d.status === 'pending_input' ? '<span class="st new">유입 입력 대기</span>' : d.status === 'no_data' ? '<span class="st">데이터 없음</span>' : detTag(d) + advTag(d);
      h += '<div class="aic-row' + (S.open[d.date] ? ' open' : '') + '" data-open="' + d.date + '"><span class="aic-badge ' + (d.badge || 'none') + '">' + (BADGE[d.badge] || '—') + '</span><span class="dt">' + dlabel(d.date) + '</span>' +
        '<span class="vl">' + esc(d.rule ? textOf(d, d.date).verdict_line || '' : (d.note || '')) + '</span>' + st + '<span class="tw">▶</span></div>';
      if (S.open[d.date]) h += dayCard(d);
    });
    if (!S.data.days.length) h += '<div class="aic-empty">선택한 기간에 날짜가 없습니다.</div>';
    return h;
  }
  function detTag(x) { return hasDetail(x) ? '<span class="st det">🤖 AI 상세' + (x.detailStale ? ' · 데이터 바뀜' : '') + '</span>' : ''; }
  function advTag(x) {
    if (!x.saved) return '<span class="st">AI 조언 없음</span>';
    if (x.saved.ai_error) return '<span class="st stale">AI 조언 실패</span>';
    return '<span class="st ai">🤖 AI 조언' + (x.saved.source === 'example' ? '(예제)' : '') + (x.stale ? ' · 이후 데이터 바뀜' : '') + '</span>';
  }

  // 카드 머리 — 배지 · 날짜 · 채널 · 프로모션 · 핵심 2지표
  function head(d) {
    var tags = (d.promo || []).map(function (p) { return '<span class="aic-tag promo">' + (p.day_after_end ? '프로모션 종료 다음날 · ' : p.first_day ? '프로모션 첫날 · ' : '프로모션 · ') + esc(p.name) + '</span>'; }).join('');
    var ds = d.data_status || {};
    if (d.ch === 'mall' && ds.inflow_source === 'Cafe24') tags += '<span class="aic-tag warn">유입 Cafe24 대체(이프두 업로드 전)</span>';
    if (d.ch === 'mall' && ds.ifdu_3steps === false) tags += '<span class="aic-tag warn">이프두 3단계 미입력</span>';
    if (d.baseline_note) tags += '<span class="aic-tag warn">기준선 부족</span>';
    var hl = d.headline || {};
    var kp = d.status === 'data_error'
      ? '유입 집계 <b>' + comma((d.steps || [])[0] && d.steps[0].cur) + '</b> · 의지 목표 <b>' + (hl.net_vs_target_pct != null ? hl.net_vs_target_pct + '%' : '—') + '</b>'
      : '7일평균 대비 <b class="' + sgnCls(hl.net_vs_avg7_pct) + '">' + spct(hl.net_vs_avg7_pct) + '</b> · 의지 목표 <b>' + (hl.net_vs_target_pct != null ? hl.net_vs_target_pct + '%' : '—') + '</b>';
    return '<div class="aic-ch"><span class="aic-badge ' + (d.badge || 'none') + '">' + (BADGE[d.badge] || '—') + '</span><span class="tt">' + dfull(d.date) + ' · ' + esc(d.channel) + '</span>' + tags + '<span class="kp">' + kp + '</span></div>';
  }
  // 단계별 7일평균 대비 — 자사몰은 비율 단계만(설계서 예시), 스토어는 단계가 둘뿐이라 유입(%)도 함께
  function stepLine(d) {
    return '<p class="aic-steps">' + (d.steps || []).filter(function (s) { return s.key !== 'inflow' || d.ch === 'ss'; }).map(function (s) {
      if (s.key === 'inflow') return '<span>유입 <b class="' + sgnCls(s.vs_avg7_pct) + '">' + spct(s.vs_avg7_pct) + '</b></span>';
      if (s.hold) return '<span>' + esc(s.name) + ' 판단 보류</span>';
      return '<span>' + esc(s.name) + ' <b class="' + sgnCls(s.vs_avg7_pp) + '">' + spp(s.vs_avg7_pp) + '</b></span>';
    }).join(' · ') + ' <span style="color:#9CA3AF">(모두 7일평균 대비)</span></p>';
  }
  // 갭 분해 막대 — 가운데(0) 기준 왼쪽 마이너스 · 오른쪽 플러스, 길이는 금액에 비례. 금액 글자는 막대 반대편에 둬 넘치지 않게
  function gapBars(w, d) {
    var inflow = (d.steps || [])[0] ? d.steps[0].cur : null;
    var rows = [
      ['유입', w.inflow, comma(inflow) + '명 vs 목표 ' + comma(w.target_inflow) + '명'],
      ['전환', w.conversion, (d.ch === 'ss' ? '구매율 ' : '주문완료율 ') + (w.cur_rate_pct != null ? w.cur_rate_pct.toFixed(2) + '%' : '—') + ' vs ' + (w.target_rate_pct != null ? w.target_rate_pct.toFixed(2) + '%' : '—')],
      ['객단가', w.aov, won(w.cur_aov) + ' vs ' + won(w.target_aov)],
    ];
    if (w.other) rows.push([w.other.label.split(' — ')[0], w.other.amount, w.other.label.split(' — ')[1] || '']);
    var max = Math.max.apply(null, rows.map(function (r) { return Math.abs(r[1] || 0); }).concat([Math.abs(w.total || 0), 1]));
    var bar = function (v, total) {
      var pct = Math.max(1, Math.round((Math.abs(v) / max) * 46));
      var cls = total ? 't' : v < 0 ? 'n' : 'p';
      var pos = v < 0 ? 'right:50%' : 'left:50%';
      var lab = v < 0 ? 'left:calc(50% + 6px)' : 'right:calc(50% + 6px)';
      return '<div class="aic-bar"><i class="' + cls + '" style="width:' + pct + '%;' + pos + '"></i><em class="' + (total ? '' : sgnCls(v)) + '" style="' + lab + '">' + swon(v) + '</em></div>';
    };
    var h = '<div class="aic-bars">';
    rows.forEach(function (r) { h += '<div class="nm"><b>' + esc(r[0]) + '</b><br>' + esc(r[2] || '') + '</div>' + bar(r[1] || 0); });
    return h + '<div class="nm"><b>합계</b><br>실제 − 목표</div>' + bar(w.total || 0, true) + '</div>';
  }
  function actions(list, label) {
    return '<div class="aic-blk act"><p class="aic-lb">' + label + '</p>' + ((list || []).length ? list.map(function (a, i) {
      return '<div class="aic-act"><span class="no">' + (i + 1) + '</span><span class="eta">' + (a.eta_min ? a.eta_min + '분' : '—') + '</span><span class="ti">' + esc(a.title) + '</span><span class="wy">' + esc(a.why) + '</span></div>';
    }).join('') : '<p class="aic-p">조치 불필요</p>') + '</div>';
  }
  function aiMeta(dt) {
    var u = dt.usage || {};
    return 'Claude ' + esc(String(dt.model || '').replace(/^claude-/, '')) + ' · ' + esc(when(dt.createdAt)) + ' 저장' + (u.input ? ' · 토큰 입력 ' + comma(u.input) + ' · 출력 ' + comma(u.output) : '');
  }
  // 🤖 AI 상세 분석 줄 — [데이터 분석 | 🤖 AI 상세 분석] 보기 전환 + 받기 버튼. 이미 받았으면 [↻ 다시 받기] → 경고 후에만
  function modeBar(x, key) {
    var dt = x.detail, has = hasDetail(x), v = viewOf(x, key), me = S.busy && S.busyKey === key && S.busyKind === 'detail';
    var h = '<div class="aic-mode">';
    if (has) h += '<span class="aic-seg"><button type="button" data-view="' + key + '" data-v="rule"' + (v === 'rule' ? ' class="on"' : '') + '>데이터 분석</button><button type="button" data-view="' + key + '" data-v="ai" class="ai' + (v === 'ai' ? ' on' : '') + '">🤖 AI 상세 분석</button></span>';
    if (me) h += '<span><span class="aic-spin"></span> AI 상세 분석 받는 중… 보통 10~30초</span>';
    else if (has && v === 'ai') h += '<span>문장은 AI가 서버 계산값으로 썼습니다 — 숫자·막대·케이스는 데이터 기반 그대로' +
      (x.detailStale ? ' · <b class="err">분석 이후 데이터가 바뀌었습니다</b>' : '') + (dt.ai_error ? ' · <span class="err">다시 받기 실패(' + esc(when(dt.errorAt)) + ') — 이전 분석을 보여 줍니다</span>' : '') + '</span>';
    else if (has) h += '<span>데이터 기반 분석을 보는 중 · AI 상세 분석 저장됨(' + esc(when(dt.createdAt)) + ')</span>';
    else if (dt && dt.ai_error) h += '<span class="err">AI 상세 분석을 받지 못했습니다 — ' + esc(dt.ai_error) + '</span>';
    else h += '<span><b>🤖 AI 상세 분석</b> — AI가 MD 설계서 방식으로 이 카드 문장 전체(판정·병목·가설·액션)를 다시 씁니다. 누를 때만 · 받은 분석은 저장</span>';
    if (!me) h += '<span class="sp"></span><button type="button" class="aic-go ai' + (has ? ' light' : '') + '" data-detail="' + key + '"' + (S.busy ? ' disabled' : '') + ' title="Claude Sonnet · 생각 깊이 보통 · 장당 수십 원">' +
      (has ? '↻ 다시 받기' : dt && dt.ai_error ? '🤖 다시 시도' : '🤖 AI 상세 분석 받기') + '</button>';
    return h + '</div>';
  }
  // 🤖 AI 조언 — 데이터 분석(규칙)이 놓쳤을 수 있는 점만. 없으면 받기 버튼
  function aiBlock(x, kind) {
    var sv = x.saved;
    var h = '<div class="aic-blk ai"><p class="aic-lb">🤖 AI 조언 <span style="letter-spacing:0;font-weight:500">— AI가 같은 데이터를 한 번 더 확인한 참고 의견(간략)</span></p>';
    if (sv && !sv.ai_error) {
      h += sv.advice && sv.advice.length ? '<ul class="aic-ol">' + sv.advice.map(function (a) { return '<li>· ' + esc(a) + '</li>'; }).join('') + '</ul>' : '<p class="aic-p">데이터 분석이 놓친 점은 없다는 의견입니다.</p>';
      h += '<p class="aic-p mute" style="margin-top:4px">Claude · ' + esc(sv.model || '') + ' · ' + when(sv.createdAt) + ' 저장' + (sv.source === 'example' ? ' · 예제(Claude Code 작성)' : '') + (x.stale ? ' · <span style="color:#C0392B">조언 이후 데이터가 바뀌었습니다</span>' : '') +
        (sv.source === 'example' || x.stale ? ' <button type="button" class="aic-go light" data-act="' + kind + '" data-regen="1"' + (S.busy ? ' disabled' : '') + '>↻ Sonnet으로 다시 받기</button>' : '') + '</p>';
    } else if (sv && sv.ai_error) {
      h += '<p class="aic-p" style="color:#C0392B">AI 조언을 받지 못했습니다 — ' + esc(sv.ai_error) + ' <button type="button" class="aic-go light" data-act="' + kind + '" data-regen="1"' + (S.busy ? ' disabled' : '') + '>다시 시도</button></p>';
    } else {
      h += '<p class="aic-p">아직 받지 않았습니다. <button type="button" class="aic-go" data-act="' + kind + '"' + (S.busy ? ' disabled' : '') + '>🤖 AI 조언 받기</button> <span style="font-size:11.5px;color:#9CA3AF">Claude Sonnet · 몇 초 · 토큰 소량</span></p>';
    }
    return h + '</div>';
  }

  function dayCard(d) {
    if (d.status === 'no_data' || d.status === 'pending_input') {
      return '<div class="aic-card"><div class="aic-ch"><span class="aic-badge none">—</span><span class="tt">' + dfull(d.date) + ' · ' + esc(d.channel) + '</span></div>' +
        '<div class="aic-pending">' + esc(d.note || '데이터가 없습니다') + '</div></div>';
    }
    var aiv = viewOf(d, d.date) === 'ai', t = textOf(d, d.date), err = d.status === 'data_error';
    var h = '<div class="aic-card ' + (d.badge || 'normal') + (aiv ? ' aiv' : '') + '">' + head(d) + modeBar(d, d.date);
    h += '<div class="aic-blk"><p class="aic-lb">한 줄 판정</p><div class="aic-verdict">' + esc(t.verdict_line) + '</div></div>';
    if (err) {
      h += '<div class="aic-blk hold"><p class="aic-lb" style="color:#C0392B">판단 보류</p><p class="aic-p">' + esc(t.bottleneck_text) + '</p></div>';
    } else {
      var ol = d.opportunity_loss;
      h += '<div class="aic-blk ' + (d.bottleneck ? 'bn-bad' : 'bn-ok') + '"><p class="aic-lb">' + (d.ch === 'ss' ? '구매율 점검' : '오늘의 병목') + '</p>' +
        '<p class="aic-p"><b>' + (d.bottleneck ? esc(d.bottleneck) + ' — 진짜 병목' : '없음') + '</b>' + (ol ? ' · 기회손실 ' + (ol.minor ? '영향 미미' : '약 ' + won(ol.amount) + ' (약 ' + ol.orders + '건, 추정)') : '') + '</p>' +
        stepLine(d) +
        ((d.quiet_decline || []).length ? '<p class="aic-p"><b style="color:#B4501C">조용한 악화</b> — 목표는 넘겼지만 7일평균보다 나빠진 단계: ' + d.quiet_decline.map(esc).join(' · ') + '</p>' : '') +
        '<p class="aic-p">' + esc(t.bottleneck_text) + '</p></div>';
    }
    if (t.good_text) h += '<div class="aic-blk"><p class="aic-lb">' + (err ? '그래도 읽을 수 있는 것' : '잘된 것') + '</p><p class="aic-p">' + esc(t.good_text) + '</p></div>';
    if (!err && d.will_gap) {
      var w = d.will_gap;
      h += '<div class="aic-blk gap"><p class="aic-lb">의지 목표 갭 — 임원 보고용</p>' +
        '<p class="aic-gaptop">의지 목표에 <span class="' + sgnCls(w.total) + '">' + (w.total < 0 ? won(-w.total) + ' 못 미쳤습니다' : won(w.total) + ' 넘겼습니다') + '</span>' +
        ' <span style="font-weight:500;font-size:12px;color:#6B7280">실제 ' + won(w.actual) + ' − 목표 ' + won(w.target) + '(퍼널 목표 곱)</span></p>' +
        gapBars(w, d) + (t.will_gap_text ? '<p class="aic-p">' + esc(t.will_gap_text) + '</p>' : '') + '</div>';
    }
    if ((t.hypotheses || []).length) {
      h += '<div class="aic-blk"><p class="aic-lb">원인 가설 — ' + esc(d.bottleneck || '') + ' 병목</p><ul class="aic-ol">' +
        t.hypotheses.map(function (x, i) { return '<li>' + '①②③'.charAt(i) + ' ' + esc(x.text) + (x.how_to_check ? ' <span class="ck">→ ' + esc(x.how_to_check) + '</span>' : '') + '</li>'; }).join('') + '</ul></div>';
    }
    // 상품 신호(블록 H) — MD 가 상품 매핑·설정 할인율을 넣으면 서버가 채운다. 0개면 블록 생략
    if (aiv && t.product_text) h += '<div class="aic-blk"><p class="aic-lb">상품 신호</p><p class="aic-p">' + esc(t.product_text) + '</p></div>';
    else if ((d.product_signals || []).length) {
      h += '<div class="aic-blk"><p class="aic-lb">상품 신호</p><ul class="aic-ol">' + d.product_signals.slice(0, 3).map(function (x) {
        return '<li><b>' + esc(x.name || '') + '</b> — ' + esc(x.detail || '') + ' <span class="ck">' + esc(x.type) + (x.consecutive_days > 1 ? ' · ' + x.consecutive_days + '일 연속' : '') + '</span></li>';
      }).join('') + '</ul></div>';
    }
    h += actions(t.actions, '액션') + (aiv ? '' : aiBlock(d, d.date)) + detail(d) + foot(d, aiv);
    return h + '</div>';
  }

  // 판정 근거 — 단계별 비율 표(접힘)
  function detail(d) {
    var rows = (d.steps || []).map(function (s) {
      if (s.key === 'inflow') return '<tr><td>유입</td><td>' + comma(s.cur) + '명</td><td>' + comma(s.target) + '</td><td>' + comma(s.avg7) + '</td><td>' + spct(s.vs_target_pct) + '</td><td>' + spct(s.vs_avg7_pct) + '</td><td>' + caseChip(s) + '</td></tr>';
      if (s.hold) return '<tr><td>' + esc(s.name) + '</td><td colspan="5" style="text-align:left">' + esc(s.hold) + '</td><td></td></tr>';
      return '<tr><td>' + esc(s.name) + '</td><td>' + (s.cur_pct != null ? s.cur_pct.toFixed(2) + '%' : '—') + ' <span style="color:#9CA3AF">(' + comma(s.cur) + ')</span></td><td>' + (s.target_pct != null ? s.target_pct.toFixed(2) + '%' : '—') + '</td><td>' + (s.avg7_pct != null ? s.avg7_pct.toFixed(2) + '%' : '—') + '</td><td>' + spp(s.vs_target_pp) + '</td><td>' + spp(s.vs_avg7_pp) + '</td><td>' + caseChip(s) + '</td></tr>';
    }).join('');
    var n = d.net_revenue || {};
    var extra = d.ch === 'mall' ? '주문 이프두 ' + comma(n.orders) + '건 · Cafe24 ' + comma(n.orders_cafe24) + '건' : '판매 ' + won(n.sales) + (n.returns ? ' · 반품 ' + won(n.returns) : '') + ' · 판매 주문 ' + comma(n.orders) + '건';
    return '<details class="aic-det"><summary>▸ 판정 근거 — 단계별 비율 · 케이스 · 순매출</summary>' +
      '<div class="aic-tblw"><table class="aic-tbl"><thead><tr><th>단계</th><th>당일</th><th>목표</th><th>7일평균</th><th>vs 목표</th><th>vs 7일평균</th><th>케이스</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="aic-p mute" style="margin-top:6px">순매출 ' + won(n.actual) + ' (일 목표 ' + won(n.target_daily) + ' · 7일평균 ' + won(n.avg7) + ') · 객단가 ' + won(n.aov) + ' (7일평균 ' + won(n.aov_avg7) + ' · 목표 ' + won(n.aov_target) + ') · ' + extra + '</p></details>';
  }
  function caseChip(s) {
    if (!s.case) return '';
    return '<span class="aic-case ' + s.case + '" title="' + esc(CASE_TXT[s.case]) + '">' + s.case + '</span>' + (s.consecutive_days > 1 ? ' <span style="color:#9CA3AF">' + s.consecutive_days + '일째</span>' : '');
  }
  function foot(d, aiv) {
    var ds = d.data_status || {}, parts = [aiv ? '문장 — 🤖 AI 상세 분석(' + aiMeta(d.detail) + ')' : '분석 — 데이터 기반(서버 규칙)'];
    if (d.ch === 'mall') { parts.push('이프두 3단계 ' + (ds.ifdu_3steps ? '입력됨' : '미입력')); parts.push('유입 ' + (ds.inflow_source || '—')); parts.push('순매출 Cafe24'); }
    else { parts.push('스토어 유입 ' + (ds.inflow_uploaded ? '입력됨' : '미입력')); parts.push('순매출 이카운트 원장'); }
    parts.push('기준선 7일평균');
    return '<div class="aic-foot">' + parts.join(' · ') + '</div>';
  }

  function periodCard(p) {
    var aiv = viewOf(p, 'P') === 'ai', t = textOf(p, 'P'), tt = p.totals || {};
    var h = '<div class="aic-card period' + (aiv ? ' aiv' : '') + '"><div class="aic-ch"><span class="aic-badge period">기간 종합</span><span class="tt">' + p.period.start.replace(/-/g, '.') + ' ~ ' + p.period.end.slice(5).replace('-', '.') + ' · ' + esc(p.channel) + ' · ' + p.period.days + '일</span>' +
      '<span class="kp">의지 목표 <b>' + (tt.achievement_pct != null ? tt.achievement_pct + '%' : '—') + '</b> · 순매출 ' + won(tt.net) + '</span></div>' + modeBar(p, 'P');
    h += '<div class="aic-blk"><p class="aic-lb">한 줄 요약</p><div class="aic-verdict">' + esc(t.summary_line) + '</div></div>';
    h += '<div class="aic-blk"><p class="aic-lb">일자별 상태</p><div class="aic-chips">' + (p.badges || []).map(function (b) {
      return '<span class="aic-badge ' + (b.badge || 'none') + '">' + b.date.slice(8) + '(' + DOW[dowOf(b.date)] + ') ' + (BADGE[b.badge] || (b.status === 'pending_input' ? '입력 대기' : '없음')) + '</span>';
    }).join('') + '</div></div>';
    var reps = (p.repeat_patterns || []).filter(function (r) { return r.n; });
    h += '<div class="aic-blk rep"><p class="aic-lb">반복 패턴</p>' +
      '<p class="aic-steps">' + reps.map(function (r) { return '<span>' + esc(r.name) + ' 진짜 병목 <b' + (r.is_structural ? ' class="aic-neg"' : '') + '>' + r.A + '/' + r.n + '일</b>' + (r.B + r.C ? ' · 의지 목표 갭 ' + (r.B + r.C) + '일' : '') + (r.D ? ' · 조용한 악화 ' + r.D + '일' : '') + '</span>'; }).join(' &nbsp;|&nbsp; ') + '</p>' +
      '<ul class="aic-ol">' + (t.repeat_patterns || []).map(function (r) { return '<li>' + (r.is_structural ? '<b class="aic-neg">구조 신호</b> ' : '') + esc(r.text) + '</li>'; }).join('') + '</ul></div>';
    var wk = p.weekday || {};
    h += '<div class="aic-blk"><p class="aic-lb">요일 패턴</p>' +
      '<p class="aic-steps">' + (wk.weekend ? '<span>주말 ' + wk.weekend.days + '일 평균 순매출 <b>' + won(wk.weekend.net_avg) + '</b> (의지 목표 ' + wk.weekend.net_vs_target_avg_pct + '%)</span>' : '') +
      (wk.weekend && wk.weekday ? ' &nbsp;|&nbsp; ' : '') + (wk.weekday ? '<span>평일 ' + wk.weekday.days + '일 평균 <b>' + won(wk.weekday.net_avg) + '</b> (의지 목표 ' + wk.weekday.net_vs_target_avg_pct + '%)</span>' : '') + '</p>' +
      (t.weekday_note ? '<p class="aic-p">' + esc(t.weekday_note) + '</p>' : '') + '</div>';
    var g = p.gap_trend || {};
    h += '<div class="aic-blk trend"><p class="aic-lb">의지 갭 추세</p>' +
      '<p class="aic-p">기간 평균 갭 <b class="' + sgnCls(g.avg_gap) + '">' + swon(g.avg_gap) + '</b> / 일' +
      (g.prev_avg_gap != null ? ' — 직전 같은 기간 평균 ' + swon(g.prev_avg_gap) + ' 대비 <b class="' + sgnCls(g.vs_prev_period) + '">' + (g.vs_prev_period >= 0 ? won(g.vs_prev_period) + ' 축소' : won(-g.vs_prev_period) + ' 확대') + '</b>' : '') + '</p>' +
      '<p class="aic-steps">기여도 평균 — 유입 <b class="' + sgnCls(g.avg_inflow) + '">' + swon(g.avg_inflow) + '</b> · 전환 <b class="' + sgnCls(g.avg_conversion) + '">' + swon(g.avg_conversion) + '</b> · 객단가 <b class="' + sgnCls(g.avg_aov) + '">' + swon(g.avg_aov) + '</b></p>' +
      (t.gap_trend_text ? '<p class="aic-p">' + esc(t.gap_trend_text) + '</p>' : '') + '</div>';
    var tr = p.step_trends || [];
    if (tr.length) {
      h += '<div class="aic-blk"><p class="aic-lb">단계별 추세 — 직전 같은 기간 대비</p><p class="aic-steps">' + tr.map(function (x) {
        return '<span>' + esc(x.name) + ' <b class="' + (x.direction === '개선' ? 'aic-pos' : x.direction === '악화' ? 'aic-neg' : '') + '">' + (x.direction || '—') + ' ' + spp(x.delta_pp) + '</b></span>';
      }).join(' · ') + '</p>' + (aiv && t.trend_text ? '<p class="aic-p">' + esc(t.trend_text) + '</p>' : '') + '</div>';
    }
    h += actions(t.actions, '기간 액션') + (aiv ? '' : aiBlock(p, 'P'));
    var notes = (p.data_notes || []).length ? '참고 — ' + p.data_notes.map(esc).join(', ') + ' · ' : '';
    return h + '<div class="aic-foot">' + notes + (aiv ? '문장 — 🤖 AI 상세 분석(' + aiMeta(p.detail) + ')' : '분석 — 데이터 기반(서버 규칙)') + ' · 일자별 카드 ' + p.period.days + '장은 아래에</div></div>';
  }

  // ── 이벤트 ──
  function bind() {
    var el = root(); if (!el) return;
    el.querySelectorAll('[data-ch]').forEach(function (b) { b.onclick = function () { if (S.busy || S.ch === b.dataset.ch) return; S.ch = b.dataset.ch; S.open = {}; S.view = {}; load(); }; });
    el.querySelectorAll('[data-pre]').forEach(function (b) {
      b.onclick = function () {
        if (S.busy) return;
        var y = yday(), p = b.dataset.pre;
        if (p === 'w') { var w = lastWeekend(); S.start = w[0]; S.end = w[1]; }
        else { S.end = y; S.start = p === '1' ? y : p === '3' ? shift(y, -2) : p === '7' ? shift(y, -6) : y.slice(0, 8) + '01'; }
        S.open = {}; S.view = {}; load();
      };
    });
    var go = el.querySelector('#aicGo');
    if (go) go.onclick = function () {
      if (S.busy) return;
      var a = el.querySelector('#aicS').value, b = el.querySelector('#aicE').value, y = yday();
      if (!a || !b) return;
      if (a > b) { var tmp = a; a = b; b = tmp; }
      if (b > y) b = y; if (a > y) a = y;
      S.start = a; S.end = b; S.open = {}; S.view = {}; load();
    };
    var bt = el.querySelector('#aicBatch'); if (bt) bt.onclick = batch;
    var bd = el.querySelector('#aicBatchD'); if (bd) bd.onclick = batchDetail;
    el.querySelectorAll('[data-detail]').forEach(function (b) { b.onclick = function (ev) { ev.stopPropagation(); detailOne(b.dataset.detail); }; });
    el.querySelectorAll('[data-view]').forEach(function (b) { b.onclick = function (ev) { ev.stopPropagation(); S.view[b.dataset.view] = b.dataset.v; draw(); }; });
    el.querySelectorAll('[data-open]').forEach(function (r) { r.onclick = function () { var k = r.dataset.open; S.open[k] = !S.open[k]; draw(); }; });
    el.querySelectorAll('[data-act]').forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var k = b.dataset.act, regen = b.dataset.regen === '1';
        if (regen && !confirm('Claude Sonnet으로 AI 조언을 다시 받습니다(토큰 소량 사용). 진행할까요?')) return;
        if (k === 'P') advicePeriod(regen); else adviceOne(k, regen);
      };
    });
  }

  // ── 열기 — 대시보드의 다른 탭을 숨기고 이 화면만 ──
  function open() {
    injectCss();
    if (!S.start) { S.end = yday(); S.start = S.end; }
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.tab-panel').forEach(function (x) { x.classList.remove('active'); x.style.display = 'none'; });
    var p = document.getElementById('t12');
    if (p) { p.classList.add('active'); p.style.display = 'block'; }
    var btn = document.getElementById('btnAiCards'); if (btn) btn.classList.add('on');
    try { if (location.hash !== '#ai') history.replaceState(null, '', location.pathname + location.search + '#ai'); } catch (_) {}
    if (!S.data && !S.loading) load(); else draw();
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) {}
  }
  // 다른 탭을 누르면 이 화면은 기존 탭 동작으로 숨겨진다 — 버튼 표시·주소의 #ai 만 정리
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('.tab');
    if (!t) return;
    var btn = document.getElementById('btnAiCards'); if (btn) btn.classList.remove('on');
    try { if (location.hash === '#ai') history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
  });

  window.AiCards = { open: open };
  window.openAiCards = open;
  // /api/report#ai 로 들어오면 바로 이 화면 — 같은 페이지에서 주소의 #ai 만 바뀌어도(새로 읽지 않음) 연다
  if (location.hash === '#ai') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', open); else open(); }
  window.addEventListener('hashchange', function () { if (location.hash === '#ai') open(); });
})();
