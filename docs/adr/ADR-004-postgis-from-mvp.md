# ADR-004 PostGIS 를 MVP 부터, Apple Silicon 에서는 arm64 네이티브 이미지

**상태** 채택

## 결정
항적 이력(72 h 원해상도 · 1분 요약 30일)·재생·통계·감사 로그는 PostgreSQL 18 + PostGIS 3.6 에 둔다. 실시간 경로(스냅샷·판정·WS)는 DB 에 의존하지 않는다.

공식 `postgis/postgis:18-3.6` 은 amd64 만 있어 Apple Silicon 에서 에뮬레이션된다. 다중 아키텍처 빌드 `imresamu/postgis:18-3.6`(arm64 네이티브, PostGIS 메인테이너의 도커 저장소)을 쓴다. `docker manifest inspect` 로 arm64 태그를 확인했다(2026-09-27).

## 역할 3개
`skywx_migrator`(DDL·소유, Flyway) · `skywx_api`(DML, audit_log 는 INSERT 만) · `skywx_collector`(ingest 테이블 INSERT/UPDATE 만). 새 파티션에도 권한이 따라가도록 `ALTER DEFAULT PRIVILEGES`.

## 실측
- `track_point` 는 일 파티션 + `(hex, ts)` PK + BRIN(ts). 파티션 생성/삭제는 DB 함수(`track_point_ensure_partitions`, `track_point_drop_old`)를 api 가 스케줄로 호출한다.
- pgjdbc 는 `java.time.Instant` 를 바인딩하지 못한다 → 모든 timestamptz 파라미터는 `Sql.ts()`(OffsetDateTime UTC) 로 넘긴다(VERIFICATION #1).
