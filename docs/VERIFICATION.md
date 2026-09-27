# 검증 기록 (VERIFICATION.md)

실데이터·자동 검사로 찾은 문제를 "증상 → 재현 → 원인 → 수정 → 회귀 테스트" 순서로 기록한다. 날짜는 2026-09-27, 환경은 macOS 26.7(Apple Silicon) · Docker Desktop 29.8 · 실공급자.

## #1 항적·SIGMET·알림이 DB 에 저장되지 않음
- **증상** api 로그에 `BadSqlGrammarException` 이 매 주기 반복. 스냅샷·WS 는 정상.
- **재현** `docker compose logs api | grep "persist failed"`.
- **원인** pgjdbc 는 `java.time.Instant` 를 `setObject` 로 바인딩하지 못한다(SQLState 07006 이 문법 오류로 매핑돼 메시지가 오해를 부름).
- **수정** `persist/Sql.ts()` 로 모든 timestamptz 파라미터를 `OffsetDateTime(UTC)` 로 변환.
- **회귀** 기동 후 `SELECT count(*) FROM track_point/sigmet/alert_event` 증가 확인(현재 컴포즈 기동 5분 내 track_point 2,458행·sigmet 126·alert 12).

## #2 첫 주기의 alert_event INSERT 가 FK 위반
- **증상** `alert_event_sigmet_id_fkey` 위반이 기동 직후에만 발생.
- **원인** SIGMET 저장은 가상 스레드에서 비동기라 엔진의 첫 판정보다 늦을 수 있다.
- **수정** `AlertRepository` 가 INSERT 전에 `SigmetRepository.upsert()`(자연키, 멱등)로 존재를 보장.
- **회귀** 재기동 후 `persist failed` 0건.

## #3 위조 X-Forwarded-For 가 api 까지 도달 (IP 제한 우회)
- **증상** 서로 다른 XFF 를 붙인 요청이 서로 다른 `rl:*` 버킷에 들어감(`X-RateLimit-Remaining` 이 119, 119, 106).
- **재현** `curl -H "X-Forwarded-For: 1.2.3.4" /api/v1/status` 를 헤더만 바꿔 3회.
- **원인** nginx 는 `location` 에 `proxy_set_header` 가 하나라도 있으면 상위의 `proxy_set_header` 전부를 무시한다. `/api/` 의 `Connection ""` 때문에 서버 레벨 XFF 덮어쓰기가 사라졌다.
- **수정** 공통 헤더를 `infra/edge/proxy_headers.conf` 로 분리해 모든 location 에서 `include`.
- **회귀** 같은 3회 요청이 118 → 117 → 116 으로 한 버킷을 공유. E2E `forged X-Forwarded-For does not bypass rate limiting` 로 고정.

## #4 WebSocket 핸드셰이크 403
- **증상** 브라우저 `WebSocket connection failed`, edge 로그 `GET /ws/v1 403`.
- **원인** `proxy_set_header Host $host` 는 포트를 빼고 넘긴다. Spring 의 same-origin 검사는 `Origin: http://localhost:8700` 과 `Host: localhost`(포트 8000 추정)를 비교해 거부.
- **수정** `Host $http_host`. 교차 출처(`Origin: http://evil.example`)는 여전히 403.
- **회귀** curl 핸드셰이크 101 / 403 확인, E2E `conn` 배지 `open`.

## #5 nginx 설정을 고쳤는데 컨테이너에는 반영되지 않음
- **원인** macOS `sed -i` 가 파일을 새 inode 로 쓰고, Docker 단일 파일 bind mount 는 옛 inode 를 잡고 있다(`open() failed: No such file`).
- **수정** 설정 변경 후 `docker compose up -d --force-recreate edge`. README 에 명시.

## #6 api 기동 실패: Jackson 3 설정 키
- **증상** `spring.jackson.serialization.write-dates-as-timestamps` 바인딩 실패.
- **원인** Spring Boot 4 는 Jackson 3(`tools.jackson`)이 기본이며 해당 기능이 `datetime` 그룹으로 이동, 기본값이 ISO-8601.
- **수정** 설정 제거.

