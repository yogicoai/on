'use strict';
/**
 * 일일매출보고 HTML → 통합분석용 템플릿 생성.
 *   ① 배포용 HTML 생성 버튼(btnDeploy) 제거  ② Report Text 탭(t7) 버튼 제거
 *   ③ 4개 데이터 태그(ds-main/products/promo/traffic) 내용을 placeholder 로 교체 → 엔드포인트가 라이브 주입
 *   결과: public/report-template.html
 */
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'Yogibo_온라인 일일매출보고_20260621.html');
const OUT = path.join(__dirname, '..', 'public', 'report-template.html');

let html = fs.readFileSync(SRC, 'utf8');
const before = html.length;

function removeBetween(h, startStr, endStr) {
  const s = h.indexOf(startStr);
  if (s < 0) { console.warn('  ⚠ 못 찾음:', startStr.slice(0, 40)); return h; }
  const e = h.indexOf(endStr, s) + endStr.length;
  return h.slice(0, s) + h.slice(e);
}
function replaceScript(h, id, placeholder) {
  const tag = '<script id="' + id + '" type="application/json">';
  const s = h.indexOf(tag);
  if (s < 0) { console.warn('  ⚠ 데이터 태그 못 찾음:', id); return h; }
  const cs = s + tag.length;
  const e = h.indexOf('</script>', cs);
  return h.slice(0, cs) + placeholder + h.slice(e);
}

// ① 배포용 HTML 생성 버튼 제거
html = removeBetween(html, '<button id="btnDeploy"', '</button>');
// ② Report Text 탭 버튼 제거 (패널 t7 은 버튼 없으면 활성 안 되므로 그대로 둬도 무해)
html = removeBetween(html, '<button class="tab" data-tab="t7">', '</button>');
// ②-2 하드코딩 TARGET_CONFIG → placeholder (목표를 전부 DB에서 주입)
(function () {
  const s = html.indexOf('const TARGET_CONFIG = {');
  if (s < 0) { console.warn('  ⚠ TARGET_CONFIG 못 찾음'); return; }
  const e = html.indexOf('\n};', s); // 최상위 닫는 }; (col 0)
  if (e < 0) { console.warn('  ⚠ TARGET_CONFIG 닫는 }; 못 찾음'); return; }
  html = html.slice(0, s) + 'const TARGET_CONFIG = __DS_TARGET__;' + html.slice(e + 3);
})();
// ②-3 헤더에 '← 판매 분석'(대시보드 복귀) 버튼 추가 — 첫 번째 .controls(헤더)
html = html.replace('<div class="controls">', '<div class="controls">' +
  '<a href="/" class="btn" title="판매 분석 대시보드로 돌아가기" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px">← 판매 분석</a>' +
  '<a href="/?openpt=1" class="btn" title="프로모션 목표 추가·수정 (대시보드에서 열림)" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px">🎯 목표 설정</a>');
// ②-4 하드코딩 EXT_CHANNELS(외부채널 사이트별 목표) → placeholder (byMall 목표 주입)
(function () {
  const s = html.indexOf('const EXT_CHANNELS = [');
  if (s < 0) { console.warn('  ⚠ EXT_CHANNELS 못 찾음'); return; }
  const e = html.indexOf('\n];', s); // 최상위 닫는 ]; (col 0)
  if (e < 0) { console.warn('  ⚠ EXT_CHANNELS 닫는 ]; 못 찾음'); return; }
  html = html.slice(0, s) + 'const EXT_CHANNELS = __DS_EXT__;' + html.slice(e + 3);
})();
// ②-5 5월 프로모션 리뷰 섹션 제거(숨김) — 데이터 하드코딩 + 월 고정이라 제외
html = html.replace('<div id="mayPromoReviewSection" style="', '<div id="mayPromoReviewSection" style="display:none;');
// ③ 데이터 태그 → placeholder
html = replaceScript(html, 'ds-main', '__DS_MAIN__');
html = replaceScript(html, 'ds-products', '__DS_PRODUCTS__');
html = replaceScript(html, 'ds-promo', '__DS_PROMO__');
html = replaceScript(html, 'ds-traffic', '__DS_TRAFFIC__');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`✅ 템플릿 생성: ${OUT}`);
console.log(`   크기 ${(before / 1048576).toFixed(2)}MB → ${(html.length / 1048576).toFixed(2)}MB (데이터 제거)`);
console.log(`   placeholder: ${['__DS_MAIN__', '__DS_PRODUCTS__', '__DS_PROMO__', '__DS_TRAFFIC__', '__DS_TARGET__', '__DS_EXT__'].filter((p) => html.includes(p)).length}/6`);
console.log(`   하드코딩 남음 — TARGET_CONFIG: ${html.includes('"2026-06":')} · EXT_CHANNELS: ${html.includes("name:'쿠팡'")} · 5월리뷰 숨김: ${html.includes('id="mayPromoReviewSection" style="display:none;')}`);
