# QA 2026-10 AWS — 신뢰성 · 데이터 손실(계획 §3.4)

- 영역키 `reliability` · 결함 번호 QA-1240–QA-1269 · 브랜치 `qa/aws-2026-10`(main `29d39e38` + QA 도구) · 2026-10-14 KST 03:59–05:26(UTC 10-13 18:59–20:26).
- **환경(모든 결함 공통)**: 스택 B = compose 프로젝트 `wlqa-b` · `http://localhost:8702` · 망 10.80.0 · fixture 모드(서버의 외부 호출 0) · 이미지 `wakeline-*:qa` ·
  `tools/qa/wlqa.sh B`(시험 env — 사용자의 `.env` 를 읽지 않는다) · 브라우저 없음(HTTP 직접). AWS 판과 다른 점: DB 가 RDS 가 아니라 컨테이너, 연결 풀은 표준(12/6/4 — AWS 는 6/3/2).
- 시각: 저장 · 로그는 UTC(`…Z`). `rel_fault.sh` 의 `run.log` 와 증거 폴더 이름(`<시나리오>-HHMMSS`)은 KST, 새 스크립트의 `run.log` 는 UTC(`…Z`).
- 증거: `docs/qa/2026-10-aws/evidence/reliability/`. 도구(이번에 더하거나 인자를 더함 — 기본값은 옛 동작 그대로):
  - 새로: `tools/qa/rel_qa_1240_partition_after_long_stop.sh`(QA-1240 라이브 재현) · `rel_qa_1241_ais_starts_before_redis.sh`(QA-1241 라이브 재현) ·
    `rel_weekend_stop_sim.sh`(평일 · 주말 정지 + 데몬 재시작 흉내) · `rel_ais_restart_redis_down.sh <A|B|N>`(Redis 장애 중 AIS 재시작) ·
    `rel_redelivery.py`(같은 메시지 재전달 멱등) · `rel_backup_restore_b.sh <default|full|aws>`(백업 → 새 볼륨 → 복원 · 권한 · 기동).
  - 인자 더함: `rel_fault.sh`(`WLQA_PROJECT=wlqa-b` · 시나리오 `ais-*` · `writers-stop-<초>` · `db-connfull-<초>` · `dbpaused-api-stop` · `dockerkill-<서비스>`) · `stream_db_integrity.py`(`--project wlqa-b` 허용) ·
    `db_snapshot.py` · `rel_concurrency.py`(`WLQA_PROJECT`) · `rel_frozen_db_reads.py`(`QA_PROJECT=wlqa-b`).

## 결함

| 번호 | 심각도 | 한 줄 | 재현 시험 |
|---|---|---|---|
| QA-1240 | 높음 | 3일 넘게 멈췄다 켤 때 DB 가 api 보다 늦게 준비되면(또는 연결이 꽉 차면) 오늘(UTC) 파티션을 6 h 동안 만들지 않아, 그동안 항적 · 선박 위치가 모두 버려지고 ACK 된다(영구 손실 · /healthz 는 ok) | `apps/api/src/test/java/dev/wakeline/qa/Qa1240PartitionEnsureNotRetriedAfterLateDbDbTest.java` · `tools/qa/rel_qa_1240_partition_after_long_stop.sh` |
| QA-1241 | 낮음 | ais 가 Redis 보다 먼저 일어나면(부팅 때 동시 기동 · Redis 장애 중 재시작) 이전 실행의 정지 공백을 이어받지 못해 수신 공백이 ingest_gap 에 남지 않는다 | `apps/collector/tests/qa/test_qa_1241_ais_restart_gap_lost_when_redis_is_late.py` · `tools/qa/rel_qa_1241_ais_starts_before_redis.sh` |

---

