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

## #24 리뷰 v1(4단계 절차) — 98건 진단(고유 97 + 3단계 추가 R-98) · 85건 승인 · 2차 검토 35건 · 문서 사실 확인 2회
- 절차: 기준선 측정([review/BASELINE](review/BASELINE.md)) → 진단([review/REVIEW-v1](review/REVIEW-v1.md), 독립 검증자가 반박 시도) → 승인 항목 수정(버그·보안은 실패하는 시험 먼저, 계약 변경은 [ADR-017](adr/ADR-017-review-v1-contract-changes.md) 먼저)
  → 재측정·검증([review/VERIFICATION](review/VERIFICATION.md)). 1차 수정은 6개 레인 90커밋, 레인마다 독립 검토자가 다시 확인해 35건을 찾았고 모두 다시 처리했다.
- 결과 요약: api 이미지 CRITICAL 3 → 0 · web 이미지 HIGH 4 → 0 · Semgrep 9 → 0 · gitleaks 2 → 0 · 첫 화면 JS 613.6 → 497.7 KiB · api 메모리 611 → 경합 기록이 없는 오전 k6 실행에서 약 500 MiB(최종 측정 스크립트 527.2 MiB · 같은 기계에 다른 부하가 있으면 577–611 MiB) · collector 메모리 40분 뒤 약 297 → 약 210 MiB ·
  시험 collector 682 → 746 · api 457 → 534 · web 286 → 378.

## #25 퍼센트 인코딩한 경로로 운영 세션 수명·CSRF·요청 제한 우회(R-98)
- **증상** `/api/v1/%6Fps/providers/opensky/disable` 을 CSRF 헤더 없이 쿠키만으로 보내면 204 — 공급자가 실제로 꺼졌다. 같은 방법으로 만료 세션 200, 분당 한도 우회.
- **원인** 세 검사가 원문 `getRequestURI()` 앞부분으로 대상을 골랐고, 인가·Spring MVC 는 디코딩한 경로로 맞췄다. edge 는 원문 URI 를 그대로 넘긴다.
- **수정** 경로 판단을 인가와 같은 `PathPatternRequestMatcher`(`ApiPaths`) 하나로. **회귀** 실제 HTTP 로 보내는 `SecurityIT` 4건(수정 전 200·204·200 — 기대 404·403·429).
- **교훈** 경로로 보안 결정을 할 때는 인가 규칙과 같은 매처를 쓴다. 문자열 앞부분 비교는 정규화 차이로 우회된다.

## #26 api 메모리가 힙을 줄여도 줄지 않음 — glibc malloc 아레나(NFR-03)
- **증상** 힙 비율을 60 → 40 % 로 줄였지만(R-25) 부하 중 RSS 605–629 MiB(목표 ≤ 512 MB). 힙 커밋은 약 200 MiB 뿐이었다.
- **원인 찾기** JVM Native Memory Tracking(종료 때 요약 출력 — 강화된 컨테이너라 `jcmd` 붙이기가 실패)으로 JVM 이 쓴 메모리(NMT committed) 427 MiB, 종료 직전 프로세스 익명 메모리 588 MiB — 약 160 MiB 가 JVM 밖, 스레드별 malloc 아레나였다.
- **수정** 실행 이미지에 `MALLOC_ARENA_MAX=2` → 경합 없을 때 k6 부하 중 최대 497 MiB · 실행 끝 501 MiB. 같은 부하의 교대 A/B 로 지연 차이가 실행 간 흔들림 안임을 확인.
- **남은 것** 같은 기계에 다른 부하가 있으면 처리가 밀려 G1 이 힙 커밋을 늘리고(241 → 298 · 217 → 316 MiB) RSS 가 577–611 MiB 까지 오른다(힙 표본). k6 없이 큰 경합 속에서는 힙 커밋 381 · RSS 661 MiB, 최종 측정 스크립트(k6 없음)는 527.2 MiB — NFR-03(≤ 512)은 경합 없는 k6 실행에서만 맞았다. 힙 상한 조정은 경합 없는 측정으로 정할 다음 후보.

