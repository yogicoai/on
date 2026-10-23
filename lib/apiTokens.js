'use strict';

/**
 * 개인별 API 토큰 — MCP 서버(클라우드타입)와 Export API(Vercel)가 같이 쓴다 (2026-10-22).
 *
 * 공유 토큰 하나가 사내 게시글에 평문으로 올라간 일이 있어(점검 요청 3번), 사람마다 따로 준다.
 *   <PREFIX>_TOKENS = "이름:토큰[:권한], 이름:토큰[:권한], …"   쉼표 또는 줄바꿈으로 구분, 토큰은 24자 이상 무작위.
 *     권한은 서비스마다 뜻이 다르다 — MCP: read(조회) · sync(동기화 실행까지) / Export: read(조회) · write(월 목표 저장까지).
 *     생략하면 read.
 *   <PREFIX>_TOKEN  = 예전 공유 토큰 — 모두 옮길 때까지만 받는다(권한 all = 예전처럼 다 됨).
 *   <PREFIX>_LEGACY = read 면 예전 토큰은 조회만, off 면 거절(기본 all).
 * 토큰 값은 해시로만 들고 비교한다. 로그에는 이름만 남긴다. 토큰은 환경 변수에만 — 이 저장소는 공개다.
 */

const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();

/** 환경 변수에서 토큰 목록을 읽는다. prefix = 'MCP' | 'EXPORT' */
function loadTokens(prefix, env = process.env) {
  const list = [];
  for (const raw of String(env[`${prefix}_TOKENS`] || '').split(/[,\n]/)) {
    const s = raw.trim();
    if (!s) continue;
    const [name, token, scope] = s.split(':').map((x) => (x || '').trim());
    if (!name || !token || token.length < 24) {
      console.error(`[auth] ${prefix}_TOKENS 항목을 건너뜀: ${name || '(이름 없음)'} — 형식은 이름:토큰[:권한], 토큰은 24자 이상`);
      continue;
    }
    list.push({ name, hash: sha256(token), scope: scope || 'read' });
  }
  const legacy = String(env[`${prefix}_TOKEN`] || '').trim();
  const mode = String(env[`${prefix}_LEGACY`] || 'all').trim().toLowerCase();
  if (legacy && mode !== 'off') list.push({ name: 'legacy-shared', hash: sha256(legacy), scope: mode === 'read' ? 'read' : 'all' });
  return list;
}

/**
 * Authorization 헤더 값으로 누구인지 — 맞으면 { name, scope }, 아니면 null.
 * 토큰을 하나도 안 걸었으면 예전처럼 열어 둔다(로컬 개발).
 */
function makeIdentify(tokens) {
  return (authorization) => {
    if (!tokens.length) return { name: 'open', scope: 'all' };
    const m = /^Bearer\s+(.+)$/i.exec(String(authorization || '').trim());
    if (!m) return null;
    const got = sha256(m[1].trim());
    return tokens.find((t) => crypto.timingSafeEqual(got, t.hash)) || null;
  };
}

/** 그 권한이 있는가 — all(예전 공유 토큰·로컬)은 무엇이든 된다 */
const allows = (who, scope) => !!who && (who.scope === scope || who.scope === 'all');

module.exports = { loadTokens, makeIdentify, allows };