### QA-1240 · 높음 · 신뢰성 / 조건부 데이터 손실(평일 정지 · 연휴 · RDS 늦은 준비)
- **환경**: 스택 B(위) · 단위 시험은 Testcontainers PostGIS(`wakeline-db:local` — 운영과 같은 이미지).
- **재현 절차**:
  ```bash
  # 1) 결정적 재현 — 스프링 스케줄러를 흉내 내 MaintenanceJobs 의 고정 지연 예약 작업을 기동 뒤 5분 40초 동안 돌린다(DB 는 처음 40 s 동안 연결 거부)
  cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa1240PartitionEnsureNotRetriedAfterLateDbDbTest'
  # 2) 라이브(스택 B): 오늘(UTC) 파티션을 떼어 보관(긴 정지 흉내) → db 를 멈춘 채 api · collector · ais 기동(데몬 재시작) → 40 s 뒤 db 기동 → 150 s 관찰
  #    → 스트림 ↔ DB 대조 → 보관한 파티션을 다시 붙여 되돌린다. 행 손실이면 종료 1
  bash tools/qa/rel_qa_1240_partition_after_long_stop.sh docs/qa/2026-10-aws/evidence/reliability/qa-1240-live-<시각>
  ```
- **기대 결과**: DB 가 기동보다 늦게 답해도, 답한 뒤 몇 분 안에 오늘(UTC) 항적 · 선박 위치 파티션이 생겨 수집한 행이 저장된다(같은 기동 경로의 다른 DB 작업 —
  따라잡기 `catchUpTick` · 설정 미러 `StartupMirror.periodicMirror` · 공역 `AirspaceRefresher` — 은 1분 안에 다시 한다). 저장하지 못하면 /healthz 가 알린다.
- **실제 결과**:
  - 시험: `Expecting empty but was: ["track_point_20261013", "ship_position_20261013"]` — 실행된 예약 작업 `[+5s ensurePartitions (db down), +60s catchUpTick, … +300s catchUpTick]`,
    `ensurePartitions 주기 PT6H`(`evidence/reliability/qa-1240-gradle.txt`).
  - 라이브(`evidence/reliability/qa-1240-live-040956/`): 기동 5 s 뒤 `ensure track_point partitions failed: … CannotGetJdbcConnectionException`(19:10:19Z) ·
    `ensure ship_position partitions failed`(19:10:24Z). DB 가 19:10:41Z 에 돌아온 뒤에도 파티션을 만들지 않아 모든 배치가
    `ERROR: no partition of relation "track_point" found for row`(SQLState 23514) → `track batch (127 rows) failed permanently after 3 attempts, dropped`(첫 버림 19:11:50Z, 150 s 동안 19번).
    지표 `wakeline_track_rows_total{result="failed"} 2413` · `wakeline_ship_rows_total{result="failed"} 862` · `written` 0. 스트림 ↔ DB 대조:
    `"aircraft_rows_lost": 2159, "ship_windows_lost": 747` · `groups_not_drained {}`(PEL 비어 있음 — 이미 ACK, 다시 오지 않는다). 그동안 `/healthz` 는 `ok`
    (버린 행은 '밀림'이 아니라 writer_backlog 에 잡히지 않는다). 다음 시도는 기동 6 h 뒤.
  - 같은 실패는 다른 두 기동에서도 났다(파티션이 이미 있어 손실은 없었다): 데몬 재시작 흉내(`weekend-sim-050024/api-log.txt` — db 30 s 늦음, 20:00:52Z) ·
    연결 고갈 중 기동(`db-connfull-90-041930/api-log.txt` — 공유 RDS 가 꽉 찬 상태, SQLSTATE 53300, 19:20:08Z).
- **조건 · 영향**: 파티션 함수는 그날 −1 ~ +3일만 만든다. 평일 정지(약 15 h) · 주말(약 63 h)은 앞서 만든 +3일이 덮지만, 3일 넘게 멈춘 뒤(예: 금 18:00 → 화 08:50 KST
  연휴 87 h — 마지막 보장은 금 05:50 UTC 경 → 월(UTC)까지)에는 화 00:00 UTC(= 화 09:00 KST)부터 오늘 파티션이 없다. 그 첫 보장이 실패하면 다음 보장(기동 6 h 뒤,
  약 14:50 KST)까지 공개 데모의 모든 항적 · 선박 위치 · 재생 · 교통량 원본이 영구히 빈다. AWS 에서 기동 직후 DB 작업 실패는 실제로 있었다(VERIFICATION #138 —
  2026-10-10 `catch-up failed` · RDS 준비 전). 세 프로젝트가 같은 RDS(max_connections 78)를 08:50 에 함께 붙는 것도 같은 결과를 낸다(위 연결 고갈 실행).