## #26b collector 메모리가 재기동 뒤 계단식으로 늘어남 — 스레드별 malloc 아레나
- **증상** 재기동 뒤 40분에 RssAnon 99 → 289–298 MiB. 누수로 보였다.
- **원인 찾기** 코드 감사(3개 갈래, 후보마다 반박 검증)에서 끝없이 자라는 자료 구조는 없었다. 메모리가 뛴 시각이 기상청 레이더 해석(수십 MB numpy)과 맞았고, 이 해석이 공용 스레드 풀(최대 8)의 아무 스레드에서 돌아 스레드마다 glibc 아레나가 최고점을 따로 쥐었다(해석은 기준선부터 풀에서 돌았고, R-21 이 풀을 쓰는 호출을 늘려 스레드가 많아진 것으로 추정). 아레나만 묶어서는 멈추지 않았다.
- **수정** 해석은 전용 스레드 하나에서만 + `MALLOC_ARENA_MAX=2` → 같은 40분에 173–217 MiB 로 평탄. **회귀** `test_decode_runs_on_one_dedicated_thread_not_the_shared_pool` · 정책 시험.

## #27 푸시 전에 잡은 CI 빨간불 — 실 Redis 시험이 없어진 ACL 변수를 읽음
- **증상** R-86(Redis 명령 허용 목록) 뒤 `collector_redis_test.sh`(CI collector job)가 시험 코드에 닿기 전에 실패 — 로컬 기본 실행에서는 건너뛰는 시험이라 드러나지 않았다.
- **수정** 시험이 start.sh 와 같은 규칙(키·명령 목록·선택자, 이어 붙인 줄 포함)으로 사용자를 만든다. 6/6 통과.

## #28 부하 시험 결과가 같은 기계의 다른 작업에 흔들림 — 측정 방법
- 브라우저 패널에 상황판(선박 약 1.4만 척 WebGL)을 열어 둔 채 k6 를 돌리면 REST p99 가 207–228 ms 로 올랐다(닫고 27–137 ms). 같은 Docker VM 에서 다른 프로젝트(aptlake)의 CPU 를 실행 중 기록한 13:21 · 13:30 실행(23–244 %)에서는 REST p95 가 1.0–6.2 s,
  호스트 부하만 기록한 12:03 · 12:10 실행(1분 부하 5.3–12.4)에서는 3.1–30 s 까지 나빴다(기록이 없는 11:54 실행은 0.4 s — 원인은 확인하지 않았다). 이후 부하 시험은 호스트 부하·`docker stats` 를 함께 기록하고, 오염된 실행은 이유를 적고 버린다. Lighthouse 도 한 번의 값은 흔들림이 커서(TBT 620–2,732 ms) 5회 중앙값을 쓴다.

## #29 E2E 가 조용한 날에 4건 실패 — MapLibre 파일이 IP당 제한 안으로 들어감(R-02 부작용)
- **증상** 최종 코드의 `make e2e` 가 4/16 실패, edge 로그 `limiting requests … zone "perip"`(429). 호스트가 바빠 느리게 돈 날에는 통과했다.
- **원인** R-02 가 MapLibre 를 `/_next/static`(제한 밖)에서 `/maplibre/<버전>/` 으로 옮겼는데 edge 는 이를 `location /`(IP당 제한)로 보냈다. 첫 화면마다 양동이를 3–4칸 더 쓰고,
  Playwright 작업자 여럿은 같은 IP 라 캐시 없는 첫 화면을 동시에 열어 양동이를 넘겼다.
- **수정** `/maplibre/` 를 `/_next/static` 처럼 제한 밖·1년 immutable 로. UI 시험은 작업자 1명(여러 브라우저 = 한 IP 뒤의 여러 사용자 — 재시도로 가리지 않는다).
- **회귀** `edge_test.sh`(양동이가 찬 뒤 `/maplibre` 100회 중 429 0) · `test_edge_policy.StaticAssetsTest` · `make e2e` 16/16 연속 2회.

