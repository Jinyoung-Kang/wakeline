# 기능 정확성 — 모든 API · WebSocket(QA 계획 §3.2) 발견 기록

- 영역: 공개 REST 27 · 운영 REST 19 · WS `/ws/v1` 의 정상 · 경계 · 비정상 입력, 쓰기 경로, fixture 대비 값 정확성. 결함 번호 QA-200 – QA-299.
- 환경(모든 항목 공통): 제품 코드 = main `359a3eac`(QA 브랜치 `qa/2026-10` 의 `a71b302b` 까지 apps · infra · schemas 변경 없음 — `git diff --stat 359a3eac a71b302b -- apps infra schemas` 빈 출력) ·
  격리 스택 **A**(`wakeline-e2e`, http://localhost:8701, fixture 모드, api 이미지 `20ca58fa936c` 2026-10-01T17:15Z) · 브라우저 없음(HTTP · WS 를 직접) · 측정 2026-10-01 17:23–18:05 UTC.
  재현 시험은 이 작업 가지 `qa-func` 의 `apps/api/src/test/java/dev/wakeline/qa/` — DB 시험은 운영과 같은 `wakeline-db:local` 이미지(Testcontainers), WS 시험은 실제 Tomcat.
- 도구(이번에 더함 — 모두 8701 · 8702 만 허용, 요청 제한을 다른 QA 에이전트와 나눠 쓰도록 `X-RateLimit-Remaining` 이 45 아래면 쉼):
  - `tools/qa/fuzz_api.py` — 경로 39개 · 사례 1,267건(공개 938 · 운영 329, 운영은 `qa_session.py` 의 `qa-b`). 기록: `evidence/functional/fuzz-20261001T172925Z.{jsonl,md}`
    (+ `fuzz-20261001T174745Z` — ships.search 의 limit 사례를 맞는 검색어로 다시).
  - `tools/qa/ws_probe.py` — WS 시나리오 86개(최소 RFC 6455 클라이언트 + `schemas/ws/server.v1.json` 검증). 기록: `ws-20261001T173159Z.{jsonl,md}`.
  - `tools/qa/write_probe.py` — 쓰기 228사례(설정 · 공급자 · 해결 표시 · 재집계 · `/client-errors`). 기록: `writes-20261001T175918Z.md`.
  - `tools/qa/value_checks.py` — fixture 대비 값 · 단위 · 시각 · 쪽 넘김 · 검색 · 재생 · 통계 33점검. 기록: `values-20261001T180305Z.md`.
- 스택 A 에 남긴 것: 운영 쓰기는 모두 되돌렸다(설정 `metar_poll_s` 는 같은 값으로 한 번 저장 → version 1 → 2 · updated_by qa-b, 공급자 `opensky` 끄고 켬 → version 4 · 켜짐,
  해결 표시 하나 만들고 되돌림 — 활성 0, 어제(KST) 재집계 3회 — 매일 03:30 에 어차피 다시 센다). QA-208 로 생긴 `stats_daily` 의 `-infinity` 행 하나는 지웠다(감사 행은 남김).
  `/client-errors` 정상 보고 4건(`QA-func probe — ignore`)이 브라우저 오류 스트림에, 퍼저의 500 들이 시스템 로그 ERROR 묶음에 남아 있다(지우는 API 없음 — QA-201 증거).

## 요약
| 번호 | 심각도 | 한 줄 | 재현 시험 |
|---|---|---|---|
| QA-207 | **높음** | 공개 `/stats/sigmet` · `/stats/alerts` 에 4713 BC 앞 날짜 → `generate_series(-infinity…)` 가 3 s 한도까지 DB CPU 100 % · 임시 파일 0.5–0.8 GB, 답은 503 '재시도' | `Qa207StatsBcDateRunsAwayTest` |
| QA-201 | 보통 | 시각 파라미터(Instant)가 PostgreSQL · Instant 범위 밖이면 500 + ERROR 스택(공개 4경로 · 운영 3경로) | `Qa201TimeParamOutOfRangeTest` · `Qa201OpsTimeParamOutOfRangeTest` |
| QA-202 | 보통 | 통계 날짜(LocalDate) 끝값 · PostgreSQL 범위 밖 → 500 + ERROR 스택(`/stats/*` 3경로 · 운영 재집계) | `Qa202StatsDateOutOfRangeTest` |
| QA-206 | 보통 | `/aircraft/search` 가 등록번호로 찾은 실시간 항공기에 등록번호를 싣지 않아 검색 목록이 '—' 로 그린다 | `Qa206AircraftSearchHidesRegistrationTest` |
| QA-203 | 낮음 | WS subscribe 의 bbox 원소가 309자리 이상 정수면 BAD_BBOX 대신 1002 로 끊김(알려진 한계의 새 경로) | `Qa203WsBboxHugeIntegerTest` |
| QA-204 | 낮음 | WS 메시지 상한이 '4 KB' 가 아니라 4,096 글자(UTF-16) — 12 KB 까지 받는다 | `Qa204WsMessageLimitIsCharsNotBytesTest` |
| QA-205 | 낮음 | 운영 `/ops/runs` 의 job · provider · status 에 NUL → 500 + ERROR 스택 | `Qa205OpsRunsFilterNulTest` |
| QA-208 | 낮음 | 운영 재집계가 4713 BC 앞 날을 받아 `day = -infinity` 행을 쓴다(응답 · 감사와 다른 값) | `Qa208AggregateBcDayWritesInfinityTest` |
| QA-209 | 낮음 | `/client-errors` 가 브라우저 시각의 연도 0 · 기원전을 다른 기원후 연도로 바꿔 저장(`yyyy` = 기원 안 연도) | `Qa209ClientErrorTsYearOfEraTest` |
| QA-210 | 낮음 | fixture 모드 항공기가 시간이 지나면 관심 지역을 영영 떠나고, 뒤집힌 항공기는 보고 방위와 반대로 움직인다(데모 · E2E · QA 스택) | `apps/collector/tests/qa/test_qa_210_fixture_aircraft_leave_region.py` |

재현 시험은 모두 지금 실패한다(아래 '재현 시험' 의 실패 글). 실행: `cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa20*'` — QA-201–208 의 9 클래스 · 30 사례는 함께 돌려 `30 tests completed, 30 failed`(34 s, Docker 필요), QA-209 는 `2 tests completed, 2 failed`(Docker 없이), QA-210 은 `cd apps/collector && uv run --offline pytest tests/qa -q` → `2 failed`.

## 결함

### QA-207 · 높음 · 기능 / 성능(보안 영역과 겹침 — 자원 고갈)
- **환경**: 공통(스택 A). 익명 요청, 인증 · 쿠키 없음.
- **재현 절차**:
  ```bash
  q="select temp_files, temp_bytes from pg_stat_database where datname='wakeline'"
  docker exec wakeline-e2e-db-1 psql -U postgres -d wakeline -Atc "$q"
  curl -s -i "http://localhost:8701/api/v1/stats/sigmet?from=-5000-01-01&to=-5000-01-02" | sed -n '1p;/^Retry-After/p;$p'
  docker exec wakeline-e2e-db-1 psql -U postgres -d wakeline -Atc "$q"
  # 같은 것: /api/v1/stats/alerts?from=-5000-01-01&to=-5000-01-02 · /api/v1/stats/sigmet?to=-5000-01-01 · from=-4713-11-20&to=-4713-11-30
  ```
- **기대 결과**: 400 `BAD_RANGE`(problem+json) — 저장소에 닿지 않고 바로. 날짜 하한(예: 2000-01-01 또는 PostgreSQL 하한)을 검사.
- **실제 결과**: 3.1 s 뒤 **503 `UNAVAILABLE` "data store temporarily unavailable; retry later" + `Retry-After: 10`**(다시 해도 같다). 그 3 s 동안 DB 백엔드 하나가
  `active · IO:BufFileWrite` 로 돌고 db 컨테이너 CPU 94–100 %, `pg_stat_database.temp_bytes` 가 요청 하나에 **541 MB · 828 MB**(두 번 잼) 늘었다. 정상 범위(2026-09-01 ~ 10-01)는 18 ms · 200.
  공개 조회 격벽(PublicReadGate 6개)과 IP 당 분당 120 이 동시에 돌 수 있는 수의 상한이지만, 그 6개를 이 요청으로 채우면 다른 공개 DB 조회(항적 · 이력 · 통계)가 모두 기다린다(추론 —
  부하 시험은 이 단계 밖이라 재지 않았다, '미확인' 5).
- **증거**: `evidence/functional/qa-207-stats-bc-date.txt`(요청 전후 temp_bytes `2501107712 → 3042500608`, 요청 중 `pg_stat_activity`
  `2359|active|IO:BuffileWrite|00:00:01.405|/* wakeline stats.days limit_s=3 */ SELECT … generate_series …`, `docker stats` 94.82 %, api WARN
  `statement cancelled (SQLSTATE 57014) … statement=stats.days statement_limit_s=3 → 503`), `temp_file_limit = -1`(제한 없음).
- **의심 원인**: `HistoryController.java:118-123`(range — from ≤ to · 92일만 보고 하한 없음) → `StatsRepository.java:70-74`(`generate_series(:from::date, :to::date, interval '1 day') d ORDER BY d`).
  pgjdbc 는 4713 BC 앞의 `LocalDate` 를 `'-infinity'` 로 보낸다(`-infinity + 1 day = -infinity` — 계열이 끝나지 않고, `ORDER BY` 가 임시 파일로 정렬한다). 끊는 것은 `Sql.publicRead` 의
  3 s 한도뿐이고, 그 취소(57014)를 `ProblemAdvice.unavailable` 이 '저장소 일시 장애' 로 분류한다(`ProblemAdvice.java:90-96`).
- **재현 시험**: `apps/api/src/test/java/dev/wakeline/qa/Qa207StatsBcDateRunsAwayTest.java` — 실패:
  `[/api/v1/stats/sigmet → 503 after 3364 ms {"detail":"data store temporarily unavailable; retry later",…,"code":"UNAVAILABLE"…}] expected: 400 but was: 503`(alerts 도 같음, 3226 ms).

### QA-201 · 보통 · 기능(입력 검증 · 오류 처리) — 보안 영역과 겹침(익명 ERROR 로그 넘침, SEC-10)
- **환경**: 공통. 공개 4경로는 익명, 운영 3경로는 `qa-b` 세션.
- **재현 절차**:
  ```bash
  B=http://localhost:8701/api/v1
  curl -s "$B/aircraft/71be01/track?from=%2B300000-01-01T00:00:00Z&to=%2B300000-01-01T01:00:00Z"   # 범위 검사 통과 → DB 가 거절
  curl -s "$B/aircraft/71be01/track?to=-1000000000-01-01T00:00:00Z"                                # end.minus(2h) 넘침
  curl -s "$B/ships/440123450/track?from=%2B300000-01-01T00:00:00Z&to=%2B300000-01-01T01:00:00Z"
  curl -s "$B/ais/gaps?to=-1000000000-01-01T00:00:00Z"
  curl -s "$B/alerts/history?from=-1000000000-01-01T00:00:00Z"                                      # toEpochMilli() 넘침
  curl -s "$B/alerts/history?from=%2B300000-01-01T00:00:00Z&to=%2B300000-01-01T01:00:00Z"
  # 운영(qa-b): /api/v1/ops/runs?since=%2B300000-01-01T00:00:00Z · ?since=-1000000000-01-01T00:00:00Z · /api/v1/ops/logs?since=%2B1000000000-12-31T23:59:59Z · /api/v1/ops/logs/groups?since=…
  ```
- **기대 결과**: 400(예: `BAD_RANGE` — '시각은 2000-01-01 ~ 지금 + 1일' 같은 범위) problem+json, INFO 한 줄(ProblemAdvice 설명: '4xx 는 INFO — 익명 요청으로 ERROR 스택을 쏟아내게 할 수 없다(SEC-10)').
- **실제 결과**: 500 `INTERNAL` "unexpected error" + api ERROR 스택. 퍼저에서 이 계열 500 이 공개 18건 · 운영 7건(통계 날짜 15건은 QA-202, 운영 NUL 3건은 QA-205 — 퍼저의 500 은 모두 43건). 그 ERROR 들이 시스템 로그 스트림을 거쳐 **운영 `/logs` 의 ERROR 묶음**으로
  보인다(`/ops/logs/groups?level=ERROR&service=api` 에 ProblemAdvice 묶음 21개 — 예외 종류 DataIntegrityViolationException · DateTimeException · ArithmeticException). 익명 사용자가
  분당 120 건까지 운영자의 '서버 오류' 목록을 만들 수 있다.
- **증거**: `evidence/functional/fuzz-20261001T172925Z.md`(5xx 표), `qa-201-202-205-api-error-log.txt`(request_id 로 맞춘 ERROR 줄 — 예:
  `rid=6e51578067e880616139e28165073348 /api/v1/aircraft/71be01/track?from=%2B300000-…&to=%2B300000-… → DataIntegrityViolationException … ERROR: timestamp out of range: "300000-01-01 00:00:00+00"`,
  `rid=6838d966cf5fe0904f6c0b641363c82c …?to=-1000000000-… → java.time.DateTimeException: Instant exceeds minimum or maximum instant`), `qa-201-202-ops-log-groups.txt`
  (묶음 목록 — 같은 시간 다른 QA 에이전트의 요청이 섞였을 수 있다).
- **의심 원인**: 시각 파라미터에 범위 검사가 없다 — `AircraftController.java:178-182`, `ShipController.java:346-350` · `400-404`, `WeatherController.java:109-113`(111: `end.toEpochMilli() - start.toEpochMilli()`),
  `OpsController.java:158` → `IngestRunRepository`(`Sql.java:21` `OffsetDateTime.ofInstant` 가 LocalDateTime 범위 밖에서 DateTimeException), `LogReader.java:451`(`since.toEpochMilli()`).
  DB 가 거절한 22008 은 Spring 이 DataIntegrityViolationException 으로 번역해 `ProblemAdvice.java:237-248`(`other` → 500 + `log.error`)로 간다. 반면 `/replay` 는 31일 규칙이 먼저라 같은 값에 400 이다(경로 사이 불일치).
- **재현 시험**: `Qa201TimeParamOutOfRangeTest`(공개 8사례) · `Qa201OpsTimeParamOutOfRangeTest`(운영 6사례) — 모두 실패:
  `[/api/v1/aircraft/71be01/track?from=+300000-01-01T00:00:00Z&to=+300000-01-01T01:00:00Z → 500 {"detail":"unexpected error",…,"code":"INTERNAL"…}] expected: 400 but was: 500`,
  `[/api/v1/ops/logs?since=+1000000000-12-31T23:59:59Z → 500 …]`(원인 `java.lang.ArithmeticException: long overflow`).

### QA-202 · 보통 · 기능(입력 검증 · 오류 처리) — 보안 영역과 겹침(익명 ERROR 로그 넘침, SEC-10)
- **환경**: 공통. 공개 3경로는 익명, 재집계는 `qa-b`.
- **재현 절차**:
  ```bash
  B=http://localhost:8701/api/v1
  curl -s "$B/stats/sigmet?from=%2B999999999-12-31&to=%2B999999999-12-31"   # f.plusDays(92) 넘침
  curl -s "$B/stats/alerts?to=-999999999-01-01"                               # t.minusDays(7) 넘침
  curl -s "$B/stats/sigmet?from=%2B300000-01-01&to=%2B300000-01-02"           # generate_series: date out of range for timestamp
  curl -s "$B/stats/traffic?day=%2B6000000-01-01"                             # date out of range(PostgreSQL date 상한 5874897 AD)
  # 운영(qa-b): POST /api/v1/ops/stats/aggregate?day=-999999999-01-01 → 500
  ```
- **기대 결과**: 400 `BAD_RANGE`(날짜 하한 · 상한 검사), INFO 한 줄.
- **실제 결과**: 500 `INTERNAL` + ERROR 스택(퍼저 공개 15건). 재집계는 500(트랜잭션 롤백 — 행 · 감사 없음).
- **증거**: `fuzz-20261001T172925Z.md`(stats.* 5xx), `qa-201-202-205-api-error-log.txt`(예: `rid=42aa7bfe… /api/v1/stats/sigmet?to=%2B6000000-01-01 → … ERROR: date out of range`,
  `…?to=%2B999999999-12-31 → java.time.DateTimeException: Invalid value for EpochDay`), `writes-20261001T175918Z.md`(`stats.aggregate day=-999999999-01-01: 500 INTERNAL`).
- **의심 원인**: `HistoryController.java:118-123`(`t.minusDays(7)` · `f.plusDays(92)` 를 범위 검사 전에 계산), `HistoryController.java:93-95`(traffic day 검사 없음),
  `StatsRepository.java:70-74`(date → timestamp 계열), `OpsController.java:65-72`(day < 오늘만 — `aggregateDay` 가 DB 에서 실패). 같은 뿌리의 다른 증상이 QA-207 · QA-208.
- **재현 시험**: `Qa202StatsDateOutOfRangeTest`(7사례) — 모두 실패: `[/api/v1/stats/sigmet?from=+999999999-12-31&to=+999999999-12-31 → 500 {…"code":"INTERNAL"…}] expected: 400 but was: 500`,
  `[/api/v1/stats/traffic?day=+6000000-01-01 → 500 …] expected: 400 but was: 500`.

### QA-206 · 보통 · 기능(검색 결과 값)
- **환경**: 공통(fixture 항공기 — 등록번호 `B-9971` · `B-9938` 이 호출부호 없이 들어 있다). 웹 화면은 코드로 확인(`components/AircraftSearch.tsx:268`).
- **재현 절차**: `curl -s "http://localhost:8701/api/v1/aircraft/search?q=B-99"` → 각 항목에 `registration` 이 있는지 본다. 같은 hex 의 `/api/v1/aircraft/780b7a` 와 견준다.
- **기대 결과**: 등록번호 앞부분으로 찾은 항목에 그 등록번호(가능하면 type_code 도)가 실린다 — 검색 목록의 '등록번호' 칸이 맞은 근거를 보인다.
- **실제 결과**: 실시간 항목 2건(`780b7a` · `780b1d`) 모두 `callsign` 도 `registration` 도 없다. 상세는 `state.registration = B-9971`, `static.registration = B-9971`. 웹 검색 목록은
  `h.registration ?? "—"` 라 서버가 아는 값을 '모름(—)' 으로 그리고, 'B-99' 로 찾은 줄에 'B-99' 가 어디에도 보이지 않는다. 같은 hex 의 DB 항목(등록번호 있음)은 실시간 항목 뒤라 버려진다.
  q=`B-` 20건 중 실시간 항목 모두 같다(`values-20261001T180305Z.md` 의 유일한 어긋남).
- **증거**: `evidence/functional/qa-206-search-registration.txt`.
- **의심 원인**: `AircraftController.java:105`(`AircraftJson.encode(a, "lite", false)` — lite 는 registration · type_code 를 싣지 않는다, `AircraftJson.java:77-82`)와 `:116`(같은 hex 의 DB 행을 건너뜀).
  매칭은 `:101-103` 에서 registration 을 본다.
- **재현 시험**: `Qa206AircraftSearchHidesRegistrationTest` — 실패: `java.lang.AssertionError: No value at JSON path "$.items[0].registration"`.

### QA-203 · 낮음 · WS(입력 처리) — 알려진 한계의 새 경로
- **환경**: 공통, Origin `http://localhost:8701`.
- **재현 절차**: `python3 tools/qa/ws_probe.py --only 'bbox_bigint_400|bbox_1e400'` (hello 뒤 `{"type":"subscribe","bbox":[124,33,1000…(400자리),39],"zoom":7}`).
- **기대 결과**: 범위 밖 bbox 와 같이 `error BAD_BBOX`, 연결 유지(1e400 은 그렇게 답한다).
- **실제 결과**: `error BAD_MESSAGE` 뒤 **1002 로 연결이 닫히고** api WARN(분에 한 줄). 알려진 한계(ADR-017 §6.2 S4 · VERIFICATION #101 '309자리 이상 정수의 WS zoom')는 zoom 만 적었다 —
  bbox 원소도 같은 결과다(영향은 같다: 그 연결만, 스택 없는 WARN).
- **증거**: `evidence/functional/qa-203-204-ws.txt`(`bbox_bigint_400 | fail | (1002, 'BAD_MESSAGE')`, WARN `JsonNodeException: 'BigIntegerNode' method asDouble() cannot convert value 1000…`).
- **의심 원인**: `WakelineWsHandler.java:195-203`(`v[i] = n.asDouble()` 201 — Jackson 3 은 double 로 못 바꾸는 BigIntegerNode 에서 던진다) → `:119-121` 의 마지막 그물(BAD_MESSAGE · 1002).
- **재현 시험**: `Qa203WsBboxHugeIntegerTest`(실제 앱 · 실제 WS) — 실패:
  `[error for a bbox member beyond double] Expecting actual: "{"type":"error","code":"BAD_MESSAGE",…}" to contain: ""code":"BAD_BBOX""`.

### QA-204 · 낮음 · WS(메시지 상한)
- **환경**: 공통.
- **재현 절차**: hello 뒤 `{"type":"ping","pad":"가…(4,072자)"}`(4,096 글자 · 12,240 바이트)와 같은 길이의 ASCII 4,097 바이트를 보낸다 — `qa-203-204-ws.txt` 의 python 조각.
- **기대 결과**: 계약대로 4 KB(바이트)를 넘으면 1009(`schemas/ws/client.v1.json` '≤ 4 KB', `WakelineWsHandler` 설명 '클라이언트 메시지 ≤ 4 KB', 상수 이름 `MAX_MESSAGE_BYTES`).
- **실제 결과**: 4,096 글자 · **12,240 바이트는 받아 pong**, 4,097 글자는 1009. 상한이 바이트가 아니라 디코딩한 UTF-16 글자 수다(최대 약 12 KB).
- **증거**: `qa-203-204-ws.txt`(`글자 4096 · 바이트 12240 → ['pong'] · 닫힘 None`).
- **의심 원인**: `WakelineWsHandler.java:39 · 64`(`setTextMessageSizeLimit(4096)` — Tomcat 은 텍스트 버퍼를 글자 단위로 잡는다).
- **재현 시험**: `Qa204WsMessageLimitIsCharsNotBytesTest` — 실패: `[a 9024-byte message must be refused like a 4,097-byte ASCII one (1009); pong received: true] Expecting actual not to be null`.

### QA-205 · 낮음 · 운영 API(입력 검증)
- **환경**: 공통, `qa-b` 세션(운영 경로 — 익명은 404).
- **재현 절차**: `python3 tools/qa/fuzz_api.py --only '^ops\.runs$'` 또는 세션으로 `GET /api/v1/ops/runs?job=a%00`(provider · status 도 같다).
- **기대 결과**: 400(필터 글자 검사 — 제어 문자 거절), INFO.
- **실제 결과**: 500 `INTERNAL` + ERROR 스택(`DataIntegrityViolationException … ERROR: invalid byte sequence for encoding "UTF8": 0x00`).
- **증거**: `qa-201-202-205-api-error-log.txt`(ops/runs 의 세 줄), `fuzz-20261001T172925Z.md`.
- **의심 원인**: `OpsController.java:151-158`(job · provider · status 를 검사 없이) → `IngestRunRepository.java:42-44`(SQL 매개변수). 다른 글자 필터(로그 q · fp · rid)는 `LogsController.java:93-106` 에서 검사한다.
- **재현 시험**: `Qa205OpsRunsFilterNulTest`(3사례) — 실패: `[/api/v1/ops/runs?job=a%00 → 500 {…"code":"INTERNAL"…}] expected: 400 but was: 500`.

### QA-208 · 낮음 · 운영 API(저장 값)
- **환경**: 공통, `qa-b` 세션 · CSRF(`write_probe.py`).
- **재현 절차**: 세션으로 `POST /api/v1/ops/stats/aggregate?day=-5000-01-01` → `SELECT day, metric, dim FROM stats_daily WHERE day = '-infinity'`(스택 A db 컨테이너).
- **기대 결과**: 400 `BAD_DAY`(PostgreSQL 이 담을 수 없는 날 · 원본이 있을 수 없는 날 거절) — 또는 적어도 요청한 날짜 그대로 저장.
- **실제 결과**: 200 `{"day":"-5000-01-01"}`, 감사 `72|STATS_AGGREGATE|-5000-01-01`, 그런데 저장된 완료 표식은 `-infinity|aggregated_at|sigmet` — 응답 · 감사와 저장 값이 다르다. (정리: 그 행 하나 지움.)
- **증거**: `evidence/functional/qa-208-aggregate-bc-day.txt`, `writes-20261001T175918Z.md`.
- **의심 원인**: `OpsController.java:65-72`(오늘 이전만 검사) → `MaintenanceJobs.aggregateDay`(`:331-` — `:d` 로 LocalDate 를 그대로) · pgjdbc 의 4713 BC 앞 LocalDate → `-infinity` 변환.
- **재현 시험**: `Qa208AggregateBcDayWritesInfinityTest` — 실패: `[POST ?day=-5000-01-01 → 200 {"day":"-5000-01-01"}; rows with day = -infinity: 1] expected: 400 but was: 200`.

### QA-209 · 낮음 · 기능(로그 값)
- **환경**: 공통(익명 `POST /api/v1/client-errors`), 저장된 항목은 `qa-b` 로 `/ops/logs` 에서 확인.
- **재현 절차**:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' -d '{"message":"QA ts min","path":"/qa","ts":"-999999999-01-01T00:00:00Z"}' http://localhost:8701/api/v1/client-errors
  # 운영 세션으로 GET /api/v1/ops/logs?service=web-client&q=QA → 그 항목의 context.client_ts
  ```
- **기대 결과**: `context.client_ts` = 받은 순간 그대로(`-999999999-01-01T00:00:00.000Z` · 연도 0 은 `0000-…`) — 또는 그런 ts 를 400 으로 거절.
- **실제 결과**: 204 뒤 `client_ts` = **`+1000000000-01-01T00:00:00.000Z`**(기원전이 먼 미래로), `0000-06-01T00:00:00Z` → `0001-06-01T00:00:00.000Z`. 운영자가 보는 '브라우저 시각' 이 받은 값과 다르다.
  (브라우저의 `toISOString()` 은 이런 값을 만들지 않는다 — 시계가 틀렸거나 직접 보낸 요청만, 그래서 낮음.)
- **증거**: 스택 A `/ops/logs`(stream client) 항목 `1790877502765-0` — `"message": "QA-func probe — ts min", "context": {"client_ts": "+1000000000-01-01T00:00:00.000Z", …}`(보낸 ts `-999999999-01-01T00:00:00Z`,
  `writes-20261001T175918Z.md` 의 `ts_year_min: 204`).
- **의심 원인**: `ClientErrorController.java:67`(`DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")` — `y` 는 year-of-era, 기원을 찍지 않는다. `uuuu` 이거나 `DateTimeFormatter.ISO_INSTANT` 여야 한다).
  같은 형식기가 `LogEvents.java:55` 에도 있지만 서버의 지금 시각만 쓰므로 닿지 않는다.
- **재현 시험**: `Qa209ClientErrorTsYearOfEraTest`(2사례) — 실패: `expected: "0000-06-01T00:00:00.000Z" but was: "0001-06-01T00:00:00.000Z"`,
  `expected: "-999999999-01-01T00:00:00.000Z" but was: "+1000000000-01-01T00:00:00.000Z"`.

### QA-210 · 낮음 · 기능(fixture 모드 값 — `make demo` · E2E · QA 스택)
- **환경**: 스택 A(fixture 모드 — 수집기 `FixtureAircraftProvider`), 기동 2026-10-01T17:15Z.
- **재현 절차**: 스택을 1시간 가까이 둔 뒤
  `curl -s 'http://localhost:8701/api/v1/aircraft?bbox=100,15,155,60'` 의 항공기 중 관심 지역(36.5,127.8 · 250 NM) 안의 수를 센다. 같은 hex 를 10 s 간격으로 두 번 읽어 위치 변화의 방향과 `track_deg` 를 견준다.
- **기대 결과**: 공급자 설명대로 "관심 지역 밖으로 나가면 반대편에서 다시 들어오게"(데모가 비지 않도록) — 항공기는 지역 안에 남고, 보이는 방위(track)와 움직임이 같다.
- **실제 결과**: 기동 55–57분 뒤 250 NM 안 **127 → 52대**, 가장 먼 것 654 NM(계속 멀어진다). `780de6` 은 track 249.98(서남서)인데 10 s 에 경도 +0.044° — 동북동으로 움직인다(보고 방위와 반대).
  지도의 기체 아이콘이 진행 방향과 반대를 가리키고, 오래 띄운 데모 · QA 스택은 한반도 위가 점점 빈다(같은 스택을 쓰는 화면 · 알림 시험의 기대도 시간에 따라 달라진다).
  뒤집는 순간 위치가 수백 NM 건너뛰어 수집기 품질 규칙 `position_jump` 가 기동 뒤 1시간에 131건 남았다(운영 품질 탭 — 예: `71c014` 344 NM / 10.1 s).
- **증거**: `evidence/functional/qa-210-fixture-drift.txt`.
- **의심 원인**: `apps/collector/wakeline_collector/providers/fixture.py:40-57`(`_moved` — 53행 — 지역 밖이면 `dead_reckon(원래 위치, trk + 180, gs, dt)` 로 원래 자리에서 같은 경과 시간만큼 반대로 보낸다 —
  그 위치도 곧 반경 밖이 되고, `a["track"]` 은 그대로 둔다). 왕복(경과 시간을 지역 지름 왕복 주기로 접기)하고 뒤집을 때 track 도 바꿔야 한다.
- **재현 시험**: `apps/collector/tests/qa/test_qa_210_fixture_aircraft_leave_region.py` — 실패:
  `AssertionError: 81/127 fixture aircraft are outside the 250 NM region after 1 h (farthest [('4ba94e', 681), ('a96f37', 658), ('48ae20', 653)])`,
  `AssertionError: 10 fixture aircraft move opposite to their reported track (hex, track, moved): [('71c591', 237.15, 58), ('899068', 194.47, 15), ('781de5', 247.84, 69)]`.

## 미확인
1. **항적 요청 두 건의 2.1–2.2 s**(`aircraft.track` `from=…23:59:60Z` · `stepS=1`, 17:31–17:33Z) — 같은 요청을 다시 재면 6–17 ms. 같은 때 다른 에이전트 · 내 Gradle 시험이 돌았다. 재현 못 함 → 성능 단계에서.
2. **WS 연결 상한(IP 당 5 · 전체 200)** — 같은 IP 의 다른 에이전트 브라우저 연결을 끊을 수 있어 스택 A 에서 하지 않았다(계획 §3.4 '동시 요청' — 스택 B).
3. **KST 날짜 경계의 통계 값** — 스택 A 는 2026-10-01T17:15Z(02:15 KST) 기동이라 KST 날짜 경계를 걸친 원본이 없다. 코드(`MaintenanceJobs.aggregateDay` 의 `[00:00 KST, +1일)` ·
   `extract(hour FROM ts AT TIME ZONE 'Asia/Seoul')`)와 기존 `StatsAggregationDbTest` 로 갈음했고, 스택 A 에서는 기본 범위(KST 오늘 − 7 ~ 오늘) · `day_zone` · 오늘 `aggregated=false` 만 확인.
4. **항적 보존(72 h) 경계에서 `/replay` 의 source 전환(track_point → track_point_1m)** — 새 스택이라 72 h 앞 자료가 없다. 31일 경계(±2분)와 2시간 레이더 경계만 확인.
5. **QA-207 의 동시 영향**(공개 조회 격벽 6개를 채웠을 때 다른 공개 DB 조회 · 기록기 지연 · 디스크) — 이 단계는 부하 시험 금지. 성능 · 신뢰성(스택 B)에서 잴 것.

## 개선 제안(결함 수에 넣지 않음)
1. **시각 · 날짜 파라미터 파서를 한 곳에**(설계): bbox 는 `platform.web.BboxParam` 한 곳에서 검사하는데, Instant · LocalDate 는 컨트롤러마다 따로 계산 · 비교한다(QA-201 · 202 · 207 · 208 이 모두 여기서 나온다).
   `platform.web` 에 `TimeRange.parse(from, to, 기본 길이, 최대 길이, 하한)` 같은 공통 파서(PostgreSQL · Instant 범위 · 하한 2000-01-01 — 해결 표시의 `UPTO_MIN` 과 같은 값)를 두면 경로 사이 규칙도 같아진다.
2. **같은 정수 파라미터의 다른 규칙**: `/ships/search?limit` 은 범위 밖 400 `BAD_LIMIT`(계약 v5 §B1), `/alerts/history` · `/ops/runs` · `/ops/audit` · `/ops/logs` 의 limit 과 `/ops/quality?days` 는 끝값으로
   자른다(`WeatherController.java:112`, `OpsController.java:157 · 177 · 219`, `LogsController.java:72` — 로그만 문서에 적힘). 공개 `/alerts/history` 의 규칙을 문서에 적거나 하나로.
3. **모르는 필터 값의 처리가 경로마다 다르다**: `/alerts?kind=bogus` → 관측 + 예측 **모두**(`EngineService.java:247-254` — 오타가 예측 알림을 섞는다), `/sigmets?hazard=bogus` → 0건,
   `/stats/sigmet?group=bogus` → fir 로(응답 group 이 밝힘), `/aircraft?detail=bogus` → lite. 모르는 값은 400 으로 통일 제안(웹은 이 쿼리들을 쓰지 않는다 — 공개 API 소비자만).
4. **Spring 의 너그러운 해석**: 중복 파라미터는 형이 있으면 첫 값(`from=a&from=b` → a), 글자면 쉼표로 이어 붙인다(bbox 8개 → 400). 정수는 `0x10` · 전각 `５` · `+5` 도 받고, LocalDate 는
   `10/02/26`(en_US 짧은 형식)도 받는다. `String.trim()` 이 NUL 도 지워 `bbox=124%00,…` · `hex=71be01%00` · `q=%00AB` 가 정상으로 통과한다. 해는 찾지 못했지만 OpenAPI(int32 · date)보다 넓다.
5. `/airports/{icao}/wx` 의 `toUpperCase()`(기본 로캘 — `WeatherController.java:274`, `Params.java:9` 의 `toLowerCase()` 도) — `rksı`(점 없는 ı)가 RKSI 로 찾아진다. 다른 곳처럼 `Locale.ROOT` 와 ASCII 검사 먼저.
6. `Accept: application/geo+json` 으로 `/status`(GeoJSON 아님)를 부르면 `Content-Type: application/geo+json` 으로 나간다(produces 없는 경로의 협상).
7. 이미 꺼진 공급자를 다시 끄면 `version` 이 오르고 감사 행이 하나 더 생긴다(멱등 요청이 변경으로 기록 — `writes` 의 `version 2 → 3`). `aircraft_providers` 는 `opensky,opensky` 같은 중복을 받는다(`SettingsService.java:174`).
8. `/client-errors` 는 모르는 필드(`pad`)를 받아 버리고, 해결 표시는 모르는 필드를 거절한다(`ResolutionService` FIELDS) — 같은 '익명 · 운영 본문' 규칙을 하나로.
9. edge 가 만든 `/api/` 오류(414 URI 8 KB 초과 · NUL 경로 400 · 413 1 MB 초과 · 429)는 nginx HTML 이다(429 는 VERIFICATION 에 '설계대로'). `/api/` location 에 problem+json `error_page` 를 두면 클라이언트 처리가 하나가 된다.
10. 405 의 `Allow` 가 `GET` 만이다(HEAD · OPTIONS 도 200).

## 확인했고 문제없음
- **REST 응답 모양**: 퍼저 1,267건 중 4xx · 5xx 772건 전부(edge 가 만든 27건 — 414 · NUL 경로 400 — 제외)가 `application/problem+json` 이고 `type · title · status · detail · code · request_id` 를 갖고, 본문 `status` = HTTP 상태,
  `request_id` = `X-Request-Id`. 405(Allow) · 404(대소문자 · 끝 `/` · v2) · 406(Accept 불일치, 본문 없음 — 설계) 확인. 중앙값 14.6 ms · p95 113 ms(500 제외), 가장 큰 응답 365 KB(`/ops/logs`).
- **bbox(REST 5경로)**: NaN · Infinity · 지수 · 16진 실수 · 접미사 · 21자리 소수 · 전각 · 아랍 숫자 · 개수 틀림 · 역순 · 폭 0 · 날짜변경선 · 범위 밖 → 400 `BAD_BBOX`, 면적 2,500 초과 → 422 `BBOX_TOO_LARGE`
  (aircraft · ships · replay. sigmets · airports 는 상한 없음 — 설계), 정확히 2,500 은 200. `-0` · 공백 · `+` 부호 · 아주 작은 상자 200.
- **경로 값**: hex(6자리 16진 · 대소문자 · 앞뒤 공백) · MMSI(9자리, 아랍 · 전각 숫자 거절) · ICAO · 기상청 tm(12자리 ASCII) · 로그 id(`\d{1,20}-\d{1,20}`, 64비트 넘으면 404) · SIGMET id · 인코딩한 `/` 와 `..`(400) — 모두 4xx.
- **기간 규칙**: 항공기 · 선박 항적 24 h(정확히 24 h 200, +1 s 400), AIS 공백 31일, 알림 이력 30일, 통계 92일(정확히 92 200, 93 400), 재생 31일(−2분 200 · +2분 400) · 미래 60 s, 역순 · 같음 400.
- **검색**: `/aircraft/search` 2–10자 `[A-Z0-9-]`(1 · 11자 · 따옴표 · 유니코드 · 이모지 400), ≤ 20건, 실시간 먼저. `/ships/search` 2–40자 · limit 1–20(0 · 21 · 2^31 → 400), 13키 · `count` · 정확 일치 → 최근 보고 순.
- **값 정확성(fixture 대비)**: 항공기 127대 — `alt_ft`(ft) · `gs_kt`(kt) · `track_deg`(deg) · `vrate_fpm`(ft/min) · squawk · 호출부호가 `adsb_lol_region.json` 그대로, fixture 에 없는 값은 키 없음.
  선박 376척 — 선수방위 511(133척) · 침로 360(25척) → 키 없음(SOG 102.3 은 fixture 484줄에 없어 `apps/collector/wakeline_collector/ais/parse.py` 의 `SOG_NA` 규칙으로만 확인), SOG(kt) · 선수방위가 보고값 중 하나, ETA 월 0 · 일 0 · 시 24 · 분 60 → 그 칸만 없음(25척 상세), 크기(m) · 흘수(m) · 선명 그대로.
  공개 응답의 ISO 시각 938개 모두 UTC `Z`(`reg_dt_kst` 같은 KST 필드는 이름이 밝힘 — 계약 v5 §G20). 웹의 선박 ETA KST 변환(`lib/ship-card.ts` `etaKst` — 2월 28일 · 29일 · 12월 31일 넘김)도 코드로 확인.
- **알림 이력 쪽 넘김**: 3시간 창 706건을 limit 25(29쪽)와 limit 200(4쪽)으로 끝까지 — 겹침 · 빠짐 없음, id 내림차순, `entered_at` ∈ [from, to], hex 필터(대문자 입력) 정상.
- **재생 · 통계**: 5분 전 → `source: track_point`, 항공기 89대 모두 at ± 3분 · bbox 안, radar 있음 / 3시간 전 radar null(RainViewer 2시간). 통계 기본 범위 KST 8일 · `day_zone: Asia/Seoul` · 오늘 `aggregated: false`.
- **쓰기 — `/client-errors`**: 정상 204, `text/plain` · Content-Type 없음 415, JSON 깨짐 · 배열 · null · 빈 본문 · message 빈 값 · 숫자 · 2,001자 · path 가 '/' 로 시작 안 함 · 절대 URL · 301자 ·
  시간대 없는 ts · stack 8,001 · component 201 · 잘못된 UTF-8 · 깊은 중첩 400, 8,433 바이트(Content-Length · chunked 모두) 413, 2 MB 는 edge 413. IP 당 분당 10 을 지키며 보냄.
- **쓰기 — 설정 PUT**: 키 10개 모두 상한 · 하한 안은 통과(409 로 확인 — 일부러 틀린 If-Match), 하나 밖 · 실수 · 글자 · null · bool · 2^31 · 2^63 · 10^400 · 배열 · 객체 → 400 `BAD_VALUE`.
  region_center ±85 · ±180 경계, 소수 9자리 · 지수 · NaN · 아랍 숫자 400. ais_bboxes 상자 16개 · 구역 3개 통과, 17 · 4 · 빈 구역 · 넓이 0 · 범위 밖 · 소수 7자리 · `+` · 1,025자 400. If-Match 없음 428 ·
  `"abc"` · `W/"1"` · 11자리 · `*` 400 · `-1` 409, 모르는 키 404, JSON 깨짐 · 빈 본문 · null 400, text/plain 415. 같은 값 저장 200(version +1 · mirrored) → 옛 version 409.
- **쓰기 — 공급자 · 해결 표시 · 재집계**: 모르는 공급자 · 동작 · 대문자 · 남는 경로 404, 인코딩한 `/` 400, GET 405. 해결 표시 본문 규칙 25가지 → 400 `BAD_RESOLUTION`(중복 필드 · 모르는 필드 ·
  미래 · 2000 전 · 시간대 없음 · 제어 문자 · 4,097자 · 깊은 중첩 포함), 201 → 목록 → 204 → 다시 404, 경로 id 형식 밖 404. 재집계 오늘 · 내일 · 틀린 형식 · 2월 30일 400, 어제 200(본문 day 는 무시).
- **WS(86 시나리오, 기대와 다른 것은 QA-203 하나)**: hello 전 메시지 4종 · 대문자 HELLO · JSON 깨짐 → error + 1002, hello 5 s 시간 초과 1002, proto 2 · 없음 · null · 2^31 · 2^32+1 · 1e10 · 1e400 · 400자리 · 음수
  → UNSUPPORTED_PROTO + 1002(`"1"` · 1.9 는 받아들임 — 스키마보다 너그러움, 설명에 적힌 대로). 배열 · 숫자 · null · 글자 · 빈 메시지 · type 숫자 · 객체 · 모르는 종류 → UNKNOWN_TYPE(연결 유지),
  깊이 1,500 → BAD_JSON 1002, 잘못된 UTF-8 → 1007, 바이너리 → 1003, 4,097 바이트 ASCII · 64 KB → 1009, 20개/10 s 넘음 → 1008, subscribe 15번 연속 → 마지막 bbox 로 하나.
  bbox · zoom · detail · select · select_ship · layers · resync 의 형 · 범위 오류 → 각 오류 코드(연결 유지), zoom 은 0–24 로 자름, 전세계 bbox 는 zoom ≤ 5 만. 형식 오류로 닫힌 연결 20개 뒤에도
  새 연결이 welcome 을 받음(연결 상한 예약이 풀림 — 갇힌 세션 없음). 다른 Origin 핸드셰이크 403. 받은 서버 메시지 모두 `schemas/ws/server.v1.json`(Draft 2020-12) 통과 — 종류 welcome · snapshot · diff ·
  alerts · alerts_batch · sigmets · radar · status · demand · selected · ships_snapshot · ship_selected · error · ping · pong.
