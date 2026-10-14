# QA 2026-10 AWS — 영역 rehearsal(AWS 판 로컬 리허설 R — 데이터 · 설정) 결함 상세

대상: `main` 29d39e38 의 제품 코드(QA 이미지 `wakeline-*:qa`) + aws-deploy `31c2b97`(읽기만). 번호 범위 QA-1620–QA-1639.
범위는 계획 §1.4 R 중 **데이터 · 설정 다섯 가지만**: ① AWS 백업 방식 복원 ② RDS 인증서 검증(verify-full) ③ 공유 RDS 연결 수 여유 ④ 앞단 경로 차단(정상 동작만)
⑤ 앞단을 거친 보안 헤더. 우회 시도 · 대량 요청 · gate 시험은 하지 않았다. AWS 에는 접속하지 않았다(실제 공급자 호출 0 — fixture 모드, 외부 키 빈 값).

## 환경(2026-10-14 02:50–04:10Z, 이 Mac 의 Docker Desktop 4 CPU · 7.75 GiB)
| 프로젝트 | 무엇 | 구성 |
|---|---|---|
| `wlqa-rds` | RDS 흉내 | aws-deploy `rehearsal/compose.rds-emu.yml` + 덧붙임(세션 임시 폴더 `compose.rds.yml`): 이미지 `wakeline-db:qa`(PostgreSQL 18.6 + PostGIS 3.6.4), **max_connections 78**(superuser_reserved 3 → 일반 계정 75), TLS 강제(`hostnossl reject`), 비 superuser 마스터 `rdsmaster`(CREATEDB · CREATEROLE · rds_superuser 흉내), 서버 인증서 = **시험 CA A** 가 서명 · SAN `rds.wlqa.test`. 호스트 127.0.0.1:55432. 역할 · DB · PostGIS 는 aws-deploy **`rds/bootstrap.sh` 를 그대로**(읽기 전용 마운트) 실행 |
| `wlqa-aws` | wakeline AWS 판 | `infra/compose.yml` + `infra/compose.aws.yml` + `tools/qa/compose.qa-tag.yml`(WLQA_TAG=qa) + 덧붙임 `compose.aws-r.yml`(migrate · api · collector 에 `rds.wlqa.test → host-gateway` 와 CA 묶음 자리 `/etc/wakeline/rds-ca.pem` 만 바꿈). WAKELINE_PORT=18710 · 망 10.81.0 · fixture. env 는 `tools/qa/make_qa_env.py` + `RDS_HOST=rds.wlqa.test` · `RDS_PORT=55432` · `PUBLIC_ORIGIN=http://localhost:8103` |
| `wlqa-front` | 앞단 | aws-deploy `rehearsal/compose.edge.yml` + 덧붙임 `compose.front.yml`: Caddy 2.11.7(다이제스트 고정 그대로) · gate 는 새 태그 `portfolio-gate:wlqa`(aws-deploy `gate/` 에서 빌드) · 운영과 같은 메모리 상한(Caddy 128m · gate 96m) · `MACRO_DEMO_TOKEN` · **`PUBLIC_SCHEME=https`**(운영 값). 127.0.0.1:8101–8103 |

이미지: api `372eee42749e` · collector `8220ce595cdf` · web `1a0ec7158604` · edge `4c042b930c91` · db `a1b67035920c` · gate `9bdf32b7f7d3` · caddy `d8542f48d34a`.
시험 비밀값(DB · Redis · 마스터 · 다른 두 프로젝트 · ORIGIN_SECRET · GATE_SECRET · 접근 코드 · 운영자)은 `tools/qa/rehearsal/setup.py` 가 세션 임시 폴더에 새로 만들었다(0600, 출력 · 기록 안 함 — 증거 폴더와 스크립트에 값이 없음을 검사했다).
흉내와 RDS 의 알려진 차이: 확장 소유자(흉내는 `postgres` — 복원 시험에서만 RDS 쪽인 '마스터'로 맞춤, 아래 QA-1620), `spatial_ref_sys` 소유자(흉내는 `postgres` — RDS 값 모름), RDS 내부 예약 연결(rdsadmin 등 — 모름).