## #30 E2E 가 계약 v5 뒤 1건 실패 — 주 메뉴 미리 가져오기가 IP당 양동이를 먼저 씀
- **증상** `make e2e` 13 통과 · 1 실패 · 2 실행 안 됨. 실패한 시험(dashboard.spec.ts:76)의 `/api/v1/aircraft` 가 JSON 대신 nginx 의 HTML 오류 페이지를 받았다(429 로 보임 — 실패 뒤 남긴 edge 로그
  마지막 150줄에는 이 요청 줄이 없다). 같은 실행의 뒤 시험에서도 `/api/v1/radar/kr` 부터 `limiting requests, excess: 36.630 by zone "perip"` 로 429 가 이어졌고, 초과분은 미리 가져오기 요청에서 60 대까지 올랐다.
- **원인** 모든 화면이 요청 때 그리는 동적 경로(ƒ)인데 Next 가 주 메뉴 링크 6개를 화면을 열 때마다 미리 가져왔다(서버 렌더 6번). edge 의 `perip`(10 r/s)은 `/`(burst 60)와 `/api/`(burst 30)가 같이 쓰므로,
  계약 v5 가 더한 "로그" 메뉴까지 미리 가져오기가 초과분을 30 위로 올려 그 뒤 API 호출이 429 를 받았다 — 실제 사용자도 화면을 빨리 넘기면 같은 일이 날 수 있다(재현하지는 않았다).
- **수정** 셸의 링크(로고 + 메뉴 6)는 `prefetch={false}`. **회귀** `tests/shell-prefetch.test.ts`(시험 1건 — 수정 전에는 prefetch 를 끄지 않은 링크 7개로 실패) · `make e2e` 16/16(수정 뒤 2회 — 성공한 실행은 edge 로그를 남기지 않아 429 수는 세지 않았다).

## #31 gitleaks 가 새 가짜 값 4건에서 실패
- **증상** 보안 게이트 `leaks found: 4`(이전 0).
- **확인** 네 값 모두 계약 v5 가림 시험의 입력이다: 합성 HS256 토큰(sub=1234567890 — 기존 허용 항목과 같은 값) 2건, 호스트 `*.test` 의 자리표시 키 `ABCDEFGH12345` 2건.
  `.env` 의 어떤 값과도 같지 않음을 스크립트로 대조했다(값은 출력하지 않음).
- **처리** `.gitleaksignore` 에 정확한 지문(커밋:파일:규칙:줄)만 더하고 이유를 주석으로. 정책 시험(`test_ci_policy`)이 허용 목록 전체를 고정한다. 게이트 PASS.

## #32 날짜변경선을 넘는 SIGMET 이 180° 동쪽에서 판정되지 않음 — 새 WS 검증기가 배포 직후 발견
- **증상** 배포한 화면의 상태 바에 `WS 형식 오류 · 원소 1`. 상세: `sigmets.collection.features[73]: 형식이 틀린 값을 버림`.
- **원인** AWC 가 UHMM(마가단 FIR) SIGMET 을 이어진 경도(176.8 → 184 → 191.033)로 보냈다. 수집기의 분할은 점 사이 점프가 180 을 넘을 때만 날짜변경선을 넘는다고 봐서,
  경도 > 180 인 폴리곤이 그대로 나갔다. api 는 경도 −180..180 의 항공기로 판정하므로 이 경보의 180° 동쪽 부분(서경 약 169–180°)에 있는 항공기는 **경보 안으로 잡히지 않았다**. 웹은 스키마(경도 ±180)에 맞지 않아 이 경보를 지도에서 뺐다.
- **수정** 링을 먼저 이어진 경도로 편 뒤 360° 폭 창마다 잘라 되돌린다(점프 · 이어진 경도 두 형식 모두). **회귀** 시험 2건(수정 전 실패) · 실수신 UHMM 폴리곤을 다시 풀면 2조각 · 면적 99.825 제곱도 그대로 · 서경 175° 점이 안에 든다.
  배포 뒤 `/api/v1/sigmets` 160건 모두 경도 ±180 안.
- **스키마 전수 확인** 배포한 스택의 실제 WS 메시지를 150 s 동안 세 세션(전세계 · 도쿄만 · 밴쿠버, 선박 켬 · 선박 선택)으로 받아 `schemas/ws/server.v1.json` 으로 검증: 최종 빌드에서 230건 · 14종, 형식 오류 0건([review/evidence/v5-ws-live-check.txt](review/evidence/v5-ws-live-check.txt) — 스크립트 포함).
- **교훈** 스키마를 코드와 fixture 로만 만들면 실제 공급자 값의 모양을 놓친다 — 배포 뒤 실메시지를 한 번 검증한다(위 절차).