## #7 MapLibre 지도가 비어 있음 · 보간 워커 실패
- **증상** `Worker failed to load`, `non-JavaScript MIME type "text/html"` 또는 `video/mp2t`.
- **원인** Turbopack 이 `new Worker(new URL("x.ts", import.meta.url))` 를 자산 복사로 처리(`.ts` → `video/mp2t`). MapLibre 6 의 모듈 워커도 같은 경로로 실패.
- **수정** MapLibre 워커를 `public/maplibre/` 로 복사 + `setWorkerUrl()`; 보간 워커는 순수 JS(`public/interpolate.worker.js`) + TS 구현과의 일치 테스트(`tests/worker-sync.test.ts`).

## #8 React 오류 #185(최대 갱신 깊이 초과)로 화면이 죽음
- **원인** `useSyncExternalStore` 의 getSnapshot 이 매번 새 객체를 반환(StatusBar 의 객체 셀렉터).
- **수정** 스토어 객체 자체를 선택하고 컴포넌트 안에서 필드를 읽음. React Compiler 린트(`react-hooks/purity`, `refs`, `set-state-in-effect`) 위반 6건도 함께 정리.

## #9 운영자 로그인 500
- **원인** `request.changeSessionId()` 는 세션이 없으면 예외. 또 세션에 저장되는 `OpsUserService.User` 가 Serializable 이 아니었다.
- **수정** `getSession(true)` 후 ID 교체, `User implements Serializable`.
- **회귀** curl 시나리오: 잘못된 비밀번호 401 → 로그인 200(HttpOnly·SameSite=Strict 쿠키 2개) → CSRF 없는 PUT 403 → If-Match 불일치 409 → 값 검증 400 → 정상 200 → Redis 미러 반영 → 감사 로그 3건(IP·request_id) → 로그아웃 204 → 비인증 404 → 5회 실패 잠금.

## #10 adsb.lol 429
- **관찰** 10 s 주기에서 adsb.lol 이 간헐적으로 429 를 돌려준다(README 는 "제한 없음", 제3자 보고와 일치). 12분 동안 폴백/복귀 전환 9회.
- **수정** 429 는 지수 백오프(60→120→240→300 s)로 쉬고 그동안 adsb.fi(초당 1회 토큰 버킷)가 맡는다. 전환은 `wakeline:events` 스트림과 운영 화면에 남는다.

## #11 공개 포트 충돌
- **증상** 8080 은 같은 Mac 의 SmartCollab 이 사용.
- **수정** 형제 프로젝트 compose 파일의 포트를 모두 조사해 8700 으로 변경, 127.0.0.1 바인딩.

## #13 collector 로그에 API 키 노출
- **증상** httpx 가 INFO 레벨로 요청 URL 전체(기상청 `authKey=` 쿼리 포함)를 기록.
- **수정** httpx/httpcore 로거를 WARNING 으로, 마스킹 규칙에 `authKey=` 추가(11패턴). 운영 화면 오류 원문도 같은 마스킹을 거친다.
- **회귀** `test_masking` 에 authKey 케이스 추가, 재기동 후 로그에 `authKey=` 0건.

## #14 기상청 API허브 레이더(FR-31)
- **관찰** 인증키는 유효하지만 API 별 "활용신청" 이 없으면 모든 엔드포인트가 403 JSON 을 돌려준다.
- **구현(승인 후)** 바이너리 포맷 문서(헤더 64+20×48 B, 반사도 short×2305×2881, 값 dBZ×100, NULL −20000/−25000/−30000)와 데이터위키의 proj 문자열·Affine 정의를 근거로 격자를 해석해 서버에서 웹 메르카토르 PNG 로 재투영, MapLibre image source 로 오버레이(ADR-012). 영상 API(`data=img`)는 해당 시각 파일이 없어 200 + "file not exist" 텍스트를 돌려주므로 바이너리만 쓴다.
- **회귀** 실헤더 fixture 파싱 테스트, 기준점 재투영 픽셀 테스트, RainViewer 같은 시각 프레임과의 육안 대조(서해안 북부·전남 해안·부산 남동 해상 에코 위치 일치).

