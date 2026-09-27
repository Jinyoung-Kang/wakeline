-- VERIFICATION #16: 파티션 함수가 SECURITY INVOKER 라 wakeline_api(스키마 CREATE 권한 없음)가 호출하면 실패했다.
-- 소유자(wakeline_migrator) 권한으로 실행하도록 SECURITY DEFINER 로 바꾸고, search_path 를 고정해 함수 하이재킹을 막는다.
-- 실행 권한은 api 역할에만 준다(PUBLIC 기본 EXECUTE 회수).
ALTER FUNCTION track_point_ensure_partitions(int) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION track_point_drop_old(int) SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION track_point_ensure_partitions(int), track_point_drop_old(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION track_point_ensure_partitions(int), track_point_drop_old(int) TO wakeline_api;

-- 인자 상한: 호출자가 큰 값을 넘겨 파티션을 대량 생성하거나(DoS) 보존 기간을 0 으로 만들어 이력을 지우지 못하게 한다.
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
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION track_point_drop_old(retention_hours int) RETURNS int LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; n int := 0; cutoff date;
BEGIN
  IF retention_hours < 24 OR retention_hours > 24 * 30 THEN RAISE EXCEPTION 'retention_hours out of range: %', retention_hours; END IF;
  cutoff := ((now() AT TIME ZONE 'UTC') - make_interval(hours => retention_hours))::date - 1;
  FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'track_point' LOOP
    IF to_date(substring(r.relname from 'track_point_(\d{8})'), 'YYYYMMDD') < cutoff THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;