## #33 `make ops-user` 가 뜨지 못함(2026-09-28 부터) — 운영자 계정을 만들 수 없었음
- **증상** 격리 스택에 시험용 운영자를 만들다 `Health contributor 'ingestPipeline' defined in 'management.endpoint.health.group.ingest.include' does not exist` 로 실패.
- **원인** 헬스 그룹 `ingest` 가 가리키는 기여자(IngestHealthIndicator)는 `@Profile("!cli & !migrate")` 라 일회성 cli 컨텍스트에 없다. Spring Boot 는 그룹 구성원을 검사해 컨텍스트를 멈춘다.
  시험은 입력 검사(WakelineApplicationTest)만 있어 실제 cli 컨텍스트를 띄운 적이 없었다(5251859 부터).
- **수정** cli 컨텍스트만 그룹 구성원 검사를 끈다(헬스 엔드포인트를 내보내지 않는 일회성 프로세스). **회귀** `CreateOpsUserCliIT` — 실제 cli 프로필 컨텍스트를 통합 시험 스택에 띄워 계정 행까지 확인(수정 전 같은 예외로 실패).

## #34 레이더를 한 번도 받지 않았는데 상태가 "오래됨 아님"
- **증상** `status.radar.stale = false` 인데 `fetched_at` 이 자리표시 1970-01-01(ws-contract 레인이 fixture 에서 발견).
- **원인** 지연 계산이 자리표시에 −1 을 돌려주고, SIGMET 에만 있던 "받은 적 없음 = 오래됨" 조건이 레이더에는 없었다. **수정** 같은 규칙. **회귀** `StatusServiceTest.radarNeverFetchedIsStale`(수정 전 실패) · WS 표본 다시 만듦.

## #35 같은 오류가 두 번 났는데 로그에는 1번 — 억제 수가 다음 항목을 영영 기다림
- **증상** 격리 스택에서 같은 브라우저 오류를 10 s 안에 두 번 보냈더니 `/logs` 묶음이 "항목 1 · 억제 합 0". 운영 pipeline 의 `log_suppressed` 합계에만 보였다.
- **원인** 두 로그 싱크(api Java · collector/ais Python)는 같은 지문을 10 s 에 1건만 싣고, 그사이 억제한 수를 그 지문의 **다음** 항목에 싣는다. 다음 항목이 오지 않으면 그 수는 프로세스 메모리에만 남았다.
- **수정**(계약 v5 §G9 · ADR-018 개정) 창이 닫힐 때 억제한 것이 k 건이면 마지막 억제 발생을 suppressed = k − 1 로 싣는다(기존 1 s 전송 주기에서, 새 스레드 없음). 종료 때도 남은 것을 먼저 싣는다.
  지문 표가 가득 차 억제 수를 가진 지문을 잊어야 하면 그 수를 dropped 로 센다(조용히 잃지 않음). api 는 logback 이 나중에 읽는 스레드 이름·MDC(요청 id)를 앱 스레드에서 고정한다.
- **회귀** 두 언어가 같은 파일 `schemas/vectors/log-suppression.v1.json`(11 사례 · 87 단계)을 재생하고, 무작위 300 가지 순서에서 "항목 수 + 억제 합 = 발생 수"를 확인. `LogsIT`(같은 경고 두 번 → 수정 전 "Expected size: 2 but was: 1").
  레인 리뷰가 찾은 5건(전송 스레드의 Error 로 묶음을 잃음 · 같은 주기의 순서가 언어마다 다름 · 예외 문구를 늦게 읽음 · 벽시계 사용 · 계약 검사가 형식 오류에 멈춤)도 시험 먼저 고쳤다.

