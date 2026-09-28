-- Wakeline 스키마 V9 — 리뷰 v1 의 DB 변경(ADR-017 §2). V1~V8 은 고치지 않는다. 적용은 운영과 같은 --migrate(wakeline_migrator)만.
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 위에서부터 순서대로 실행한 뒤 이력 행을 지운다 ====
-- -- R-06: 파티션 삭제 경계를 V2·V5 의 규칙(하루 더 남김, `- 1`)으로 되돌린다
-- CREATE OR REPLACE FUNCTION track_point_drop_old(retention_hours int) RETURNS int LANGUAGE plpgsql
-- SECURITY DEFINER SET search_path = public, pg_temp AS $$
-- DECLARE r record; n int := 0; cutoff date;
-- BEGIN
--   IF retention_hours < 24 OR retention_hours > 24 * 30 THEN RAISE EXCEPTION 'retention_hours out of range: %', retention_hours; END IF;
--   cutoff := ((now() AT TIME ZONE 'UTC') - make_interval(hours => retention_hours))::date - 1;
--   FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
--            JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'track_point' LOOP
--     IF to_date(substring(r.relname from 'track_point_(\d{8})'), 'YYYYMMDD') < cutoff THEN
--       EXECUTE format('DROP TABLE %I', r.relname);
--       n := n + 1;
--     END IF;
--   END LOOP;
--   RETURN n;
-- END $$;
-- CREATE OR REPLACE FUNCTION ship_position_drop_old(retention_hours int) RETURNS int LANGUAGE plpgsql
-- SECURITY DEFINER SET search_path = public, pg_temp AS $$
-- DECLARE r record; n int := 0; cutoff date;
-- BEGIN
--   IF retention_hours < 24 OR retention_hours > 24 * 30 THEN RAISE EXCEPTION 'retention_hours out of range: %', retention_hours; END IF;
--   cutoff := ((now() AT TIME ZONE 'UTC') - make_interval(hours => retention_hours))::date - 1;
--   FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
--            JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'ship_position' LOOP
--     IF to_date(substring(r.relname from 'ship_position_(\d{8})'), 'YYYYMMDD') < cutoff THEN
--       EXECUTE format('DROP TABLE %I', r.relname);
--       n := n + 1;
--     END IF;
--   END LOOP;
--   RETURN n;
-- END $$;
-- -- (알림 30일 보존은 스키마가 아니라 api 설정이다: WAKELINE_ALERT_RETENTION_DAYS=0 이면 지우지 않는다.)
-- DELETE FROM flyway_schema_history WHERE version = '9';
-- ==== 되돌리기 끝 ====

-- ---- R-06: 항적·선박 위치 파티션을 보존 경계에서 정확히 지운다 ----
-- 파티션 [d, d+1) 은 끝(d+1 00:00 UTC)이 now − retention 이전이면 모든 행이 보존 기간보다 오래됐다 → 지운다.
-- 이전 규칙(cutoff = (now − retention)::date − 1, 그보다 앞선 날만)은 하루를 더 남겨 가장 오래된 행이 99–123 h 였다(72 h 설정).
-- 이제 가장 오래된 행은 72 h + 그날 경과 시간(최대 96 h)이다. api 가 매시 부르므로 파티션은 경계를 넘은 뒤 1시간 안에 지워진다.
-- CREATE OR REPLACE 는 소유자·실행 권한(V1·V2·V5 의 REVOKE/GRANT)을 그대로 둔다. SECURITY DEFINER·search_path·인자 상한은 같다.
CREATE OR REPLACE FUNCTION track_point_drop_old(retention_hours int) RETURNS int LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; n int := 0; boundary timestamptz;
BEGIN
  IF retention_hours < 24 OR retention_hours > 24 * 30 THEN RAISE EXCEPTION 'retention_hours out of range: %', retention_hours; END IF;
  boundary := now() - make_interval(hours => retention_hours);
  FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'track_point' LOOP
    IF ((to_date(substring(r.relname from 'track_point_(\d{8})'), 'YYYYMMDD') + 1)::timestamp AT TIME ZONE 'UTC') <= boundary THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION ship_position_drop_old(retention_hours int) RETURNS int LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; n int := 0; boundary timestamptz;
BEGIN
  IF retention_hours < 24 OR retention_hours > 24 * 30 THEN RAISE EXCEPTION 'retention_hours out of range: %', retention_hours; END IF;
  boundary := now() - make_interval(hours => retention_hours);
  FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'ship_position' LOOP
    IF ((to_date(substring(r.relname from 'ship_position_(\d{8})'), 'YYYYMMDD') + 1)::timestamp AT TIME ZONE 'UTC') <= boundary THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;
