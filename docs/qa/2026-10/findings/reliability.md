# QA 2026-10 — 신뢰성 · 데이터 무결성(계획 §3.4)

- 담당: 신뢰성 에이전트 · 결함 번호 QA-100 … QA-199 · 작업 트리 `qa-rel`(바탕 `a71b302b`)
- 환경(모든 결함 공통): **스택 B** compose 프로젝트 `wakeline-qa` · `http://localhost:8702` · 망 10.79.0 · fixture 모드(외부 호출 0 — 기상청 · 연안 교통량 작업은 꺼져 있다) ·
  이미지 `wakeline-*:local`(= `:qa-prod`, main `359a3eac` 운영 배포본) · 브라우저 없음(HTTP · WS 직접). 시각은 UTC(로그 그대로), 실행 기록의 `[hh:mm:ss]` 는 KST.
- 도구(이번에 더함, 모두 스택 B 전용 — 다른 포트 · 프로젝트를 막는다):
  `tools/qa/stream_db_integrity.py`(스트림 엔트리 ↔ DB 행 대조 — 항적 (hex, ts) · 선박 (mmsi, 60 s 창) · SIGMET id · AIS 공백 · 창 끝 이전 PEL, 결함이면 종료 1) ·
  `tools/qa/rel_fault.sh <시나리오>`(장애 하나 + 공개 API · /healthz 표본 + 무결성 대조) · `tools/qa/probe.py` · `tools/qa/endpoint_sweep.py`(공개 GET 25경로) ·
  `tools/qa/rel_concurrency.py` · `tools/qa/rel_restart_midtx.py` · `tools/qa/rel_db_lock_slow.py` · `tools/qa/rel_frozen_db_reads.py` · `tools/qa/db_snapshot.py` ·
  `tools/qa/qa_100_api_crash_ship_loss.sh`.
- 증거: `docs/qa/2026-10/evidence/reliability/<시나리오>-<KST 시각>/`(run.log · probe.jsonl · probe-summary.txt · api-log.txt · integrity.json).
  주의: 처음 두 api-kill 실행(`api-kill-022627` 의 probe)은 probe 의 Accept 헤더가 틀려 `/aircraft` · `/ships` 가 406 이었다(도구 결함 — 고친 뒤 실행부터 200).
  여러 실행의 `wakeline_ship_rows_total{result="dropped"} 237` 은 QA-100 재현(17:38)에서 센 같은 프로세스의 누적값이다(새로 버린 것이 아니다).

## 결함

| 번호 | 심각도 | 한 줄 | 재현 시험 |
|---|---|---|---|
| QA-100 | 높음 | api 비정상 종료 뒤 기동 때 스트림 소비자가 저장기 · 단일 인스턴스 가드보다 먼저 시작해, 그사이 처리한 선박 메시지의 행을 버리고 ACK — ship_position 영구 손실 | `apps/api/src/test/java/dev/wakeline/qa/Qa100ConsumerStartsBeforeWritersTest.java` · `tools/qa/qa_100_api_crash_ship_loss.sh` |
| QA-102 | 보통 | Redis 장애 중 운영 세션 쿠키(Path=/api)를 실은 모든 /api 요청이 500 + ERROR 스택(공개 경로 포함) — 로그인한 운영자의 상황판 REST 가 전부 실패 | `apps/api/src/test/java/dev/wakeline/qa/Qa102RedisDownSessionCookieIT.java` |
| QA-104 | 보통 | DB 서버가 답하지 않으면 공개 조회 문장 상한 3 s 가 지켜지지 않는다 — 읽기가 장애 내내 묶이고 edge 가 30 s 에 504(Retry-After 없음) | `apps/api/src/test/java/dev/wakeline/qa/Qa104FrozenDbPublicReadIT.java` · `tools/qa/rel_frozen_db_reads.py` |
| QA-101 | 낮음 | DB 장애 중 운영 요청의 503 에 Retry-After 가 없다(Redis 만 읽는 /ops/logs 도 503 — ADR-024 와 어긋남) | `apps/api/src/test/java/dev/wakeline/qa/Qa101OpsUnavailableRetryAfterTest.java` |
| QA-105 | 낮음 | 종료 마지막 ACK 가 저장기 flush 보다 먼저 나가 flush 한 메시지가 PEL 에 남고 다음 기동에서 다시 처리된다 | `apps/api/src/test/java/dev/wakeline/qa/Qa105FinalAckBeforeWriterFlushTest.java` |
| QA-103 | 낮음 | README '백업·복원' 이 "공급자 켜기/끄기는 Redis 에만 있어 다시 설정" 이라고 한다 — V11 부터 DB 원본이라 복원된다 | `apps/api/src/test/java/dev/wakeline/qa/Qa103ReadmeRestoreProviderSwitchTest.java` |