## #15 E2E 가 fixture 모드가 아닌데 통과함(거짓 통과) · 개발 DB 오염
- **증상** `make e2e` 4건 통과. 그러나 compose 로그에서 collector 가 재생성되지 않았고(`Running`), 컨테이너 환경변수는 api=1 · collector=0. 외부 공급자를 호출하는 상태에서 화면 배지는 "FIXTURE MODE · 외부 호출 없음" 이었다.
- **원인** ① collector 는 `env_file` 만 읽어 셸의 `WAKELINE_FIXTURE_MODE=1` 을 받지 못했다. ② 배지가 collector 의 실제 모드가 아니라 api 설정값을 보여 줬다. ③ E2E 가 개발 스택(8700)을 fixture 로 바꿔 돌리는 구조라, 앞서 수동 fixture 실행(09:03–09:05 UTC)의 재생 자료가 개발 DB 에 섞였다. 재생 SIGMET 이 `awc_isigmet` 출처로 저장돼 실자료와 구분도 안 됐다.
- **수정** E2E·데모를 별도 compose 프로젝트(`wakeline-e2e`, 포트 8701, 서브넷 10.78.0.0/24, 별도 볼륨)로 격리하고 끝나면 `down -v`. collector `environment` 에도 `WAKELINE_FIXTURE_MODE` 전달. 배지 = collector heartbeat 의 실제 모드. 재생 SIGMET 출처는 `fixture`. nginx upstream 을 서비스 이름으로 바꿔 같은 설정이 두 스택에서 동작. E2E 에 "status 의 region·sigmet 출처가 fixture" 검사 추가(이 검사는 첫 실행을 실패시켰을 것이다).
- **데이터 정리** 개발 DB 에서 fixture 창에 쓰인 SIGMET 132 · 알림 84 · 항적 1,143 · METAR 13 · 항공기 95 · 당일 통계 81 행을 백업 후 한 트랜잭션으로 삭제. 실 SIGMET·항적은 유지.
- **회귀** `make e2e` 5건 통과, 종료 후 `wakeline-e2e` 리소스 0, 개발 스택 `fixture_mode=false`.

## #12 통계 화면 `/stats/traffic` 500
- **원인** `SELECT dim hour` — `hour` 는 PostgreSQL 예약어.
- **수정** 별칭 제거(화면은 `dim` 을 읽음). 운영 API `POST /ops/stats/aggregate?day=` 를 추가해 집계를 즉시 재실행(멱등·감사 기록)할 수 있게 했다.
- **회귀** 집계 후 `/stats/*` 3종 200, 화면에 FIR·hazard·시간대 막대 표시.

## #16 같은 관측이 0.1 s 어긋난 두 점으로 저장됨(집중 추적 실측)
- **증상** 선택 항공기의 항적에 거의 같은 위치의 점이 0.0–0.1 s 간격으로 두 개씩 생겼다. 원천 응답을 대조하니 같은 관측을 관심 지역·핫 리전·집중 추적이 각각 받은 것이었다.
- **원인** `seen_at = 수신 시각 − seen_pos`. 수신 시각은 호출마다 다르고 seen_pos 는 공급자 시각 기준이라, 같은 관측이 호출마다 조금씩 다른 시각이 됐다.
- **수정** readsb 응답의 `now`(공급자 서버 시각)를 기준으로 뺀다. 공급자 시계가 수신 시각의 −10 s ~ +2 s 밖이면 수신 시각으로 되돌리고 센다(리뷰에서 창을 ±120 s → 이 범위로 좁힘 — 미래 시각 격리 30 s 와 겹치지 않게).
- **회귀** 실측 두 응답(now 차 16 s, seen_pos 2.394 / 18.394)이 같은 seen_at 이 되는 단위 시험. 재배포 뒤 비행 중 항공기 집중 추적 60 s: 관측 13건, 간격 중앙값 5.05 s, 저장 항적의 1 s 미만 중복 0건.

