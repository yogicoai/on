'use strict';

/**
 * 스마트스토어 최근 변경분 적재 (매시 실행용) — 주문 상태·송장을 CS 조회에 빨리 반영한다.
 *
 *   사용:
 *     node scripts/sync-smartstore-recent.js       (최근 2시간)
 *     node scripts/sync-smartstore-recent.js 6     (최근 6시간, 최대 24)
 *
 *   MCP 서버의 매시 예약(mcp/nightlySync.js, ENABLE_SMARTSTORE_HOURLY=1)이 TZ=Asia/Seoul 자식 프로세스로 부른다.
 *   네이버 커머스 API는 허용 IP(cloudtype·로컬)에서만 동작한다.
 */

const smartstoreIngest = require('../lib/smartstoreIngest');

(async () => {
  const hours = Number(process.argv[2]) || 2;
  try {
    const result = await smartstoreIngest.syncRecent(hours);
    console.log(`[smartstore-recent] ✓ 최근 ${hours}시간 변경 ${result.changed}건 · 저장 ${result.stored}건`);
    process.exit(0);
  } catch (e) {
    console.error('[smartstore-recent] 실패:', e);
    process.exit(1);
  }
})();
