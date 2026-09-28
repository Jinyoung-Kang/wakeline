# ADR-020 WebSocket 메시지를 JSON Schema 로 계약하고 웹에서 검증한다

**상태** 채택 · 2026-09-29 · 계약 v5 §E · 리뷰 R-76 · R-93

## 배경
Redis 스트림은 `schemas/*.json` 으로 두 언어가 계약하지만, WebSocket 16–17종 메시지는 기계 검사 계약이 없었다(R-76). 웹은 대부분을 검증 없이 형 변환했다 —
원소 하나가 잘못되면 주 스레드와 워커가 갈라지고, `diff` 는 적용 전에 `lastSeq` 를 올려 다음 전체 스냅샷(30 s · 전세계 120 s)까지 어긋난 채였다(R-93).

## 결정
- `schemas/ws/server.v1.json`(type 으로 나뉜 oneOf) · `schemas/ws/client.v1.json`. api 시험이 실제 빌더(WsMessages · WsHub)로 만든 메시지를 검증하고 그 표본을 웹 시험 fixture 로 남긴다.
- 웹 `lib/ws-validate.ts`: 메시지 종류별 형태 검사 — 잘못된 원소는 버리고 수를 센다(상태 표시), 봉투가 틀리면 메시지를 버리고 resync. `diff` 는 적용이 끝난 뒤에만 `lastSeq` 를 올린다. 처리 중 예외는 resync + 브라우저 오류 보고(§C8).
- 런타임 JSON Schema 검증기는 싣지 않는다(번들 크기 — NFR-04). 손으로 쓴 검증기가 스키마와 어긋나지 않게 fixture 시험으로 묶는다.

## 되돌리기
커밋 되돌리기. 프로토콜 모양은 바뀌지 않는다(검증만 더한다).
