# ADR-004 PostGIS 를 MVP 부터, Apple Silicon 에서는 arm64 네이티브 이미지

**상태** 채택

## 결정
항적 이력(72 h 원해상도 · 1분 요약 30일)·재생·통계·감사 로그는 PostgreSQL 18 + PostGIS 3.6 에 둔다. 실시간 경로(스냅샷·판정·WS)는 DB 에 의존하지 않는다.

공식 `postgis/postgis:18-3.6` 은 amd64 만 있어 Apple Silicon 에서 에뮬레이션된다. 다중 아키텍처 빌드 `imresamu/postgis:18-3.6`(arm64 네이티브, PostGIS 메인테이너의 도커 저장소)을 쓴다. `docker manifest inspect` 로 arm64 태그를 확인했다(2026-09-27).

## 역할 3개
`wakeline_migrator`(DDL·소유, Flyway) · `wakeline_api`(DML, audit_log 는 INSERT 만) · `wakeline_collector`(ingest 테이블 INSERT/UPDATE 만). 새 파티션에도 권한이 따라가도록 `ALTER DEFAULT PRIVILEGES`.

## 실측
- `track_point` 는 일 파티션 + `(hex, ts)` PK + BRIN(ts). 파티션 생성/삭제는 DB 함수(`track_point_ensure_partitions`, `track_point_drop_old`)를 api 가 스케줄로 호출한다.
- pgjdbc 는 `java.time.Instant` 를 바인딩하지 못한다 → 모든 timestamptz 파라미터는 `Sql.ts()`(OffsetDateTime UTC) 로 넘긴다(VERIFICATION #1).

## 개정(2026-09-30) — db 이미지를 직접 빌드한다(REVIEW-v1 R-63, 사용자가 권장안으로 처리하도록 맡김)
**문제** `imresamu/postgis:18-3.6`(Debian 판)은 2026-02-09 이후 재빌드가 없어 고칠 수 있는 CVE 가 쌓였다 — 2026-09-30 Trivy(고칠 수 있는 HIGH ·
CRITICAL, 고유): CRITICAL 9 · HIGH 76(OS 패키지 142건 + gosu 22건). 새 다이제스트가 없어 다이제스트 갱신으로는 고칠 수 없었다.

**결정** `infra/db/Dockerfile` 로 직접 빌드한다: 공식 `postgres:18-trixie`(arm64 · amd64 다중 아키텍처 — `docker buildx imagetools inspect` 로 확인,
다이제스트 고정 · Dependabot docker `/infra/db`) + PGDG 의 `postgresql-18-postgis-3=3.6.*`(공식 이미지에 PGDG 저장소가 이미 있다) + `apt-get upgrade`
+ gosu 삭제 + `USER postgres`. 이미지 태그는 `wakeline-db:local`(레지스트리에 없다 — compose · make test-api · CI 가 빌드한다).
- 결과(같은 날 Trivy): 고칠 수 있는 HIGH · CRITICAL **0건**. 남아 있던 22건은 모두 gosu 안의 Go 표준 라이브러리였다 — 처음부터 postgres(999)로 돌면
  엔트리포인트가 gosu 를 쓰지 않으므로 지웠고, compose 의 db 추가 권한(CHOWN · DAC_OVERRIDE · FOWNER · SETGID · SETUID)도 없앴다.
- 기존 볼륨 그대로: 같은 Debian 13(glibc 2.41 — 문자열 정렬 en_US.utf8 그대로) · 같은 메이저 18(18.1 → 18.6, 부 버전은 데이터 형식이 같다) ·
  같은 데이터 디렉터리(/var/lib/postgresql/18/docker). PostGIS 3.6.1 → 3.6.4 의 SQL 쪽은 한 번 `make db-postgis-update`(확장 소유자가 슈퍼유저라
  로컬 소켓으로 `ALTER EXTENSION postgis UPDATE`, 3.6.x 안에서만 · 멱등).
- 확인: `infra/tests/db_image_swap_test.sh` — 이전 이미지로 초기화한 볼륨을 새 이미지가 추가 권한 없이 열고, 행 수 · amcheck `bt_index_check`
  (한글 · 대소문자 · 기호 섞인 정렬 색인) · PostGIS 갱신 · 도형 연산이 맞다. db 권한 · 백업 · 비밀번호 교체 시험도 새 이미지로 통과(36 · 48 · 27).
- 게이트: db 는 이제 자체 이미지라 CI · `make security` 에서 **차단** 스캔(이전에는 보고만).
- 되돌리기: compose 의 db 를 이전 `image: imresamu/postgis:18-3.6@sha256:b5766…` · 이전 추가 권한으로 되돌린다(같은 메이저라 데이터 그대로; 확장은
  3.6.4 로 갱신된 뒤라 이전 라이브러리의 postgis_full_version() 이 'procs need upgrade' 를 알릴 수 있다 — 기능은 같은 3.6 이다).

