'use strict';

/**
 * 비즈어드바이저 마케팅채널 유입수 — DB 적재 + 분석파일 내보내기.
 *
 *   ※ 이카운트 매크로와 같은 역할: 외부 데이터를 받아 on.bizInflow 에 적재한다.
 *     대시보드(스마트스토어 ⑦ 마케팅 분석)는 이 DB를 읽어 "분석"만 한다.
 *
 *   사용법:
 *     1) 비즈어드바이저 마케팅분석 화면 → F12 → 네트워크 → report?useIndex= 요청
 *        우클릭 → Copy → "Copy as cURL (bash)"
 *     2) 그 내용을 scripts/bizadvisor-curl.txt 에 붙여넣고 저장
 *     3) node scripts/bizadvisor-export.js [시작월(기본 2025-01)]
 *        예) node scripts/bizadvisor-export.js 2025-01
 *
 *   결과: on.bizInflow 적재(2025-01~오늘) + bizadvisor_out/*.json,*.csv(엑셀용) 생성
 *
 *   ⚠️ bizadvisor-curl.txt 에는 로그인 토큰/쿠키가 들어있습니다 → 커밋 금지(.gitignore).
 *      실행 후 비즈어드바이저 로그아웃→재로그인으로 세션을 갈아주세요.
 */

const fs = require('fs');
const path = require('path');
const ba = require('../lib/bizadvisor');
const store = require('../lib/store');

const AUTH_FILE = path.join(__dirname, 'bizadvisor-curl.txt');
const OUT_DIR = path.join(__dirname, '..', 'bizadvisor_out');

(async () => {
  if (!fs.existsSync(AUTH_FILE)) {
    console.error(`\n❌ ${AUTH_FILE} 가 없습니다.`);
    console.error('   DevTools → report?useIndex= 요청 우클릭 → Copy → "Copy as cURL (bash)"');
    console.error('   → 그 내용을 위 파일에 붙여넣고 저장한 뒤 다시 실행하세요.\n');
    process.exit(1);
  }
  const curl = fs.readFileSync(AUTH_FILE, 'utf8');
  const ym = (process.argv[2] || '2025-01').split('-');
  const opt = { fromYear: +ym[0] || 2025, fromMonth: +ym[1] || 1 };

  console.log('\n=== 비즈어드바이저 유입수 → DB 적재 (on.bizInflow) ===');
  console.log(`수집 시작월: ${opt.fromYear}-${String(opt.fromMonth).padStart(2, '0')} ~ 오늘\n`);

  const r = await ba.refresh(curl, opt);
  r.months.forEach((m) => console.log(`  ${m.ym}: ${m.error ? '❌ ' + m.error : m.rows + '행'}`));
  console.log(`\n✅ DB 적재 완료: ${r.totalRows}행 · 최초 데이터 ${r.firstWithData || '-'} · site ${r.site}`);

  // 분석파일 내보내기 (DB에서 읽어 JSON + 엑셀용 CSV)
  const s = await ba.summary('', '');
  if (s.days.length) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const base = `bizadvisor_inflow_${s.from}_${s.to}`;
    fs.writeFileSync(path.join(OUT_DIR, base + '.json'), JSON.stringify(s, null, 2));
    const H = ['날짜', ...s.channels, '총합계'];
    const lines = [H.join(',')].concat(s.days.map((d) => [d.date, ...s.channels.map((c) => d.ch[c] || 0), d.total].join(',')));
    fs.writeFileSync(path.join(OUT_DIR, base + '.csv'), '﻿' + lines.join('\r\n')); // 엑셀용 BOM+CRLF
    console.log(`📄 분석파일: bizadvisor_out/${base}.json , .csv (엑셀에서 더블클릭으로 열림)`);
  }

  console.log('🔒 끝났으면 비즈어드바이저 로그아웃→재로그인으로 세션을 갈아주세요.\n');
  await store.close();
  setTimeout(() => process.exit(0), 150);
})().catch((e) => { console.error('\n💥', e.message, '\n'); process.exit(1); });