## #36 운영 화면에서 읽을 수 없던 것 — UTC 시각 · 오류 원문 · 전환 사유 · "— ms"(사용자 확인, 2026-09-29)
- **증상**(사용자 캡처) 운영 · 로그 화면의 모든 시각이 UTC(`…Z`). 마지막 오류 칸이 `ProviderHttpError('HTTP 429: <html>\r\n<head><title>429 To…` · `ReadTimeout('')` ·
  `ConnectError('')` 처럼 원문 그대로. 공급자 전환 사유가 모두 `fallback/recovery`(왜 바뀌었는지 모름). 지연을 모르는 행이 `— ms`.
- **수정** 운영 · 로그 화면은 한국 표준시(열 머리 `(KST)`, 원본 UTC 는 툴팁 · JSON 복사 · .ndjson — 계약 v5 §G10). 복사 · .txt 머리는 ISO 8601 `+09:00`.
  수집기 오류 문구 하나로(`errors.describe_error` — `HTTP 429 Too Many Requests` · `ReadTimeout — read 제한 15 s 초과 (apihub.kma.go.kr)` · `ConnectError — 연결 실패 (host): 원인`).
  전환 사유는 까닭을 적는다(`fallback — adsb_lol 429 쉼(60 s)` · `… 429 반복 → 20분 뒤로 미룸` · `recovery — adsb_lol 쉼 끝(1순위 복귀)` 등, ADR-011).
  모르는 값 뒤에 단위를 붙이지 않는다(운영 · 로그 · 상태 바 · AIS 배지 · 재생 — `— ms` · `— frames` · `— msg/s` 대신 `—`).
- **뒤이은 요청** 사용자가 상황판도 KST 로 바꾸라고 했다 — 상황판 · 재생(입력도 KST, 요청은 UTC) · 통계(시각은 KST, 일 집계는 "(UTC 날짜)") · 공항까지 KST, 원문 METAR · TAF · SIGMET 은 발표 그대로(계약 v5 §G11).
- **확인** 배포 뒤 개발 스택의 Redis: 전환 사유 `fallback — adsb_lol 429 쉼(60 s)`, 공급자 상태 `last_error = HTTP 429 Too Many Requests`. 격리 스택에서 운영 7개 탭 · 로그 목록 · 상세를
  브라우저로 열어 남은 `HH:MM:SSZ` 0건 · `— ms` 0건, 복사 머리 `2026-09-29T10:14:36.115+09:00`. **회귀** 웹 시험(시간대 5곳에서 같은 결과) · 수집기 오류 문구 시험(위 원문 그대로의 입력).

## #37 api 를 띄울 때마다 SpringDoc 경고가 시스템 로그에 실림
- **증상** 배포마다 `WARN SpringDocAppInitializer — SpringDoc /api/v1/openapi endpoint is enabled by default …`(사용자가 로그 메뉴에서 봄).
- **원인** 공개 API 문서는 일부러 켜 두었는데, springdoc 은 속성 `springdoc.api-docs.enabled` 를 적지 않으면 설정 객체의 값이 false 로 남고 그 값이 false 일 때 이 경고를 낸다
  (엔드포인트 자체는 기본으로 켜진다 — 라이브러리 바이트코드로 확인).
- **수정** 속성을 명시(`true`) — 엔드포인트는 그대로. **회귀** `OpenApiSnapshotIT.openApiDocsAreEnabledExplicitly_soStartupLogsNoSpringDocWarning`(수정 전 실패), 시험 컨텍스트 출력에 경고 없음.

## #38 adsb.lol 429 가 재배포 때마다 처음부터 되풀이됨
- **증상**(사용자가 준 로그) 관심 지역 1순위 adsb.lol 이 10–11 s 주기에서 5–7회 호출마다 429 를 돌려주고(`backing off 60 → 120 → 240 → 300 s`), 운영 화면의 공급자 전환이
  adsb_lol ↔ adsb_fi 로 수 분마다 바뀌었다. 24 h 실행 기록에서 adsb_lol 오류 144건.
- **원인** 429 이력(R-17: 되풀이되면 10 → 20 → 40 → 60분 뒤로 미룸)이 프로세스 메모리에만 있어, 재시작(이날 여러 번의 재배포)마다 60 s 단계로 돌아가 adsb.lol 을 곧바로 다시 불렀다.
  adsb.lol README 는 한도가 부하에 따라 달라진다고만 하고 수치를 밝히지 않는다(ADR-011 — 속도를 추정해 정하지 않는다).
