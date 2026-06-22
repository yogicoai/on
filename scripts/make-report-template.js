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
// ③ 데이터 태그 → placeholder
html = replaceScript(html, 'ds-main', '__DS_MAIN__');
html = replaceScript(html, 'ds-products', '__DS_PRODUCTS__');
html = replaceScript(html, 'ds-promo', '__DS_PROMO__');
html = replaceScript(html, 'ds-traffic', '__DS_TRAFFIC__');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`✅ 템플릿 생성: ${OUT}`);
console.log(`   크기 ${(before / 1048576).toFixed(2)}MB → ${(html.length / 1048576).toFixed(2)}MB (데이터 제거)`);
console.log(`   placeholder: ${['__DS_MAIN__', '__DS_PRODUCTS__', '__DS_PROMO__', '__DS_TRAFFIC__'].filter((p) => html.includes(p)).length}/4`);
console.log(`   btnDeploy 남음? ${html.includes('btnDeploy')} · Report Text 탭 남음? ${html.includes('data-tab="t7"')}`);
