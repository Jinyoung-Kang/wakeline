# api 보안(api-sec) — AWS 공개 데모 QA(2026-10-14)

- 대상: 브랜치 `qa/aws-2026-10`(main `29d39e38` + QA 도구) — 제품 코드는 고치지 않았다(찾기 단계). 결함 번호 범위 QA-1100–1129 중 **1100–1103** 을 썼다.
- 환경 **U**: JUnit 통합 시험(`IntegrationTest` — `@SpringBootTest` 실제 Tomcat 임의 포트 + Testcontainers PostGIS(`wakeline-db:local` 읽기만) +
  실제 ACL Redis(`redis:8-alpine` + `infra/redis/start.sh`)). 요청은 127.0.0.1(신뢰하지 않는 원격)에서 **원시 소켓**(`QaRawHttp` — 헤더 값 바이트 ·
  요청 줄을 그대로)으로 보냈다. 라이브 스택(8701 · 8702) · AWS · 외부 공급자는 쓰지 않았다.
- 방법: 코드 읽기(보안 체인 · 필터 순서 · 방화벽 · 세션 · 요청 제한 · 오류 처리 · 입력 규칙) → 임시 탐침 IT 두 개로 약 70가지 요청을 실제로 보내 관찰
  ([probe-output.txt](../evidence/api-sec/probe-output.txt) · [qa-1101-flood-probe.txt](../evidence/api-sec/qa-1101-flood-probe.txt), 탐침 원본은
  `evidence/api-sec/probes/` — 저장소의 시험에서는 지웠다) → 재현된 것만 재현 시험으로 고정.
- 실행한 시험: 새 재현 시험 16건(15 실패 · 대조 1 통과) + 대조군 기존 시험 36건(`SecurityIT` 25 · `OpsSessionLifetimeFilterTest` 9 ·
  `RateLimitFilterTest` 2 — 모두 통과) · 탐침 IT 2회.

| 번호 | 심각도 | 결함 | 재현 시험 |
|---|---|---|---|
| QA-1101 | 보통 | 공개 경로가 읽는 헤더(If-None-Match · User-Agent)의 C1 제어 문자 → 익명 500 + ERROR 스택, 서버 로그 스트림을 익명 요청으로 채울 수 있다 | `apps/api/src/test/java/dev/wakeline/qa/Qa1101ControlCharHeaderValueIs500IT.java` |
| QA-1100 | 낮음 | 보안 체인이 끝낸 익명 운영 요청(404 · CSRF 403 · Origin 403)이 공개 요청 제한(IP당 분당 120)에 세지지 않는다 | `…/qa/Qa1100AnonymousOpsRequestsSkipRateLimitIT.java` |
| QA-1102 | 낮음 | 익명 로그인의 username 에 NUL → 500 + ERROR(실패한 SQL 포함) | `…/qa/Qa1102LoginUsernameNulIs500IT.java` |
| QA-1103 | 낮음 | `strip()` · `trim()` 이 U+001C–U+001F · 탭을 지워 제어 문자가 붙은 hex · icao · mmsi · 정수 · 날짜 · 선택 값을 받아들인다(계약 §G43 위반) | `…/qa/Qa1103StripAcceptsControlCharsIT.java` |

실행 명령(네 결함 모두 + 대조군):
```bash
cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa110*' --tests 'dev.wakeline.it.SecurityIT' \
  --tests 'dev.wakeline.ops.OpsSessionLifetimeFilterTest' --tests 'dev.wakeline.platform.web.RateLimitFilterTest'
# → 52 tests completed, 15 failed (2026-10-14 04:03 KST) — 실패 15 는 모두 Qa110x, 대조군 36 통과
```
시험 공용 도우미: `apps/api/src/test/java/dev/wakeline/qa/QaRawHttp.java`(원시 HTTP/1.1 — java.net.http 는 0x80–0x9F 헤더 바이트를 그대로 보내지 못한다).

---