---

### QA-100 · 높음 · 신뢰성/데이터 손실(수집 → 저장)
- **환경**: 커밋 `a71b302b` · 스택 B · HTTP
- **재현 절차**(작업 트리 루트에서):
  ```bash
  # 1) 결정적 단위 재현(Spring 컨텍스트 — 운영과 같은 빈 클래스 · 생성자 주입)
  cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa100ConsumerStartsBeforeWritersTest'; cd -
  # 2) 스택 B: 인스턴스 임대가 막 갱신된 순간 api 를 kill -9 → 새 프로세스의 가드가 죽은 임대를 기다리는 동안 소비자는 이미 돈다
  bash tools/qa/qa_100_api_crash_ship_loss.sh            # 결함이면 종료 1
  HOLD_AFTER_S=0 bash tools/qa/qa_100_api_crash_ship_loss.sh   # 임대를 건드리지 않는 자연 조건(기동이 빠를 때만 재현)
  ```
- **기대 결과**: 스트림 소비자(phase MAX-10)는 저장기(TrackWriter · ShipWriter · OrderedWriter, MAX-200)와 SingleInstanceGuard(MAX-200 — 주석 "스트림 소비·임대
  작성보다 먼저 시작한다")가 시작한 **뒤**에 메시지를 읽는다. 재시작 사이에 쌓인 메시지는 모두 저장되고(at-least-once — 행이 커밋된 뒤에만 XACK) 손실이 없다.
- **실제 결과**:
  - 시험: 소비자 `start()` 순간 `{OrderedWriter=false, ShipWriter=false, SingleInstanceGuard=false, TrackWriter=false}` — 넷 모두 아직 멈춰 있다.
    그때 처리한 선박 메시지는 `dropped=1.0` 으로 행을 쓰지 않았는데 영수증이 풀려 `acked=true`(ACK 대기열로).
  - 스택 B 자연 재현(`evidence/reliability/api-kill-022627`): 17:26:42 kill -9 → 17:26:44 다시 뜸 → 소비자 부트스트랩 17:26:51.571, 가드가 임대를 잡은 것은
    17:26:55.038(죽은 프로세스의 임대 만료까지 기다림). 그사이 처리된 엔트리 `1790875607810-0`(51척)이 저장되지 않음: 새 프로세스
    `wakeline_ship_rows_total{result="dropped"} 51` · 스트림 ↔ DB 대조 `ship_windows_lost: 32`(17:26 창) · PEL 비어 있음(이미 ACK — 다시 오지 않는다).
  - 결정적 재현(`evidence/reliability/qa-100-023739/run.log`): `new process: wakeline_ship_rows_total dropped=237.0` · `ship windows lost (stream ↔ DB): 236`
    (예: `563195900 2026-10-01T17:37:00Z 1790876267809-0`). 같은 조건에서 항적은 잃지 않았다 — 같은 phase 안의 시작 순서(빈 등록 순서)에서 TrackWriter 가
    가드보다 앞서 시작했기 때문이고, ShipWriter 는 가드 뒤라 가드가 기다리는 만큼 창이 열린다(순서는 보장된 것이 아니다).
  - 같은 원인으로 R-79 의 두 번째 인스턴스 막기도 뚫린다: 가드가 시작하기 전에 소비자가 이름 `api-1` 로 읽고 ACK 한다(스크립트의 '임대 유지' 는 다른 인스턴스가
    살아 있는 상태와 같다 — 그동안 새 프로세스가 메시지를 가져가 버렸다). 실제 두 번째 api 컨테이너는 띄우지 않았다(미확인 1).
- **증거**: `evidence/reliability/api-kill-022627/{run.log,integrity.json,api-log.txt}` · `evidence/reliability/qa-100-023739/{run.log,integrity.json}` ·
  같은 조건이 아닌 실행(기동이 느려 임대가 먼저 풀림)은 재현되지 않았다: `api-kill-023121` · `api-kill-023239` · `qa-100-023506`(자연) · `qa-100-023625`(임대 20 s).
- **의심 원인**: `apps/api/src/main/java/dev/wakeline/ingest/StreamAckFinalizer.java:14,18` — phase `MAX-250`(가장 먼저 시작하는 무리)인 빈이 생성자로
  `StreamConsumer` 에 의존한다. Spring `DefaultLifecycleProcessor` 는 빈을 시작하기 전에 그 빈이 의존하는 빈을 phase 와 상관없이 먼저 시작하므로
  `StreamConsumer`(`StreamConsumer.java:248`, MAX-10)가 MAX-250 무리에서 시작된다. 저장기는 멈춘 동안 받은 행을 버리고 영수증을 잡지 않는다
  (`ShipWriter.java:226-232` · `TrackWriter.java:163-166` — 주석 "종료 중에는 소비가 먼저 멈추므로 실제로는 오지 않는다" 가 기동 때는 틀리다).
  가드(`SingleInstanceGuard.java:97-130 · 195`)는 죽은 임대(TTL 15 s)가 풀릴 때까지 최대 20 s 기다려 그 창을 넓힌다.
- **재현 시험**: `Qa100ConsumerStartsBeforeWritersTest` — 2건 실패:
  `Expecting map: {"OrderedWriter"=false, "ShipWriter"=false, "SingleInstanceGuard"=false, "TrackWriter"=false} to contain entries: ["ShipWriter"=true]` ·
  `[기동 중 처리한 선박 메시지가 행을 쓰지 않고(dropped=1.0) ACK 되었다(acked=true) — PEL 로 다시 오지 않는 영구 손실] Expecting value to be false but was true`.
  스택 점검: `tools/qa/qa_100_api_crash_ship_loss.sh` → `QA-100 DEFECT: ship rows dropped while the writer was not running`(종료 1).
- 심각도 근거: 조건부(비정상 종료 뒤 빠른 재기동 · 또는 두 번째 인스턴스) 영구 손실 — 표의 '높음(조건부 데이터 손실)'. 정상 종료 뒤 기동(가드가 바로 임대를 잡음)
  에서는 3번 모두 손실이 없었다(`api-stop-30-022920` · `api-stop-20-032835` · 백업 전 정지).

### QA-102 · 보통 · 신뢰성(Redis 장애) · 운영 세션
- **환경**: 커밋 `a71b302b` · 스택 B · HTTP(운영자 세션 쿠키 — `tools/qa/qa_session.py`)
- **재현 절차**:
  ```bash
  cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa102RedisDownSessionCookieIT'; cd -   # Testcontainers Redis 를 pause
  # 스택 B(손으로): qa-a 로 로그인한 쿠키로, redis 를 멈춘 뒤 공개 · 운영 GET
  docker stop wakeline-qa-redis-1; sleep 3
  # (qa_session 쿠키로) GET /api/v1/aircraft?bbox=124,33,132,39 · /api/v1/status · /api/v1/ops/settings · DELETE /api/v1/ops/session
  docker start wakeline-qa-redis-1
  ```
- **기대 결과**: Redis 장애는 계약 §2 대로 503 + Retry-After(로그인은 그렇게 답한다 — `anon login 503 retry-after=10`). 공개 조회는 쿠키가 있어도 메모리 · DB 로
  답한다(쿠키 없는 같은 요청은 200). ERROR 스택은 결함에만.
- **실제 결과**(`evidence/reliability/sweeps/ops-redis-down-cases.json`): 쿠키를 실은 `GET /api/v1/aircraft` **500** · `GET /api/v1/status` **500** ·
  운영 GET · PUT · 로그아웃 DELETE **500**(Retry-After 없음, code INTERNAL_SERVER_ERROR). 같은 순간 쿠키 없는 공개 25경로는 모두 200(`sweeps/public-redis-down.json`).
  pause(응답 없음)에서도 같다: `/api/v1/status` 500 · 15,060 ms, `/api/v1/ops/settings` 500 · 9,053 ms(`sweeps/ops-redis-paused-cases.json`).
  요청마다 Tomcat ERROR 3줄(`Servlet.service() … threw exception` · `Exception Processing ErrorPage`) + `RedisSystemException: Redis exception ← Currently not connected`.
  세션 쿠키는 `Path=/api` 라 로그인한 운영자의 브라우저는 상황판의 모든 REST 요청에 이 쿠키를 싣는다 — Redis 장애 동안 그 운영자만 상황판 REST(상태 · SIGMET · 이력)가
  모두 실패한다(익명 사용자는 정상). Redis 가 돌아오면 같은 쿠키로 다시 200(세션은 AOF 로 남는다 — `sweeps/ops-redis-back.json`).
- **증거**: 위 JSON 세 개 · api 로그(스택): `RedisSessionRepository.findById ← SessionRepositoryFilter$SessionRepositoryRequestWrapper.getSession ←
  dev.wakeline.ops.OpsSessionLifetimeFilter.doFilterInternal(OpsSessionLifetimeFilter.java:63)`(운영 경로) · 공개 경로는 `RateLimitFilter.doFilterInternal(RateLimitFilter.java:48)`
  뒤 보안 필터 사슬(`AnonymousAuthenticationFilter` → 지연 보안 컨텍스트)에서 같은 예외.
- **의심 원인**: 세션 저장소(Spring Session · Redis) 오류를 아무 곳도 503 으로 바꾸지 않는다 — 필터 단계 예외라 `ProblemAdvice` 에 닿지 않고 500 이 된다.
  `apps/api/src/main/java/dev/wakeline/ops/OpsSessionLifetimeFilter.java:63`(`req.getSession(false)`), `SecurityConfig.java:46`(`SESSION_COOKIE_PATH = "/api"` — 공개 경로에도 쿠키가 간다).
- **재현 시험**: `Qa102RedisDownSessionCookieIT` 실패:
  `{"/api/v1/ops/settings"="500 retry-after=-", "/api/v1/status"="500 retry-after=-"} … Expecting actual: "500 retry-after=-" to start with: "503 retry-after="`.

### QA-104 · 보통 · 신뢰성(느린 의존성 — DB 무응답) · 공개 조회 상한
- **환경**: 커밋 `a71b302b` · 스택 B · HTTP
- **재현 절차**:
  ```bash
  python3 tools/qa/rel_frozen_db_reads.py      # db 를 45 s pause 하고 그 직후 DB 읽는 공개 경로 8개를 동시에 — 10 s 넘거나 504 면 종료 1
  cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa104FrozenDbPublicReadIT'   # 문장이 서버에 간 뒤 PostGIS 시험 컨테이너를 15 s pause
  ```
- **기대 결과**: 공개 조회 문장 상한 3 s(R-62 · `Sql.PUBLIC_READ_TIMEOUT_S`) — 넘으면 503 + Retry-After, 공개 조회가 연결 · 허가를 오래 잡지 않는다
  (PublicReadGate 주석: "문장 상한(3 s)은 공개 조회 하나가 연결을 얼마나 오래 잡는지 묶는다").
- **실제 결과**(`evidence/reliability/db-frozen-reads/frozen-db-reads.json` · `api-log.txt`): 8건 중 7건은 1.1–5.2 s 에 503 + Retry-After 10(연결을 얻지 못함 —
  정상), 1건(`/api/v1/replay?…bbox=120,30,135,40`)은 이미 연결을 빌려 문장을 보낸 뒤라 **edge 가 30.0 s 에 504(Retry-After 없음)**, api 쪽은
  `statement cancelled (SQLSTATE 57014) … elapsed_ms=45078 statement=replay.track_point statement_limit_s=3` — DB 가 돌아온 45 s 뒤에야 끝났다. 그동안 공개 조회 허가 1개와
  공유 풀 연결 1개가 묶였다(6개가 묶이면 다른 공개 조회는 모두 1 s 뒤 503). 시험: `still waiting → failed QueryTimeoutException, 걸린 시간 15427 ms(pause 15000 ms)`.
  잠금으로 느린 DB(서버가 답함)에서는 상한이 지켜졌다(아래 '문제없음' — 3.0 s 에 503).
- **의심 원인**: 공유 풀(`apps/api/src/main/resources/application.yml:12-20` `spring.datasource.hikari`)에 pgjdbc `socketTimeout` 이 없다. 문장 상한은
  `withQueryTimeout(3)`(`Sql.java:33`)뿐인데, 그 취소는 서버에 새 연결로 보내는 요청이라 서버가 멈추면 닿지 않는다. 선택 조회 읽기 풀은 이 경우를 알고
  `ReadPool.java:45` `SOCKET_TIMEOUT_S = 3 + 2` 를 걸었지만 공개 REST 조회(`Sql.publicRead` → 공유 풀)는 그렇지 않다.
- **재현 시험**: `Qa104FrozenDbPublicReadIT` 실패: `[공개 조회(문장 상한 3 s)가 DB 가 멈춘 동안 끝나야 한다 — 결과: still waiting → failed QueryTimeoutException,
  걸린 시간 15427 ms(pause 15000 ms)] Expecting actual: 15427L to be less than: 6000L`. 스택 점검 `rel_frozen_db_reads.py` → `"over_limit": 1`(종료 1).

### QA-101 · 낮음 · 신뢰성(DB 장애) · 운영 API 계약
- **환경**: 커밋 `a71b302b` · 스택 B · HTTP(qa-a 세션)
- **재현 절차**:
  ```bash
  cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa101OpsUnavailableRetryAfterTest'; cd -
  # 스택 B: qa-a 로 로그인한 세션으로 docker stop wakeline-qa-db-1 동안 운영 GET 11경로 → docker start wakeline-qa-db-1
  ```
- **기대 결과**: 503 은 Retry-After 를 싣는다 — 계약 §2 기본 10 s(공개 503 은 모두 그렇다), §G14 는 `/ops/resolutions` 의 503 에 `Retry-After: 30` 을 약속한다.
  ADR-024 는 "로그 조회는 Redis 만 읽는 경로라 … DB 장애 중에도 된다(resolution_state: stale · unavailable)" 고 적는다.
- **실제 결과**(`evidence/reliability/sweeps/ops-db-down.json`): 운영 GET 11경로(`/ops/session` · `/ops/providers` · … · `/ops/logs` · `/ops/logs/groups`) 모두
  **503 UNAVAILABLE · Retry-After 없음** · 각 약 5 s. 같은 때 공개 503 은 모두 `Retry-After: 10`(`sweeps/public-db-down.json`). Redis 만 읽는 `/ops/logs` 도 503 —
  세션 자격 확인(R-95 후속)이 먼저 DB 를 읽어서다. ADR-017 S3 는 "다른 운영 요청은 여전히 503" 이라 적어 두 문서가 어긋난다(의도 판단은 사용자 몫 —
  Retry-After 누락은 어느 쪽이든 계약 위반).
- **의심 원인**: `apps/api/src/main/java/dev/wakeline/ops/OpsSessionLifetimeFilter.java:70` `ProblemJson.write(res, req, 503, "UNAVAILABLE", …)` — Retry-After 를 붙이지 않는다
  (`Problem.unavailable` 은 `UNAVAILABLE_RETRY_AFTER_S` 를 싣는다).
- **재현 시험**: `Qa101OpsUnavailableRetryAfterTest` 실패: `[/api/v1/ops/logs: 503 은 Retry-After 를 싣는다(계약 §2 — 공개 503 은 10)] Expecting actual not to be null`.

### QA-105 · 낮음 · 신뢰성(정상 종료) · 스트림 ACK
- **환경**: 커밋 `a71b302b` · 스택 B
- **재현 절차**:
  ```bash
  cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa105FinalAckBeforeWriterFlushTest'; cd -
  bash tools/qa/rel_fault.sh api-stop-30    # 정상 종료 → 기동 로그의 "re-processed N pending messages"
  ```
- **기대 결과**: StreamAckFinalizer(주석: "종료 순서는 … 항적·순서 큐 flush(MAX-200) → 이것(MAX-250). flush 가 커밋한 메시지의 영수증이 풀려 ACK 대기열에 들어간 뒤 한 번
  보낸다 — 그러지 않으면 정상 종료 때마다 마지막 몇 건이 PEL 에 남아 다음 기동에서 중복 처리된다")가 저장기 flush **뒤**에 ACK 한다.
- **실제 결과**: 시험 — 마지막 ACK(`StreamAckFinalizer.stop` → `flushAcksQuietly`) 순간 `["ShipWriter", "TrackWriter", "OrderedWriter"]` 가 아직 돌고 있다(종료 맨 앞에 나간다).
  스택 B — 정상 종료 뒤 기동에서 `re-processed 1 pending messages on wakeline:ships`(17:30:15 — `api-stop-30` 뒤, 18:15:40 — 백업 전 `docker stop` 뒤). 세 번째 정상 종료
  (`api-stop-20`, 18:28:52)는 종료 순간 남은 영수증이 없어 재처리가 없었다. 쓰기가 멱등이라 데이터는 틀리지 않는다(중복 처리 · 기동 지연뿐).
- **의심 원인**: QA-100 과 같다 — `StreamAckFinalizer.java:18`(생성자 의존) 때문에 Spring 이 소비자(MAX-10)를 멈추기 전에 그에 의존하는 Finalizer 를 먼저 멈춘다
  (`StreamAckFinalizer.java:23-25`).
- **재현 시험**: `Qa105FinalAckBeforeWriterFlushTest` 실패: `[마지막 ACK(StreamAckFinalizer.stop) 순간 아직 멈추지(종료 flush 하지) 않은 저장기 — 없어야 한다]
  Expecting empty but was: ["ShipWriter", "TrackWriter", "OrderedWriter"]`.

### QA-103 · 낮음 · 문서(백업 · 복원)
- **환경**: 커밋 `a71b302b` · 스택 B
- **재현 절차**: README `### 백업·복원(PostgreSQL)` 셋째 글머리(`README.md:150`)를 읽는다. 스택 B 절차는 '확인했고 문제없음 — 백업 → 복원' 의 명령 그대로
  (opensky 끄기 → `WAKELINE_PROJECT=wakeline-qa bash tools/db-backup.sh` → 새 볼륨에 `tools/db-restore.sh` → Redis 의 `wakeline:provider:opensky disabled` 지우기 → 기동).
  `cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa103ReadmeRestoreProviderSwitchTest'`
- **기대 결과**: README 가 실제 동작을 적는다 — 공급자 스위치는 DB `provider_switch`(V11, R-94)가 원본이라 백업에 들고 복원 뒤 기동 때 Redis 로 다시 미러된다.
- **실제 결과**: README 는 "운영 화면의 공급자 켜기/끄기는 Redis 에만 있어 다시 설정해야 합니다" — 스택 B 에서는 복원 뒤 `/ops/providers` 가
  `opensky disabled: True, version 11, redis_disabled '1', mirror_differs False`(지운 Redis 필드가 기동 때 되돌아옴 — `evidence/reliability/backup-restore/app-after-restore.txt`).
- **의심 원인**: R-94(provider_switch) 때 README 를 고치지 않았다(`README.md:150`).
- **재현 시험**: `Qa103ReadmeRestoreProviderSwitchTest` 실패: `[README '백업·복원' — 공급자 스위치는 DB(provider_switch)에 있어 백업 · 복원된다] Expecting actual: … not to contain "공급자 켜기/끄기는 Redis 에만 있어"`.

## 미확인(의심했지만 이 환경에서 재현하지 못함)
1. **두 번째 api 인스턴스(R-79)가 실제로 떠 있을 때의 손실**: QA-100 의 원인(소비자가 가드보다 먼저 시작)으로 두 번째 프로세스가 가드에 막히기 전 최대 20 s 동안 `api-1` 로
   읽고 ACK 할 것이다. '임대 유지' 로 같은 상태를 흉내 내 손실(236 창)을 봤지만, 실제 두 번째 api 컨테이너는 띄우지 않았다(compose 고정 IP · 브리프의 허용 명령 밖).
2. **기상청 프레임 목록 ↔ 영상 · meta(수집기 kill 중)** · **연안 교통량 격자 채우기 중 재시작**: fixture 모드에서는 두 작업이 꺼져 있다(키 없음 — `traffic_grid_state fixture`,
   `radar_kr: {}`). 쓰는 순서(영상 → meta → 목록 → 옛 영상 DEL)는 코드로 확인했고 단계별 Redis 실패 시험 `apps/collector/tests/test_kma_redis_failures.py` ·
   `test_traffic_grid_fill.py` 26건은 이 작업 트리에서 통과했다 — 스택 증거는 없다.
3. **WS 전체 상한 200 · 브라우저 오류 전체 상한 분당 120**: 한 호스트 IP 로는 IP 당 상한(5 · 10)이 먼저 걸려 닿지 않는다.
4. **같은 날 재집계가 5 s 넘게 줄 서는 경우(알려진 한계 #101)**: 스택 B 자료가 작아(하루 3행) 4건 동시도 0.21 s — 다시 재지 않았다.
5. **외부 공급자 느림 · 끊김(계획 §3.4 셋째 줄)**: 브리프의 점검 목록 밖이라 하지 않았다.

## 개선 제안(결함 수에 넣지 않음)
1. **기동 · 종료 순서를 의존이 뒤집지 못하게 가드**: QA-100 · QA-105 는 'phase 가 낮은 SmartLifecycle 이 phase 가 높은 SmartLifecycle 에 의존' 한 한 줄에서 나왔다.
   `ArchitectureTest` 처럼 컨텍스트를 띄워 "MAX-250 이 MAX-10 에 의존" 같은 역방향 의존을 막는 시험이 있으면 다시 생기지 않는다(Finalizer 는 `ObjectProvider` · 지연 조회로).
2. **Redis 장애 중 AIS 위치가 최신값으로 합쳐지고 공백 기록도 없다**(설계 — `apps/collector/wakeline_collector/ais/sink.py` 머리 주석 "선박 변경분은 쌓지 않고 … 복구 뒤 첫 발행이
   그때의 최신값"): redis 150 s pause 동안 분당 선박 행이 평소 244–284 에서 116 · 137 로 줄었고 `ingest_gap` 은 0행(`evidence/reliability/redis-pause-150-033109/ship-minutes.txt`).
   항적에 설명 없는 빈 곳이 생긴다(제품 규칙 '정직성'). 발행 공백을 ais_gap 처럼 기록하거나 MMSI 별 분당 첫 보고만이라도 모아 두는 것을 제안한다. ADR · README 에는 적혀 있지 않다.
3. **요청 제한기가 Redis 무응답마다 3 s 를 기다린다**: redis pause 동안 모든 공개 REST 가 3.05–3.1 s(`redis-pause-75-025208/probe-summary.txt` max_ms 3,076–3,104) —
   제한은 열린 채(가용성 우선) 지연만 더한다. 짧은 차단기(실패 뒤 N s 동안 Redis 를 건너뜀)를 두면 지연이 사라진다.
4. **/healthz 가 DB 장애 · 기록 지연을 말하지 않는다**(REL-20 설계 — 수집 경로만): db 60 s pause · 40 s stop 동안 내내 `ok`, 그동안 항적 큐 887 행 · 선박 큐 347 행이 쌓였다.
   `reasons` 에 `writer_backlog`(가장 오래된 미기록 행 나이) 같은 원인 코드를 더하면 운영자가 본다(HTTP 200 은 그대로).
5. **저장기 백오프 상한 30 s**: DB 가 돌아온 뒤 첫 쓰기까지 최대 30 s(`db-pause-60` — `retry in 30000 ms`, 17:44:33 → 17:45:03). 연결이 다시 되는지 짧게 확인하는 길을 두면 회복이 빨라진다.

## 확인했고 문제없음(이번 세션 · 스택 B 증거)
**장애 중 기록기 — 스트림 ↔ DB 대조(`stream_db_integrity.py`, 창 = 장애 앞 60 s ~ 회복 뒤 25 s, 창 끝 이전 PEL 0 까지 기다림)**: QA-100 의 두 실행 말고는 손실 · 중복 0.
| 시나리오 | 회복(헬스 ok + 새 스냅샷) | 대조한 항적 행 · 선박 창 · SIGMET id | 공개 API(표본 4 s) |
|---|---|---|---|
| api kill -9 ×3 · 잠금으로 막힌 배치 중 kill(`api-kill-blocked` — PEL 3 · 3건 재처리) | 5–20 s | 1,270–1,778 · 454–610 · 0–132, 손실 0(첫 실행만 QA-100) | 재기동 동안 502 2표본 |
| api 정상 종료 20 s · 30 s | 5–6 s | 1,651–1,777 · 556–598 | 같음 |
| db pause 10 · 30 · 60 s | 4–6 s(쓰기는 백오프로 ≤ 30 s 뒤) | 1,395–2,028 · 517–713 | 실시간 200, 이력 503 + Retry-After 10(≤ 5.3 s) |
| db stop 40 s | 2 s | 1,774 · 646 · 132 | 같음, 수집기 ingest_run 큐 → 복구 뒤 기록 |
| db 잠금(track_point ACCESS EXCLUSIVE 20 s, `db-lock-slow`) | — | 1,016 · 357 | 항적 · 재생 12건 모두 503 + RA 10, 1.0 s(허가 대기) · 3.0 s(문장 상한), /healthz · /aircraft 10 ms |
| redis pause 30 · 75 · 150 s · restart(AOF 0.4 s) · kill -9 | 0–10 s | 1,270–2,286 · 489–786 | 200(제한기 3 s 지연), /healthz 75 s 때 `consumer_stalled`(33 s 뒤) |
| collector restart · kill -9 · stop 150 s | 1–2 s | 1,397–1,775 · 440–1,121 | /healthz 120 s 뒤 `region_feed_lag`, 회복 뒤 ok |
| `tools/chaos.sh ais`(망 60 s 끊김, `WAKELINE_PROJECT=wakeline-qa`) | 다시 받음 1.7 s | 1,270 · 447 | fixture 재생이라 수신 공백 없음 → ingest_gap 0 은 맞다 |

**공개 API 503 + Retry-After 와 스스로 회복**(`evidence/reliability/sweeps/`): DB stop 중 공개 GET 25경로 — 메모리 경로 200, DB 경로 503 + Retry-After 10(5 s), `/aircraft/{hex}` ·
`/ships/{mmsi}` · `/ships/search` 는 200 + `meta.db_unavailable`, 500 0 · 회복 뒤 모두 200. Redis stop 중(쿠키 없음) 25경로 모두 200 · 로그인은 503 + RA 10 ·
세션은 Redis 재시작 뒤에도 유지. 끝난 SIGMET id 404 는 fixture 세트가 바뀐 것.

**동시성**(`rel_concurrency.py`, `evidence/reliability/concurrency*/`): 같은 If-Match 설정 저장 8건 → 200 ×1 · 409 VERSION_MISMATCH ×7(계약은 409 —
VERIFICATION 회귀 시나리오), 감사 1행, version 1 → 2 · 공급자 토글 8건 → 200 ×8, version 1 → 9 사슬이 끊김 없음, 마지막 감사 = DB = Redis 미러 · 해결 6건 생성 → 201 ×6 · 감사 6,
한 id 되돌림 6건 동시 → 204 ×1 · 404 ×5 · 감사 1 · 같은 날 재집계 4건 → 200 ×4 · 감사 4 · 완료 표식 계열마다 1행 · 로그인 실패(qa-b, 분마다 새 제한 창): 4건 동시 → 잠기지
않음 · failed_count 4, 5건 → 정확히 한 번 잠김(ACCOUNT_LOCKED 1) · 맞는 비밀번호도 401, 8건 → ACCOUNT_LOCKED 1 · WS 같은 IP 7개 → 5개 유지 · 2개 1013(두 번 — 닫힌 뒤 자리 반납도 확인)
· 브라우저 오류 30건 동시 → 204 ×10 · 429 ×20(Retry-After), 스트림에는 지문 억제로 1항목.

**작업 중 재시작**(`rel_restart_midtx.py`, `evidence/reliability/restart-midtx/`): audit_log 를 잠가 설정 PUT · 재집계 POST 가 '본 작업 뒤 감사 INSERT 에서 기다림'(잠금 대기 2)일 때
api kill -9 → 설정 version 2 · 값 600 · Redis 미러 600 · 그날 stats_daily md5 · 감사 행 수 모두 그대로(한 트랜잭션 확인), 14 s 뒤 회복. 수집기 주기 중 재시작 — 위 표.

**백업 → 복원**(`evidence/reliability/backup-restore/`): 쓰는 컨테이너를 멈추고 기본 백업(624 K · 항목 253) · FULL(2.0 M · 263) → 비어 있지 않은 DB 와 틀린 확인 문구는
아무것도 바꾸지 않고 거절 → `wakeline-qa` 프로젝트만 내림 · `wakeline-qa_db_data` 새 볼륨 · db 만 기동 → `tools/db-restore.sh` 한 트랜잭션(표 38 · V17) → 표 36개 모두 행 수 ·
md5 같음, 시퀀스 같음, 원해상도 파티션 10개는 구조만(기본 백업 규칙) → 전체 기동: migrate 0 · /healthz ok · qa-a 로그인 · 설정 10 · 감사 · 공급자 스위치 복원 · 이력 200.
복원 뒤 기록도 무결성 대조 통과(`db-lock-slow` 창).