- **의심 원인**:
  - `apps/api/src/main/java/dev/wakeline/history/MaintenanceJobs.java:98-108` — `@Scheduled(initialDelay = 5_000, fixedDelay = 6 * 3600_000)`, 실패는 WARN 만 남기고 6 h 뒤에야 다시 한다
    (같은 클래스의 따라잡기는 1분 틱 · 실패 뒤 1분부터 두 배 — `MaintenanceJobs.java:301-319`).
  - `apps/api/src/main/resources/db/migration/V2__partition_functions_security_definer.sql:15-16` · `V5__ships.sql:50-51` — 보장 범위 −1 ~ +3일.
  - `apps/api/src/main/java/dev/wakeline/platform/data/DbErrors.java:36-49` — 23(파티션 없음 포함)은 영구 오류 → `TrackWriter.java:345-357` · `ShipWriter.java:345-355` 가
    세 번 뒤 버리고 영수증을 놓아 ACK.
  - `apps/api/src/main/java/dev/wakeline/ingest/IngestHealthIndicator.java:82` — 상태는 밀림(writer_backlog)만 보고 영구 실패로 버린 행은 보지 않는다.
- **재현 시험 실패 글**: `java.lang.AssertionError: [DB 가 기동 40 s 뒤에 답한 뒤 5분 안에 오늘(UTC) 파티션이 있어야 한다 — 없으면 그동안 항적 · 선박 위치 행은 23514 로 버려진다.
  예약 작업 실행: [+5s ensurePartitions (db down), +60s catchUpTick, +120s catchUpTick, +180s catchUpTick, +240s catchUpTick, +300s catchUpTick] · ensurePartitions 주기 PT6H]
  Expecting empty but was: ["track_point_20261013", "ship_position_20261013"]`.
  라이브: `QA-1240 DEFECT: rows of today (UTC) were dropped while its partition was missing and the startup ensure was not retried`(종료 1).
- **심각도 근거**: 조건부(3일 넘는 정지 + 기동 순간 DB 를 못 씀) 영구 손실 — 표의 '높음(조건부 데이터 손실)'. 손실 범위가 최대 6 h · 모든 항적 · 선박이고, 상태 화면이 알리지 않는다.

### QA-1241 · 낮음 · 신뢰성 / AIS 수신 공백 기록(부팅 순서)
- **환경**: 스택 B · 단위 시험은 `tests/fakes.FakeRedis`(down 이면 모든 명령 ConnectionError) + 실제 ShipBook · ShardSet · AisSink(main._run 의 기동 순서 그대로).
- **재현 절차**:
  ```bash
  cd apps/collector && uv run --offline pytest tests/qa/test_qa_1241_ais_restart_gap_lost_when_redis_is_late.py -q
  # 라이브(스택 B): ais 정상 종료 → 60 s → redis 정지 → ais 기동 → 5 s 뒤 redis 기동 → 60 s 뒤 ingest_gap 확인(공백이 없으면 종료 1)
  bash tools/qa/rel_qa_1241_ais_starts_before_redis.sh
  CONTROL=1 bash tools/qa/rel_qa_1241_ais_starts_before_redis.sh   # 대조: redis 를 멈추지 않으면 공백이 남는다
  ```
- **기대 결과**: 정상 종료한 ais 는 상태 해시에 '멈춤'을 남기고, 다음 기동이 그 공백(마지막 수신 → 다시 받음, `ais process stopped`)을 ingest_gap 에 남긴다
  (대조 실행이 그렇다). 기동 순간 Redis 가 답하지 않아도 Redis 가 답한 뒤 같은 공백을 남긴다.
