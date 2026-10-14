# API 라이브 점검(api-live) — AWS 공개 데모 QA(2026-10-14)

- 대상: 브랜치 `qa/aws-2026-10`(main `29d39e38` + QA 도구) — 제품 코드는 고치지 않았다(찾기 단계). 결함 번호 범위 QA-1310–1349 중 **1310–1313** 을 썼다.
- 환경 **A**: 격리 스택 A(`wlqa-a` · http://localhost:8701 · edge → api · fixture 모드 · 이미지 `wakeline-*:qa` · 공개 데모 끔 = A0, 시험 운영자 `qa-ops`).
  환경 **U**: JUnit 통합 시험(`IntegrationTest` — 실제 Tomcat 임의 포트 + Testcontainers PostGIS(`wakeline-db:local` 읽기만) + ACL Redis), 원시 소켓 요청(`QaRawHttp`).
  AWS · 외부 공급자 · 운영 스택(8700)은 쓰지 않았다. 퍼징 동안만 api 를 `PUBLIC_RATE_LIMIT_PER_MIN=1000000` 으로 다시 만들었고 끝난 뒤 기본값 120 으로 되돌렸다.
- 방법: 기존 도구(fuzz_api · boundary_api · endpoint_sweep · authz_matrix · ws_probe · write_probe · value_checks)를 이 스택 · 증거 경로로 돌리고, 빠진 경로를 더했다
  (boundary_api 9경로 · endpoint_sweep 7경로) → 시험이 약한 경로를 따로 확인(stepS · `/sigmets/{id}` · `active` · `watched` · 304 · 선박 항적 · 쪽 넘김) →
  손 탐침(유니코드 · 경계 면적 · 파라미터 수 · 퍼센트 인코딩 · 헤더 · 쿠키 · 메서드 · Accept) → 재현된 것만 재현 시험으로 고정.
- 실행한 요청 · 시험(대략): 퍼저 1,444 · 경계 619 · 경로 32 · 인가 234 · WS 86 시나리오 + 손 탐침 · 쓰기 228 · 값 33 · 손 탐침 약 600 · 요청 제한 약 310 ·
  재현 시험 4클래스 22건(실패 16 · 대조군 6 통과) + 대조군 기존 시험 16건(StrictInputsIT 6 · FilterRulesIT 2 · BboxParamTest 4 · ParamsTest 4 — 모두 통과).

| 번호 | 심각도 | 결함 | 재현 시험 |
|---|---|---|---|
| QA-1312 | 보통 | 질의 문자열을 Tomcat 이 해석하지 못하면(잘못된 `%` 인코딩 · 파라미터 1,000개 초과) 파라미터를 읽는 공개 GET 18곳이 익명 요청에 500 + ERROR 스택 — 서버 로그 스트림을 익명 요청으로 채운다 | `apps/api/src/test/java/dev/wakeline/qa/Qa1312QueryParameterParseFailureIs500IT.java` |
| QA-1310 | 낮음 | 비 ASCII 글자(ı · İ · ſ · ß · ﬀ)가 유니코드 대소문자 접기로 정해진 값(§G42 `group` · `kind` · `detail`)과 항공기 검색어가 된다(`q=ſJO` → SJO463) | `…/qa/Qa1310NonAsciiCaseFoldAcceptedIT.java` |
| QA-1311 | 낮음 | 10진 표기로 정확히 50° × 50°(= 2,500 sq°, 상한 안)인 bbox 가 자리에 따라 422 "bbox area 2500 sq° exceeds 2500"(REST 3경로 · WS) | `…/qa/Qa1311BboxExactly2500SqdegRejectedTest.java` |
| QA-1313 | 낮음 | `Cookie` 의 쿠키가 200개를 넘으면 모든 /api 가 RFC 9457 이 아닌 Spring 기본 오류 JSON(`timestamp` · `error` — code · request_id · X-Request-Id 없음, GeoJSON 경로는 Content-Type 도 geo+json) | `…/qa/Qa1313TooManyCookiesErrorBodyIsNotProblemIT.java` |

실행 명령(네 결함 + 대조군):
```bash
cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa131*' --tests 'dev.wakeline.platform.web.BboxParamTest' \
  --tests 'dev.wakeline.platform.web.ParamsTest' --tests 'dev.wakeline.it.StrictInputsIT' --tests 'dev.wakeline.it.FilterRulesIT'
# → 38 tests completed, 16 failed (2026-10-14 05:35 KST) — 실패 16 은 모두 Qa131x(1310 9 · 1311 5 · 1312 1 · 1313 1), 대조군 22 통과
```

---

## QA-1312 보통 — 질의 해석 실패(잘못된 `%` · 파라미터 1,000개 초과)가 익명 500 + ERROR
- **환경**: A(edge 를 거친 라이브) · U. 익명 · 세션 없음.
- **재현 절차**:
  1. `GET /api/v1/aircraft?bbox=124,33,132,39&x=%zz`(쓰지 않는 파라미터 하나의 잘못된 퍼센트 인코딩). 같은 것을 `?bbox=%zz` · 끝의 `%` · `%2` · `%G1` ·
     UTF-8 이 아닌 `%FF` · `%C3` · 이름 쪽 `&%=1` 로.
  2. `GET /api/v1/aircraft?bbox=124,33,132,39&x&x&…`(합쳐 1,001개 — 약 2 KB, edge 의 URI 8 KB · CloudFront 8,192 B 안). 대조: 합쳐 1,000개.
  3. 1 · 2 를 공개 GET 29경로 전부에(`tools/qa/qa_1312_live.py`).
  4. 운영 화면 `/api/v1/ops/logs?level=ERROR&service=api`(서버 로그 스트림 `wakeline:logs`)를 본다.
- **기대**: 400 problem+json(`BAD_REQUEST` — 같은 부류인 경로 디코딩 실패 · 방화벽 거절이 이미 400) 또는 다른 경로처럼 무시한 정상 답. 500 · ERROR · 서버 로그 스트림 항목 없음.
- **실제**: 파라미터를 읽는 공개 GET **18곳**(/aircraft · /aircraft/search · 항공기 track · /ships · /ships/search · 선박 track · /ais/gaps · /sigmets · /alerts ·
  /alerts/history · /airports · /replay · /stats/sigmet · /stats/traffic · /stats/alerts · /airspace · /warnings/history · /watch)이 1 · 2 모두 **500 INTERNAL**.
  읽지 않는 11곳(/healthz · /status · `/aircraft/{hex}` · `/ships/{mmsi}` · coverage · grid · radar 둘 · 공항 wx · /warnings · /openapi)은 200, 1,000개면 모두 200.
  요청마다 `ProblemAdvice : unhandled error … path=/api/v1/aircraft` ERROR + `org.apache.tomcat.util.http.InvalidParameterException: Character decoding failed.
  Parameter [x] with value [%zz] has been ignored …`(또는 "More than the maximum number of request parameters … ([1,000])") 스택. 운영 로그의 최근 ERROR 20건이
  모두 이것이었다(경로마다 다른 지문 — `fp=0ab3e019b768fff2`(airspace) · `0bda8769c6af764e`(stats/alerts) · …). 예외 메시지에 클라이언트가 보낸 파라미터 이름 · 값이
  그대로 실린다(가림만 — 운영 로그 상세에 보인다). 운영 경로도 같다(세션 — `/ops/runs?job=%zz` · `/ops/logs?q=%` · `/ops/audit?limit=%FF` → 500).
- **영향**: QA-1101(헤더 값의 C1 → 500 + ERROR)과 같은 영향 — 익명 클라이언트가 평범한 ASCII(`%`)만으로, 한 IP 의 분당 120 안에서 경로 18개 × (경로 인코딩 바꾸기 —
  QA-1101 이 보인 지문 억제 피하기)로 서버 오류 스트림(api · collector · ais 공용, MAXLEN ~ 3000)에 ERROR 를 쌓아 진짜 서버 오류를 밀어낼 수 있다(약 25분 — 계산,
  3,000건을 실제로 채우지는 않았다). 잘린 링크 · 크롤러의 오타 같은 사고 입력도 ERROR 가 된다. 사용자 기능 손실은 없고 운영자는 `docker logs` 로 볼 수 있다(우회 가능 → 보통).
  AWS 앞단(CloudFront · Caddy · gate)이 이 질의를 그대로 넘기는지는 확인하지 않았다(미확인 — 아래).
- **증거**: [qa-1312-failure.txt](../evidence/api-live/qa-1312-failure.txt) · [qa-1312-live.txt](../evidence/api-live/qa-1312-live.txt)
  ```
  Qa1312QueryParameterParseFailureIs500IT > aQueryStringTomcatCannotParseIsAClientErrorNot500(CapturedOutput) FAILED
    Multiple Failures (13 failures)
    [GET /api/v1/aircraft?bbox=%zz — body {"detail":"unexpected error","instance":"/api/v1/aircraft","status":500,…,"code":"INTERNAL",…}] Expecting actual: 500 to be less than: 500
    … (11 경로 모두 500) …
    [ERROR entries in the server log stream wakeline:logs written by anonymous requests] Expecting empty but was: [{"level":"ERROR","logger":"dev.wakeline.platform.web.ProblemAdvice",
     "message":"unhandled error request_id=… path=/api/v1/aircraft","exception":{"type":"org.apache.tomcat.util.http.InvalidParameterException","message":"Character decoding failed. Parameter [bbox] with value [%zz] …
  ```
  대조군(통과): `/status?x=%zz&y&<1,000 × x>` 200 · `/aircraft` 합쳐 1,000개 200 · 올바른 `%25zz` 200.
- **의심 원인**: Tomcat 은 질의 해석 실패를 `getParameter*` 를 처음 부르는 쪽에 `InvalidParameterException`(IllegalStateException)으로 던진다 — 첫 호출이
  `apps/api/src/main/java/dev/wakeline/platform/web/SingleValueParams.java:30`(`req.getParameterValues(name)`, 모든 `@RequestParam` 컨트롤러의 인터셉터) 또는
  Spring 의 인자 해석이다. `apps/api/src/main/java/dev/wakeline/platform/web/ProblemAdvice.java:255-266`(`@ExceptionHandler(Exception.class)` — `ErrorResponse` 가 아니면
  500 + `log.error(…, e)`)이 이것을 입력 오류로 가르지 않는다. 같은 부류(QA-1101 의 `RequestRejectedException`)와 함께 '클라이언트 입력 예외 → 400' 으로 한곳에서 고칠 수 있다.

## QA-1310 낮음 — 비 ASCII 글자가 대소문자 접기로 정해진 값 · 항공기 검색어가 된다
- **환경**: A · U. 익명.
- **재현 절차**: 아래를 GET(원문 그대로):
  `/api/v1/stats/sigmet?group=f%C4%B1r`(fır — 점 없는 ı) · `?group=f%C4%B0r`(fİr) · `/api/v1/alerts?kind=ob%C5%BFerved`(obſerved — 긴 s) · `?kind=pred%C4%B1cted` ·
  `/api/v1/aircraft?bbox=124,33,132,39&detail=l%C4%B1te` · `/api/v1/aircraft/search?q=%C5%BFJO`(ſJO) · `?q=%C4%B1BX`(ıBX) · `?q=%C3%9F%C3%9F`(ßß) · `?q=%EF%AC%801`(ﬀ1).
  대조: `/api/v1/ships/search?q=ev%C4%B1er` · `/api/v1/airports/rks%C4%B1/wx`(이미 400) · `group=FIR` · `kind=OBSERVED`(ASCII 대문자 — 200 이 맞다).
- **기대**: 계약 v5 §G42 "정해진 값 중 하나 — 맞는 값은 대소문자를 가리지 않고, 모르는 값이면 400 `BAD_FILTER`" · 항공기 검색 q 는 영숫자 · '-'(ASCII) → 비 ASCII 는 400
  (`BAD_FILTER` · `BAD_QUERY`). 앞선 QA(2026-10 기능 개선 제안 5)가 같은 부류('rksı' → RKSI)를 공항 ICAO · hex 에서 "ASCII 를 먼저 검사" 로 고쳤다.
- **실제**: 9건 모두 200 — `group=fır` 는 `"group":"fir"` 로 답하고, `kind=obſerved` 는 관측 알림 목록, `q=ſJO` 는 **SJO463**, `q=ıBX` 는 **IBX60** 을 찾는다(라이브 A).
  `ßß` 는 "SSSS", `ﬀ1` 은 "FF1" 로 바뀌어 검색된다. 선박 검색 · 공항 · hex 는 400(대조군).
- **영향**: 보낸 글자와 다른 값으로 조회한다(계약 §G42 · §G43 '너그럽게 읽지 않는다' 위반). 주입 · 데이터 손상은 없다 — 낮음.
- **증거**: [qa-1310-failure.txt](../evidence/api-live/qa-1310-failure.txt) · [qa-1310-1311-live.txt](../evidence/api-live/qa-1310-1311-live.txt)
  ```
  "/api/v1/stats/sigmet?group=f%C4%B1r" → "400" "BAD_FILTER" FAILED  — body {…,"group":"fir",…} expected: 400 but was: 200
  "/api/v1/aircraft/search?q=%C5%BFJO" → "400" "BAD_QUERY" FAILED   — expected: 400 but was: 200
  (tests=13 · failures=9 · 대조군 4 통과)
  BUG  200 (기대 400) /api/v1/aircraft/search?q=%C5%BFJO items=[["86d8cc", "SJO463"]]      ← 라이브 A
  ```
- **의심 원인**: `apps/api/src/main/java/dev/wakeline/platform/web/Params.java:40`(`choice` — `a.equalsIgnoreCase(v)`: 글자마다 `Character.toUpperCase` ·
  `toLowerCase` 라 ı → I · İ → i · ſ → S 가 맞는다) · `apps/api/src/main/java/dev/wakeline/aircraft/web/AircraftController.java:104-106`(`q.strip().toUpperCase(Locale.ROOT)`
  뒤에 `^[A-Z0-9-]+$` 검사 — 바꾼 다음 검사).

## QA-1311 낮음 — 정확히 2,500 sq°(50° × 50°)인 bbox 가 자리에 따라 422
- **환경**: A(REST 3경로 · WS) · U(단위 시험).
- **재현 절차**: `GET /api/v1/aircraft?bbox=100.3,10.3,150.3,60.3`(경도 · 위도 폭 모두 10진 50) · 같은 bbox 로 `/ships` · `/replay?at=<2분 전>&bbox=…` · WS
  `{"type":"subscribe","bbox":[100.3,10.3,150.3,60.3],"zoom":7}`. 대조: `bbox=124.1,10.1,174.1,60.1` · `0,0,50,50`(같은 50° × 50°).
- **기대**: 넓이 ≤ 2,500 sq° 는 받는다(상한 '초과'만 422 `BBOX_TOO_LARGE` — 계획 §1.1 "bbox 면적 2,500 sq° 초과 422").
- **실제**: 대조군은 200 · snapshot, 100.3/150.3 · 14.4/64.4 · 101.8/151.8 경계의 상자는 **422** `"bbox area 2500 sq° exceeds 2500"`(REST) · WS error `BBOX_TOO_LARGE`.
  이진 부동소수 뺄셈 오차(150.3 − 100.3 = 50.000000000000014 → 넓이 2500.000000000001). 0.1° 간격의 50° 폭을 세면 경도 3,100자리 중 400 · 위도 1,300자리 중 104 가 넘는다.
  웹 재생 화면은 상한의 1 − 1e-6 로 줄이고 안쪽으로 반올림해(`apps/web/lib/replay.ts:170 · 178-182`) 거의 걸리지 않는다 — 직접 API 를 부르는 클라이언트 · 드문 화면 크기만.
- **증거**: [qa-1311-failure.txt](../evidence/api-live/qa-1311-failure.txt) · [qa-1310-1311-live.txt](../evidence/api-live/qa-1310-1311-live.txt)
  ```
  Qa1311BboxExactly2500SqdegRejectedTest > aBoxOfExactly50By50DegreesIsWithinTheLimit(String) > "100.3,10.3,150.3,60.3" FAILED
    Expecting code not to raise a throwable but caught "dev.wakeline.platform.web.Problem: bbox area 2500 sq° exceeds 2500
  (tests=7 · failures=5 · 대조군 2 통과)
  ```
- **의심 원인**: `apps/api/src/main/java/dev/wakeline/geo/Bbox.java:14`(`area()` = 두 double 뺄셈의 곱) · `apps/api/src/main/java/dev/wakeline/platform/web/BboxParam.java:32`
  (`b.area() > maxAreaSqdeg` — 허용 오차 없음) · `apps/api/src/main/java/dev/wakeline/ws/WakelineWsHandler.java:205`(같은 비교). 메시지의 `%.0f` 가 차이를 감춰 "2500 exceeds 2500".

## QA-1313 낮음 — 쿠키 200개 초과의 400 이 RFC 9457 문제 응답이 아니다
- **환경**: A · U. 익명.
- **재현 절차**: `Cookie: c0=v; c1=v; …`(201개)로 `GET /api/v1/status` · `/api/v1/aircraft?bbox=…`(Accept geo+json) · `/api/v1/ops/providers`. 대조: 199 · 200개.
- **기대**: 계약의 공통 오류 형식 — `application/problem+json` · `code` · `request_id`(= `X-Request-Id`).
- **실제**: 199 · 200개는 정상(200 · 익명 운영 404 problem), **201개부터 400** 인데 본문이 Spring Boot 기본 오류 JSON
  `{"timestamp":"…","status":400,"error":"Bad Request","path":"/api/v1/aircraft"}` · `X-Request-Id` 없음 · Content-Type 은 요청의 Accept 를 따라
  `application/geo+json`(GeoJSON 이 아니다) 또는 `application/json`. 웹의 오류 처리(`lib/api.ts` — problem 의 code · request_id 를 읽는다)는 요청 id 를 보이지 못한다.
- **영향**: 브라우저가 한 도메인에 쿠키를 200개 넘게 갖는 일은 드물다(공유 도메인에 다른 서비스 쿠키가 쌓일 때). 형식 위반 · 드문 조건 — 낮음.
- **증거**: [qa-1313-failure.txt](../evidence/api-live/qa-1313-failure.txt) · [qa-1313-live.txt](../evidence/api-live/qa-1313-live.txt)
  ```
  [GET /api/v1/status with 201 cookies — body] Expecting actual: "{"timestamp":"2026-10-13T20:34:30.461Z","status":400,"error":"Bad Request","path":"/api/v1/status"}" to contain: "code":
  [GET /api/v1/status with 201 cookies — X-Request-Id] Expecting actual not to be null
  (15 failures · 대조군 200개 → 200 통과)
  ```
- **의심 원인**: Tomcat 이 쿠키를 해석하다(maxCookieCount 기본 200) `sendError(400)` 하면 `/error` 로 넘어가고, 앱에 문제 응답용 `/error` 처리기가 없어 Spring Boot 기본
  `BasicErrorController` 가 쓴다(`apps/api/src/main/resources/application.yml:36-38` 은 message · stack 만 숨김). `apps/api/src/main/java/dev/wakeline/platform/web/ProblemErrorReportValve.java:39`
  는 본문이 이미 쓰였으면 건드리지 않는다. 앞선 리뷰 REVIEW-v1 R-84 가 같은 부류(방화벽 · `%2F`)를 고쳤고 이 길이 남았다.

---

## 확인했고 결함이 아닌 것(커버리지)
| 항목 | 확인 | 결과 |
|---|---|---|
| 51경로 정상 · 경계 · 비정상(퍼저 1,444 · 경계 619) | 큰 수 · 음수 · 0 · 소수 · 지수 · NaN · Infinity · 2^63 · 유니코드 숫자(전각 · 아랍) · NUL · RTL · 10 KB · 중복 · SQL · `..` · 범위 밖 시각 · 날짜 | 5xx 0(인코딩한 값). 모든 4xx 가 problem+json · `request_id` = `X-Request-Id`. 10 KB 값은 edge 414 problem. 중복 파라미터 35곳 모두 400 "must be given once". 최대 77 ms |
| 잘못된 bbox | 뒤집힘 · 경도 ±180 넘음 · 위도 ±90 넘음 · 폭 0 · 날짜변경선 · 3 · 5개 · 지수 · 16진 실수 · 접미사 · 전각 · NaN | 400 BAD_BBOX, 면적 초과 422(`/airports` · `/sigmets` 는 면적 상한 없음 — 설계) |
| `/aircraft/{hex}/track?stepS>0` | 실제 항적(24 h · 550점)으로 stepS 1 · 5 · 10 · 60 · 300 · 3600 · 3601 · −5 · 2^31−1 를 '버킷마다 첫 점' 계산과 비교 | 모두 같다 · 시간순 · 3600 초과는 3600, 음수는 원해상도(설계 — 끝값으로) |
| `/sigmets/{id}` 404 · `aircraft_inside` | 없는 id · 공백 · 300자 · `%2F` · `..` · 활성 132건 전부 | 404 NOT_FOUND / 400(방화벽). `aircraft_inside` 의 항공기 상세 `inside_sigmets` 가 그 SIGMET 을 포함(어긋난 2건은 두 요청 사이 이탈 — 다시 보면 일치) |
| `?active=false` | fixture SIGMET 132건이 모두 유효(fixture 가 유효 시간을 지금으로 옮긴다) | 두 목록이 같아 구분 못 함 — 코드 확인(`SigmetGeoJson.java:24`) · 만료 때 version 을 올려 ETag 가 바뀜(`SigmetStore.java:36-39`). 라이브로는 미확인 |
| `?watched=false` | 스택 A DB 에 관심 아닌 시험 공항(ZQAA) 한 줄을 넣고 · 확인 뒤 지움 | watched=false 14(ZQAA 포함) · 기본 · true 13 · bbox 와 함께도 맞다 |
| 조건부 요청 304 | `/radar/frames` · `/radar/kr` · `/aircraft` · `/sigmets`(active 둘 · bbox) · `/ships` · grid · coverage · `/warnings` · `/airspace`(+category) × gzip 있음 · 없음 | 모두 같은 ETag(약한 W/ 포함) · 목록 형식 If-None-Match 로 304 |
| 선박 항적 | 실시간 25척 24 h — 시간순 · 선분 = 연속 점 · 15분 넘는 틈에서 끊김 · points 수 | 어긋남 0. 점 수는 60 s 표본이라 24 h 최대 1,441 — '정확히 5,000점'은 제품이 만들 수 없다(아래 개선 제안 3) |
| 알림 이력 쪽 넘김 | 40분 창 642건을 limit 7 로 92쪽 · limit 200 과 비교 | 빠짐 · 겹침 0 · entered_at 최신순 · 같으면 id 역순 |
| 공개 자원 id 바꾸기 | `/alerts/{id}`(열린 · 닫힌 · 없는 · 0 · 음수 · 19자리) · 항적 hex · mmsi · 운영 로그 항목 id | 공개 경로는 모두 공개 자료(알림 · 항적 · 선박)뿐 — 다른 사람만의 자료가 없다(역할이 운영자 하나). 로그 항목은 `/ops/logs/{id}` 만(익명 404) |
| 운영 19경로 인가(authz_matrix 234줄) | 익명 · CSRF 쌍 · 위조 쿠키 4종 · 로그아웃 재생 · `%6Fps` · `//` · `;` · `..` · `%2e` · 대소문자 · 끝 `/` · 메서드 9 · Origin 11 | 기대와 다름 0 — 익명은 404/400, 세션 + CSRF/Origin 틀림은 403, CORS 허가 헤더 없음 |
| WS(86 시나리오 + 손 탐침) | 클라이언트 10종의 형식 · 형 · 범위 · 크기 · 빈도 · hello 전 · Origin 9가지 | 설계대로(BAD_JSON 1002 · 1007 · 1009 · 1008 · error 코드) · 서버 메시지 스키마 위반 0 · 갇힌 연결 없음 |
| 요청 제한(기본 120) | 새 분에 125건 | 120번째까지 200(`X-RateLimit-Remaining` 119 → 0), 121번째부터 429 `RATE_LIMITED` + `Retry-After` · problem+json. 위조 `X-Forwarded-For` · `X-Real-IP` 는 무시(edge 가 덮음) |
| 응답 크기(fixture 규모) | bbox 2,500 sq° · 5회 | `/aircraft` lite 43 KB(gzip 8 KB) · full 56 KB · `/ships` 107 KB · `/replay` 최대 105 KB(gzip 11 KB) · 중앙 8–27 ms. 큰 규모는 성능 단계 |
| 메서드 · Accept | POST · PUT · DELETE · PATCH · HEAD · OPTIONS · Accept 불일치 | 405 problem + `Allow: GET,HEAD,OPTIONS`(§G44) · 406 본문 없음(앞선 QA 의 설계) · 415 problem |
| 헤더 개수 · 본문 | 헤더 99–400개 · GET 본문 · 1 MB 넘는 본문 | 400 problem(edge/Tomcat) · edge 413 problem |

## 미확인(재현하지 못함 — 결함 수에 넣지 않음)
| 내용 | 이유 |
|---|---|
| AWS 앞단(CloudFront · Caddy · gate)이 `&x=%zz` · 파라미터 1,001개 · 쿠키 201개를 api 까지 넘기는가(QA-1312 · QA-1313 의 공개 데모 영향) | 이 영역은 스택 A 만 쓴다(AWS 금지 · R 스택은 다른 영역). 로컬 edge(nginx)는 그대로 넘긴다 |
| WS 바이너리 프레임에 1003 대신 1006(닫힘 프레임 없이 끊김) | ws_probe 한 번(hello 직후 바이너리)에서만 — 같은 순서 · 지연 0–200 ms 로 20회 더 해 모두 1003. 앞선 QA(2026-10-01)도 두 실행 중 한 번 1006 |
| `?active=false` 가 만료된 SIGMET 을 싣는가 | fixture 의 SIGMET 이 모두 유효 — 만료된 세트를 넣으려면 스트림 주입(수집기의 다음 발행이 덮음)이 필요해 하지 않았다. 코드로 확인 |
| 선박 항적 정확히 5,000점의 `truncated` | 제품이 만들 수 없다(60 s 표본 · 24 h 상한 → 최대 1,441). DB 에 직접 넣는 재현은 하지 않았다 — 개선 제안 3 |

## 개선 제안(결함 수에 넣지 않음)
1. **WS resync 의 증폭**: 한 연결이 10 s 에 resync 17번(허용 20)이면 scope 없음 1.76 MB · `sigmets` 2.1 MB 를 받는다(평소 34 KB — 50–60배). IP당 5연결이면 약 1 MiB/s
   (스택 A 측정, 다른 요청의 p95 · api CPU 영향은 없었다 — 9 → 9 ms · 10 % 안팎). 공개 데모의 송신량 · 비용을 생각하면 scope 별 resync 간격(예: 5 s 에 1번)을 두는 안.
2. **관심 대상의 원시 항목 상한**: `/watch` 는 쉼표로 자른 원시 항목이 51개를 넘으면 중복 · 빈 칸이어도 `TOO_MANY_TARGETS`(RKSI × 52 → 400, × 51 → 200 · 1개) —
   계약 §G50 "합쳐 50개(중복은 한 번 · 빈 칸 건너뜀)" 와 문구가 다르다. 코드 주석이 의도(긴 입력을 개수 전에 막기 — `WatchController.java` `list`)를 밝히므로 계약 문구에 원시 상한을 적는 쪽.
3. **선박 항적 `truncated` 판정**: `ShipController.java` 는 `repo.track(…, 5000)` 뒤 `pts.size() >= 5000` 이라 정확히 5,000점이면 잘렸다고 한다(항공기는 limit + 1 로 묻는다).
   지금은 60 s 표본이라 닿지 않지만 표본 · 범위가 바뀌면 틀린다 — 항공기와 같은 방식으로.
4. **모르는 커서**: `/alerts/history?cursor=<없는 id>`(1 · 0 · −1 · 2^63−1)가 200 · 빈 목록 · `next_cursor` 없음 — '끝' 과 구별되지 않는다(보존 삭제된 커서도 같다). 400 `BAD_CURSOR` 또는 meta 표시.
5. **특보 이력 잘림 표시**: `/warnings/history` 는 limit(최대 500)에서 자르지만 `truncated` · 다음 쪽이 없다 — 30일 창에서 잘렸는지 알 수 없다.
6. **공개 캐시 응답의 Set-Cookie**: 쿠키 없는 공개 GET 마다 `Set-Cookie: WAKELINE_CSRF=…` 와 `Cache-Control: public, max-age=5–600` 이 함께 나간다. 지금은 공유 캐시가
   없지만(CloudFront CachingDisabled · edge 캐시 없음) 나중에 API 캐시를 켜면 한 사람의 CSRF 쿠키가 모두에게 갈 수 있다 — 공개 경로에서는 CSRF 쿠키를 내지 않거나 `private`.
   (Secure 없음은 config 영역 QA-1600.)
7. **공항 404 문구**: `/airports/ZZZZ/wx` 의 detail 이 "airport not watched: ZZZZ" 인데 실제 뜻은 '모르는 공항'이다(관심 아닌 공항도 200 — ZQAA 로 확인).
8. **재생 31일 · 1분 요약 30일**: `/replay` 는 31일 전까지 받지만 1분 요약 보존이 30일이라 마지막 하루는 늘 `source: none`(value_checks "31일 − 2분: none"). 창을 30일로 또는 문서에.
9. **시험이 없는 경로에 회귀 시험**: stepS > 0 · `active=false` · `watched=false` · `/radar/frames` 304 · `/sigmets/{id}` 의 `aircraft_inside` 는 api 시험이 없다(이번에 라이브로만 확인).
10. **QA 도구 기대값**: fuzz_api(`limit_21` — §G41 끝값) · write_probe(§G45 같은 값 저장 · 중복 공급자) · value_checks(fixture 의 되돌아가는 방위 — QA-210)가 지금 계약 · fixture
    보다 옛 기대를 갖고 있어 거짓 '다름'을 낸다. boundary_api 는 Accept 가 `application/json` 이라 GeoJSON 경로가 모두 406 이었다(이번에 고침 — 앞선 QA 의 그 표는 GeoJSON 경로를 검사하지 못했다).
11. **edge 의 TRACE**: `TRACE /api/v1/status` → nginx 405 text/html(문제 응답이 아님) — 앞선 QA 가 405 로만 적었다. edge 의 problem 페이지에 405 를 더하는 안.

## 앞선 QA 와 같음(다시 결함으로 올리지 않음)
- 익명 운영 요청 · 방화벽 400 이 공개 요청 제한에 세지지 않음 — api-sec **QA-1100** 그대로(라이브 A 에서 다시 봄: 익명 운영 GET 60건 뒤 `X-RateLimit-Remaining` 119).
- 406 은 본문 없음 — 2026-10 QA 기능 표의 설계 판단 그대로.
- WS 전체 상한 200 을 여러 IP 로 채우기 — 2026-10-02 QA 의 미확인 그대로(한 호스트는 IP당 5 가 먼저).
- 공개 경로 제어 문자(`%1F` 등)를 strip 이 지우는 것 — api-sec **QA-1103**(이번에 다시 시험하지 않음).

## 더한 · 고친 시험 코드 · 점검 스크립트(제품 코드는 고치지 않음)
- 새 재현 시험: `apps/api/src/test/java/dev/wakeline/qa/Qa1310NonAsciiCaseFoldAcceptedIT.java` · `Qa1311BboxExactly2500SqdegRejectedTest.java` ·
  `Qa1312QueryParameterParseFailureIs500IT.java` · `Qa1313TooManyCookiesErrorBodyIsNotProblemIT.java`.
- 새 스크립트: `tools/qa/qa_1310_1311_live.py` · `tools/qa/qa_1312_live.py` · `tools/qa/rate_limit_live.py` · `tools/qa/api_live_sizes.py`.
- 고친 스크립트: `tools/qa/qa_session.py`(QA_CREDS 가 계정 하나 모양 `{username, password}` 이면 그 계정으로 — 비밀번호를 출력하지 않는다) ·
  `tools/qa/boundary_api.py`(빠진 9경로 · GeoJSON Accept · 'bbox out of range' 거짓 후보 제외 · `QA_SKIP_OPS`) · `tools/qa/endpoint_sweep.py`(빠진 7경로 · 표본 알림 id · 레이더 tm).