## 결과 요약
| # | 확인할 것 | 결과 |
|---|---|---|
| 1 | AWS 백업 방식 복원 | **결함 2건** — QA-1620(높음) 권한 · 소유자가 사라져 wakeline 이 정상으로 뜨지 않음, QA-1621(보통) README 의 복원 옵션이면 0행 복원 뒤 빈 DB 로 정상처럼 뜸. 덤프 자체는 온전(표 40 · 37,746행 일치). 고치는 절차 두 가지를 실제로 돌려 확인(아래 '복원 절차에 더할 것') |
| 2 | RDS 인증서 검증 | 정상 — migrate · api · collector 모두 시험 CA A + 맞는 이름은 붙고, 시험 CA B · 저장소의 실제 AWS 묶음 · 틀린 이름(host.docker.internal)은 거절(12경우 모두 기대대로) |
| 3 | 연결 수 여유 | 정상 — 더미 14 + 배포(전부 다시 만들기) 중 wakeline 최대 동시 7(api 6 · collector 1) + migrate 1, 전체 22/75. 남은 자리를 모두 빼앗으면 DB 읽기 503 + `Retry-After: 10`(500 아님), 풀면 5 s 안에 스스로 회복. 배포 · 기동 중 300 s 넘게 모자라면 api 가 스스로 뜨지 않음(개선 제안 1) |
| 4 | 앞단 경로 차단 | 정상 — 잠금 해제 쿠키가 있어도 `/ops` · `/ops/` · `/ops/settings` · `/logs` · `/logs/abc` · `/api/v1/ops` · `/api/v1/ops/session`(GET · POST) · `/api/v1/ops/providers` 는 Caddy 의 404(앱까지 가지 않음), 공개 12경로는 200 |
| 5 | 앞단 응답 헤더 | 정상 — HSTS · CSP · X-Frame-Options · nosniff · Referrer-Policy · X-Robots-Tag · Permissions-Policy · COOP 가 모두 한 번씩, `Server` 없음, 화면 CSP 에 `frame-ancestors 'none'` |

---

## QA-1620 (높음) — AWS 백업(backup.sh)으로 받은 wakeline 덤프를 새 RDS 에 복원하면 소유자 · 권한이 사라져 wakeline 이 정상으로 뜨지 않는다 · aws-deploy(공유) + wakeline
- 환경: R(위 표). 덤프는 aws-deploy `rds/backup.sh` 를 **그대로** 실행해 받았다(`pg_dump … -Fc --no-owner --no-privileges`, 마스터 계정, `sslmode=require`). 복원 대상은 `wlqa-rds` 를 `down -v` 로 지우고 다시 띄운 뒤 `rds/bootstrap.sh` 를 그대로 돌린 **새** RDS 흉내.
- 재현 절차:
  - 처음부터 한 번에: `cd /Users/jinyoung/Projects/wakeline && python3 -B tools/qa/rehearsal/setup.py && tools/qa/rehearsal/qa_1620_1621_aws_restore.sh` → 지금 **종료 코드 1**(약 12분).
    2026-10-14 03:49–04:01Z 실행: owner rc 1(DB 읽기 500 · 로그인 500) · master rc 1(migrate 실패) · readme rc 1(0행 → 빈 스키마로 기동) · 대조 keepacl · aclfix rc 0 — `evidence/rehearsal/qa-1620-repro/repro.log`.
    아래 수치는 앞선 단계별 실행(03:32–03:43Z, 원본 37,746행 — `evidence/rehearsal/restore/`)의 것이고, 처음부터 실행(원본 3,463행)도 같은 결과였다.
  - 단계별: `tools/qa/rehearsal/backup_restore.sh backup <폴더>`(원본의 쓰는 컨테이너를 멈추고 행 수 · 권한을 적은 뒤 backup.sh) → `backup_restore.sh restore owner|master <폴더>/<방식>`.
  - owner = README '데이터 이전'의 복원 줄(README.md:169 — BuildRisk 용)을 wakeline 에 맞춘 것: 소유 역할 `wakeline_migrator` 로 `pg_restore --no-owner --no-privileges -j 2`(`--exit-on-error` 를 빼야 끝까지 간다 — 넣으면 QA-1621). master = backup.sh 와 같은 마스터 계정으로 같은 옵션.