- **실제 결과**:
  - 라이브(`evidence/reliability/qa-1241-live-051225/run.log`): `WARNING ais.sink: previous ais status unavailable (ConnectionError) — no gap carried over` →
    `ingest_gap covering the 60s stop (from 2026-10-13T20:12:25Z): NONE`. 대조(`qa-1241-control-051451/`): `ais gap published: 2026-10-13T20:14:51.423Z → 20:15:53.550Z (ais process stopped)`.
  - 시험: 전제(Redis 가 먼저 준비)는 통과, 본 시험 `AssertionError: Redis 가 ais 기동 1 s 뒤에 답했을 뿐인데 밤새 정지(2027-01-15T08:01:00.000Z → 2027-01-15T23:00:00.000Z)의
    공백이 기록되지 않았다 — 발행된 ais_gap: []`(`evidence/reliability/qa-1241-pytest.txt`).
  - 그 구간의 선박 위치는 DB 에 없고(수신이 없었다) 공백 기록도 없어, 재생 · `/api/v1/ais/gaps` 에서 '자료 없음'이 아니라 '선박이 없었다'로 보인다.
- **의심 원인**: `apps/collector/wakeline_collector/ais/main.py:140` — 이전 상태를 기동 때 **한 번만** 읽는다. `apps/collector/wakeline_collector/ais/sink.py:425-431` —
  Redis 오류면 빈 dict 와 WARN 뒤 다시 읽지 않는다(공백 이어받기는 `ais/feed.py:103-113` · `ais/shards.py:146-151`). compose 의 `depends_on: redis healthy` 는
  `compose up` 때만 지켜지고, 부팅 때 dockerd 가 `unless-stopped` 컨테이너를 띄울 때는 지켜지지 않는다.
- **심각도 근거**: 위치 손실은 없고(받지 못한 구간) 공백 표시만 빠진다 · 기동 순간의 경합이 필요하다 — '낮음(표시 · 드문 조건)'. 로컬 부팅 흉내(`weekend-sim-050024`)에서는
  Redis 가 먼저 준비돼 공백이 남았다(`ais gap published: 20:00:22.690Z → 20:00:39.365Z`) — AWS 부팅(Redis AOF 적재 시간)에서 얼마나 자주 겹치는지는 미확인.
- 참고: 수집기 영역의 `evidence/collector/c5_ais_restart_during_redis_outage.*` 가 같은 코드 경로(Redis 장애 중 재시작)를 모의 실행으로 보였다. 장애 동안 모은 위치를 잃는 것은
  ADR-033 '남은 한계'에 적힌 설계(아래 '설계상 수용')이고, 이 결함은 그와 별개로 **정지 공백**(수신이 실제로 없던 구간)을 잃는 부분이다.

## 미확인(의심했지만 이 환경에서 확인하지 못함)
1. **AWS 백업(`--no-owner --no-privileges`)을 되살리는 절차**: 계획 §1.2 의 aws-deploy `rds/backup.sh` 옵션으로 스택 B 를 덤프해 이 저장소의 `tools/db-restore.sh` 로 새 볼륨에
   복원하면 모든 표 · 함수가 `postgres` 소유 · 권한 없음이 되어 api · collector 의 DB 읽기 · 쓰기가 모두 `permission denied`(api 500 · 운영 로그인 500 · 수집기
   `InsufficientPrivilegeError … dropped`)인데 `compose up --wait` 와 `/healthz` 는 정상이었다(`evidence/reliability/backup-restore-awsopts-050329/` — `grants-diff.txt` 86줄 ·
   `api-errors.txt`). aws-deploy 의 실제 백업 스크립트와 RDS 복원 절차(복원 뒤 권한 다시 주기 등)를 읽지 못해(이 세션의 aws-deploy 읽기가 막힘) 결함인지 정하지 못했다 —
   R(AWS 리허설) 점검과 맞춰 볼 것.
2. **부팅 때 Redis AOF 적재가 ais 기동보다 늦는 빈도(QA-1241 의 실제 빈도)**: 로컬 Redis 는 AOF 가 작아 1 s 안에 준비됐다.
3. **AWS `start-stack.sh` 의 migrate 순서**: 로컬 데몬 재시작 흉내에서는 `restart: "no"` 인 migrate 를 데몬이 띄우지 않고 나머지가 그대로 이어졌다(마이그레이션 변화 없음).
   aws-deploy 의 기동 스크립트가 RDS 준비 전에 migrate 를 부를 때의 동작은 읽지 못해 확인하지 못했다.