- **수정** 429 이력을 Redis 에 남겨 재시작 뒤에도 이어 간다(논리 만료 + Redis TTL, 수집기 ACL 에 그 키의 EXPIRE 만 추가 — ADR-011). 단계 상한 5.
- **확인**([review/evidence/ops-followup-observation.txt](review/evidence/ops-followup-observation.txt)) 배포 뒤 35분: 429 가 01:13(쉼 60 s) · 01:15(120 s + 10분 미룸) · 01:27(240 s + 20분 미룸)로
  간격이 늘었고, 같은 30분에 관심 지역 수집은 adsb_fi 158회 · adsb_lol 15회로 끊기지 않았다. 이력은 Redis 에 TTL 과 함께 남았다(단계 3 · 미룸 1,200 s).
  미룸이 60분까지 늘면 adsb.lol 429 는 시간당 한 번 안팎이 된다(설계값으로 계산 — 그 뒤 구간은 관찰하지 않았다).

## #39 기상청 레이더가 5분 주기의 약 4분의 1에서 ReadTimeout — 어느 호출인지 모름
- **증상** 로그 `kma radar: ReadTimeout('')` 가 약 27주기 중 7회(24 h 실행 기록 오류 36 · 성공 253). 목록 · 바이너리 중 어느 호출인지, 얼마나 기다렸는지 없었다. 다음 주기가 따라잡아 프레임은 늦을 뿐 잃지 않았다.
- **수정** 실패 기록에 단계(목록 날짜 · 바이너리 tm)와 걸린 시간을 싣고, 일시 오류는 실패한 호출마다 같은 주기 안에서 5 s 뒤 한 번 다시 부른다(예산 1 추가). KMA 호출만 읽기 제한 15 s
  (전체 상한 40 s 그대로). 5 s · 15 s · 한 번은 고른 값이다(잰 값이 아니다 — ADR-011).
- **확인** 배포 뒤 30분 동안 목록 호출 시간 초과 1회(01:37:36, 15.1 s) → 5 s 뒤 다시 불러 01:37:42 에 프레임 저장(경고 없음). 30분에 프레임 6개로 5분 주기를 모두 채웠다.
  15 s 로도 시간 초과가 난다는 것은 공급자 쪽 정지가 길 때가 있다는 뜻이다 — 다시 부르기가 그 주기를 살렸다.

## #40 전체 시험에서 가끔 실패하던 ShipsIT(선박 diff 를 30 s 안에 못 받음)
- **증상** `ShipsIT.wsShipsLayer_snapshotThenDiffWithContiguousSseq` 가 호스트가 바쁜 전체 실행에서 가끔 `no 'ships_diff' message within PT30S`(2026-09-28 에는 20 s 창에서, 이날 레인 리뷰에서 4회 중 2회).
  혼자서 3회 · 통합 시험 묶음 2회는 모두 통과(7.6 s).
- **원인 찾기** 코드로 본 후보(미래 시각 거절 5분 · 60 s 전체 재동기 · 우편함 합치기 · 소비자 재시작)는 모두 해당하지 않았다. 시험은 스트림 소비와 10 s 팬아웃을 한 창(30 s)으로 기다려,
  어느 쪽이 늦었는지 실패 문구로 알 수 없었다 — 재현하지 못해 원인은 확정하지 않았다(부하 때 소비 지연으로 본다 — 추정).
- **수정(시험)** 두 번째 위치가 ShipStore 에 반영될 때까지 빈으로 먼저 기다리고, 그다음 diff 에 30 s 를 따로 준다. 시험 WS 클라이언트는 시간이 넘으면 그사이 받은 메시지 종류를 적는다.
  수정 뒤 전체 실행 통과(JUnit 696). 다시 실패하면 문구가 어느 단계인지 말해 준다.

