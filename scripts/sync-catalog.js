'use strict';

/**
 * 제품/색상 카탈로그 동기화 — youtube 프로젝트의 products.json·colorchips.json → onlineData DB.
 *   적재처: catalog_products(제품 70종) · catalog_colors(표준 색상칩 25종). 전량 갱신(deleteMany→insertMany).
 *   업데이트: youtube 쪽 데이터가 바뀌면 이 스크립트를 재실행하면 MCP에 반영된다.
 *
 *   사용법:  node scripts/sync-catalog.js  [소스폴더]
 *     예)   node scripts/sync-catalog.js
 *           node scripts/sync-catalog.js "C:\\Users\\Yogibo Design\\Desktop\\youtube\\data"
 */

const fs = require('fs');
const path = require('path');
const store = require('../lib/store');

const SRC = process.argv[2] || 'C:\\Users\\Yogibo Design\\Desktop\\youtube\\data';

(async () => {
  const rd = (f) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
  let products, colors;
  try { products = rd('products.json'); colors = rd('colorchips.json'); }
  catch (e) { console.error('❌ 소스 파일 읽기 실패:', e.message, '\n   경로:', SRC, '\n   (youtube 프로젝트의 data 폴더 경로를 인자로 넘겨주세요)'); process.exit(1); }

  if (!Array.isArray(products) || !Array.isArray(colors)) { console.error('❌ JSON 형식이 배열이 아닙니다'); process.exit(1); }

  const now = new Date().toISOString();

  // 전속 모델 — src/app/models/page.js 의 const CATEGORIES 배열을 추출(FTP 주입 후 평가) → 모델 단위로 평탄화.
  //   status = "어떤 식으로 등록됐는지"(시트 완성도·착석 제품 등). 파일이 없거나 형식이 바뀌면 모델만 건너뛴다.
  const modelsPage = path.join(SRC, '..', 'src', 'app', 'models', 'page.js');
  let models = [];
  try {
    const src = fs.readFileSync(modelsPage, 'utf8');
    const FTP = (src.match(/const FTP\s*=\s*['"]([^'"]+)['"]/) || [])[1] || '';
    const m = src.match(/const CATEGORIES\s*=\s*(\[[\s\S]*?\n\]);/);
    if (!m) throw new Error('CATEGORIES 배열을 찾지 못함');
    const CATEGORIES = new Function('FTP', 'return ' + m[1])(FTP); // FTP만 주입해 배열 리터럴 평가
    for (const cat of CATEGORIES) {
      for (const md of (cat.models || [])) {
        models.push({
          카테고리: cat.cat, 카테고리설명: cat.spec || '', code: md.code, 이름: md.name,
          키: md.size || '', 외모: md.identity || '', 상태: md.status || '',
          참조이미지: md.ref || null, 시트: md.sheets || null,
          ...(md.video ? { 영상: md.videoPoster || md.video, 영상메모: md.videoNote || '' } : {}),
          _syncedAt: now,
        });
      }
    }
  } catch (e) { console.warn('⚠️ 모델 추출 건너뜀:', e.message, '(경로:', modelsPage, ')'); }

  const pc = await store.collection('catalog_products');
  const cc = await store.collection('catalog_colors');

  await pc.deleteMany({}); await pc.insertMany(products.map((p) => ({ ...p, _syncedAt: now })));
  await cc.deleteMany({}); await cc.insertMany(colors.map((c) => ({ ...c, _syncedAt: now })));

  let mCount = 0;
  if (models.length) { const mc = await store.collection('catalog_models'); await mc.deleteMany({}); await mc.insertMany(models); mCount = models.length; }

  console.log(`✅ 카탈로그 적재 완료 — 제품 ${products.length}건 · 색상 ${colors.length}건 · 모델 ${mCount}명`);
  console.log(`   기준시각 ${now} · 소스 ${SRC}`);
  await store.close();
  setTimeout(() => process.exit(0), 100);
})().catch((e) => { console.error('💥', e.message); process.exit(1); });