4. **EC2 정지 때 OS 종료의 실제 유예**: 로컬은 `docker stop`(api · collector 30 s · ais 20 s). EC2 의 systemd · dockerd 종료 시간 한도는 로컬로 확인할 수 없다(계획 §7).

## 개선 제안(결함 수에 넣지 않음)
1. **저장기의 영구 실패를 /healthz 에 알리기**: QA-1240 · 권한 없는 복원(미확인 1)에서 행이 계속 버려지는데 `/healthz` 는 `ok` 였다. 최근 N 분의 `result="failed"` 가
   늘면 `writer_failing` 같은 원인 코드를 더하면 운영자가 본다(HTTP 200 은 그대로).
2. **`tools/db-restore.sh` 가 소유자 · 권한이 없는 덤프를 알아보기**: `pg_restore --list` 에 ACL · OWNER 항목이 없으면 경고하거나 거절하면, 다른 방식으로 뜬 덤프를 넣고도
   '복원 끝 — make up' 으로 끝나는 일을 막는다.
3. **종료 중 DB 무응답이면 알림 기록이 버려진다(설계 확인)**: `dbpaused-api-stop-050921` 에서 `alert persist failed during shutdown, dropped`. OrderedWriter 의 설명대로
   알림 이벤트는 스트림 영수증에 묶이지 않아(영수증은 SIGMET 세트), 다시 처리(오래된 스냅샷은 항적만)로 되살아나지 않는다. 다음 기동이 열린 알림을 `restart` 로 닫으므로
   그 몇 초의 진입 · 이탈 기록만 빈다. 문서(OrderedWriter 머리 주석 · ADR)에 '알림은 종료 유예 안에 쓰지 못하면 잃는다'를 적어 두기를 제안한다.
4. **`tools/qa/rel_concurrency.py` 의 기대값이 §G45 이전 것**: 같은 값 설정 PUT 8건 → 200 ×8 · version 그대로 · 감사 0, 공급자 토글 8건 → 바뀐 것만 version · 감사(5건)
   — 계약 v5 §G45(같은 값은 바꾸지도 기록하지도 않음)대로다. 도구의 기대(200 ×1 · 409 ×7, version +8)를 고친다(제품 결함 아님 — 다른 값 동시 PUT 은 200 ×1 · 409 ×7 · 감사 1).

## 설계상 수용(앞선 결정과 같음 — 결함으로 올리지 않음)
- **Redis 장애 중 ais 재시작 → 장애 동안 모은 분당 위치 손실 · 그 구간 공백 기록 없음**: ADR-033 '남은 한계'. 라이브(`ais-redis-A-042507/minutes.txt`): redis 정지 19:27:08Z,
  ais 재시작 19:29:39Z, redis 시작 19:31:09Z → 분당 선박 행 19:27 = 10 · 19:28 = 0 · 19:29 = 90(평소 210–280), ingest_gap 0행. 재시작이 없으면(`ais-redis-N-043339`)
  같은 4분 장애에도 모든 분이 채워졌고(1,100 위치 다시 보냄), Redis 가 먼저 돌아오면(`ais-redis-B-044210`) 모은 685 위치를 보낸 뒤 재시작 공백 2.3 s 를 남겼다.
- **Redis kill -9 때 AOF everysec 로 최대 1 s 의 발행 손실**: `redis.conf` `appendfsync everysec`(설계). 대조 범위 안의 손실은 없었다(`redis-crash-042334`).

