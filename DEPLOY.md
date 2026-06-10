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
- **개인정보**: 비즈유도/세그먼트/쿠폰구매자 화면에 고객 이름·연락처·이메일이 포함됩니다. 인증 없이 공개하면 노출되니, 필요 시 **Vercel → Settings → Deployment Protection(Password)** 으로 잠그세요.
- **함수 타임아웃**: Hobby 플랜은 함수 실행 10초 제한이라, 라이브 API를 호출하는 화면(트래픽·비즈유도 등)은 캐시가 없으면 끊길 수 있습니다. **데이터를 로컬에서 미리 캐시**해 두면 조회는 빠릅니다. (Pro 플랜은 `maxDuration` 60초까지)
- **수집/동기화/적재**(백필·쿠폰명 적재·트래픽 월별 워밍)는 **로컬에서 `npm run legacy`**(= `node server.js`)로 실행하세요. Vercel에서는 `READ_ONLY=1`로 비활성화됩니다.

## 로컬 실행
- Next 개발: `npm run dev` → http://localhost:5200
- 기존 단일 서버(수집 포함): `npm run legacy` → http://localhost:5200
