# Yogibo 데이터 Export API

> ## 📌 먼저 읽어주세요 (비개발자용)
>
> 이 문서는 **Codex(또는 AI)에게 데이터를 가져오라고 시킬 때 참고하는 설명서**입니다.
> 세부 내용을 직접 이해하실 필요는 없어요 — **Codex가 이 문서를 읽고 알아서 처리**합니다.
>
> **사용하실 때는** Codex에 아래 문장을 붙이고, 그 뒤에 원하시는 걸 말로 적으시면 됩니다.
>
> ```
> 첨부한 안내서(EXPORT-API.md)를 참고해서 아래에서 데이터를 가져와 분석해줘.
> 주소: https://on-iota-three.vercel.app/api/export
> 열쇠(토큰): (별도로 전달받은 토큰을 여기에)
>
> 👉 여기에 원하시는 분석을 적으세요
>    예) 지난달 온라인·오프라인 매출이랑 광고비 다 가져와서 8월 프로모션안이랑 비교해줘
> ```
>
> - 기간은 **"지난달", "최근 7일", "7월"** 처럼 편하게 말하면 됩니다.
> - 주소를 인터넷 창에 직접 붙여넣으면 오류가 뜨는데 **정상**입니다(보안상 Codex를 통해서만 열림).
> - 고객 개인정보(이름·연락처·주소)는 **전혀 포함되지 않습니다**.
>
> ### 가져올 수 있는 데이터
> - **💰 매출** — 온라인(자사몰·스마트스토어·기타 채널, 상품별) · 오프라인 매장(매장별·판매사원별·상품별)
> - **📣 마케팅·광고** — 광고 성과(매체별 광고비·노출·클릭·전환) · 방문 통계(방문·페이지뷰·가입·구매) · 채널별 유입수
> - **🎯 목표** — 온라인 월 목표(자사몰·스마트스토어·기타몰) · 오프라인 매장별 월/주차 목표
> - **📦 재고** — 현재 품목별·색상별 재고 수량
>
> ---
> *아래부터는 Codex(개발 도구)가 참고하는 기술 상세입니다.*

DB에 적재된 **매출·마케팅·목표·재고 데이터**를 외부 시스템에서 직접 가져가 가공할 수 있는 API입니다.
CSV 수동 다운로드 없이, 프로그램에서 URL을 호출해 바로 받아갈 수 있습니다.

- **Base URL**: `https://on-iota-three.vercel.app/api/export`
- **인증**: 모든 요청에 헤더 `Authorization: Bearer <토큰>` 필요 (토큰은 별도 전달)
- **응답**: 기본 JSON, `format=csv` 지정 시 CSV(UTF-8 BOM — 엑셀에서 한글 정상)

> ⚠️ 브라우저 주소창으로 열면 401이 뜹니다. 주소창은 인증 헤더를 보낼 수 없기 때문이며, 정상 동작입니다.
> curl·Python·스프레드시트 스크립트 등 **헤더를 보낼 수 있는 도구**로 호출해 주세요.

---

## 1. 데이터셋 목록

| dataset | 내용 | 기간 파라미터 |
|---|---|---|
| `sales-online` | 이카운트 온라인 매출(출고일 기준) — 자사몰·스마트스토어·외부채널, 상품 단위 | 필요 |
| `sales-offline` | 오프라인 매장 매출 — 매장·판매사원·상품 단위 | 필요 |
| `ads` | 광고 일별×매체 — 광고비·노출·클릭·전환·전환매출 | 필요 |
| `stock` | 현재 재고 — 품목×색상 수량 | 불필요 |
| `traffic` | 자사몰 트래픽 일별 — 방문·페이지뷰·가입·구매·매출 | 필요 |
| `inflow` | 마케팅 채널별 유입수 일별×채널(네이버 비즈어드바이저) | 필요 |
| `targets-online` | 온라인 월 목표(자사몰·스마트스토어·기타몰) | 필요(월 단위) |
| `targets-offline` | 오프라인 매장별 월/주차 목표 | 필요(월 단위) |

목록은 API로도 확인할 수 있습니다: `GET /api/export/catalog`

## 2. 호출 형식

```
GET /api/export?dataset=<이름>&period=<기간>&format=json|csv
```