## #17 AIS 전세계 구독이 1분마다 끊김 — 사유가 서버 탓으로 잘못 기록됨
- **증상** `ais_bboxes` 를 전세계로 바꾸자 10분에 11번 끊겼다(공백 합계 87 s). 사유는 모두 "connection lost (no close frame)".
- **원인** close 프레임은 우리가 보냈다(1011 keepalive ping timeout). 컨테이너 소켓의 수신 대기열은 0 — 우리는 즉시 읽는데, 공급자 쪽 연결별 전달이 뒤처져
  (수신 시각 − time_utc 가 13 → 17 → 22 s) pong 도 20 s 넘게 늦었다. 반구·지역별 탐침: 동경 반구 4 → 53 s, 유럽 단독도 2 → 33 s 뒤 서버가 끊음,
  아메리카+아시아·태평양 한 연결은 3분 탐침에서 2–5 s, 10분 운영 측정에서 p50 7.9 s · p90 17.9 s(스스로 회복, 재연결 1회)(ADR-014 부록 A).
- **수정** 끊김 사유를 보낸 쪽으로 구분(`client closed (1011 …)` / `server closed (…)` / `connection lost`). 수신 범위를 0~45°E 를 뺀 전 해역으로 정하고
  (운영 설정, 감사 기록), 범위를 상태·지도(점선 경계·범례)로 보인다. 공백은 수신 시각 기준이며 데이터 시각 구멍은 그 순간 지연만큼 더 길 수 있음을 ADR 에 적었다.
- **회귀** 사유 분류 단위 시험 3건. 운영 API 로 범위를 바꾸면 9 s 안에 같은 연결에서 다시 구독(로그). 10분 재측정은 PERF.md.

## #18 짧은 수신 공백이 선박 항적을 조각내고, 공백 목록은 최신 것을 버림
- **증상(예상 → 확인)** 저장 간격이 60 s 인데 1분마다 2–6 s 공백이 생기면 거의 모든 두 점 사이에 공백이 걸쳐 선이 끊긴다. 또 공백 목록 상한(500)이 오래된 것부터
  채워 가장 최근 공백이 빠졌다(api 와 웹 모두).
- **수정** 선은 60 s 이상 공백(또는 열린 공백)에서만 끊는다(더 짧은 공백은 저장점을 없애지 못한다). 끊기 판정용 긴 공백은 따로 조회해 목록 상한의 영향을 받지 않는다.
  목록은 최신 N개 + `truncated`. 웹은 서버가 준 구간 경계를 따르고, 카드에는 창 안에서 잘라 센 공백 요약을 보인다(기록 조회 실패 시 "선택 뒤 받은 공백 · 6 h 전체가 아님").
- **회귀** api·웹 단위 시험(200개 넘는 공백 중 가장 오래된 10분 공백이 선을 끊는지 포함).

## #19 AIS 수신 범위를 바꾸려면 .env 수정·재시작이 필요했음
- **원인** ais 프로세스는 `wakeline:settings.ais_bboxes` 를 30 s 마다 읽지만 api 운영 설정에 그 키가 없었다.
- **수정** V6 로 설정 행 추가(빈 값 = .env 기본), api 검증은 수집기 `parse_bboxes` 규칙 + 더 엄격한 숫자 형식(api 가 받은 값은 수집기도 받는다). If-Match·CSRF·감사 기록은 기존 설정과 같다.
- **회귀** 단위 시험(형식·범위·넓이 0·16개·1,024자·지수/NaN/16진 거절) · 통합 시험(400 → 200 → Redis 미러 → 감사 1건).

