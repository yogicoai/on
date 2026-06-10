# onlineData — Cafe24 판매 분석 대시보드

Yogibo Cafe24 쇼핑몰의 **유입 / 회원·비회원 결제 / 상품별 쿠폰 프로모션 성과**를 분석하는 대시보드.

## 실행

```bash
npm install
npm start          # → http://localhost:5200
```

랜딩 시 **전날(어제) 데이터**를 자동 조회합니다.

## 토큰 정책 (중요)

Cafe24 OAuth 토큰은 **yogiChat 이 단일 소유·자동 갱신**한다. 본 프로젝트는 공유 MongoDB(`tokens` 컬렉션)의 토큰을
**읽기 전용으로만** 사용하며 **절대 refresh 하지 않는다**(1회용 refresh_token 회전 충돌 방지). 401 시 DB 최신 토큰을 한 번 다시 읽어 재시도. (mkboard 광고대시보드와 동일 패턴)

`.env` 키: `MONGODB_URI`, `CAFE24_MALL_ID`, `CAFE24_TOKEN_URI`, `CAFE24_TOKEN_DB`, `CAFE24_TOKEN_COLLECTION`,
`CAFE24_API_VERSION`(2025-12-01), `PORT`(5200), `STALE_MIN`(60), `REFRESH_DAYS`(7), `ONLINEDATA_DB`(onlinedata).

## 데이터 소스 (프로빙으로 검증된 엔드포인트)

**Analytics(통계) API — `https://ca-api.cafe24data.com`** (유입)
| 엔드포인트 | 필드 |
|---|---|
| `/visitors/view` (device_type: total\|pc\|mobile) | date, visit_count, first_visit_count, re_visit_count |
| `/pages/view` | url, count(PV), visit_count |
| `/visitpaths/keywords` | keyword, visit_count |
| `/visitpaths/domains` | domain, visit_count |
| `/visitpaths/adsales` | ad, order_count, order_amount, join_count |

**Admin API — `https://{mall}.cafe24api.com/api/v2/admin`** (주문·쿠폰)
| 엔드포인트 | 용도 |
|---|---|
| `/orders` (embed=items) | 회원/비회원(member_id), payment_amount, actual_order_amount.coupon_discount_price, items[].coupon_discount_price |
| `/coupons` | issued_count, benefit_*, available_product_list, available_category_list |
| `/coupons/{no}/issues` | member_id, issued_date, used_coupon, used_date, related_order_id (필터: `issued_start_date`/`issued_end_date` 최대 ~31일, `used_coupon`) |

## 분석 구성

1. **유입** — 전체 사이트 방문(신규/재방문·PC/모바일), 유입 도메인, 검색 유입어, 광고 유입, 인기 페이지.
2. **회원·비회원** — member_id 유무로 분리한 주문수·결제·매출·객단가·쿠폰할인·신규주문, 매출 비중, 일별 추이.
3. **프로모션(쿠폰)**
   - *상품별 성과*(실거래): 주문 아이템 중 `coupon_discount_price>0` 를 상품별 롤업 → 주문/수량/매출/할인/할인율.
   - *쿠폰별 깔때기*(기간 발급 코호트): 쿠폰별 발급 → 사용 → 사용률 → 연결매출(related_order_id 조인).

## DB 캐시 / API 호출 최소화

- 집계 결과는 onlineData **전용 DB `onlinedata`** 의 `report_cache` 에 구간별로 저장(공유 클러스터, 타 프로젝트 데이터 불침범).
- **과거 구간(end < 오늘)은 불변 → 영구 캐시** (라이브 API 재호출 0). **오늘 포함 구간만 `STALE_MIN`(60분) TTL**.
- `↻ 갱신`: 현재 구간을 캐시 무시하고 1회 라이브 재집계.
- `⟳ 최근 1주일 재취합(API)`: 오늘~`REFRESH_DAYS`(7) 전 구간을 **라이브 강제 재집계**하고, 그 기간과 겹치는 기존 Mongo 캐시를 **삭제 후 갱신**.

## API

| 라우트 | 설명 |
|---|---|
| `GET /api/overview?start&end&force` | 종합(없으면 기본=어제). `force=1` 캐시 무시 |
| `GET /api/refresh-week?days=7` | 최근 N일(≤7) 재취합 + 겹치는 캐시 삭제·갱신 |
| `GET /api/health` | 상태/설정 |
| `GET /api/cache` | 캐시 목록(디버그) |

## 개발 스크립트
`scripts/probe*.js` 는 Cafe24 엔드포인트/필드 검증용(프로빙 기록), `scripts/smoke.js` 는 세 집계 통합 점검.