- 기대: 복원 뒤 `docker compose … up --wait` 만으로 원본과 같은 소유자(`wakeline_migrator`) · 권한(api · collector 표 권한, 파티션 함수 EXECUTE 는 api 만)이 살아 있고, api · collector 가 읽고 쓴다(원본에서 같은 probe 통과 — `evidence/rehearsal/03-source-probe.json`).
- 실제(행은 모두 들어온다 — 표 40 · 37,746행 · 인덱스 89 · 제약 396 일치. 사라지는 것은 소유자와 권한):
  - **owner(소유 역할로 복원)** — 표 · 함수 소유자는 맞지만 GRANT 46항목이 모두 없다(`restore/owner/acl-diff.txt` 86줄). `up` rc 0 · 모든 컨테이너 healthy · `/healthz` 200 `ok` 인데
    - DB 를 읽는 공개 경로 500(`/api/v1/warnings/history` · `/alerts/history` · `/stats/traffic`, 원인 `permission denied for table wx_warning · stats_daily …`), 운영 로그인 500(`ops_user`).
    - **쓰기가 버려진다**: collector `ingest_run(region) rejected (InsufficientPrivilegeError: permission denied for table ingest_run) — dropped`(60 s 사이 권한 오류 32줄), api 의 track_point · ship_position 이 60 s 동안 한 줄도 늘지 않음(22,479 → 22,479).
    - 파티션 함수 4개는 SECURITY DEFINER · 소유자 `wakeline_migrator` 는 남지만 `REVOKE EXECUTE … FROM PUBLIC` 이 사라져(proacl NULL = PUBLIC 실행) **`wakeline_collector` 도 `track_point_drop_old` · `ship_position_drop_old` 를 소유자 권한으로 실행할 수 있다**(`has_function_privilege` = true — 최소 권한 V2 · V5 가 깨짐).
  - **master(backup.sh 와 같은 계정으로 복원)** — 모든 표 · 함수 소유자가 `rdsmaster`. migrate 가 `ERROR: permission denied for table flyway_schema_history` 로 실패(rc 1) → `up` rc 1, api · collector · edge 는 `Created` 로 남아 **wakeline 전체가 뜨지 않는다**(`restore/master/aws-ps.txt`). 파티션 함수는 SECURITY DEFINER 인 채 소유자가 마스터(rds_superuser 구성원 · CREATEROLE · CREATEDB) + PUBLIC 실행.
  - 덤프 목차: ACL 항목 0개(같은 pg_dump 에서 두 옵션만 빼면 46개 — `restore/dump-toc.txt`).
- 원인:
  - aws-deploy `rds/backup.sh:18-19` 가 세 DB 모두 `--no-owner --no-privileges` 로 받는다 → wakeline 의 소유자 · GRANT · 함수 EXECUTE 제한 · (V9 의 기본 권한 회수)가 덤프에 없다.
  - wakeline 은 권한을 **마이그레이션 때 한 번만** 준다(`V1__init.sql:160-171` · `V2__partition_functions_security_definer.sql:6-7` · `V5__ships.sql:77-78,100-104` · `V8` · `V11` · `V13–V21` 의 GRANT). 복원본에는 `flyway_schema_history` 가 같이 들어와 migrate 는 "up to date" — 다시 주는 길이 없다(Flyway afterMigrate 콜백 · R__ 반복 마이그레이션 없음. BuildRisk 는 afterMigrate 로 런타임 계정 권한을 매번 다시 준다 — aws-deploy `rds/bootstrap.sql:20-21` 주석의 ADR-014).
  - wakeline 복원 절차가 어디에도 없다: aws-deploy README '데이터 이전'(README.md:161-170)은 "Wakeline 은 새로 시작"이고 복원 줄은 Macro · BuildRisk 뿐, '마무리'는 backup.sh 뒤 RDS 를 지우고 "최종 스냅샷을 만들 필요는 없습니다(덤프가 있음)"(README.md:259-260) — 정리 뒤에는 이 덤프가 유일한 사본이다. wakeline ADR-039 · README '백업·복원'은 로컬(`make backup/restore` — 소유자 · 권한을 담는다)만 다룬다.
