# Yogibo 판매분석 MCP 서버

Claude(Desktop/웹)가 **MongoDB의 판매 데이터를 직접 조회·분석**하게 해주는 MCP 서버.
기존 `lib/` 분석 함수들을 도구로 노출한다. **고객 개인정보(이름·연락처)는 노출하지 않음 — 집계/성과만.**

> 인앱 AI(API·종량제)와 달리, 이건 각자 **Claude 구독(정액)** 으로 쓴다 → 토큰 종량과금 없음.

## 노출 도구 (9개)

| 도구 | 내용 |
|---|---|
| `cafe24_analysis(start,end)` | 자사몰 매출·카테고리·충전재등급·상품TOP·색상 |
| `smartstore_analysis(start,end)` | 스마트스토어 상품·유입경로·쿠폰·할인이벤트 |
| `promotion_performance(start,end)` | 전 몰 프로모션별 매출·주문 |
| `cafe24_coupon_performance(start,end)` | 자사몰 프로모션 쿠폰별 매출·할인·실효할인율 |
| `marketing_inflow(start,end)` | 비즈어드바이저 채널별 유입수 |
| `other_channels(start,end)` | 쿠팡·롯데·현대·신세계 등 기타채널 매출 |
| `channel_comparison(start,end)` | 전년/전월/전주 비교 |
| `monthly_trend()` | 2024~현재 월별 추이 |
| `target_status(month)` | 월 목표 달성률 |

날짜는 `YYYY-MM-DD`, 월은 `YYYY-MM`.

## 실행

```bash
# 로컬(Claude Desktop): stdio
npm run mcp

# 원격 호스팅: HTTP (PORT, MCP_TOKEN 환경변수)
MCP_TOKEN=<긴-비밀토큰> PORT=8787 npm run mcp:http
# → http://<host>:8787/mcp  (인증: Authorization: Bearer <MCP_TOKEN>)
# → http://<host>:8787/health 로 헬스체크
```

서버는 `.env`의 Mongo 접속정보(`MONGODB_URI`/`ONLINEDATA_URI` 등)가 필요하다.

## 두 사람 연결하기

**구조: MCP 서버 1개(공유) + Claude 계정 사람당 1개.** 서버는 한 번만 올리고, 각자 자기 Claude로 붙는다.

### A. 로컬 stdio (가장 간단, 셋업 빠름)
각자 PC에 이 저장소(+`node_modules`, `.env`)를 두고, **Claude Desktop** 설정에 추가:

`claude_desktop_config.json`
```json
{
  "mcpServers": {
    "yogibo-sales": {
      "command": "node",
      "args": ["C:\\Users\\<당신>\\onlineData\\mcp\\server.js"],
      "cwd": "C:\\Users\\<당신>\\onlineData"
    }
  }
}
```
Claude Desktop 재시작 → 도구 9개가 잡히면 끝.

### B. 원격 HTTP (한 번 올려두고 둘이 붙기) ← "올릴꺼야"면 이쪽
1. 서버를 상시 호스트(예: **클라우드타입**, VM)에 올린다 — `npm run mcp:http`, 환경변수 `MONGODB_URI`·`MCP_TOKEN`·`PORT`.
   - ⚠️ Vercel(서버리스)은 세션 유지가 어려워 **상시 실행 호스트** 권장.
2. 공개 URL `https://<host>/mcp` + 토큰을 두 사람에게 공유.
3. 각자 **Claude Desktop**에서 원격 MCP 커넥터로 추가 (URL + `Authorization: Bearer <MCP_TOKEN>` 헤더).
   - 클라이언트/버전에 따라 연결 방식이 조금 다를 수 있음 — 호스팅 끝나면 그 환경 기준으로 맞춰 드림.

## 보안
- `MCP_TOKEN`은 **긴 무작위 문자열**로, `.env`·호스팅 환경변수에만. **절대 커밋 금지.**
- 도구는 **집계/성과만** 반환 — 고객 PII(이름·연락처) 노출 안 함.
- 토큰 노출 시 즉시 교체.