## #41 운영 PIPELINE 의 빨간 "손실 1" — 실제로는 손실이 아니라 선박 스트림 보존 창이 1.66 h 로 짧아진 것
- **증상**(사용자 캡처) PIPELINE 탭 `● 1`. 0 이 아닌 값은 `ais.stream_budget_trims = 233`.
- **원인** 선박 스트림의 바이트 예산 16 MiB 가 10 s 배치(약 28 KB) × 보존 목표 2.5 h(900건 ≈ 25 MB)보다 작아, 첫 항목이 약 99분 전인 창(1.66 h)으로 잘렸다. api 는 실시간으로 읽고 있어
  읽기 전에 잘린 것은 없었다(`wakeline_stream_unread_trimmed{ships} 0` · `stream_messages_total{trimmed} 0`) — api 가 1.7 h 넘게 멈췄을 때만 되읽을 구간이 모자란다. 화면은 이 여유 부족을 "손실"로 셌다.
- **수정** 선박 예산 32 MiB(측정값으로 고른 값 — 약 26 % 여유). api 가 스트림마다 실제 보존 창(`stream_window_s` — 30 s 마다 XINFO STREAM 첫 항목으로)을 내고, PIPELINE 은 예산 트림을 손실에서
  빼고 "보존 창 N h / 목표 2.5 h"(예산 때문에 짧아짐 · 채우는 중)로 보인다(계약 v5 §G12). 수집기 재시작 뒤에도 재시작 전 항목을 예산에 넣는다(레인 리뷰가 찾은 구멍).
- **확인**([review/evidence/dashboard-kst-followup-observation.txt](review/evidence/dashboard-kst-followup-observation.txt)) 배포 뒤 50분: 선박 창 6,281 → 9,032 s(2.5 h 도달) · 예산 트림 0 ·
  선박 스트림 24.3 MB(예산 32 MiB) · Redis 전체 63.1 → 70.2 MB(maxmemory 256 MB). 격리 스택 PIPELINE 화면에서 새 행과 설명 확인.

## #42 adsb.lol 은 60분 미룸 뒤에도 약 1분 만에 다시 429
- **증상** 미룸 상한(60분)이 끝나 1순위로 돌아가면 1–2분 안에 429(KST: 11:29:34 복귀 → 11:30:33 429, 12:30:41 복귀 → 12:32:36 429). 정상 상태에서 시간당 한 번꼴 429.
- **수정** 되풀이된 429 의 미룸 단계를 10 → 20 → 40 → 60 → 120 → 240 → 360분(최대 6 h)으로 늘렸다(고른 값 — adsb.lol 은 한도 수치를 밝히지 않는다, ADR-011). 15분 조용하면 초기화는 그대로.
- **확인** 배포(재시작) 뒤에도 이력이 이어져 14:34:05 KST 복귀 → 14:35:26 KST 429 → `120분 뒤로 미룸`(단계 6, Redis TTL 7,011 s). 그동안 관심 지역 수집은 adsb_fi 가 맡는다.

