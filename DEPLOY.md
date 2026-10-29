# Vercel 배포 가이드

이 프로젝트는 Next.js(App Router)로 변환되어 Vercel에 배포할 수 있습니다.
- 프론트엔드: 기존 바닐라 JS(`public/app.js`, `public/style.css`) 그대로 사용 — `app/page.js`가 셸을 렌더하고 `/app.js`를 로드합니다.
- API: 기존 `server.js`의 라우팅 로직(약 50개 `/api/*`)을 그대로 재사용 — `app/api/[...path]/route.js`가 `server.handle(req,res)`를 호출합니다.

## 1) 사전 조건
- **MongoDB는 Atlas/공개 호스트**여야 합니다(Vercel 함수가 외부에서 접속). 로컬/사내 Mongo는 접속 불가.
- 데이터(주문/캐시/PV/가입 등)는 **로컬에서 미리 수집**해 Mongo에 적재해 둡니다. Vercel은 **읽기 전용**.

## 2) 환경변수 (Vercel → Settings → Environment Variables)
`.env.example` 참고. 핵심:
- `MONGODB_URI` (또는 `ONLINEDATA_URI`) — 분석 캐시 DB
- `CAFE24_TOKEN_URI`, `CAFE24_TOKEN_DB`, `CAFE24_TOKEN_COLLECTION`, `CAFE24_MALL_ID`, `CAFE24_API_VERSION`
- (선택) `NAVER_COMMERCE_CLIENT_ID/SECRET`
- `READ_ONLY=1` — 수집·동기화·설정변경 버튼 비활성화(서버리스 타임아웃 방지)

## 3) 배포
1. GitHub에 푸시 → Vercel에서 Import (Framework: Next.js 자동 감지)
2. 위 환경변수 입력
3. Deploy

## 4) 주의 / 한계
- **개인정보 / 접속 잠금**: 비즈유도/세그먼트/쿠폰구매자 화면에 고객 이름·연락처·이메일이 포함됩니다. 그래서 `middleware.js` 가 화면과 `/api/*` 전체를 **아이디·비밀번호(브라우저 로그인 창)** 로 잠급니다.
  - Vercel 환경변수에 `DASHBOARD_USER`(기본 `yogibo`)·`DASHBOARD_PASSWORD` 를 **먼저** 넣고 배포하세요. 비밀번호가 없으면 운영에서는 503으로 전부 막힙니다(다시 열리는 사고 방지).
  - 예외: `/api/health`(공개), `/api/export*`·`/api/dash-targets`(Export 토큰), `/api/cron/sync`(`CRON_SECRET` — GitHub Secrets·Vercel 양쪽에 같은 값으로 넣는 걸 권장).
  - dash 같은 서버 간 호출은 개인 Export 토큰(Bearer)으로 `middleware.js` 의 `TOKEN_PATHS`(집계 주소)만 통과합니다. 개인정보 주소는 토큰으로 열리지 않습니다.
  - 예전 배포 주소(`*-yogicoai.vercel.app` 같은 개별 URL)까지 막으려면 Vercel → Settings → Deployment Protection 의 Vercel Authentication(Standard)도 켜 두세요.
- **함수 타임아웃**: Hobby 플랜은 함수 실행 10초 제한이라, 라이브 API를 호출하는 화면(트래픽·비즈유도 등)은 캐시가 없으면 끊길 수 있습니다. **데이터를 로컬에서 미리 캐시**해 두면 조회는 빠릅니다. (Pro 플랜은 `maxDuration` 60초까지)
- **수집/동기화/적재**(백필·쿠폰명 적재·트래픽 월별 워밍)는 **로컬에서 `npm run legacy`**(= `node server.js`)로 실행하세요. Vercel에서는 `READ_ONLY=1`로 비활성화됩니다.

## 5) 매일 자동 동기화 (항상 켜진 호스트에서)
Vercel은 읽기 전용/서버리스라 **무거운 적재·쿠폰 스캔을 못 돌립니다**. 데이터 최신화는 **항상 켜진 호스트(ychat 서버 등)**에서 합니다.

**무엇을 캐시하나** — 대시보드 종합(overview)은 구간별 `report_cache`, 쿠폰 발급→사용 funnel 은 `coupon_funnel_cache`에 저장됩니다. 쿠폰 funnel 스캔은 쿠폰 200개×issues API 페이지네이션이라 한 구간당 **1~3분**이 걸려 Vercel에서 직접 못 돌립니다 → 로컬/항상켜진 호스트에서 미리 채워두면 서버는 **즉시 응답**합니다.

**동기화 명령**
- `npm run warm` — 적재 없이 자주 보는 구간(이번달/최근30일/지난달/등록 프로모션)의 overview + funnel 캐시만 채움
- `node scripts/daily-sync.js` — **최근 1주일 Cafe24+스마트스토어 주문 적재 → 위 구간 캐시 워밍** (매일 돌릴 루틴)

**스케줄링 — 둘 중 택1**
- **A) 인서버 스케줄러**: 항상 켜진 호스트에서 `node server.js`를 24시간 띄우고 `ENABLE_DAILY_SYNC=1` 설정 → 매일 **00:00(로컬=KST)** 자동 실행.
  - `DAILY_SYNC_DAYS=7`(기본 7일), `DAILY_SYNC_ON_BOOT=1`(기동 직후 1회) 옵션.
  - ⚠️ **Vercel/`READ_ONLY=1`에서는 자동으로 비활성**(켜지지 않음). 반드시 항상 켜진 호스트에서만.
- **B) OS 스케줄러**: 상시 Node 프로세스 없이 OS가 트리거.
  - Windows 작업 스케줄러: 매일 00:00에 `node C:\...\onlineData\scripts\daily-sync.js` 실행.
  - Linux cron: `0 0 * * * cd /path/onlineData && node scripts/daily-sync.js`

**대시보드 "⟳ 오늘 재취합(API)" 버튼** — 낮에 누르면 **오늘 주문만**(Cafe24+스마트스토어) 적재 후 오늘 포함 구간을 빠르게 갱신합니다(쿠폰 funnel 은 캐시 유지 → 1~2초). 최근 1주일 전체 동기화는 00:00 자동 스케줄러가 담당합니다.

## 로컬 실행
- Next 개발: `npm run dev` → http://localhost:5200
- 기존 단일 서버(수집 포함): `npm run legacy` → http://localhost:5200
- 캐시 워밍: `npm run warm` / 일일 동기화: `node scripts/daily-sync.js`