| 파라미터 | 필수 | 설명 |
|---|---|---|
| `dataset` | ✅ | 위 표의 이름 |
| `period` | 기간 필요 데이터셋만 | 자연어 기간 (아래 참조) |
| `start` / `end` | `period` 대신 사용 가능 | `YYYY-MM-DD`, 양끝 포함 |
| `format` | | `json`(기본) 또는 `csv` |

### 기간(`period`) — 자연어로 지정

날짜를 직접 계산하지 않고 말하듯 쓰면 됩니다.

| 분류 | 사용 가능한 값 |
|---|---|
| 상대 | `어제` `오늘` `이번주` `지난주` `이번달` `지난달` `올해` `작년` |
| 최근 N | `최근 7일` `최근 30일` `최근 3개월` |
| 특정 월/연 | `2026년 7월` `2026-07` `7월`(올해) `2026년` |
| 특정 일 | `2026-07-10` `2026년 7월 10일` `7월 10일` |
| 범위 | `2026-07-01~2026-07-15` · `6월부터`(오늘까지) · `2026년 5월부터 7월까지` |
| 영문 | `yesterday` `thismonth` `lastmonth` `thisyear` `lastyear` `last7days` `last3months` |

- 기준일은 **한국시간(KST)** 입니다.
- 미래 구간은 **오늘까지로 잘립니다** (`2026년` → 1/1 ~ 오늘).
- 응답의 `start` · `end` · `기간해석` 필드에 **실제 적용된 구간**이 표시되니 확인하고 쓰시면 됩니다.
- 해석할 수 없는 값이면 `400`과 함께 사유를 알려줍니다 (예: `"다음달"` → 미래라 데이터 없음).

```bash
# 아래 두 요청은 완전히 동일합니다
...?dataset=ads&period=지난달
...?dataset=ads&start=2026-06-01&end=2026-06-30
```

## 3. 응답 필드

**sales-online** — `orderNo` 주문번호 · `date` 출고일 · `store` 채널 · `productName` 상품명 · `color` 색상 · `category` 카테고리 · `beadType` 충전재 · `qty` 수량 · `amount` 금액(원) · `isSet` 세트여부 · `isCover` 커버여부

**sales-offline** — 위와 동일 + `manager` 판매사원 (`store`는 매장명)

**ads** — `date` 일자 · `platform` 매체 · `spend` 광고비(원) · `imp` 노출 · `clk` 클릭 · `conv` 전환수 · `convValue` 전환매출(원)

**stock** — `updatedAt` 재고 기준시각 + `items[]`: `code` 품목코드 · `name` 품목명 · `color` 색상 · `category` 카테고리 · `qty` 수량

**traffic** — `date` 일자 · `visits` 방문수 · `pv` 페이지뷰 · `signups` 가입수 · `purchases` 구매건수 · `revenue` 매출(원) *(자사몰 기준. 최근 며칠은 visits가 0으로 보정될 수 있음)*

**inflow** — `date` 일자 · `channel` 유입 채널 · `inflow` 유입수 *(일별×채널 long 포맷. 네이버 비즈어드바이저 기준, 주 1회 수동 갱신이라 최근 2~3일은 비어있을 수 있음)*

**targets-online** — `month` 대상월(YYYY-MM) · `mall` 몰(자사몰·스마트스토어·쿠팡 등) · `target` 목표액(원) *(월 단위. 기간에 걸친 모든 월 반환)*

**targets-offline** — `month` 대상월 · `store` 매장명 · `monthlyTarget` 월 목표(원) · `w1`~`w6` 주차별 목표(원) *(월 단위)*

JSON 응답 형태:
```json
{ "ok": true, "dataset": "ads", "start": "2026-07-01", "end": "2026-07-15",
  "count": 73,
  "rows": [ { "date": "2026-07-01", "platform": "네이버 키워드", "spend": 20132, "imp": 0, "clk": 0, "conv": 19, "convValue": 143800 } ] }
```
※ `stock`은 `rows` 대신 `items`를 사용합니다.
※ 금액 단위는 모두 **원(KRW)** 입니다.

## 4. 예제

**curl** — 한글은 URL 인코딩이 필요할 수 있어 `--data-urlencode -G` 사용을 권장합니다.
```bash
curl -H "Authorization: Bearer <토큰>" -G \
  "https://on-iota-three.vercel.app/api/export" \
  --data-urlencode "dataset=sales-online" \
  --data-urlencode "period=지난달"

# 한글 입력이 번거로우면 영문 별칭도 동일하게 동작합니다
curl -H "Authorization: Bearer <토큰>" \
  "https://on-iota-three.vercel.app/api/export?dataset=sales-online&period=lastmonth"
```