## #43 AWC · RainViewer 일시 오류가 그 주기를 그대로 잃음
- **증상** `sigmet/awc failed: ReadTimeout — read 제한 8 s 초과 (aviationweather.gov)` 한 번 — 다음 주기(5분)까지 SIGMET 이 늦었다. 같은 날 KMA 에 넣은 "한 번 다시 부르기"는 주기를 살렸다(#39).
- **수정** 날씨 작업(METAR · TAF · SIGMET · RainViewer)도 일시 오류는 실패한 호출마다 5 s 뒤 한 번 다시 부른다(속도 상한 · 예산을 지나고, 정규 일정이 남은 하루에 쓸 몫은 건드리지 않는다 — 보내지 못한 시도는 예산을 돌려준다, ADR-011).
  HTTP 오류 · 속도 상한은 다시 부르지 않는다. **회귀** 수집기 시험(하루 모의: 연결 실패가 이어져도 예산 소진 없음).

## #44 기상청 레이더 프레임의 절반가량이 일부 지점만 합성된 이른 판 — 상황판에서 에코가 깜박임
- **증상** 저장된 KMA 프레임의 에코 셀 수가 이웃 프레임 사이에서 37,764 → 8,924 → 37,623 → 8,366 → 17,243 → 7,766 으로 오르내렸다(5분 간격 강수 면적으로는 있을 수 없는 변화).
- **원인** 저장한 원본(raw_ref)을 다시 해석하니 낮은 프레임은 헤더의 레이더 지점이 5 · 7 · 7 · 9 · 7곳(이웃은 12–15곳)이었다. 기상청은 합성을 일찍 내고 지점 자료가 들어오는 대로
  채운다 — tm 약 3.5분 뒤에 받은 판은 일부, 8분 넘어 받은 판은 거의 전부였다. 같은 tm(14:40 · 14:50 KST)을 약 17분 뒤 다시 받으니 7곳 → 15곳(8,587 → 42,275 셀) · 7곳 → 12곳(7,950 → 38,652 셀).
  수집기는 tm 마다 한 번만 받아 이른 판을 그대로 보였다([review/evidence/dashboard-kst-followup-observation.txt](review/evidence/dashboard-kst-followup-observation.txt)).
- **수정**(ADR-021) 프레임마다 헤더의 지점 수 · 목록과 기준(지난 60분 저장 프레임 중 최대, 지지 프레임 2개 이상)을 싣고, 기준보다 적으면 "일부 합성"으로 표시한다. 일부 합성 프레임은
  tm 뒤 30분까지 4분 간격으로 한 주기에 2개까지 다시 받아 지점이 늘었을 때만 바꾼다(정규 일정 몫의 예산은 남긴다). 화면은 `합성 N/M곳` 과 "일부 지점만 합성" 경고를 보이고, 완전하다고는
  말하지 않는다(기준 도달 = 최근 최대와 같음 — 기상청 합성이 완전한지는 자료에 없다). 60분 · 30분 · 4분 · 2개는 고른 값이다.
- **확인**([review/evidence/kma-partial-observation.txt](review/evidence/kma-partial-observation.txt)) 배포 뒤 40분: 새 프레임 7개 모두 `stations 15 / 15`, 화면 `합성 15/15곳`(툴팁에 지점 목록).
  이 창에서는 수집 주기가 tm 약 8분 뒤에 걸려 부분 합성이 없었고 다시 받기는 돌지 않았다 — 다시 받기 경로는 수집기 시험(선택 · 교체 · 예산 · 오류)으로 확인했고, 실제 동작은 heartbeat 의
  `radar_kr_partial` · `radar_kr_refetches` · `radar_kr_upgrades` 로 본다.

## 자동 검사 현황(2026-09-29 KST, 계약 v5 · 운영 화면 보강 · 상황판 KST · KMA 부분 합성 뒤)
| 층 | 도구 | 수 |
|---|---|---|
| collector · ais 단위·통합 | pytest | 1,054 통과(12 건너뜀 — 실 Redis 10건은 CI 와 아래 '버리는 컨테이너 시험'의 collector 실 Redis 로 따로 실행, 실 PostgreSQL 2건(test_db_pg_integration.py)은 손으로만 돌리는 선택 시험 — CI 는 돌리지 않는다) · 커버리지 97 % |
| api 단위·통합 | JUnit 5 + Testcontainers(PostGIS·Redis 실물) | 703 · JaCoCo LINE 96.3 % · BRANCH 84.9 %(하한 95 / 80) |
| web 단위 | Vitest | 788 · 커버리지(소스 전체) Lines 88.6 % · Branches 78.6 % |
| 언어 간 계약 | tools/contract_check.py | 스키마 사본 일치 + 실메시지·fixture + WS 표본(서버 27 · 클라이언트 15) + 가림 · 억제 벡터 |
| REST 계약 | tools/rest_contract_check.py | api 통합 시험이 기록한 응답 32종 |
| 인프라 정책 | infra/tests(unittest) | 118 |
| 버리는 컨테이너 시험 | edge · Redis ACL · db 권한 · 백업·복원 · 비밀번호 교체 · collector 실 Redis | 35 · 265 · 36 · 48 · 27 · 10 |
| E2E | Playwright(격리된 fixture 스택 8701, 작업자 1명) | 16 |
| 보안 게이트 | `make security`(gitleaks · Trivy 자체 이미지 3종 · 제3자 이미지) | PASS(db · k6 는 보고만) |
| 배포 뒤 실메시지 | WS 150 s · 세 세션을 `schemas/ws/server.v1.json` 으로 | 230건 · 14종, 형식 오류 0건(#32 · docs/review/evidence/v5-ws-live-check.txt) |
