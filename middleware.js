import { NextResponse } from 'next/server';

/**
 * 대시보드 전체 잠금 — 화면과 /api/* 를 아이디·비밀번호(브라우저 기본 로그인 창, HTTP Basic)로 막는다.
 *
 * 왜: 비즈유도·세그먼트·쿠폰 구매자 같은 화면/CSV 에 고객 이름·연락처·이메일이 들어 있는데,
 *     지금까지 주소만 알면 누구나 열 수 있었다(DEPLOY.md 의 '개인정보' 주의 참고).
 *
 * 통과 조건(하나라도 맞으면):
 *  1) 공개 경로 — /api/health (상태 확인용, 개인정보 없음)
 *  2) 자체 토큰으로 지키는 경로 — /api/export*, /api/dash-targets (EXPORT_TOKENS), /api/cron/sync (CRON_SECRET)
 *  3) 올바른 계정 — DASHBOARD_USER(기본 'yogibo') / DASHBOARD_PASSWORD
 *     (크론이 같은 서버의 /api 를 부를 때도 이 계정을 붙인다 — app/api/cron/sync/route.js)
 *  4) 서버 간 호출(dash 등) — 개인 Export 토큰(Bearer, EXPORT_TOKENS·예전 EXPORT_TOKEN)으로
 *     TOKEN_PATHS 에 적힌 집계 주소만. 개인정보가 담긴 주소는 토큰으로 열리지 않는다.
 *     dash 가 새 onlineData 주소를 부르게 되면 여기에 추가해야 한다(dash/src/lib/api.js 의 onGet 사용처).
 *
 * DASHBOARD_PASSWORD 가 없으면 운영(production)에서는 전부 막는다 — 설정이 빠져 다시 열리는 일을 막기 위해서다.
 * 로컬 개발(npm run dev)에서만 비밀번호 없이 통과한다.
 */

const PUBLIC_PATHS = new Set(['/api/health']);
const SELF_GUARDED_PREFIXES = ['/api/export', '/api/dash-targets', '/api/cron/sync'];
const TOKEN_PATHS = new Set([
  '/api/compare/best',
  '/api/compare/period',
  '/api/cafe24/daily-summary',
  '/api/smartstore/analysis',
  '/api/smartstore/status',
  '/api/smartstore/sync-week',
  '/api/refresh-today',
  '/api/target',
  '/api/other/overview',
  '/api/daily-mail',
]);
const REALM = 'Basic realm="Yogibo onlineData", charset="UTF-8"';

function isSelfGuarded(pathname) {
  return SELF_GUARDED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}.`),
  );
}

// 길이가 같을 때 글자를 모두 비교해 응답 시간으로 비밀번호를 추측하지 못하게 한다.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readBasic(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const binary = atob(header.slice(6).trim());
    const text = new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { user: text.slice(0, colon), password: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// lib/apiTokens.js 와 같은 형식: EXPORT_TOKENS="이름:토큰[:권한], …" + 예전 EXPORT_TOKEN(EXPORT_LEGACY=off 면 제외)
function exportTokens() {
  const tokens = [];
  for (const raw of String(process.env.EXPORT_TOKENS || '').split(/[,\n]/)) {
    const [name, token] = raw.trim().split(':').map((part) => (part || '').trim());
    if (name && token && token.length >= 24) tokens.push(token);
  }
  const legacy = String(process.env.EXPORT_TOKEN || '').trim();
  const mode = String(process.env.EXPORT_LEGACY || 'all').trim().toLowerCase();
  if (legacy && mode !== 'off') tokens.push(legacy);
  return tokens;
}

async function isValidToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  if (!match) return false;
  const tokens = exportTokens();
  if (!tokens.length) return false; // 토큰이 없으면 열지 않는다(apiTokens 의 '로컬 개방'과 다르게)
  const given = await sha256Hex(match[1].trim());
  let ok = false;
  for (const token of tokens) {
    if (safeEqual(given, await sha256Hex(token))) ok = true;
  }
  return ok;
}

function deny(status, message) {
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
  if (status === 401) headers['www-authenticate'] = REALM;
  return new NextResponse(message, { status, headers });
}

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || isSelfGuarded(pathname)) return NextResponse.next();

  const expectedUser = process.env.DASHBOARD_USER || 'yogibo';
  const expectedPassword = process.env.DASHBOARD_PASSWORD;
  if (!expectedPassword) {
    if (process.env.NODE_ENV !== 'production') return NextResponse.next();
    return deny(503, '대시보드 잠금 비밀번호(DASHBOARD_PASSWORD)가 설정되지 않아 접속을 막았어요. Vercel 환경변수를 확인해 주세요.');
  }

  const authorization = request.headers.get('authorization');
  const credentials = readBasic(authorization);
  if (credentials && safeEqual(credentials.user, expectedUser) && safeEqual(credentials.password, expectedPassword)) {
    return NextResponse.next();
  }
  if (TOKEN_PATHS.has(pathname) && (await isValidToken(authorization))) return NextResponse.next();

  return deny(401, '로그인이 필요해요.');
}

export const config = {
  // Next 내부 정적 파일만 빼고 화면·public 파일·/api 전부
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
