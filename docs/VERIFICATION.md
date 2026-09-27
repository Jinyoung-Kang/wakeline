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
- **수정** 429 는 지수 백오프(60→120→240→300 s)로 쉬고 그동안 adsb.fi(초당 1회 토큰 버킷)가 맡는다. 전환은 `skywx:events` 스트림과 운영 화면에 남는다.

## #11 공개 포트 충돌
- **증상** 8080 은 같은 Mac 의 SmartCollab 이 사용.
- **수정** 형제 프로젝트 compose 파일의 포트를 모두 조사해 8700 으로 변경, 127.0.0.1 바인딩.

## #13 collector 로그에 API 키 노출
- **증상** httpx 가 INFO 레벨로 요청 URL 전체(기상청 `authKey=` 쿼리 포함)를 기록.
- **수정** httpx/httpcore 로거를 WARNING 으로, 마스킹 규칙에 `authKey=` 추가(11패턴). 운영 화면 오류 원문도 같은 마스킹을 거친다.
- **회귀** `test_masking` 에 authKey 케이스 추가, 재기동 후 로그에 `authKey=` 0건.

## #14 기상청 API허브 레이더(FR-31)
- **관찰** 인증키는 유효하지만 API 별 "활용신청" 이 없으면 모든 엔드포인트가 403 JSON 을 돌려준다.
- **구현** 어댑터·잡·예산·원천 보관·`/api/v1/radar/kr`(메타)·`/latest.png`·화면 패널까지 준비하고, 승인 전에는 사유(403)를 상태로 노출. 격자·투영 정보는 실응답으로 확인하기 전까지 추정하지 않으므로 지도 오버레이는 보류(영상 그대로 표시).

## 자동 검사 현황
| 층 | 도구 | 수 |
|---|---|---|
| collector 단위·계약 | pytest | 50 |
| api 단위·계약 | JUnit 5 | 37 |
| web 단위 | Vitest | 13 (워커 일치 3 포함) |
| 언어 간 계약 | tools/contract_check.py | 4 payload 검사 |
| E2E | Playwright(fixture 모드) | 4 시나리오(`apps/web/e2e`) |

## #12 통계 화면 `/stats/traffic` 500
- **원인** `SELECT dim hour` — `hour` 는 PostgreSQL 예약어.
- **수정** 별칭 제거(화면은 `dim` 을 읽음). 운영 API `POST /ops/stats/aggregate?day=` 를 추가해 집계를 즉시 재실행(멱등·감사 기록)할 수 있게 했다.
- **회귀** 집계 후 `/stats/*` 3종 200, 화면에 FIR·hazard·시간대 막대 표시.