- 영향 · 심각도: 데이터는 덤프에 온전하다(영구 손실 아님). 그러나 이 덤프로 되살린 wakeline 은 ⓐ 뜨지 않거나(master) ⓑ 정상(healthy · `/healthz ok`)처럼 보이면서 DB 읽기 500 · 새로 수집한 자료를 버린다(owner) — 저절로 회복되지 않는 장애 + 그동안의 수집 자료 손실 → 기준상 **높음**.
  (드문 작업 · 손으로 권한을 다시 주면 살릴 수 있어 '보통' 의견도 가능 — 검증자 판단에 맡긴다.) 같은 문제를 신뢰성 영역이 로컬 복원(`make restore`)으로 '미확인 1'로 남겼다(`findings/reliability.md` 미확인 1) — 이 결함이 그 확인이다.
- 의심 원인 파일:줄 — aws-deploy `rds/backup.sh:18-19` · aws-deploy `README.md:161-170, 259-260` · wakeline `apps/api/src/main/resources/db/migration/V1__init.sql:160-171`(권한이 마이그레이션 안에만).
- 고치기: aws-deploy(공유)는 보고만 — 고치기는 사용자 결정. 아래 '복원 절차에 더할 것' 의 ①·② 는 실제로 돌려 원본과 권한 구조가 같고 probe 가 통과함을 확인했다.

## QA-1621 (보통) — README 의 복원 옵션(`--exit-on-error`)으로 wakeline 덤프를 복원하면 첫 항목에서 멈춰 0행인데, 이어서 띄우면 빈 DB 로 정상처럼 뜬다 · aws-deploy(공유)
- 환경: QA-1620 과 같다(같은 덤프 · 새 RDS 흉내 · bootstrap.sh).
- 재현 절차: `tools/qa/rehearsal/backup_restore.sh restore readme <폴더>/readme` — README.md:169 의 옵션 그대로(`--no-owner --no-privileges --exit-on-error -j 2`), 계정만 wakeline DB 의 소유 역할. 처음부터는 `qa_1620_1621_aws_restore.sh`(종료 코드 1).
- 기대: 복원이 되거나, 안 되면 운영자가 알아챌 수 있게 실패(빈 DB 로 정상처럼 뜨지 않음).
- 실제: `pg_restore: error: could not execute query: ERROR: must be owner of extension postgis — Command was: COMMENT ON EXTENSION postgis IS …` 에서 rc 1 로 멈추고 **표 0개 · 0행**(원본 40표 · 37,746행). 이어서 README 순서대로 `up --wait` 하면 migrate 가 빈 DB 에 V1–V21 을 새로 적용(`migrations applied: 21`)해 rc 0 · 모든 컨테이너 healthy · 공개 읽기 9경로 200 · 수집 쓰기 정상. 백업 자료(알림 · 통계 · 감사 · 운영자 · 30일 요약 …)만 없고, 눈에 띄는 증상은 운영 로그인 401(계정 없음)뿐이다(`restore/readme/run.log` · `probe.json`).
- 원인: backup.sh 덤프에 postgis 확장 항목(`EXTENSION - postgis` · `COMMENT - EXTENSION postgis` · `TABLE DATA public spatial_ref_sys`)이 들어 있다(`restore/dump-toc.txt`). RDS 에서 확장은 bootstrap.sql:51 이 마스터로 만들어 소유자가 마스터 — wakeline_migrator(또는 다른 비소유자)가 복원하면 `COMMENT ON EXTENSION` 이 거절되고, `--exit-on-error` 는 사전 데이터의 둘째 항목에서 멈춘다(표를 만들기 전). 이 오류는 흉내 보정과 무관하다(소유자가 마스터든 postgres 든 migrator 가 아님). BuildRisk 는 덤프에서 확장을 뺀다(README.md:164 'ADR-031').
- 영향: 운영자가 rc 1 을 놓치면(README 순서는 복원 → 기동) 백업이 복원된 줄 알고 빈 DB 로 운영하게 된다. 덤프는 남아 있어 영구 손실은 아니다 → 보통.
- 의심 원인 파일:줄 — aws-deploy `rds/backup.sh:18-19`(확장 제외 옵션 없음) · `README.md:169`(확장을 포함한 덤프에 쓸 수 없는 옵션 조합) · `rds/bootstrap.sql:51`.

