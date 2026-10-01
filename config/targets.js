'use strict';

/**
 * 월별 채널 목표 매출 (원) — DB가 연결되지 않은(로컬 개발) 경우에만 쓰는 값.
 * 운영에서는 DB(targets)에 MD가 매달 올린 값만 쓰고, 그 달에 안 올렸으면 0(미등록)이다(lib/target.js getTargets).
 * 미등록 달을 임시로 채울 값은 config/fallbackTargets.js 에 월별로 넣는다(일일 모니터링 페이지에서만 쓰임).
 */
module.exports = {
  monthly: {
    '2026-06': { cafe24: 127000000, smartstore: 50000000 },
    '2026-05': { cafe24: 127000000, smartstore: 50000000 },
  },
  default: { cafe24: 127000000, smartstore: 50000000 },
};
