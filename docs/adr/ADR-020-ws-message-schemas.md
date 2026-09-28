# ADR-020 WebSocket 메시지를 JSON Schema 로 계약하고 웹에서 검증한다

**상태** 채택 · 2026-09-29 · 계약 v5 §E · 리뷰 R-76 · R-93

## 배경
Redis 스트림은 `schemas/*.json` 으로 두 언어가 계약하지만, WebSocket 16–17종 메시지는 기계 검사 계약이 없었다(R-76). 웹은 대부분을 검증 없이 형 변환했다 —
원소 하나가 잘못되면 주 스레드와 워커가 갈라지고, `diff` 는 적용 전에 `lastSeq` 를 올려 다음 전체 스냅샷(30 s · 전세계 120 s)까지 어긋난 채였다(R-93).

## 결정
- `schemas/ws/server.v1.json`(type 으로 나뉜 oneOf) · `schemas/ws/client.v1.json`. api 시험이 실제 빌더(WsMessages · WsHub)로 만든 메시지를 검증하고 그 표본을 웹 시험 fixture 로 남긴다.
- 웹 `lib/ws-validate.ts`: 메시지 종류별 형태 검사 — 잘못된 원소는 버리고 수를 센다(상태 표시), 봉투가 틀리면 메시지를 버리고 그 종류에 맞게 다시 받는다. `diff` 는 적용이 끝난 뒤에만 `lastSeq` 를 올린다. 처리 중 예외도 같은 복구 + 브라우저 오류 보고(§C8).
- 다시 받기는 종류마다 다르다(2차 리뷰): 항공기 · 선박 흐름은 `resync`, 서버가 바뀔 때만 보내는 목록(알림 · SIGMET · 레이더)은 `{type:"resync", scope}` 로 그 목록만 전체로.
  알림 배치는 증분이라 하나를 잃으면 다음 배치로 바로잡히지 않는다 — 웹은 배치 버전의 틈(v > 현재+1)도 잃은 것으로 본다.
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
  status 표본은 둘 — 연결 없는 Redis(빈 값)와, 수집기 heartbeat · AIS · 기상청 레이더 · 활성 공급자 해시가 있는 Redis(`status.populated` — sources.ais · radar_kr · active_providers ·
  demand.adsb_fi_rps_1m 이 채워진 운영 StatusService 출력).
- **웹 검증기**: `lib/ws-validate.ts` 의 규칙 표가 스키마의 `$defs` 와 1:1 이다(shape · str · int · num · re · oneOf · arrOf · tuple · mapOf 조합 — 런타임 스키마 해석기는 아니다).
  `tests/ws-schema-sweep-v5.test.ts` 가 표본마다 스키마의 잎 제약을 모두 훑어(`tests/helpers/schema-sweep.ts`) 제약 하나에 틀린 값 하나(표본 전체 약 800건)를 만들어 웹이 버리거나 세는지,
  스키마가 허용하는 끝값(최소 · 최대 · 최대 길이 · 열거값 · 시간대가 있는 시각 · 상한 없는 수의 1e9 · 긴 문자열 — 약 520건)은 그대로 받는지 본다. 시각은 RFC 3339 + 달력 검사
  (contract_check 와 같다 — `Date.parse` 는 "9999" · 2월 30일을 받는다), 길이는 코드포인트로 센다.
  틀린 값의 처리(모두 상태 바에 센다): (1) 적용에 꼭 필요한 값(type · seq/sseq · 원소 배열 · 알림 version · SIGMET collection · 레이더 host/generated/past · selected hex/prediction ·
  ship_selected mmsi · error code · status 의 모든 값)이면 메시지를 버린다. (2) 배열 원소와 따로 버릴 수 있는 묶음(selected.state/route · demand.hot/focus ·
  ship_selected.state/static/destination_info · 스냅샷 sources.region/global · 격자 칸 선종별 수)은 그것만 버린다. (3) 참고 값(welcome 의 값 전부 · v/ts/fetched_at/provider/
  computed_at/sigmets_version · ships_grid cell_deg/capped · error title/detail)은 모름(null)으로 둔다 — welcome 은 버리지 않는다(쓰지 않는 값 때문에 연결을 다시 맺는 고리가 없다).
  웹이 스키마보다 너그러운 곳: 없는 키 · null(모름), 모르는 키(보지 않는다), 네 원소 격자 칸(구 서버). 엄격한 곳: 격자 칸 선종별 수의 합 = 칸 선박 수(교차 규칙 — 틀리면 선종별 수만 버린다).
  이 둘은 스윕 시험의 예외 목록에 적혀 있다. 검증을 통과한 뒤의 정규화(lib/ships · lib/route — AIS 채움 문자 제거 · 옛 위치 출처 gnss → 모름 · 선박 폭 dim_c/dim_d 0–63 ·
  노선 콜사인 3–8자)는 기존 규칙 그대로다(값을 모름으로 바꿀 뿐 원소를 버리지 않는다 — 이번 범위 밖).