**CSV로 파일 저장**
```bash
curl -H "Authorization: Bearer <토큰>" -G \
  "https://on-iota-three.vercel.app/api/export" \
  --data-urlencode "dataset=ads" \
  --data-urlencode "period=2026년 7월" \
  --data-urlencode "format=csv" \
  -o ads_202607.csv
```

**Python** — `params`에 넘기면 인코딩은 라이브러리가 알아서 처리합니다.
```python
import requests
import pandas as pd

BASE = "https://on-iota-three.vercel.app/api/export"
HEADERS = {"Authorization": "Bearer <토큰>"}

r = requests.get(BASE, headers=HEADERS, params={
    "dataset": "sales-online",
    "period": "지난달",          # "최근 30일", "2026년 7월", "6월부터" 등
})
r.raise_for_status()
data = r.json()
print(data["start"], "~", data["end"], f'({data.get("기간해석")})')  # 실제 적용 구간 확인

df = pd.DataFrame(data["rows"])
print(df.groupby("store")["amount"].sum())
```

**Google Sheets (Apps Script)**
```javascript
function loadSales() {
  const url = 'https://on-iota-three.vercel.app/api/export?dataset=sales-online'
            + '&period=' + encodeURIComponent('지난달');
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer <토큰>' } });
  const rows = JSON.parse(res.getContentText()).rows;
  const cols = ['date', 'store', 'productName', 'qty', 'amount'];
  const out = [cols].concat(rows.map(r => cols.map(c => r[c])));
  SpreadsheetApp.getActiveSheet().getRange(1, 1, out.length, cols.length).setValues(out);
}
```

## 5. 데이터 갱신 주기

**실시간이 아닙니다.** 각 데이터는 아래 시점에 동기화된 값입니다.

| 데이터 | 갱신 |
|---|---|
| 매출(온라인·오프라인) | 매일 오전 9시경 (이카운트 업로드는 10:10 — 당일분은 다음 날 반영) |
| 광고 | 매일 오전 9시 30분경 |
| 트래픽 | 매일 오전 9시경 (당일 미포함) |
| 유입수(inflow) | 주 1회 수동 갱신 (최근 2~3일 비어있을 수 있음) |
| 목표(targets) | 월초 확정, 수시 조정 |
| 재고 | 약 10분 주기 |

당일 데이터를 조회하면 비어 있거나 불완전할 수 있습니다. **전일까지의 기간**으로 조회하는 것을 권장합니다.

## 6. 제약 / 주의

- **개인정보 미포함** — 집계 원장만 제공하며 고객명·연락처·주소는 어떤 데이터셋에도 없습니다.
- **최대 50,000행** — 초과 시 응답에 `note` 필드가 붙습니다. 기간을 나눠 재요청해 주세요.
- **읽기 전용** — 조회만 가능하며 데이터 변경은 불가합니다.
- **토큰 관리** — 토큰은 이 데이터에 대한 접근 권한 그 자체입니다. 공개 저장소·프론트엔드 코드에 넣지 말고 서버 환경변수로 관리해 주세요. 유출이 의심되면 즉시 알려주시면 재발급합니다.

### 현재 API로 제공하지 않는 데이터 (대시보드 전용)

아래 항목은 외부 실시간 API(주문·정산)를 매 호출마다 조회해야 해서 이 API에는 포함하지 않았습니다. 필요 시 별도 협의로 제공 가능합니다.

- **반품/취소 구분(순매출)**, **회원/비회원·쿠폰·적립금 사용** — 카페24 주문 API 실시간 조회 필요(응답 지연 큼)
- **스마트스토어 정산·수수료** — 네이버 커머스 API가 고정 IP 허용이 필요해 이 서버에서 호출 불가(별도 서버 경유 필요)
- **자사몰 유입경로·검색어·페이지뷰 상세** — 카페24 통계 API 실시간 조회 필요

## 7. 에러

| 응답 | 원인 |
|---|---|
| `401` `unauthorized` | 토큰 누락/불일치 — 헤더 형식 `Authorization: Bearer <토큰>` 확인 |
| `400` `알 수 없는 dataset` | 데이터셋 이름 오타 — 사용 가능 목록이 메시지에 포함됨 |
| `400` `start/end 필요` | 기간 파라미터 누락 또는 형식 오류(`YYYY-MM-DD`) |