## 확인했고 문제없음(이번 세션 · 스택 B)
**쓰는 중 kill · 재시작 · 정지 — 스트림 ↔ DB 대조(`stream_db_integrity.py`, 창 = 장애 앞 60 s ~ 회복 뒤 25 s, 창 끝 이전 PEL 0 까지 기다림)**: 손실 · 중복 · 남은 PEL 0.
| 시나리오(증거 폴더) | 회복 | 대조한 항적 행 · 선박 창 · SIGMET id · AIS 공백 | 공개 API(표본 4 s) |
|---|---|---|---|
| api kill -9(`api-kill-035951`) | 14 s | 1,397 · 525 · 0 · 0 | 502 3표본(재기동 중) |
| api restart(`api-restart-040115`) · stop 30 s(`api-stop-30-040246`) | 21 s · 10 s | 1,524 · 546 · 132 / 1,778 · 622 | 같음, 재처리 0(QA-105 고침 확인) |
| collector kill -9(`collector-crash-040434`) · ais kill -9 · restart(`ais-crash-040542` · `ais-restart-040655`) | 1–5 s | 1,270–1,397 · 395–451, AIS 공백 1–2(기록됨) | 200 |
| api · collector · ais 함께 정상 종료 20 s(`writers-stop-20-040806`) | 19 s | 1,524 · 530 · 132 · 2 | 종료 유예 동안 edge 504(5 s) → 정지 중 502, 모두 Retry-After 10 |
| db pause 60 s(`db-pause-60-041416`) · db stop 40 s(`db-stop-40-050719`) | 8–9 s | 2,159 · 751 / 1,905 · 641 | 실시간 200, 이력 503 + Retry-After 10(최대 5.04 s) |
| db 를 멈춘 채 api 정상 종료(`dbpaused-api-stop-050921`) | 5 s | 1,778 · 600 · 132 | 종료 flush 못 쓴 127 · 27 행의 메시지가 PEL 에 남아 `re-processed 1 pending` — 손실 0 |
| DB 연결 고갈(일반 역할 몫 97 을 다 채운 채 api · collector 기동, 90 s — `db-connfull-90-041930`) | 4 s | 2,540 · 942 · 132 | 이력 503 + RA 10(≤ 6.4 s), `/healthz` 60 s 뒤 `degraded writer_backlog`, 수집기 `TooManyConnectionsError — writes queued` → 회복 뒤 실행 기록 빈 분 없음 |
| redis restart(AOF)(`redis-restart-042222`) · kill -9(`redis-crash-042334`) | 1–9 s | 1,270–1,397 · 425–506 | 200 |
| redis 를 멈춘 채 api 재기동 → 20 s 뒤 redis(`redisdown-api-restart-052808` — 부팅 순서의 api 쪽) | 5 s | 1,651 · 606 · 132 · 1 | 소비자는 `[SingleInstanceGuard] not ready` 로 읽지 않고 기다리다 Redis 뒤 부트스트랩(항공기 · 선박 · 수신 범위) — 손실 0 |
| `docker kill -s KILL` api · collector · ais · db(`dockerkill-*-05…`) — db 는 WAL 재생(`database system was not properly shut down; automatic recovery`) | 1–9 s(손으로 기동 뒤) | 1,270–1,524 · 471–516 | 같음. `docker kill` 은 Docker 가 '손으로 멈춤'으로 보아 `unless-stopped` 가 다시 띄우지 않는다(Docker 동작 — 컨테이너 안 프로세스의 kill -9 는 위 줄들처럼 다시 떴다. 메모리 한도 OOM 종료는 확인하지 않았다) |

**DB 무응답 중 공개 조회**(`db-frozen-reads-041326/frozen-db-reads.json` — db 45 s pause 직후 DB 를 읽는 공개 경로 8개 동시): 모두 503 + Retry-After 10, 1.1–5.1 s
(앞선 QA-104 의 30 s 504 는 다시 나지 않는다 — 고침 확인).

**평일 · 주말 정지 + 데몬 재시작 흉내**(`weekend-sim-050024/` — 7개 컨테이너를 한꺼번에 정지 → DB 에 '주말이 지난' 상태: KST 10-10('금요일' — 첫 순간의 UTC 파티션이 이미 보존 밖) 항적 240점 ·
교통량 완료 표식 지움, 10-12 14:00Z 한 시간 600점 · 1분 요약 지움, 보존 밖 10-08 파티션 → db 를 뺀 6개를 동시에 기동, db 는 30 s 뒤):
모든 컨테이너가 스스로 healthy(edge 만 1회 재시작 — 원인 로그는 뒤의 복원 시험이 컨테이너를 다시 만들어 남지 않았다), migrate 없이 이어짐(마이그레이션 변화 없음), 첫 따라잡기(20:01:42Z — 기동 1분 뒤, DB 는 그 전에 준비)가
10-10 교통량 24시간 행 + 표식 · 10-12 14:00Z 1분 요약 600행을 채움, 그 뒤 20:02:00Z 보존 삭제가 10-08 · 10-09 파티션을 지움(따라잡기 성공 뒤 — 순서 맞음),
새 항적 · 선박 · 실행 기록이 다시 쌓임, AIS 정지 공백 기록됨. (같은 실행에서 기동 5 s 뒤 파티션 보장이 실패했다 — QA-1240 의 전제.)

