-- Wakeline 스키마 V1 (8장). 마이그레이터(wakeline_migrator)가 소유하고, 역할별 최소 권한을 부여한다.

CREATE TABLE aircraft (
  hex           char(6) PRIMARY KEY,
  registration  text, type_code text, category text, source text,
  first_seen    timestamptz NOT NULL, last_seen timestamptz NOT NULL
);

CREATE TABLE track_point (
  hex char(6) NOT NULL, ts timestamptz NOT NULL,
  geom geometry(Point, 4326) NOT NULL,
  alt_ft int, gs_kt real, track_deg real, vrate_fpm real, on_ground bool NOT NULL DEFAULT false,
  squawk char(4), provider text NOT NULL, fetched_at timestamptz NOT NULL, quality smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (hex, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX track_point_ts_brin ON track_point USING BRIN (ts);

-- 파티션 관리 함수: 오늘 기준 [from, to] 일 파티션 생성 / retention 이전 파티션 DROP. api 가 매일 호출한다.
CREATE OR REPLACE FUNCTION track_point_ensure_partitions(days_ahead int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE d date; n int := 0; pname text;
BEGIN
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

CREATE OR REPLACE FUNCTION track_point_drop_old(retention_hours int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; n int := 0; cutoff date;
BEGIN
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

SELECT track_point_ensure_partitions(3);

CREATE TABLE track_point_1m (
  hex char(6) NOT NULL, ts_minute timestamptz NOT NULL,
  geom geometry(Point, 4326) NOT NULL, alt_ft int, gs_kt real, n smallint NOT NULL,
  PRIMARY KEY (hex, ts_minute)
);
CREATE INDEX track_point_1m_ts ON track_point_1m (ts_minute);

CREATE TABLE sigmet (
  id text PRIMARY KEY, fir_id text NOT NULL, fir_name text, issuer text, series_id text NOT NULL,
  hazard text NOT NULL, qualifier text, base_ft int NOT NULL DEFAULT 0, top_ft int,
  valid_from timestamptz NOT NULL, valid_to timestamptz NOT NULL,
  geom geometry(MultiPolygon, 4326),
  excluded_reason text,
  move_dir text, move_spd text, chng text, raw_text text NOT NULL,
  provider text NOT NULL, fetched_at timestamptz NOT NULL, first_seen timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to > valid_from), CHECK (top_ft IS NULL OR top_ft >= base_ft)
);
CREATE INDEX sigmet_geom_gist ON sigmet USING GIST (geom);
CREATE INDEX sigmet_valid ON sigmet (valid_to, valid_from);

CREATE TABLE alert_event (
  id bigserial PRIMARY KEY,
  hex char(6) NOT NULL,
  callsign text,
  sigmet_id text NOT NULL REFERENCES sigmet(id),
  kind text NOT NULL CHECK (kind IN ('OBSERVED','PREDICTED')),
  entered_at timestamptz NOT NULL, left_at timestamptz, eta_s int,
  alt_ft_at_entry int, evidence jsonb NOT NULL,
  UNIQUE (hex, sigmet_id, kind, entered_at)
);
CREATE INDEX alert_event_entered ON alert_event (entered_at DESC);
CREATE INDEX alert_event_hex ON alert_event (hex, entered_at DESC);

CREATE TABLE airport (
  icao char(4) PRIMARY KEY, iata text, name text, country text,
  geom geometry(Point, 4326) NOT NULL, elev_ft int, watched bool NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX airport_geom_gist ON airport USING GIST (geom);

CREATE TABLE metar_obs (
  icao char(4) NOT NULL REFERENCES airport(icao), obs_time timestamptz NOT NULL,
  raw text NOT NULL, temp_c real, dewp_c real, wind_dir smallint, wind_kt real,
  vis_sm real, vis_raw text, ceiling_ft int,
  flight_cat text CHECK (flight_cat IN ('VFR','MVFR','IFR','LIFR')),
  flight_cat_source text NOT NULL DEFAULT 'awc',
  wx_string text, taf_raw text, provider text NOT NULL, fetched_at timestamptz NOT NULL,
  PRIMARY KEY (icao, obs_time)
);
CREATE INDEX metar_obs_time ON metar_obs (obs_time DESC);

CREATE TABLE radar_frame (
  frame_time timestamptz PRIMARY KEY, host text NOT NULL, path text NOT NULL, fetched_at timestamptz NOT NULL
);

CREATE TABLE ingest_run (
  id bigserial PRIMARY KEY,
  job text NOT NULL, provider text NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz,
  status text NOT NULL, http_status int, latency_ms int,
  records_in int NOT NULL DEFAULT 0, records_quarantined int NOT NULL DEFAULT 0,
  raw_ref text, error_text text
);
CREATE INDEX ingest_run_started ON ingest_run (started_at DESC);
CREATE INDEX ingest_run_job ON ingest_run (job, started_at DESC);

CREATE TABLE quality_event (
  id bigserial PRIMARY KEY,
  run_id bigint REFERENCES ingest_run(id) ON DELETE CASCADE,
  rule text NOT NULL, hex char(6), detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quality_event_created ON quality_event (created_at DESC);

CREATE TABLE quality_rule_count (
  day date NOT NULL, rule text NOT NULL, count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, rule)
);

CREATE TABLE provider_budget_day (
  provider text NOT NULL, day date NOT NULL, calls int NOT NULL DEFAULT 0, credits int, limit_value int,
  PRIMARY KEY (provider, day)
);

CREATE TABLE ops_user (
  id serial PRIMARY KEY, username text UNIQUE NOT NULL,
  password_hash text NOT NULL, role text NOT NULL DEFAULT 'OPS',
  failed_count int NOT NULL DEFAULT 0, locked_until timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_setting (
  key text PRIMARY KEY, value jsonb NOT NULL, version int NOT NULL DEFAULT 1,
  updated_by text, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_setting (key, value) VALUES
  ('region_poll_s', '10'), ('global_poll_s', '120'), ('sigmet_poll_s', '300'), ('radar_poll_s', '60'), ('metar_poll_s', '600'),
  ('aircraft_providers', '"adsb_lol,adsb_fi,opensky"'), ('region_center', '"36.5,127.8"'), ('region_radius_nm', '250'),
  ('global_enabled', 'true');

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY, user_id int REFERENCES ops_user(id),
  action text NOT NULL, target text, before jsonb, after jsonb,
  ip inet, request_id text, at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stats_daily (
  day date NOT NULL, metric text NOT NULL, dim text NOT NULL, value numeric NOT NULL,
  PRIMARY KEY (day, metric, dim)
);

-- ---- 권한: api 는 DML 만, collector 는 ingest 테이블만, audit_log 는 INSERT 만 ----
GRANT SELECT, INSERT, UPDATE, DELETE ON aircraft, track_point, track_point_1m, sigmet, alert_event, app_setting, stats_daily TO wakeline_api;
GRANT SELECT ON airport, metar_obs, radar_frame, ingest_run, quality_event, quality_rule_count, provider_budget_day TO wakeline_api;
GRANT SELECT, INSERT, UPDATE ON ops_user TO wakeline_api;
GRANT INSERT, SELECT ON audit_log TO wakeline_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wakeline_api;
GRANT EXECUTE ON FUNCTION track_point_ensure_partitions(int), track_point_drop_old(int) TO wakeline_api;

GRANT SELECT, INSERT, UPDATE ON ingest_run, quality_event, quality_rule_count, airport, metar_obs, radar_frame, provider_budget_day TO wakeline_collector;
GRANT USAGE, SELECT ON SEQUENCE ingest_run_id_seq, quality_event_id_seq TO wakeline_collector;

-- 새 파티션(테이블)에도 같은 권한이 적용되도록 기본 권한 설정
ALTER DEFAULT PRIVILEGES FOR ROLE wakeline_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wakeline_api;