## #20 E2E 두 건이 가끔 실패 — edge 의 IP당 제한에 시험 자신이 걸림
- **원인** Playwright 작업자 둘이 같은 IP 로 페이지를 여는 동안 edge 의 10 r/s 양동이가 잠깐 차고, nginx 가 HTML 429 를 돌려줬다. 제품 동작은 설계대로다.
- **수정** 처음에는 두 시험이 edge 가 다시 받아 줄 때까지 기다리게 했으나, 다른 작업자가 계속 페이지를 열어 다시 실패했다. 그래서 API 를 직접 부르는 시험을
  별도 Playwright 프로젝트(`edge-limits`, 화면 시험 프로젝트 `app` 에 의존)로 옮겨 화면 시험이 모두 끝난 뒤 혼자 돌게 했다. 제한 자체는 그대로 시험한다.
- **회귀** `make e2e` 16건 통과, 연속 2회.

## #21 적대적 리뷰(2026-09-28b) 19건
네 갈래(수요 추적 수집기 · AIS · api · 웹/인프라) 리뷰어가 찾고, 각 갈래마다 독립 검증자가 반박을 시도했다. 19건 모두 살아남았다(high 1 · medium 8 · low 10).
원문·재현·증거는 `docs/audit/review-2026-09-28b.json`, 수정 계약은 `docs/audit/change-contract-v3.md`.

| 심각도 | 요지 | 수정 |
|---|---|---|
| high | 같은 MMSI 정적 정보 두 건이 한 배치에 들어가면 `ON CONFLICT` 21000 으로 선박 저장이 영구히 멈춤(재시도 무한) | 배치 전 MMSI 별 병합 · SQLSTATE 21 은 영구 오류 |
| medium | 한 세션이 선택을 번갈아 바꿔 adsb.fi 일일 예산을 소진시킬 수 있음 | 세션당 새 hex·셀 60 s 에 6개 + 수집기 빠른 조회 상한 |
| medium | 운영자가 adsb.fi 를 꺼도 수요 조회는 계속됨 | 틱마다 확인, 대기 중 조회 취소, 상태 `disabled` |
| medium | 한도 대기(Throttled)를 공급자 실패로 세어 관심 지역이 10분 멈춤 | 실패로 세지 않고 남은 대기 시간만 건너뜀 |
| medium | 오류 프레임을 데이터로 세어 끊긴 동안 '회복' 공백이 하루 1,400건 쌓일 수 있음 | 데이터 프레임만 셈 |
| medium | Redis `CLIENT TRACKING BCAST` 로 세션 키 이름(=운영 세션 ID)이 새어 나갈 수 있음(ACL 키 제한 우회) | 모든 서비스 사용자에서 금지 · ACL 시험 |
| medium | 열린 공백이 닫혀도 남아 이후 모든 관측 사이에 거짓 'AIS 공백' 이 그려짐 | 같은 시작의 열린 공백 대체 |
| medium | 키가 없어 꺼진 AIS 를 '끊김 · 재연결 중' 으로 표시 | 상태 `state` 공개, 중립 배지 |
| low ×10 | Timestamp 60 을 GNSS 로 표시 · 기국 번호를 IMO 로 표시 · 보조 선박 24B 크기 오독 · 종료 경쟁 · 시계 창 · 한도 펌프 · ETag · 항공기 레이어 끈 뒤 수 고정 · chaos 복구 트랩 · 공백 목록 절단 | 모두 수정(계약 v3 §B·§D) |


## #22 장애 주입 시험이 '재시작 안 됨' 으로 실패 — 시험 방법이 틀렸음
- **증상** `tools/chaos.sh` 첫 실행에서 api·collector·redis 가 Exited(137) 로 남고 재시작 횟수 0.
- **원인** `docker kill` 은 Docker(29.8)가 **수동 정지**로 기록해 `unless-stopped` 정책을 건너뛴다. 실제 비정상 종료를 흉내 내지 못했다. 또 세 서비스는 앱이 PID 1 이라
  컨테이너 안에서 앱만 죽일 방법도 없었다.
