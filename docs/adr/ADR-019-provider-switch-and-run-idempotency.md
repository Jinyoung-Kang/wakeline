# ADR-019 공급자 스위치의 원본은 DB · 수집 실행 기록은 멱등

**상태** 채택 · 2026-09-29 · 계약 v5 §D · 리뷰 R-94 · R-91

## R-94 공급자 스위치
- 원본: `provider_switch` 표(V11). 운영자 토글은 감사 행과 한 트랜잭션, 커밋 뒤 Redis `wakeline:provider:{name}.disabled` 로 미러.
- 60 s 마다 DB → Redis 다시 미러. collector 는 그 해시에 쓸 수 있으므로(상태 필드) 스위치 값을 바꿔도 1분 안에 되돌아온다.
- 이관: 표에 행이 없는 공급자는 지금 Redis 값을 한 번 옮겨 담는다.
- 되돌리기: V11 머리 주석의 SQL(`DROP TABLE provider_switch; DELETE FROM flyway_schema_history WHERE version='11'`) + 코드 되돌리기 — Redis 값은 그대로 남아 이전처럼 동작.

## R-91 실행 기록
- `ingest_run.run_key uuid UNIQUE`(V12, 옛 행은 NULL). collector 가 실행마다 uuid 를 만들고 `ON CONFLICT (run_key) DO NOTHING`.
- 커밋은 됐지만 응답이 시간 초과로 끊겨 다시 보내도 행은 하나다. quality_event 는 run_key 로 run id 를 되찾아 붙인다.
- 되돌리기: V12 머리 주석(`ALTER TABLE ingest_run DROP COLUMN run_key; …`).