## 복원 절차에 더할 것(둘 다 실제로 돌려 확인 — 원본과 행 수 · 소유자/권한/SECURITY DEFINER 구조 같음, probe 통과)
`evidence/rehearsal/restore/keepacl/` · `restore/aclfix/` (권한 구조 비교는 'NULL 권한 = 소유자만' 으로 맞춰서 — `app_probe.py acl-diff`, pg_dump 는 기본값과 같은 권한을 적지 않는다).
- **① 앞으로 받을 덤프(backup.sh 를 고칠 때)**: wakeline 은 `--no-owner --no-privileges` 를 빼고 `--exclude-extension=postgis`(pg_dump 17+, 이미지의 pg_dump 18 에 있음)를 더해 받는다 → 새 RDS 에 bootstrap.sh 뒤 **마스터로** `pg_restore -d "host=… dbname=wakeline user=<마스터> sslmode=require" --exit-on-error --single-transaction <덤프>` → `up`.
  확인은 같은 pg_dump 에서 두 옵션만 뺀 덤프에서 확장 세 항목을 `-L` 목록으로 빼고 복원했다(--exclude-extension 과 같은 목록). 역할 이름이 같아(bootstrap.sql = 01-roles.sh) 로컬 `make restore` 에도 그대로 들어간다.
- **② 이미 받은 backup.sh 덤프**: (a) 확장 세 항목을 뺀 목록(`pg_restore -l 덤프 | grep -v -E ' EXTENSION - postgis | COMMENT - EXTENSION postgis | TABLE DATA public spatial_ref_sys '`)으로
  `wakeline_migrator` 가 `--no-owner --no-privileges --exit-on-error --single-transaction -L 목록` 복원(소유자 = migrator) → (b) 마스터로 빈 참조 DB(`CREATE DATABASE wakeline_aclref OWNER wakeline_migrator` + bootstrap.sql 의 확장 · 스키마 권한 줄)를 만들고 같은 판 migrate(`DB_NAME=wakeline_aclref`)
  → `pg_dump -s -Fc` 의 ACL 항목 46개만(`pg_restore -l | grep ' ACL '`) wakeline_migrator 로 `pg_restore -L` → 참조 DB 삭제 → `up`. 스크립트: `backup_restore.sh restore aclfix`.
- (제안 — 돌려 보지 않음) wakeline 이 권한을 Flyway `afterMigrate` 콜백으로 매번 멱등하게 다시 주면(BuildRisk 방식), 소유 역할로 복원한 뒤 `up`(migrate) 한 번으로 권한이 돌아온다 — 제품 동작 변경이라 고치기 전에 묻는다.

---

