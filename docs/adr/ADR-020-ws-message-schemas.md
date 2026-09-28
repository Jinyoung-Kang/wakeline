# ADR-020 WebSocket 메시지를 JSON Schema 로 계약하고 웹에서 검증한다

**상태** 채택 · 2026-09-29 · 계약 v5 §E · 리뷰 R-76 · R-93

## 배경
Redis 스트림은 `schemas/*.json` 으로 두 언어가 계약하지만, WebSocket 16–17종 메시지는 기계 검사 계약이 없었다(R-76). 웹은 대부분을 검증 없이 형 변환했다 —
원소 하나가 잘못되면 주 스레드와 워커가 갈라지고, `diff` 는 적용 전에 `lastSeq` 를 올려 다음 전체 스냅샷(30 s · 전세계 120 s)까지 어긋난 채였다(R-93).

## 결정
- `schemas/ws/server.v1.json`(type 으로 나뉜 oneOf) · `schemas/ws/client.v1.json`. api 시험이 실제 빌더(WsMessages · WsHub)로 만든 메시지를 검증하고 그 표본을 웹 시험 fixture 로 남긴다.
- 웹 `lib/ws-validate.ts`: 메시지 종류별 형태 검사 — 잘못된 원소는 버리고 수를 센다(상태 표시), 봉투가 틀리면 메시지를 버리고 resync. `diff` 는 적용이 끝난 뒤에만 `lastSeq` 를 올린다. 처리 중 예외는 resync + 브라우저 오류 보고(§C8).
- 런타임 JSON Schema 검증기는 싣지 않는다(번들 크기 — NFR-04). 손으로 쓴 검증기가 스키마와 어긋나지 않게 fixture 시험으로 묶는다.

## 구현(레인 ws-contract, 2026-09-29)
- **스키마**: `schemas/ws/server.v1.json`(17종 — `type` 상수로 나뉜 oneOf, ships_grid 칸은 다섯 원소 · 선종별 수 11개) · `client.v1.json`(10종). 서버는 null 인 키를 보내지 않으므로(non_null)
  필드는 null 을 허용하지 않고 "없는 키 = 모름" 이다 — 명시적으로 null 을 싣는 키(sources.global · selected.state/route · demand.hot/focus · ship_selected 의 세 값 · SIGMET geometry)만 null.
  항공기 · 선박 필드 제약은 스트림 스키마와 같게 두고 시험이 비교한다(null 제외). 운영 코드는 WS 스키마를 읽지 않으므로 클래스패스 복사본이 없다.
- **Java**: `WsSchemaContractTest` 가 FakeWsSession 으로 실제 경로(WsHub · ShipFanout · ShipGrid · DemandService.message · StatusService · RouteReader · DestinationParser)를 태워 받은 메시지를 모두 검증한다.
  매퍼는 application.yml 의 `spring.jackson.*` 를 JacksonAutoConfiguration 에 넣어 만든 운영 매퍼 — 시험용 `WsTestKit.JSON` 은 맵의 null 값을 빼지 않아 운영과 다르다.
  `WsIT`(전체 앱 · 실제 소켓)도 받은 메시지를 모두 같은 스키마로 검증한다.
- **표본**: `apps/web/tests/fixtures/ws-samples.v1.json`(커밋). 기본 실행은 커밋된 표본과 지금 빌더의 출력을 비교해(시각 · 지연은 가리고 순서 없는 목록은 정렬) 다르면 실패한다.
  다시 만들기: `make ws-samples`(= `cd apps/api && ./gradlew test --tests 'dev.wakeline.ws.WsSchemaContractTest' -PupdateWsSamples`). `tools/contract_check.py` 가 같은 표본을 Python jsonschema 로 한 번 더 본다.
- **웹**: `lib/ws-validate.ts` 가 표본을 모두 통째로 받고, 스키마 위반으로 확인한 변형 55가지를 버리거나(봉투) 원소를 버린다(시험). 웹이 스키마보다 너그러운 곳은 "모름"뿐이다 —
  없는 키 · null · 메시지의 v/ts/sources · 네 원소 격자 칸(구 서버). 봉투가 틀린 welcome 은 구독하지 않고 연결을 다시 맺는다(4001). resync 는 항공기 · 선박 스냅샷만 다시 받으므로
  알림 · SIGMET · 레이더 · status 는 다음 갱신 때 바로잡힌다(프로토콜을 바꾸지 않는다). 버린 원소 · 메시지 · 처리 예외 수는 상태 바 배지("WS 형식 오류 N")와 연결 배지 툴팁에.
- **번들**: 검증기 단독 6.9 KiB(최소화) · 2.9 KiB(gzip). `/` 에서 곧바로 불러오는 ws 청크 30.9 → 37.8 KiB(gzip 10.2 → 12.8 KiB), 전체 클라이언트 청크 gzip +3.8 KiB(`next build`, 레인 측정).

## 되돌리기
커밋 되돌리기. 프로토콜 모양은 바뀌지 않는다(검증만 더한다).
