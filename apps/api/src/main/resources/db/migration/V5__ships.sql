-- Wakeline 스키마 V5 — 선박(AIS, ADR-014 · 계약 v2 §B3). V1~V4 는 고치지 않는다.
-- 표 세 개: ship(정적 정보, 영구) · ship_position(위치, 일 파티션 72 h) · ingest_gap(수신 공백, 영구).
-- 모든 값은 선박이 보낸 보고값 그대로다(수집기가 AIS '값 없음' 표기를 null 로 바꾼다). 범위 CHECK 는 스트림 스키마(ship_*.v1.json)와 같다.

-- ---- ship: MMSI 별 정적·항해 정보(보고값) ----
-- updated_at = 정적 정보 내용이 마지막으로 바뀐 메시지의 aisstream 수신 시각(정적 정보를 받은 적 없으면 NULL).
-- first_seen/last_seen = 이 MMSI 의 위치·정적 정보를 처음/마지막으로 저장한 시각(위치로 갱신하는 last_seen 은 10분 단위로만 쓴다 —
-- 정확한 마지막 위치 시각은 ship_position 에 있다).
CREATE TABLE ship (
  mmsi         char(9) PRIMARY KEY CONSTRAINT ship_mmsi_check CHECK (mmsi ~ '^[0-9]{9}$'),
  name         text, call_sign text,
  imo          int      CONSTRAINT ship_imo_check CHECK (imo BETWEEN 1000000 AND 1073741823),
  ship_type    smallint CONSTRAINT ship_type_check CHECK (ship_type BETWEEN 1 AND 99),
  dim_a        smallint CHECK (dim_a BETWEEN 0 AND 511), dim_b smallint CHECK (dim_b BETWEEN 0 AND 511),
  dim_c        smallint CHECK (dim_c BETWEEN 0 AND 511), dim_d smallint CHECK (dim_d BETWEEN 0 AND 511),
  draught_m    real     CHECK (draught_m > 0 AND draught_m <= 25.5),
  destination  text,
  eta_month    smallint CHECK (eta_month BETWEEN 1 AND 12), eta_day smallint CHECK (eta_day BETWEEN 1 AND 31),
  eta_hour     smallint CHECK (eta_hour BETWEEN 0 AND 23),  eta_minute smallint CHECK (eta_minute BETWEEN 0 AND 59),
  first_seen   timestamptz NOT NULL,
  last_seen    timestamptz NOT NULL,
  updated_at   timestamptz,
  provider     text NOT NULL,
  CONSTRAINT ship_seen_order CHECK (first_seen <= last_seen)
);

-- ---- ship_position: 위치(MMSI 별 60 s 창마다 첫 보고 하나 — api 가 줄여서 쓴다), UTC 일 파티션 ----
CREATE TABLE ship_position (
  mmsi            char(9) NOT NULL CONSTRAINT ship_position_mmsi_check CHECK (mmsi ~ '^[0-9]{9}$'),
  ts              timestamptz NOT NULL,                    -- 보고의 seen_at(aisstream 수신 시각)
  geom            geometry(Point, 4326) NOT NULL,
  sog_kn          real     CHECK (sog_kn >= 0 AND sog_kn <= 102.2),
  cog_deg         real     CHECK (cog_deg >= 0 AND cog_deg < 360),
  heading_deg     smallint CHECK (heading_deg BETWEEN 0 AND 359),
  nav_status      smallint CHECK (nav_status BETWEEN 0 AND 15),
  position_source text NOT NULL CONSTRAINT ship_position_source_check CHECK (position_source IN ('gnss', 'manual', 'estimated', 'inoperative')),
  provider        text NOT NULL,
  PRIMARY KEY (mmsi, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX ship_position_ts_brin ON ship_position USING BRIN (ts);

-- 파티션 함수: track_point 와 같은 방식(V2) — 소유자(wakeline_migrator) 권한으로 실행(SECURITY DEFINER), search_path 고정, 인자 상한.
-- 새 파티션은 api 가 부모 표로만 쓰고 읽는다: 부모를 거친 접근은 부모 권한만 검사하므로 파티션의 직접 권한(기본 권한이 준 DML)은 회수한다
-- — api 가 파티션을 직접 지우거나 고칠 수 없다(보존 삭제는 아래 drop 함수로만).
CREATE FUNCTION ship_position_ensure_partitions(days_ahead int) RETURNS int LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d date; n int := 0; pname text;
BEGIN
  IF days_ahead < 1 OR days_ahead > 14 THEN RAISE EXCEPTION 'days_ahead out of range: %', days_ahead; END IF;
  FOR i IN -1..days_ahead LOOP
    d := (now() AT TIME ZONE 'UTC')::date + i;
    pname := 'ship_position_' || to_char(d, 'YYYYMMDD');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = pname) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF ship_position FOR VALUES FROM (%L) TO (%L)', pname, d, d + 1);
      EXECUTE format('REVOKE ALL ON %I FROM wakeline_api', pname);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

CREATE FUNCTION ship_position_drop_old(retention_hours int) RETURNS int LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; n int := 0; cutoff date;
BEGIN
  IF retention_hours < 24 OR retention_hours > 24 * 30 THEN RAISE EXCEPTION 'retention_hours out of range: %', retention_hours; END IF;
  cutoff := ((now() AT TIME ZONE 'UTC') - make_interval(hours => retention_hours))::date - 1;
  FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'ship_position' LOOP
    IF to_date(substring(r.relname from 'ship_position_(\d{8})'), 'YYYYMMDD') < cutoff THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION ship_position_ensure_partitions(int), ship_position_drop_old(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ship_position_ensure_partitions(int), ship_position_drop_old(int) TO wakeline_api;

SELECT ship_position_ensure_partitions(3);

-- ---- ingest_gap: 수집 공백(영구 이력). 지금은 source 'ais' 만 쓴다 ----
-- 끝난 공백만 저장한다(열린 공백은 수집기 상태 해시 wakeline:ais:status 에 있다). 같은 공백의 재발행은 (source, started_at) 로 걸러진다.
CREATE TABLE ingest_gap (
  id         bigserial PRIMARY KEY,
  source     text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at   timestamptz NOT NULL,
  reason     text NOT NULL CONSTRAINT ingest_gap_reason_len CHECK (length(reason) BETWEEN 1 AND 200),
  provider   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingest_gap_source_started UNIQUE (source, started_at),
  CONSTRAINT ingest_gap_order CHECK (ended_at > started_at)
);

-- ---- 권한(최소): 기본 권한(V1 ALTER DEFAULT PRIVILEGES)이 새 표에 DML 전체를 주므로 필요한 것만 남긴다 ----
-- ship: 정적 정보 upsert(INSERT·UPDATE)·조회. 이력이므로 삭제 없음.
-- ship_position: 부모로 INSERT·SELECT 만(ON CONFLICT DO NOTHING 은 UPDATE 권한이 필요 없다). 보존 삭제는 drop 함수만.
-- ingest_gap: INSERT·SELECT 만(영구 이력 — 고치거나 지울 수 없다).
REVOKE ALL ON ship, ship_position, ingest_gap FROM wakeline_api;
GRANT SELECT, INSERT, UPDATE ON ship TO wakeline_api;
GRANT SELECT, INSERT ON ship_position TO wakeline_api;
GRANT SELECT, INSERT ON ingest_gap TO wakeline_api;
GRANT USAGE ON SEQUENCE ingest_gap_id_seq TO wakeline_api;
-- 파티션(위 ensure 가 만든 것 포함)은 함수 안에서 이미 REVOKE ALL — api 는 부모 표를 거쳐서만 쓴다.