## 확인한 것(결함 아님)
### 2. RDS 인증서 검증(verify-full) — `tools/qa/rehearsal/tls_verify.sh`(증거 `evidence/rehearsal/tls/`)
| 대상 | CA A + `rds.wlqa.test` | 시험 CA B | 실제 AWS 묶음(`infra/rds/global-bundle.pem`) | CA A + 틀린 이름 `host.docker.internal` |
|---|---|---|---|---|
| migrate | 붙음(`Schema "public" is up to date`, 7 s) | 거절 `PKIX path building failed …` | 거절(같은 글) | 거절 `The hostname host.docker.internal could not be verified` |
| api | 붙음(TLSv1.3 연결 6) | 거절 — DB 읽기 503(`could not get a DB connection (SQLSTATE 08006) ← SunCertPathBuilderException`) | (migrate 와 같은 설정 — 생략) | 거절(`Server name validation failed`) |
| collector | 붙음(TLSv1.3 연결 1) | 거절 `db: connect failed (SSLCertVerificationError) — live path continues, writes queued` | (생략) | 거절(같은 글) |
- 처음 기동(02:51Z)도 verify-full + CA A 로 21개 마이그레이션 · api 6 · collector 1 연결이 모두 TLSv1.3(`pg_stat_ssl`).
- 관찰: DB 에 못 붙어도 api · collector 컨테이너는 healthy, `/healthz` 200(`degraded: writer_backlog`) — 실시간 경로를 DB 와 떼어 둔 설계(ADR-017). 이름 불일치 때 pgjdbc 가 연결 시도마다 ERROR 한 줄(75 s 에 67줄)을 남긴다 → 개선 제안 3.
- migrate 의 Flyway `connectRetries(10)` 은 1 · 2 · 4 · … · 64 · 120 · 120 · 120 s 간격 — 거절이 확정되기까지 약 8분(`tls-migrate-bad-*.log`).

### 3. 연결 수 여유 — `tools/qa/rehearsal/conn_budget.sh`(증거 `evidence/rehearsal/conn/`, 1 s 표본 `conn_sampler.sh`)
- **배포 흉내**(더미 14 = macro 7 · buildrisk 7, TLS): `up -d --force-recreate --wait` rc 0(34 s). 계정별 최대 동시: api 6 · collector 1 · migrate 1(api 를 내린 뒤 돌아 겹치지 않음) → 전체 22/75(`deploy-conn-peak.txt`).
  설정상 최대는 api 6 + 선택 조회 풀 2(최소 0 — 이번 시험에서는 열리지 않음) + 수신 범위 부트스트랩 1(기동 30 s 뒤 잠깐) + collector 3 + migrate 1 = 13 → 다른 두 프로젝트 14 와 합쳐 27/75. 1 s 표본이라 잠깐 열리는 연결은 놓칠 수 있다.
- **운영 중 고갈**(남은 자리를 더미가 모두 쥐고 놓인 자리도 0.2 s 마다 가져감 = 연결을 새는 다른 프로젝트): 이미 뜬 api 는 풀(6)을 쥐고 있어 영향 없음. api 를 재시작하면 연결을 못 얻어 DB 읽기 3경로가 **503 + `Retry-After: 10`**(`could not get a DB connection (SQLSTATE 53300)` WARN 한 줄, 스택 없음), 기록기는 `retry in 30000 ms (queue …)`, `/healthz` 200 · 컨테이너 healthy.
  자리를 풀자 **5 s 안에 스스로 회복**(`runtime-probe.txt`). (빼앗지 않는 더미로는 api 가 재시작하며 놓은 6자리를 바로 되찾아 영향이 없었다 — `runtime-nongreedy*`.)
- **기동 중 고갈 90 s**(wakeline 정지 → 고갈 → start-stack.sh 처럼 `up -d --wait --wait-timeout 300` → 90 s 뒤 풀기): migrate 가 `remaining connection slots are reserved for roles with the SUPERUSER attribute` 로 1 · 2 · 4 · … · 64 s 재시도하다 다음 시도에 성공 → rc 0, 2분 31초 만에 정상(`boot.log`).
- **기동 중 고갈 300 s 넘게**: `up --wait` 가 300 s 에 `timeout waiting for dependencies`(rc 1)로 끝난 뒤 자리를 풀자 migrate 는 다음 재시도(+120 s)에 성공했지만 **api · collector · edge 는 `Exited` 그대로** — 3분 관찰 동안 스스로 뜨지 않음(`boot-long.log`). → 개선 제안 1(결함으로 올리지 않은 까닭 포함).

