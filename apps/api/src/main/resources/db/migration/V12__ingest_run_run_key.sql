-- Wakeline 스키마 V12 — 수집 실행 기록의 멱등 키(계약 v5 §D2 · 리뷰 R-91 · ADR-019). V1~V11 은 고치지 않는다.
-- collector 의 DB writer 는 시간 초과·연결 끊김을 일시 오류로 보고 같은 작업을 다시 실행한다. COMMIT 이 서버에 반영된 뒤 응답 전에 끊기면
-- (결과가 모호한 실패) 키 없는 INSERT 가 다시 들어가 ingest_run 이 두 행이 되고 품질 사례·규칙별 건수가 두 배로 집계됐다.
-- 이제 collector 가 실행마다 uuid 를 만들어 run_key 로 싣고 INSERT … ON CONFLICT (run_key) DO NOTHING RETURNING id 로 한 번만 넣는다
-- (행이 돌아오지 않으면 이미 커밋된 실행 — 같은 트랜잭션의 품질 사례·건수도 이미 있으므로 다시 넣지 않는다, db.py record_run).
-- 옛 행(이 열 전에 기록된 실행)은 NULL — 키가 없던 기록이라 채우지 않는다. UNIQUE 는 NULL 끼리 겹치지 않는다.
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행하고 collector 코드도 되돌린다(새 코드는 run_key 열이 있어야 기록한다) ====
-- ALTER TABLE ingest_run DROP COLUMN run_key;
-- DELETE FROM flyway_schema_history WHERE version = '12';
-- ==== 되돌리기 끝 ====

ALTER TABLE ingest_run ADD COLUMN run_key uuid NULL CONSTRAINT ingest_run_run_key_key UNIQUE;

-- 권한: 새 열은 표 권한을 따른다 — collector 는 V1 의 SELECT · INSERT · UPDATE(키를 넣고, run_key 로 run id 를 되찾는다),
-- api 는 SELECT · DELETE(보존 정리)만. V9 가 없앤 기본 권한은 새 '표'에만 해당하므로 여기서 더 줄 것이 없다(RolePrivilegesDbTest · MigrationDbTest 가 확인).
