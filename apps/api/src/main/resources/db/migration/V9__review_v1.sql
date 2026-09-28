-- Wakeline 스키마 V9 — 리뷰 v1 의 DB 변경(ADR-017 §2). V1~V8 은 고치지 않는다. 적용은 운영과 같은 --migrate(wakeline_migrator)만.
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 위에서부터 순서대로 실행한 뒤 이력 행을 지운다 ====
-- -- R-88: 기본 권한과 track_point 파티션 함수를 V1·V2 로 되돌린다(이미 있는 파티션의 직접 권한은 되살리지 않는다 — api 는 부모로만 쓴다)
-- ALTER DEFAULT PRIVILEGES FOR ROLE wakeline_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wakeline_api;
-- CREATE OR REPLACE FUNCTION track_point_ensure_partitions(days_ahead int) RETURNS int LANGUAGE plpgsql
-- SECURITY DEFINER SET search_path = public, pg_temp AS $$
-- DECLARE d date; n int := 0; pname text;
-- BEGIN
--   IF days_ahead < 1 OR days_ahead > 14 THEN RAISE EXCEPTION 'days_ahead out of range: %', days_ahead; END IF;
--   FOR i IN -1..days_ahead LOOP
--     d := (now() AT TIME ZONE 'UTC')::date + i;
--     pname := 'track_point_' || to_char(d, 'YYYYMMDD');
--     IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = pname) THEN
--       EXECUTE format('CREATE TABLE %I PARTITION OF track_point FOR VALUES FROM (%L) TO (%L)', pname, d, d + 1);
--       n := n + 1;
--     END IF;
--   END LOOP;
--   RETURN n;
-- END $$;
-- -- R-51: 항공기 검색 앞부분 인덱스
-- DROP INDEX IF EXISTS aircraft_registration_prefix;
-- DROP INDEX IF EXISTS aircraft_hex_prefix;
-- -- R-15: 알림 이력 hex 인덱스
-- DROP INDEX IF EXISTS alert_event_hex_id;
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

-- ---- R-15: 알림 이력 hex 필터 ----
-- /alerts/history?hex= 는 hex 로 거른 뒤 id 역순으로 한 쪽(≤ 201행)을 자른다. (hex, id DESC) 이면 그 hex 의 행만 id 순서대로 읽고 멈춘다
-- (기존 alert_event_hex (hex, entered_at DESC) 는 id 순서를 주지 않는다). 질의는 hex 를 char(6) 끼리 비교한다(AlertRepository.history).
CREATE INDEX alert_event_hex_id ON alert_event (hex, id DESC);

-- ---- R-51: 항공기 검색(hex·등록부호 앞부분 일치) ----
-- aircraft 는 보존 없이 커지는데 검색이 표 전체를 순차 스캔했다. 앞부분 일치는 바이트 순서 범위(~>=~ · ~<~)로 묻는다(AircraftRepository.search) —
-- text_pattern_ops 인덱스는 그 연산자를 파라미터 그대로(일반 계획에서도) 쓴다. 두 인덱스를 BitmapOr 로 합친다.
CREATE INDEX aircraft_hex_prefix ON aircraft (upper(hex) text_pattern_ops);
CREATE INDEX aircraft_registration_prefix ON aircraft (upper(registration) text_pattern_ops);

-- ---- R-88: 새 표에 api DML 을 자동으로 주던 기본 권한을 없앤다(fail-open → 명시 GRANT 만) ----
-- V1 의 ALTER DEFAULT PRIVILEGES 는 migrator 가 만드는 모든 새 표(파티션 포함)에 api DML 전체를 줬다 — 마이그레이션이 REVOKE 를 잊으면
-- INSERT 전용이어야 할 표도 api 가 고치고 지울 수 있었다(V5·V8 은 그래서 REVOKE 를 따로 썼다). 이제 표마다 필요한 권한을 GRANT 해야 한다.
-- 지금 있는 표의 권한은 그대로다(모두 V1~V8 이 명시했다 — RolePrivilegesDbTest 의 스냅샷).
ALTER DEFAULT PRIVILEGES FOR ROLE wakeline_migrator IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM wakeline_api;

-- track_point 파티션은 api 가 부모로만 쓴다(부모를 거친 접근은 부모 권한만 검사한다) — 선박 파티션(V5)과 같이 파티션의 직접 권한을 회수한다.
-- 함수가 새로 만드는 파티션도, 기본 권한으로 직접 권한을 받았던 기존 파티션도.
CREATE OR REPLACE FUNCTION track_point_ensure_partitions(days_ahead int) RETURNS int LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d date; n int := 0; pname text;
BEGIN
  IF days_ahead < 1 OR days_ahead > 14 THEN RAISE EXCEPTION 'days_ahead out of range: %', days_ahead; END IF;
  FOR i IN -1..days_ahead LOOP
    d := (now() AT TIME ZONE 'UTC')::date + i;
    pname := 'track_point_' || to_char(d, 'YYYYMMDD');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = pname) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF track_point FOR VALUES FROM (%L) TO (%L)', pname, d, d + 1);
      EXECUTE format('REVOKE ALL ON %I FROM wakeline_api', pname);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'track_point' LOOP
    EXECUTE format('REVOKE ALL ON %I FROM wakeline_api', r.relname);
  END LOOP;
END $$;