- **다시 받기(lib/ws.ts recoverFrom)**: 버린 · 처리에 실패한 메시지 뒤 — 항공기 · 선박 흐름은 그 seq 를 버리고 `resync`(서버: 항공기 · 선박 스냅샷). 알림 · SIGMET · 레이더는
  `{type:"resync", scope:"alerts"|"sigmets"|"radar"}` — 서버(WakelineWsHandler → WsHub.resyncAlerts/Sigmets/Radar)는 그 목록 하나만 버전과 무관하게 전체로 보낸다(일시정지 중이면
  보내지 않고 resume 의 전체 초기 세트가 보낸다, 모르는 scope 는 BAD_RESYNC). 요청은 목록마다 그 목록이 올 때까지 한 번(10 s 뒤 다시). JSON 이 아닌 프레임은 위를 모두.
  status 는 30 s heartbeat, selected · ship_selected 는 대상이 바뀔 때, demand 는 바뀌거나 30 s 마다 다시 오므로 요청하지 않는다(항공기 스냅샷 — 1만 대 LITE 면 약 2.8 MB, 아래 번들 절의 측정 — 을 끌어오지 않는다).
  알림: 버린 alerts/alerts_batch · 버린 알림 원소 · 배치 버전 틈 · 버전 없는 배치면 `alertsVersion` 을 null(수 "—"), `alertsIncomplete` 로 두고 전체 목록을 요청한다. 그동안 받은
  배치는 반영하지만 수는 모름이다 — 알림 패널은 "알림 목록 일부 누락"을 밝히고 ETA 를 멈춘다(R-09). 틀린 원소가 든 전체 목록은 보이되 수는 모름으로 두고 바로 다시 묻지 않는다
  (같은 버전이면 같은 목록 — 다음 배치가 10 s 게이트로 다시 묻는다). welcome 은 처리 중 예외일 때만 연결을 다시 맺는다(4001).
- **상태 바**: "WS 형식 오류 · 원소 N · 메시지 N · 예외 N"(0 인 단위는 뺀다 — 단위가 다른 수를 더하지 않는다) 단추. 키보드 · 터치로 여는 popover(최상위 층 — 가로 스크롤되는
  상태 바에 잘리지 않는다)에 단위별 뜻 · 실제 다시 받기 · 보고 위치 · 마지막 사유와 시각, 복사 단추.
- **번들**(`next build`, gzip -9): 검증기는 지도(MapView)와 함께 동적으로 불러오는 청크에 있다 — `/` 의 첫 로드 목록(page entryJSFiles)에는 없다. 레인 안의 빌드로 잰 값(레인 보고 —
  결과 파일은 남기지 않았다): 그 청크 30.9 KiB(레인 전) → 37.8 KiB(1차) → 42.0 KiB(2차, gzip 10.2 → 12.9 → 14.6 KiB), `/` 첫 로드에 드는 것은 상태 바 배지(WsInvalidBadge)뿐 — `/` entry 합계 +2.1 KiB(gzip +0.7 KiB).
  병합 뒤 main 빌드(09-29 06:21 KST)에서 다시 잰 그 청크: 42.2 KiB · gzip -9 14.6 KiB. 첫 로드 전송량 전체의 변화는 PERF §8.
  1만 대 LITE 스냅샷(2.8 MB) 검사 3.8 ms(1차 규칙 2.2 ms, JSON.parse 9 ms — 같은 기계).

## 되돌리기
커밋 되돌리기. 프로토콜은 클라이언트 → 서버 resync 에 선택 키 scope 하나만 더했다(구 서버는 모르는 키를 무시하고 항공기 · 선박 스냅샷을 보낸다 — 알림은 다음 재연결 · resume 에서 바로잡힌다).