- **수정** api·collector·redis 에 `init: true`(docker-init 이 PID 1 — 신호 전달·좀비 회수). 시험은 컨테이너 안에서 앱 프로세스를 SIGKILL 하고(`kill -9 -1`),
  init 이 137 로 끝나면 재시작 정책이 다시 띄운다.
- **회귀(2026-09-27 21:5x–22:0x UTC, 개발 스택)**

| 시나리오 | 결과 |
|---|---|
| api SIGKILL | 6.2 s 뒤 항공기 응답 · 스트림 PEL 재처리 · 항적 (hex, ts) 중복 0 |
| collector SIGKILL | 3.4 s 뒤 새 스냅샷 |
| redis SIGKILL | 중단 중 `/aircraft` 200(메모리 스냅샷) · 6.6 s 뒤 수집 재개 · 소비자 그룹 유지(AOF) |
| db 40 s 정지 | 실시간 `/aircraft` 200 · 이력 `/alerts/history` 503 + Retry-After 10 · 복구 뒤 대기열의 항적 20,236행 기록 |
| 관심 지역 공급자 3개 끔(운영 API) | 마지막 스냅샷 85대 유지 · 지연 60 s 넘으면 stale=true · 다시 켜고 4 s 뒤 fresh |
| ais 네트워크 60 s 단절 | 공백 1건 기록(사유 client closed 1011 — 끊긴 동안 ping 실패) · 복구 12.7 s 뒤 수신 · 드롭 0 · 컨테이너 재시작 0 |

## #23 날짜변경선을 넘는 화면에서 아메리카가 통째로 빠짐(스크린샷 검토 중 발견)
- **증상** 태평양 중심 세계 지도(줌 1.7, 중심 150°E)에서 아시아 쪽에만 항공기·선박 격자가 보이고 아메리카는 비었다.
- **원인** MapLibre 는 날짜변경선을 넘는 화면의 경도를 펼친 값(예: 20 ~ 280)으로 준다. 구독 영역을 만들 때 동쪽 끝을 180 으로 잘라 −180 ~ −80 이 구독에서 빠졌다.
- **수정** `lib/viewport.ts`: 줌 < 7 에서 넘으면 위도 띠 전체(−180 ~ 180)를 구독한다(낮은 줌은 전세계·격자 인코딩이고 핫 리전 수요가 없다).
  줌 ≥ 7 에서 넘으면 화면 중심 쪽만 — api 가 핫 리전 칸을 구독 영역 중심으로 정하므로 띠 전체를 보내면 중심이 경도 0 으로 잡힌다. 재생 화면의 REST 요청도 같은 규칙(중심 쪽).
- **회귀** 단위 시험 5건(보통 화면 · 낮은 줌 띠 전체 · 한 바퀴 이상 · 확대 시 중심 쪽 양방향 · 바퀴 수 정규화). 같은 화면에서 항공기 10,232대 · 선박 14k척(130칸)으로 아메리카 포함.

## 자동 검사 현황(2026-09-28)
| 층 | 도구 | 수 |
|---|---|---|
| collector · ais 단위·통합 | pytest | 453 통과(4 건너뜀) · 커버리지 95.8 % |
| api 단위·통합 | JUnit 5 + Testcontainers(PostGIS·Redis 실물) | 395 · JaCoCo LINE 95.5 % · BRANCH 81.7 %(하한 95 / 80) |
| web 단위 | Vitest | 209 |
| 언어 간 스키마 계약 | tools/contract_check.py | 스키마 사본 일치 + 실메시지·fixture 검사 |
| REST 계약 | tools/rest_contract_check.py | api 통합 시험이 기록한 응답 27종 |
| 인프라 정책 | infra/tests(unittest) | 44 |
| Redis ACL 동작 | infra/tests/redis_acl_test.sh(버리는 컨테이너) | 171 |
| E2E | Playwright(격리된 fixture 스택 8701) | 16 |