## QA-1101 보통 — 헤더 값의 C1 제어 문자로 익명 500 + ERROR, 서버 로그 스트림 채우기
- **환경**: U(실제 Tomcat · 실제 Redis · 로그 싱크 켜짐). 익명 · 세션 없음.
- **재현 절차**:
  1. `GET /api/v1/sigmets` 에 헤더 `If-None-Match: "<0x85>"`(바이트 0x85 — RFC 9110 obs-text, Tomcat 이 받아 ISO-8859-1 U+0085 로 읽는다)를 보낸다.
     같은 것을 `/aircraft?bbox=…` · `/ships?bbox=…` · `/radar/frames` · `/radar/kr` · `/traffic/grid` · `/ships/coverage` · `/warnings` · `/airspace` 에.
  2. `POST /api/v1/client-errors`(정상 본문)에 `User-Agent: Mozilla/5.0 <0x85>`.
  3. 대조: 같은 바이트를 `Accept` 에 넣어 `GET /api/v1/status`.
  4. 서버 로그 스트림 `wakeline:logs` 의 새 ERROR 항목을 센다(싱크는 1 s 마다 보낸다).
- **기대**: 4xx(대조 3 처럼 400 `BAD_REQUEST` "request rejected") 또는 그 헤더를 무시한 정상 답. 500 · ERROR · 서버 로그 항목 없음.
- **실제**: 1 · 2 의 10개 경로 모두 **500 INTERNAL**, 각각 `ProblemAdvice : unhandled error …` ERROR + `RequestRejectedException` 스택, `wakeline:logs` 에
  **ERROR 항목 10건 · 지문 10개**. 대조 3 은 400. 영향 측정(탐침): 한 IP 가 10곳에 10 s 마다 보내면 70건 → ERROR 항목 70건(분당 60); 같은 경로의 글자를
  퍼센트 인코딩만 바꾸면(`/api/v1/%61ircraft` — 디코딩하면 같은 경로) 0.2 s 안의 24건이 지문 12개로 갈려 억제(같은 지문 10 s 에 1건)를 피했다.
  `wakeline:logs` 는 api · collector · ais 의 서버 로그가 함께 쓰는 MAXLEN ~ 3000 이라, 한 IP 의 분당 120(공개 제한)으로 약 25분, 고정 경로 10곳만 써도 약
  50분이면 그 전 서버 오류 기록이 모두 밀려난다(**계산** — 3,000건을 실제로 채우지는 않았다). 계약 v5 §G2 가 브라우저 오류를 따로 자른 목적('익명 입력이
  서버 오류를 밀어내지 못하게')을 다른 길로 깬다. 운영자는 `docker logs` 로 볼 수 있다(우회 가능 → 보통).
- **증거**: [qa-1101-failure.txt](../evidence/api-sec/qa-1101-failure.txt)(실패 글 · 서버 ERROR 발췌) · [qa-1101-flood-probe.txt](../evidence/api-sec/qa-1101-flood-probe.txt)
  ```
  Qa1101ControlCharHeaderValueIs500IT > controlCharactersInHeadersReadByPublicControllersAreNot500(CapturedOutput) FAILED
    Multiple Failures (12 failures)
    [GET /api/v1/aircraft?bbox=126,37,127,38 If-None-Match with a C1 control character (all statuses: {… =500 ×9, POST /api/v1/client-errors User-Agent=500})]
      Expecting actual: 500  to be less than: 500
    [ERROR log for anonymous header input] … ProblemAdvice : unhandled error … path=/api/v1/aircraft
      org.springframework.security.web.firewall.RequestRejectedException: The request was rejected because the header: "If-None-Match " has a value …
    [ERROR entries in the server log stream wakeline:logs written by anonymous header input (distinct fingerprints: 10)] Expecting empty but was: [{"v":1,…"level":"ERROR","logger":"dev.wakeline.platform.web.ProblemAdvice",…
  ```
- **의심 원인**:
  - Spring Security `StrictHttpFirewall` 은 헤더 값을 읽는 순간(`getHeader`) 검사한다(`HEADER_VALUE_PATTERN` — `\p{IsControl}` 거절). 보안 체인 안에서 던지면
    `FilterChainProxy` 가 `SecurityConfig.requestRejectedHandler`(`apps/api/src/main/java/dev/wakeline/ops/SecurityConfig.java:102-108`)로 400 을 주지만, 체인을 지나
    컨트롤러가 같은 감싼 요청에서 읽으면 `apps/api/src/main/java/dev/wakeline/platform/web/ProblemAdvice.java:256-266`(`@ExceptionHandler(Exception.class)` →
    500 + `log.error` 스택)이 먼저 받는다.
  - 컨트롤러의 헤더 읽기: `aircraft/web/AircraftController.java:81` · `ships/web/ShipController.java:104` · `weather/web/WeatherController.java:75 · 167 · 214` ·
    `traffic/TrafficGridController.java:41` · `coverage/ShipCoverageController.java:62` · `weather/web/WarningController.java:50` ·
    `airspace/web/AirspaceController.java:50`(If-None-Match) · `logs/ClientErrorController.java:127`(User-Agent). 운영 `ops/OpsController.java:209`(`@RequestHeader If-Match`)도 같은 길(세션 필요 — 시험하지 않음).
  - 지문 억제를 피하는 까닭: `ProblemAdvice.java:265` 의 메시지에 `req.getRequestURI()`(원문)가 들어가고 `logs/LogEvents.java:57-59 · 73-78` 의 틀은 숫자 · 16진 · 따옴표만 바꾼다.
- **범위 밖 · 미확인**: AWS 앞단(CloudFront → Caddy → gate → edge nginx)과 로컬 edge 가 0x80–0x9F 헤더 바이트를 그대로 넘기는지는 확인하지 않았다(이 영역은
  라이브 스택 · AWS 를 쓰지 않는다). 어느 층이든 거르면 그 경로에서의 영향은 낮아진다 — api 자체의 결함(헤더 거절이 500 + ERROR)은 그대로다.

## QA-1100 낮음 — 익명 운영 요청이 공개 요청 제한에 세지지 않음
- **환경**: U. 익명 · 세션 없음 · 요청 제한 카운터 비운 뒤 같은 분 안.
- **재현 절차**:
  1. `GET /api/v1/ops/providers` 를 121번 보낸다(익명 → 404 존재 비공개).
  2. `PUT /api/v1/ops/settings/region_poll_s`(CSRF 없음 → 403 `CSRF_INVALID`)를 121번 보낸다.
  3. (탐침) `POST /api/v1/ops/providers/opensky/disable` + `Origin: http://evil.example`(→ 403 `ORIGIN_NOT_ALLOWED`).
  4. 각 단계 뒤 Redis `rl:api:127.0.0.1:*` 와 응답의 `X-RateLimit-*` 를 본다.
- **기대**: `RateLimitFilter` 의 약속(“/api/** 요청을 IP당 분당 N 회로 제한” — 디코딩한 경로 `ApiPaths.API` 로, 인코딩한 `/%61pi/…` 도 같은 제한 —
  `SecurityIT.publicApi121stRequestGets429…`)대로 121번째는 429 `RATE_LIMITED` + `Retry-After`, 응답마다 `X-RateLimit-Limit: 120`.
- **실제**: 404 ×121 · 403 ×121 · 403 ×5, 429 없음, `X-RateLimit-*` 없음, 카운터 키 0개. 보안 체인이 끝낸 요청(익명 404 · CSRF 403 · Origin 403 · 방화벽 400 ·
  세션 저장소 503)은 제한기에 닿지 않는다. 운영 로그인(`POST /ops/session`)은 permitAll 이라 체인을 지나 공개 제한에도 세지고, 따로 IP당 분당 10(실패 시 닫힘) ·
  계정 5회 실패 15분 잠금이 있다(SecurityIT 통과 — 이 결함과 무관).
- **영향**: api 단의 2차 제한이 빠질 뿐 — edge 의 IP당 초당 10(1차)은 그대로이고 AWS 앞단 Caddy 는 `/api/v1/ops*` 를 404 로 막는다(그 차단의 우회 여부는 앞단 영역).
  이런 요청 하나의 비용은 작다(세션 쿠키가 있으면 Redis 세션 읽기 1회). 자원 고갈은 보이지 못했다 → 낮음.
- **증거**: [qa-1100-failure.txt](../evidence/api-sec/qa-1100-failure.txt)
  ```
  Qa1100AnonymousOpsRequestsSkipRateLimitIT > anonymousOpsGetsAreCountedAgainstThePerIpLimit() FAILED
    [X-RateLimit-Limit on an anonymous /api/v1/ops request (statuses of 121 requests: {404=121})] expected: "120" but was: null
  Qa1100AnonymousOpsRequestsSkipRateLimitIT > anonymousOpsWritesRefusedByCsrfAreCountedToo() FAILED
    [api limiter counter after 121 anonymous ops writes (statuses: {403=121})] Expected size: 1 but was: 0 in: []
  ```
- **의심 원인**: `apps/api/src/main/java/dev/wakeline/platform/web/RateLimitFilter.java:15-17`(일반 서블릿 필터 `@Order(10)`) — Spring Boot 의 보안 체인 등록
  (`DelegatingFilterProxyRegistrationBean`, 기본 순서 `SecurityProperties.DEFAULT_FILTER_ORDER` = −100)보다 뒤. 거절은 `SecurityConfig.java:62-81`
  (인가 404 · CSRF 403 · `OpsOriginFilter` 403)에서 끝난다.

## QA-1102 낮음 — 익명 로그인 username 의 NUL → 500 + ERROR
- **환경**: U(실제 PostgreSQL).
- **재현 절차**: `POST /api/v1/ops/session` · `Content-Type: application/json` · 본문 `{"username":"qa\u0000ops","password":"whatever-password"}`.
- **기대**: 400(형식) 또는 401 `BAD_CREDENTIALS`(없는 계정과 같은 답). 500 · ERROR 없음.
- **실제**: **500 INTERNAL** + `ProblemAdvice : unhandled error … path=/api/v1/ops/session` ERROR 스택 —
  `DataIntegrityViolationException: … SQL [SELECT id, username, password_hash, role, locked_until FROM ops_user WHERE username = ?]; ERROR: invalid byte sequence for encoding "UTF8": 0x00`.
  응답 본문에는 스택 · SQL 이 없다(서버 로그에만). 로그인 IP당 분당 10 안에서 요청마다 ERROR 1건(서버 로그 스트림에도 실린다).
  QA-002(운영 `/ops/runs` 필터의 NUL — 세션 필요, `Params.filterText` 로 고침)와 같은 부류인데 이 경로는 **익명**이다. AWS 공개 데모는 Caddy 가 `/api/v1/ops*` 를
  막으므로 로컬(127.0.0.1) 스택에서만 닿는다.
- **증거**: [qa-1102-failure.txt](../evidence/api-sec/qa-1102-failure.txt)
  ```
  Qa1102LoginUsernameNulIs500IT > aNulInTheLoginUsernameIsAClientErrorNot500(CapturedOutput) FAILED
    [anonymous login with a NUL in the username — body {"detail":"unexpected error","instance":"/api/v1/ops/session","status":500,…,"code":"INTERNAL",…}]
    Expecting actual: 500 to be in: [400, 401]
  ```
- **의심 원인**: `apps/api/src/main/java/dev/wakeline/ops/OpsSessionController.java:72`(`Login` — `@NotBlank @Size(max = 64)` 만, 제어 문자 검사 없음) ·
  `:88` → `ops/OpsUserService.java:96`(값을 그대로 SQL 매개변수로) → `platform/web/ProblemAdvice.java:256-266`(22021 을 '결함일 수 있는 DB 오류'로 500).

## QA-1103 낮음 — `strip()` · `trim()` 이 제어 문자를 지워 받아들임(계약 v5 §G43)
- **환경**: U. 익명.
- **재현 절차**: 아래를 GET 으로(원문 그대로):
  `/api/v1/alerts/history?hex=71be01%1F` · `?hex=%1C71be01` · `?hex=71be01%09` · `?limit=10%1F` · `/api/v1/aircraft/71be01%1F` · `/api/v1/airports/RKSI%1F/wx` ·
  `/api/v1/ships/440123456%1F` · `/api/v1/ships/440123456%09` · `/api/v1/alerts?kind=observed%1F` · `/api/v1/stats/sigmet?group=fir%1F` · `/api/v1/stats/traffic?day=2026-10-01%1F`.
  대조: `?hex=71be01%00` · `?limit=10%00`.
- **기대**: §G43 "앞뒤 공백은 공백 글자만 지운다 — NUL 같은 제어 문자는 남아 각 경로의 형식 검사에 걸린다" → 400(`BAD_HEX` · `BAD_ICAO` · `BAD_MMSI` ·
  `BAD_REQUEST` · `BAD_FILTER`). 공역 `category` 는 같은 부류를 결함으로 고쳐 탭 · 제어 문자를 400 으로 받는다(QA-500 · §G53).
- **실제**: 11건 모두 정상 값으로 처리 — 200(`hex` · `limit` · `kind` · `group` · `day`) 또는 정상 값의 404("aircraft 71be01 not seen" · "airport not watched: RKSI" ·
  "ship 440123456 not seen"). 대조 `%00` 은 400. Java `String.strip()` 은 `Character.isWhitespace` 라 U+0009–U+000D · **U+001C–U+001F** 를 지우고,
  `normalizeMmsi` 의 `trim()` 은 U+0000–U+0020 을 모두 지운다(경로 변수의 NUL 은 방화벽이 먼저 400).
- **영향**: 값은 정규화된 뒤 형식 검사를 받으므로 주입 · 데이터 손상은 없다 — 계약 위반 · 입력 규칙 불일치(낮음).
- **증거**: [qa-1103-failure.txt](../evidence/api-sec/qa-1103-failure.txt)
  ```
  "/api/v1/alerts/history?hex=71be01%1F" … expected: 400 but was: 200
  "/api/v1/aircraft/71be01%1F" … body {"detail":"aircraft 71be01 not seen",…} expected: 400 but was: 404
  "/api/v1/stats/traffic?day=2026-10-01%1F" … body {"day":"2026-10-01",…} expected: 400 but was: 200
  (11 failed · 대조 %00 통과)
  ```
- **의심 원인**: `apps/api/src/main/java/dev/wakeline/platform/web/Params.java:27 · 39 · 49`(hex · choice · icao 의 `strip()`) ·
  `platform/web/NumberParams.java:37`(정수) · `platform/web/TimeParams.java:64`(날짜 `s.strip()`) · `ships/web/ShipController.java:509`(`mmsi.trim()`).
  같은 부류의 다른 곳(이번에 HTTP 로 확인하지 않음): `settings/RetainTargets.java:27` · `watch/WatchController.java:112` · `ships/core/ShipQuery.java:32` ·
  `platform/web/BboxParam.java:26` · `logs/LogsController.java:85 · 98-102 · 130`(운영).
- **앞선 QA**: 출시 QA 2차(2026-10-10) 보안 '개선 제안 1'로 적혔다("§G43 의 뜻과 다를 수 있음" — 재현 · 판단하지 않음). 이번에 HTTP 로 재현했고 §G43 본문
  (제어 문자는 남아 400)과 다르므로 결함으로 올린다 — 통합 단계에서 중복으로 볼지 정한다.

---

## 확인했고 결함이 아닌 것(커버리지)
| 후보 | 확인 | 결과 |
|---|---|---|
| 1. 운영 로그인 무차별 대입 | 코드 + `SecurityIT`(25 통과) | 로그인은 공개 제한 + 로그인 전용 IP당 분당 10(Redis 실패 시 503 — 닫힘) + 계정 5회 15분 잠금(동시 시도로도 못 피함) |
| 2. 경로 디코딩 변형 | 탐침 18가지(익명) + 5가지(운영자 세션) | `%6Fps` · `o%70s` · `%61pi` · 대소문자 · 끝 `/` · `.json` · `%20` → 404, `//` · `;` · `/./` · `/../` · `%2e` · `%3B` → 400(방화벽), `%2F` → 400(Tomcat). 운영자 세션의 `/api/v1/%6Fps/providers` 는 200(디코딩 경로로 운영 경로 — 인가 · 수명 · 자격 검사를 받는다), 같은 경로의 POST 는 CSRF 없으면 403. 우회 없음 |
| 3. 본문 크기 | 탐침 | `/client-errors` 9,000 B → 413(선언 길이로 먼저 · 읽어도 8 KiB+1 까지). 로그인 본문은 api 가 끝까지 읽는다(아래 개선 제안 1) |
| 4. WS Origin 없음 | 코드 · 기존 시험 | 설계대로 통과(`OriginAllowListTest.allowsMissingOrigin_nonBrowserClients` · `WsIntegrationTest.noOriginHeader…`), IP당 5 · 전체 200 은 `ConnectionLimiter` 의 한 임계 구역(`RateAndLimitTest`). 여러 IP 로 전체 상한을 채우는 것은 미확인(아래) |
| 5. `/client-errors` 와 운영 세션 쿠키 | 탐침 | 세션 쿠키를 실어도 세션을 읽지 않는다(`lastAccessedTime` · TTL 그대로, `Set-Cookie` 없음 — `OpsSessionIdResolver` 가 운영 경로에서만 읽음). CSRF 는 공개 경로라 대상 아님(JSON 만 받고 CORS 허가가 없어 교차 출처 브라우저는 사전 요청에서 막힘). 저장값: 메시지 · 스택 · 경로 · component · UA 는 `LogMasker` 로 가린 원문 그대로(HTML 이스케이프 없음 — 화면 렌더는 web 영역, 앞선 QA 의 `qa-sec-xss` 가 글자로 보임을 확인). 길이: 2,000 · 8,000 · 300 · 200 · 200 코드 포인트 |
| 6. Params `strip()` | 재현 | **QA-1103** |
| 7. 운영자 세션 | `SecurityIT` 25 · `OpsSessionLifetimeFilterTest` 9 통과 + 코드 | 비밀번호 교체 → 그 사용자의 세션 모두 끝(목록 삭제 + 요청마다 자격 표식 비교), 5회 실패 잠금, 로그인 때 `changeSessionId()`(세션 고정 방지), 로그인부터 8 h 절대 수명(`%6Fps` 경로도), 로그인 때 CSRF 토큰 새로 발급 |
| 8. 공개 자원 ID 바꾸기 · 공개 정보 | 코드 · 탐침 | 공개 경로에 사용자 · 운영 전용 자료 없음(알림 · 항적 · 선박은 모두 공개 자료, 로그 항목은 `/ops/logs` 만). OpenAPI 에 운영 경로 · 스키마 없음(`ClientErrorReport` 하나). `Server` · `X-Powered-By` 헤더 없음. `/status` 는 설계상 공개 상태(fixture 여부 · 관심 지역 · 공급자). OpenAPI `servers` 가 요청 Host 를 되비춤(개선 제안 2) |
| 9. 오류 응답 누출 | 탐침 · 코드 | 응답 본문(500 포함)에 스택 · SQL · 내부 경로 없음 — `"unexpected error"`, `instance` 는 요청 경로 원문(JSON 이스케이프). 스택 · SQL 은 서버 로그에만(QA-1101 · QA-1102 는 익명 입력이 그 ERROR 를 만드는 것이 결함) |

## 미확인(재현하지 못함 — 결함 수에 넣지 않음)
| 내용 | 이유 |
|---|---|
| AWS 앞단(CloudFront · Caddy · gate · edge)이 헤더 값의 0x80–0x9F 바이트를 api 까지 넘기는가(QA-1101 의 공개 데모 영향) | 이 영역은 라이브 스택 · AWS 를 쓰지 않는다. 앞단 · 스택 영역에서 `curl -H $'If-None-Match: "\x85"'` 로 8701 · R 에서 확인 필요 |
| 여러 IP 로 WS 전체 상한(200)을 채워 다른 방문자 차단 | 한 호스트 IP 로는 IP당 5 가 먼저 걸린다 — 앞선 QA(2026-10-02)와 같은 미확인. AWS 리뷰 A-1(IPv6 끔)이 한 경로를 막았다 |
| `If-Match`(운영 설정 PUT)의 C1 → 500 | 운영자 세션이 필요해 탐침하지 않음(코드상 QA-1101 과 같은 길) |

## 개선 제안(결함 아님)
1. **api 단 본문 크기 상한 없음**: 로그인(`@RequestBody Login`, 익명)은 공백 20 MiB 본문을 끝까지 읽고 401(775 ms), 15 MiB 비밀번호를 읽은 뒤 400(553 ms) —
   Jackson 이 다 읽은 다음 `@Size` 가 거른다. 운영 PUT/POST(`ResolutionController` 의 `String` 본문 · `OpsController.putSetting` 의 `JsonNode`)도 같다(세션 필요).
   지금은 edge 의 `client_max_body_size 1m`(infra/edge/nginx.conf:21)이 유일한 상한이고 api 는 edge 뒤 내부망에만 있다. 이중 방어로 api 에도 상한(예: 64 KiB)을.
2. **OpenAPI `servers` 가 요청 Host 를 되비춤**: `"servers":[{"url":"http://127.0.0.1:<포트>","description":"Generated server url"}]` — 공개 데모(Caddy 가 Host=localhost 로
   보냄)에서는 `http://localhost` 처럼 내부 주소가 공개 문서에 실릴 수 있다(확인 안 함). 고정 값이나 상대 경로(`/`)로.
3. **로그 지문에 원문 URI**: `ProblemAdvice` 의 오류 메시지 경로가 `getRequestURI()` 원문이라 같은 경로를 인코딩만 바꿔 지문 억제를 피한다(QA-1101 의 영향을 키움).
   지문에는 매칭된 경로 패턴(`BEST_MATCHING_PATTERN_ATTRIBUTE`)이나 디코딩한 경로를.
4. **요청 제한 필터의 위치**: QA-1100 을 고칠 때 보안 체인 앞(순서 < −100)으로 옮기면 로그인 실패 · 방화벽 거절도 함께 센다 — 순서를 시험으로 고정(`RateLimitFilter` 의
   순서를 보는 시험이 없다).
5. **운영자 계정 잠금으로 막기**: 익명 누구나 계정 이름만 알면 15분마다 5회 틀려 그 운영자를 계속 잠글 수 있다(설계상 수용 — 로컬 127.0.0.1 · AWS 는 Caddy 가 막음).
   IP · 계정 쌍으로 세거나 잠금 중에도 다른 IP 의 성공을 허용하는 안을 검토.
6. **브라우저 오류 전체 상한(분당 120)**: 익명 12개 IP 면 모든 방문자의 오류 보고가 429 — 계약 §C6 그대로(설계 수용). 운영 화면에 '전체 상한에 걸린 수'를 보이면 알아챌 수 있다.

## 앞선 QA 와 같음(다시 결함으로 올리지 않음)
- WS 전체 상한 200 을 여러 IP 로 채우는 것 — 2026-10-02 QA 의 미확인 그대로.
- 운영자 A 가 B 의 해결 표시를 되돌림 — 2026-10-02 QA 에서 설계(단일 역할 + 감사)로 판단. 이번에 다시 보지 않았다.