### 4 · 5. 앞단(Caddy → gate → edge) — `tools/qa/rehearsal/front_check.py`(증거 `04-front-check.{txt,json}` · `04-front-headers-table.md`, 요청 약 45개 · 0.3 s 간격 · 잠금 해제 1회)
- 비밀 헤더 없음 → 403, 잠금 쿠키 없음 → 401(JSON · 잠금화면), 접근 코드로 한 번 해제 → 303 + 쿠키.
- 운영 경로 9개(위 요약) → 404 `{"error":"데모에서는 쓸 수 없는 경로입니다"}`(Content-Type application/json) — Caddy 가 답함(앱의 problem+json 아님).
- 공개 12경로(`/` · `/replay` · `/stats` · `/about` · `/guide` · `/m` · `/airports/RKSI` · `/api/v1/status` · `/api/v1/aircraft?bbox=…` · `/api/v1/warnings` · `/healthz` · `/_next/static/…js`) → 200.
- 헤더(앞단 개수/edge 직접 개수): HSTS 1/0(Caddy 가 붙임) · CSP 1/1(화면은 nonce + `frame-ancestors 'none'`, API 는 `default-src 'none'; frame-ancestors 'none'`) · X-Frame-Options 1/1 · nosniff 1/1 · Referrer-Policy 1/1 · X-Robots-Tag 1/0 · Permissions-Policy 1/1 · COOP 1/1 · **Server 0/1**(edge 의 `nginx` 를 Caddy 가 지움). 정적 파일은 CSP 없음(설계).
- api 의 Spring Security 기본 헤더와 edge `add_header` 가 겹치지 않음(API 응답도 각 1개). `PUBLIC_SCHEME=https` 여도 edge 가 `X-Forwarded-Proto $scheme` 로 덮어 api 가 HSTS 를 따로 붙이지 않는다.

## 미확인(이 환경에서 확인하지 못함)
1. **실제 RDS 의 확장 · spatial_ref_sys 소유자**: 흉내는 둘 다 `postgres`. 복원 시험에서 확장 소유자만 '마스터'로 맞췄다(bootstrap.sql 이 마스터로 만들므로 — 추정). spatial_ref_sys 는 맞추지 않아 마스터 · 소유 역할 복원에서 `COPY public.spatial_ref_sys … permission denied` 가 났다 — RDS 에서도 나는지 모름(QA-1620 의 결론에는 영향 없음: 그 한 줄을 빼도 권한 · 소유자 문제는 그대로).
2. **RDS 의 예약 연결**: 흉내는 superuser_reserved 3 → 일반 75. RDS 는 rdsadmin 모니터링 연결 · rds_superuser 예약 등이 더 있을 수 있다(약 1–3) — 여유(27/75)에는 영향 없음.
3. **선택 조회 풀(2)과 고갈**: WS 선택 선박 조회를 걸지 않아 이 풀이 열리는 경우의 연결 수 · 고갈 때 응답(`meta.db_unavailable`)은 보지 못했다.
4. **CloudFront 가 앞에 있을 때의 헤더**: CloudFront 의 응답 헤더 정책이 HSTS 등을 덧붙이면 겹칠 수 있다 — 로컬로 재현 불가(계획 §7).
5. **AWS 에서 backup.sh 를 이미 돌렸는지 · 받은 덤프가 있는지**: AWS 에 접속하지 않아 모른다(있으면 ② 절차가 필요).