**같은 메시지 재전달 · 같은 요청 동시**(`redelivery-045056/redelivery.json` · `concurrency-050537/` · `concurrency-settings-changed-value.txt`): 특보 목록 ×3 → 자연키마다 한 행 ·
옛 빈 목록 늦게 → 아무것도 끝나지 않음, AIS 공백 ×3 → 한 행, 선박 위치 ×3 → 한 행, SIGMET 세트 재전달 → 행 수 그대로, region 엔트리 재전달 → (hex, ts) 마다 한 행,
열린 알림 (hex, 구역, 종류)마다 하나. 운영: 다른 값 설정 PUT 8건 동시 → 200 ×1 · 409 VERSION_MISMATCH ×7 · 감사 1, 해결 6건 생성 → 201 ×6 · 감사 6 · 같은 id 되돌림 6건 → 204 ×1 · 404 ×5,
같은 날 재집계 4건 → 200 ×4 · 완료 표식 계열마다 1행, 공급자 토글 8건 → 최종 상태 감사 = DB = Redis 미러.

**백업 → 복원**(`backup-restore-default-050218/` — README 절차를 `tools/db-backup.sh` · `tools/db-restore.sh` 로, compose 는 `wlqa.sh B`): 기본 백업 992 K · 항목 307 · 파일 0600 →
틀린 확인 문구 · 비어 있지 않은 DB 는 아무것도 바꾸지 않고 거절(rc 1) → 새 볼륨 → 복원(한 트랜잭션, 표 44 · V21) → 표 42개 행 수 · 지문 모두 같음(원해상도 파티션은 구조만 —
기본 백업 규칙), 시퀀스 · Flyway 같음 → 권한: 역할별 표 · SECURITY DEFINER 함수 권한 같음(다른 줄 24는 '소유자 권한만 있는 ACL ↔ 기본 ACL' 표기 차이 — 효과 같음) →
전체 기동: migrate 0건 · /healthz ok · `wx_warning` · `retained_track` · `airspace` · 특보 이력 · 알림 이력 · 통계 200 · 시험 운영자 로그인 200 · 운영 GET 200 · ERROR 0.
FULL=1(`backup-restore-full-052646/` — 1.7 M · 항목 319)도 원해상도 행까지 표 42개 · 시퀀스 · 권한이 모두 같고 기동 · 로그인 · 공개 조회가 정상이었다.
AWS 옵션 덤프는 '미확인 1'. (AWS 옵션 시험 뒤 기본 백업으로 다시 복원해 스택 B 를 되돌렸다 — `backup-restore-awsopts-050329/revert-restore.txt`. 마지막 상태는 FULL 복원본.)

## 앞선 QA 와 같음(다시 올리지 않음)
- QA-100 · QA-105(기동 · 종료 순서): kill · 정상 종료에서 손실 · 재처리 0 — 고친 상태 유지. QA-104(얼어붙은 DB 의 공개 조회 504): 다시 나지 않음.
- 2026-10 개선 제안 4(/healthz 의 DB 밀림): `writer_backlog` 로 들어왔다(연결 고갈 실행에서 확인). 참고로 QA-1240 라이브에서는 일시 오류(DB 정지) 동안 늘어난
  백오프(30 s)를 영구 오류 재시도가 이어받아 첫 배치의 세 번 시도에 60 s 가 걸렸다(19:10:50 → 19:11:50Z — 버리기까지의 시간일 뿐 손실 크기는 같다).
