'use strict';

/**
 * 리뷰 분석 자료 적재 — 마케팅팀이 넘긴 폴더(지식 문서 txt + 자사몰·스마트스토어 리뷰 엑셀) → DB(MCP 리뷰 도구용).
 *   규칙은 lib/reviewIngest.js. 지식 문서·카피 은행은 전량 교체, 리뷰는 채널:리뷰번호로 덮어쓴다.
 *
 *   사용법: node scripts/import-reviews.js <폴더> [--dry]
 *     --dry : 읽고 정리한 결과만 보여 주고 DB에는 쓰지 않는다
 *   ⚠️ 리뷰 엑셀에는 고객 이름·회원ID·주문번호가 있다 — 폴더를 저장소에 커밋하지 말 것(.gitignore 의 "리뷰 추가/")
 */

const path = require('path');
const store = require('../lib/store');
const ingest = require('../lib/reviewIngest');

(async () => {
  const dir = process.argv[2];
  const dry = process.argv.includes('--dry');
  if (!dir || dir.startsWith('--')) { console.error('사용법: node scripts/import-reviews.js <폴더> [--dry]'); process.exit(1); }

  const b = await ingest.build(path.resolve(dir));
  const by = (list, k) => list.reduce((m, r) => { m[r[k]] = (m[r[k]] || 0) + 1; return m; }, {});
  console.log(`📄 지식 문서 ${b.files.doc.map((f) => path.basename(f)).join(', ') || '없음'}`);
  if (b.docs) console.log(`   조각 ${b.docs.length}개(회의 원문 ${b.docs.filter((d) => d.restricted).length}개는 지정 토큰만) · 카피 은행 ${b.copybank.length.toLocaleString()}문장`);
  console.log(`📊 리뷰 엑셀 자사몰 ${b.files.own.length}개 · 스마트스토어 ${b.files.ss.length}개`);
  console.log(`   자사몰: 읽음 ${b.stat.own.read} · 스마트스토어 연동분 제외 ${b.stat.own.synced} · 관리자 글 제외 ${b.stat.own.admin}`);
  console.log(`   스마트스토어: 읽음 ${b.stat.ss.read} · 같은 리뷰글번호 제외 ${b.stat.ss.dupId} · 스마트스토어 파일에 없는 연동분 보충 ${b.stat.ss.fromSync}`);
  console.log(`   같은 작성자·같은 본문 반복 등록 ${b.stat.repeats}건(지우지 않고 표시 — 내용 분석에서만 뺀다)`);
  console.log(`   → 저장할 리뷰 ${b.reviews.length.toLocaleString()}건 · 채널 ${JSON.stringify(by(b.reviews, 'ch'))} · 상품군 ${JSON.stringify(by(b.reviews, 'fam'))}`);
  console.log(`   카피 은행과 연결된 리뷰 ${b.reviews.filter((r) => r.copy).length}건`);
  if (b.warnings.length) { console.log('   ⚠️ 경고:'); b.warnings.forEach((w) => console.log('      -', w)); }

  if (dry) { console.log('\n(--dry: DB에는 쓰지 않았습니다)'); process.exit(0); }
  const r = await ingest.apply(b, path.basename(path.resolve(dir)));
  console.log(`\n✅ 적재 완료 ${r.syncedAt} · 조각 ${r.docs ?? '-'} · 카피 은행 ${r.copybank ?? '-'} · 리뷰 ${r.reviews ?? '-'}(DB 전체 ${r.reviewsTotal ?? '-'})`);
  await store.close();
  setTimeout(() => process.exit(0), 100);
})().catch((e) => { console.error('💥', e.message); process.exit(1); });