## 개선 제안(결함 수에 넣지 않음)
1. **배포 · 수동 기동 중 DB 연결이 5분 넘게 모자라면 api 가 스스로 뜨지 않는다**: Flyway 재시도 창(약 8분)이 start-stack.sh · README 의 `up --wait --wait-timeout 300` 보다 길어, 그 사이에 migrate 가 성공해도 compose 가 이미 끝나 api · collector · edge 는 시작되지 않는다(위 3, `boot-long.log`).
   결함으로 올리지 않은 까닭: EC2 부팅 때는 dockerd 가 `unless-stopped` 인 api 등을 compose 와 따로 바로 띄우므로(계획 §1.2) 이 경로로 내려가지 않고, 남는 경우는 새 이미지로 다시 만드는 배포(운영자가 rc 1 을 본다)와 `compose stop` 뒤 기동뿐이다 — 그리고 고갈 자체가 다른 프로젝트의 누수 같은 외부 조건이다.
   제안: start-stack.sh 의 wakeline `--wait-timeout` 을 Flyway 창보다 길게(예: 600) 하거나 migrate 의 `connectRetries` 를 줄여 맞춘다, 또는 실패 때 한 번 더 `up`.
2. **QA-1620 · 1621 의 재발 방지 시험**: aws-deploy 쪽에 'backup.sh 덤프 → 새 RDS 흉내 → 복원 → wakeline probe' 를 리허설 단계로 두거나, wakeline 에 'GRANT 가 마이그레이션 밖에서도 다시 주어지는가'(afterMigrate) 시험. 신뢰성 영역 제안 1(저장기의 영구 실패를 `/healthz` 에)과 함께면 QA-1620 owner 의 '정상처럼 보임'도 드러난다.
3. **pgjdbc 이름 검증 실패 로그 폭주**: 틀린 이름이면 연결 시도마다 `PGjdbcHostnameVerifier` ERROR 한 줄(75 s 에 67줄)이 api 로그 · 시스템 로그 스트림(`/logs`)으로 간다. 같은 원인은 한 번만 남기도록 로거 수준을 낮추는 것을 제안.
4. **Caddy 가 만든 404 에 nosniff 가 없다**: 본문이 JSON 이고 Content-Type 이 맞아 실질 위험은 없다 — `public_headers` 에 `X-Content-Type-Options nosniff` 를 두면 앱이 답하지 않는 응답도 같아진다.

## 재현 스크립트 · 증거
- 스크립트(`tools/qa/rehearsal/`): `setup.py`(시험 비밀값 · 시험 CA · 덧붙임 compose — 세션 임시 폴더) · `r.sh`(세 프로젝트 고정 호출) · `app_probe.py`(기동 · 읽기 · 쓰기 · 파티션 함수 · 권한 오류 판정, ACL 구조 비교) ·
  `backup_restore.sh`(항목 1) · `qa_1620_1621_aws_restore.sh`(QA-1620 · 1621 처음부터 — 지금 종료 코드 1) · `tls_verify.sh`(항목 2) · `hold_conns.py` · `conn_sampler.sh` · `conn_budget.sh`(항목 3) · `front_check.py`(항목 4 · 5).
- 증거(`docs/qa/2026-10-aws/evidence/rehearsal/`): `01-bootstrap.txt` · `02-aws-up-ca-a.txt` · `03-source-probe.json` · `04-front-*` · `05-acl-source.txt` · `tls/` · `conn/` · `restore/`(readme · owner · master · master-exit-on-error · keepacl · aclfix) · `qa-1620-repro/`.
- 정리(04:05Z): `wlqa-rds`(holder · tools 포함) · `wlqa-aws` · `wlqa-front` 를 `down -v`, `portfolio-gate:wlqa` 삭제, 세션 임시 폴더의 시험 비밀값 · 인증서 · 덤프 삭제(다시 돌리면 setup.py 가 새로 만든다).
  `portfolio-gate:local` · `rds-emu_rds-data` · `wakeline_aws_rehearsal_*` · `wakeline-*:local/:mainsafe` 는 건드리지 않았다. aws-deploy 는 세션 동안 바뀐 파일 0(`find -newermt`), 커밋하지 않았다.
