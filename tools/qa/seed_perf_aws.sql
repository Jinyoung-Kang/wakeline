-- QA 2026-10 AWS 성능(docs/qa/2026-10-aws QA-PLAN §3.5 'AWS 규모'): 격리 QA 스택(wlqa-a) DB 에 AWS 데모 모양의 합성 자료를 넣는다. 운영 스택 · AWS 에는 쓰지 않는다.
--
--   docker exec -i wlqa-a-db-1 psql -X -U postgres -d wakeline -v ON_ERROR_STOP=1 < tools/qa/seed_perf_aws.sql
--
-- seed_perf.sql(합성 운영 규모 — 상한)을 AWS 판 모양으로 줄였다. 근거와 가정(실측이 아닌 것은 '가정'):
--   OpenSky 끔(compose.aws.yml — 전세계 항공기 0) · 평일 운영(ADR-039 — EC2 08:50–18:00 KST) → 원본은 최근 3일의 00–09 UTC 만 있다(가정: 정지 동안 수집 0).
--   track_point   관심 지역 130대 / 10 s(fixture 실시간 127대 · 운영 70–190대 — PERF §1) × 운영 시간 → 시간당 46,800행
--   ship_position 3,000척(가정 — 동아시아 구독 18–46N · 105–150E, PERF §3 '동아시아 5.3 msg/s'), 0..99 번은 매분 · 나머지는 분마다 8 % → 분당 약 330행
--   ship          6,000척(기록 — 영구 표, 실시간의 두 배)
--   sigmet        11,200건 · 14일(하루 800건 — seed_perf.sql 과 같은 꼴, 배포 뒤 2주라는 가정)
--   alert_event   관심 지역 기체만 — 운영일 하루 500건 × 10일(가정)
--   track_point_1m 관심 지역 130대 × 1분 × 운영일 10일 × 9 h(원해상도 구간은 앱의 요약 문장 그대로)
--   ingest_run · quality_event · metar_obs · radar_frame — 운영 시간만, ingest_gap — 밤마다 정지 공백 1건 + 짧은 공백
--   wx_warning    5,000행 · 14일(가정) · retained_track 지정 대상 20개(상한 — ADR-038) × 1분 × 운영 시간 10일 + app_setting retain_targets 를 그 20개로
-- 목표 크기: DB 수백 MB(AWS 실측 219 MB — VERIFICATION #144). 합성 행의 표식은 seed_perf.sql 과 같다(provider · raw_ref · source = 'qa_synthetic').
\set ON_ERROR_STOP on
SET synchronous_commit = off;
SET client_min_messages = notice;
SET TimeZone = 'UTC';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM sigmet WHERE provider = 'qa_synthetic' LIMIT 1) THEN RAISE EXCEPTION 'already seeded (sigmet.provider = qa_synthetic)'; END IF;
END $$;

CREATE FUNCTION pg_temp.u(x int) RETURNS double precision IMMUTABLE LANGUAGE sql AS $f$ SELECT (hashint4(x)::bigint + 2147483648) / 4294967296.0 $f$;
CREATE FUNCTION pg_temp.tri(x double precision, lo double precision, hi double precision) RETURNS double precision IMMUTABLE LANGUAGE sql AS $f$
  SELECT lo + (hi - lo) - abs((x - lo) - 2 * (hi - lo) * floor((x - lo) / (2 * (hi - lo))) - (hi - lo)) $f$;
-- 운영 시간(00:00–09:00 UTC = 09–18 KST)인가 · 평일(KST)인가
CREATE FUNCTION pg_temp.op(t timestamptz) RETURNS boolean IMMUTABLE LANGUAGE sql AS $f$
  SELECT extract(hour FROM t AT TIME ZONE 'UTC') < 9 AND extract(isodow FROM t AT TIME ZONE 'Asia/Seoul') < 6 $f$;

CREATE TABLE pg_temp.qa_anchor AS
SELECT date_trunc('hour', now()) AS t_end,
       (date_trunc('day', now()) - interval '2 days') AS t_start,
       (date_trunc('day', now()) - interval '14 days') AS t_14d,
       date_trunc('hour', now() - interval '14 days') AS t_sig0;
SELECT t_end, t_start, t_14d, t_sig0 FROM pg_temp.qa_anchor;

-- ---- 파티션(소유자 wakeline_migrator — seed_perf.sql 과 같다) ----
SET ROLE wakeline_migrator;
DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT generate_series((date_trunc('day', now()) - interval '2 days')::date, (now() + interval '3 days')::date, interval '1 day')::date LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'track_point_' || to_char(d, 'YYYYMMDD')) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF track_point FOR VALUES FROM (%L) TO (%L)', 'track_point_' || to_char(d, 'YYYYMMDD'), d, d + 1);
      EXECUTE format('REVOKE ALL ON %I FROM wakeline_api', 'track_point_' || to_char(d, 'YYYYMMDD'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ship_position_' || to_char(d, 'YYYYMMDD')) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF ship_position FOR VALUES FROM (%L) TO (%L)', 'ship_position_' || to_char(d, 'YYYYMMDD'), d, d + 1);
      EXECUTE format('REVOKE ALL ON %I FROM wakeline_api', 'ship_position_' || to_char(d, 'YYYYMMDD'));
    END IF;
  END LOOP;
END $$;
RESET ROLE;

-- ---- sigmet: 11,200건(14일, 108 s 간격 · 2–6 h 유효 · 5 % 철회 · 5 % 도형 없음) — seed_perf.sql 과 같은 식 ----
INSERT INTO sigmet (id, fir_id, fir_name, issuer, series_id, hazard, qualifier, base_ft, top_ft, valid_from, valid_to, geom, excluded_reason,
                    move_dir, move_spd, chng, raw_text, provider, fetched_at, first_seen, withdrawn_at, base_source, top_source)
SELECT 'qa-' || n, fir, fir || ' FIR', fir, chr(65 + n % 20) || (n % 9 + 1), hz,
       CASE WHEN hz IN ('TS', 'CONVECTIVE') THEN (ARRAY['EMBD', 'OBSC', 'FRQ', 'SQL'])[1 + n % 4] WHEN hz IN ('TURB', 'ICE', 'MTW') THEN 'SEV' END,
       base, top, vf, vt,
       CASE WHEN pg_temp.u(n * 7 + 5) < 0.05 THEN NULL ELSE ST_Multi(ST_MakeEnvelope(lon, lat, lon + 3, lat + 2, 4326)) END,
       CASE WHEN pg_temp.u(n * 7 + 5) < 0.05 THEN 'geometry_unparsable' END,
       (ARRAY['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'])[1 + n % 8], (5 + n % 30) || 'KT', (ARRAY['NC', 'INTSF', 'WKN'])[1 + n % 3],
       'WS' || fir || ' SIGMET ' || chr(65 + n % 20) || (n % 9 + 1) || ' VALID ' || to_char(vf, 'DDHH24MI') || '/' || to_char(vt, 'DDHH24MI') || ' ' || fir
         || '- ' || fir || ' FIR ' || hz || ' OBS AT ' || to_char(vf, 'HH24MI') || 'Z WI N' || round(lat::numeric, 1) || ' E' || round(lon::numeric, 1)
         || ' - N' || round(lat::numeric + 2, 1) || ' E' || round(lon::numeric + 3, 1) || ' TOP FL' || lpad((top / 100)::text, 3, '0') || ' MOV E 10KT NC=',
       'qa_synthetic', vf - interval '5 minutes', vf - interval '10 minutes',
       CASE WHEN pg_temp.u(n * 7 + 6) < 0.05 THEN vf + (vt - vf) * (0.2 + 0.7 * pg_temp.u(n * 7 + 7)) END,
       'json', 'json'
FROM (
  SELECT n, a.t_sig0 + make_interval(secs => n * 108 + floor(60 * pg_temp.u(n * 7 + 1))) AS vf,
         a.t_sig0 + make_interval(secs => n * 108 + floor(60 * pg_temp.u(n * 7 + 1)) + 7200 + floor(4 * pg_temp.u(n * 7 + 2)) * 3600) AS vt,
         (ARRAY['VDPF','LIRR','BGGL','SBAO','FACA','ZSHA','WSJC','NZZC','SKED','YBBB','GCCC','LGGG','EGPX','SVZM','LPPO','HLLL','MHTG','MMID','FQBE','GOOO',
                'VOMF','SAVF','TTZP','RKRR','WIIF','SCIZ','EISN','ZJSA','CZEG','SBAZ','YMMM','FAJO','SBRE','OIIX','VABF','KZAK','SACF','FCCC','ZYSH','LPPC'])
           [1 + floor(40 * pow(pg_temp.u(n * 7 + 3), 1.6))::int] AS fir,
         (ARRAY['TS','TS','TS','TS','TS','TS','TS','TS','TS','TS','TS','TURB','TURB','TURB','TURB','TURB','ICE','ICE','VA','VA','MTW','TC','CONVECTIVE'])
           [1 + floor(23 * pg_temp.u(n * 7 + 4))::int] AS hz,
         CASE WHEN n % 4 = 0 THEN 0 ELSE 1000 * (n % 20) END AS base, 20000 + 1000 * (n % 31) AS top,
         -55 + 120 * pg_temp.u(n * 11 + 1) AS lat, -180 + 357 * pg_temp.u(n * 11 + 2) AS lon
  FROM generate_series(0, 11199) n, pg_temp.qa_anchor a
) s;
SELECT 'sigmet', count(*) FROM sigmet WHERE provider = 'qa_synthetic';

-- ---- aircraft(정적): 관심 지역 합성 hex(130칸 × 40 비행) + 지난 기체 2,000 ----
INSERT INTO aircraft (hex, registration, type_code, category, source, first_seen, last_seen)
SELECT lpad(to_hex(h), 6, '0'),
       (ARRAY['HL', 'JA', 'B-', 'N', 'D-A', 'G-', 'F-G', 'VH-', 'C-F', 'RP-C'])[1 + (h % 10)] || upper(lpad(to_hex((h * 2654435761::bigint % 65536)::int), 4, '0')),
       (ARRAY['A320', 'A321', 'B738', 'B77W', 'A333', 'B789', 'A359', 'B744', 'E190', 'AT76', 'B38M', 'A20N'])[1 + (h % 12)],
       (ARRAY['A3', 'A3', 'A5', 'A3', 'A2'])[1 + (h % 5)], 'qa_synthetic',
       now() - make_interval(days => (h % 300)), now() - make_interval(hours => (h % 72))
FROM (SELECT x'f10000'::int + s * 64 + f AS h FROM generate_series(0, 129) s, generate_series(0, 39) f WHERE s >= 10 OR f = 0
      UNION ALL SELECT x'f60000'::int + k FROM generate_series(0, 1999) k) z
ON CONFLICT (hex) DO NOTHING;
SELECT 'aircraft', count(*) FROM aircraft WHERE source = 'qa_synthetic';

-- ---- ship(정적): 6,000척 ----
INSERT INTO ship (mmsi, name, call_sign, imo, ship_type, dim_a, dim_b, dim_c, dim_d, draught_m, destination, eta_month, eta_day, eta_hour, eta_minute,
                  first_seen, last_seen, updated_at, provider)
SELECT (300000000 + i)::text, 'QA VESSEL ' || i, 'Q' || upper(lpad(to_hex(i), 5, '0')), 9000000 + i,
       (ARRAY[70, 70, 70, 80, 80, 60, 30, 52, 79, 89])[1 + i % 10], 20 + i % 200, 10 + i % 60, 5 + i % 20, 5 + i % 20, round((2 + (i % 150) / 10.0)::numeric, 1),
       (ARRAY['BUSAN', 'ULSAN', 'INCHEON', 'SHANGHAI', 'NINGBO', 'SINGAPORE', 'KR PUS', 'JP TYO', 'CN QZH>KR USN', 'KAOHSIUNG', 'QINGDAO', 'TOKYO'])[1 + i % 12],
       1 + i % 12, 1 + i % 28, i % 24, (i * 7) % 60,
       now() - make_interval(days => 1 + i % 14), now() - make_interval(mins => i % 600), now() - make_interval(mins => i % 1800), 'qa_synthetic'
FROM generate_series(0, 5999) i
ON CONFLICT (mmsi) DO NOTHING;
SELECT 'ship', count(*) FROM ship WHERE provider = 'qa_synthetic';

-- ---- track_point: 운영 시간마다 한 문장(시각 순) — 관심 지역 130대 / 10 s(0..9 번 칸은 같은 hex 내내 — 긴 항적, seed_perf.sql 과 같은 식) ----
DO $$
DECLARE a record; h timestamptz; n bigint; t0 timestamptz;
BEGIN
  SELECT * INTO a FROM pg_temp.qa_anchor;
  h := a.t_start;
  WHILE h < a.t_end LOOP
    IF pg_temp.op(h) THEN
      t0 := clock_timestamp();
      INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, vrate_fpm, on_ground, squawk, provider, fetched_at, quality)
      SELECT hex, ts, ST_SetSRID(ST_MakePoint(lon, lat), 4326), alt, spd, hdg, 0, false, NULL, 'qa_synthetic', ts + interval '15 seconds', 1
      FROM (
        SELECT lpad(to_hex(x'f10000'::int + s * 64 + CASE WHEN s < 10 THEN 0 ELSE (fl % 40)::int END), 6, '0') AS hex, ts,
               pg_temp.tri(33 + 7 * pg_temp.u(sd + 1) + d * cos(radians(360 * pg_temp.u(sd + 3))), 32.6, 40.4) AS lat,
               pg_temp.tri(124 + 7.5 * pg_temp.u(sd + 2) + d * sin(radians(360 * pg_temp.u(sd + 3))) / 0.8, 123.2, 132.4) AS lon,
               (5000 + 1000 * floor(35 * pg_temp.u(sd + 5)))::int AS alt, (250 + 230 * pg_temp.u(sd + 4))::real AS spd, (360 * pg_temp.u(sd + 3))::real AS hdg
        FROM (SELECT s, ts, fl, (s * 31 + (fl % 100000)::int * 7919) AS sd, (250 + 230 * pg_temp.u((s * 31 + (fl % 100000)::int * 7919) + 4)) * (e - fl * 7200) / 3600.0 / 60.0 AS d
              FROM (SELECT s, ts, extract(epoch FROM ts) AS e, floor(extract(epoch FROM ts) / 7200)::bigint AS fl
                    FROM generate_series(0, 129) s, generate_series(0, 359) k, LATERAL (SELECT h + make_interval(secs => k * 10 + s % 10) AS ts) t) q) r
      ) rows
      ORDER BY ts
      ON CONFLICT (hex, ts) DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT;
      COMMIT;
      RAISE NOTICE 'track_point % +% rows in % s', h, n, round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1);
    END IF;
    h := h + interval '1 hour';
  END LOOP;
END $$;

-- ---- ship_position: 운영 시간마다 한 문장 — 3,000척(동아시아), 0..99 번은 매분, 나머지는 분마다 8 % ----
DO $$
DECLARE a record; h timestamptz; n bigint;
BEGIN
  SELECT * INTO a FROM pg_temp.qa_anchor;
  h := a.t_start;
  WHILE h < a.t_end LOOP
    IF pg_temp.op(h) THEN
      INSERT INTO ship_position (mmsi, ts, geom, sog_kn, cog_deg, heading_deg, nav_status, position_source, provider)
      SELECT (300000000 + i)::text, ts, ST_SetSRID(ST_MakePoint(lon, lat), 4326), sog, cog, cog::int % 360, CASE WHEN sog < 0.5 THEN 1 ELSE 0 END,
             CASE WHEN i % 7 = 0 THEN NULL ELSE 'epfs' END, 'qa_synthetic'
      FROM (
        SELECT i, ts, sog, cog,
               CASE WHEN i % 5 = 0 THEN pg_temp.tri(33 + 6 * pg_temp.u(i * 5 + 1) + d * cos(radians(cog)), 33.05, 38.95)
                    ELSE pg_temp.tri(18 + 28 * pg_temp.u(i * 5 + 1) + d * cos(radians(cog)), 18, 46) END AS lat,
               CASE WHEN i % 5 = 0 THEN pg_temp.tri(124 + 8 * pg_temp.u(i * 5 + 2) + d * sin(radians(cog)) / 0.8, 124.05, 131.95)
                    ELSE pg_temp.tri(105 + 45 * pg_temp.u(i * 5 + 2) + d * sin(radians(cog)) / 0.8, 105, 150) END AS lon
        FROM (SELECT i, ts, (20 * pg_temp.u(i * 5 + 3))::real AS sog, floor(360 * pg_temp.u(i * 5 + 4))::real AS cog,
                     20 * pg_temp.u(i * 5 + 3) * (extract(epoch FROM ts) - 1790000000) / 3600.0 / 60.0 AS d
              FROM generate_series(0, 59) m, generate_series(0, 2999) i,
                   LATERAL (SELECT (extract(epoch FROM h)::bigint / 60 + m)::int AS mi) mm,
                   LATERAL (SELECT h + make_interval(mins => m, secs => floor(60 * pg_temp.u(i * 13 + mm.mi))) AS ts) t
              WHERE i < 100 OR pg_temp.u(i * 7 + (mm.mi % 1000000) * 131) < 0.08) q
      ) r
      ORDER BY ts
      ON CONFLICT (mmsi, ts) DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT;
      COMMIT;
      RAISE NOTICE 'ship_position % +% rows', h, n;
    END IF;
    h := h + interval '1 hour';
  END LOOP;
END $$;

-- ---- track_point_1m: 원해상도가 없는 운영일(14일 안의 평일 · 00–09 UTC) — 관심 지역 130대 × 1분 ----
DO $$
DECLARE a record; d timestamptz; n bigint;
BEGIN
  SELECT * INTO a FROM pg_temp.qa_anchor;
  d := a.t_14d;
  WHILE d < a.t_start LOOP
    IF pg_temp.op(d) THEN
      INSERT INTO track_point_1m (hex, ts_minute, geom, alt_ft, gs_kt, n)
      SELECT lpad(to_hex(x'f10000'::int + s * 64 + CASE WHEN s < 10 THEN 0 ELSE (fl % 40)::int END), 6, '0'), ts,
             ST_SetSRID(ST_MakePoint(pg_temp.tri(124 + 7.5 * pg_temp.u(sd + 2) + dd * sin(radians(360 * pg_temp.u(sd + 3))) / 0.8, 123.2, 132.4),
                                     pg_temp.tri(33 + 7 * pg_temp.u(sd + 1) + dd * cos(radians(360 * pg_temp.u(sd + 3))), 32.6, 40.4)), 4326),
             (5000 + 1000 * floor(35 * pg_temp.u(sd + 5)))::int, (250 + 230 * pg_temp.u(sd + 4))::real, 6
      FROM (SELECT s, ts, fl, (s * 31 + (fl % 100000)::int * 7919) AS sd,
                   (250 + 230 * pg_temp.u((s * 31 + (fl % 100000)::int * 7919) + 4)) * (extract(epoch FROM ts) - fl * 7200) / 3600.0 / 60.0 AS dd
            FROM generate_series(0, 129) s, generate_series(0, 539) k,
                 LATERAL (SELECT d + make_interval(mins => k) AS ts) t, LATERAL (SELECT floor(extract(epoch FROM t.ts) / 7200)::bigint AS fl) f) q
      ORDER BY ts
      ON CONFLICT (hex, ts_minute) DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT;
      COMMIT;
      RAISE NOTICE 'track_point_1m % +% rows', d, n;
    END IF;
    d := d + interval '1 day';
  END LOOP;
END $$;
-- 원해상도가 있는 구간은 앱의 요약 문장 그대로(MaintenanceJobs.summarizeHour — 관심 지역 bbox 36.5,127.8 r=250 NM)
DO $$
DECLARE a record; h timestamptz;
BEGIN
  SELECT * INTO a FROM pg_temp.qa_anchor;
  h := a.t_start;
  WHILE h < a.t_end - interval '1 hour' LOOP
    INSERT INTO track_point_1m (hex, ts_minute, geom, alt_ft, gs_kt, n)
    SELECT hex, date_trunc('minute', ts) m, ST_SetSRID(ST_MakePoint(avg(ST_X(geom)), avg(ST_Y(geom))), 4326), avg(alt_ft)::int, avg(gs_kt), count(*)
    FROM track_point
    WHERE ts >= h AND ts < h + interval '1 hour'
      AND geom && ST_MakeEnvelope(127.8 - 250 / (60 * cos(radians(36.5))), 36.5 - 250 / 60.0, 127.8 + 250 / (60 * cos(radians(36.5))), 36.5 + 250 / 60.0, 4326)
    GROUP BY hex, m
    ON CONFLICT (hex, ts_minute) DO NOTHING;
    COMMIT;
    h := h + interval '1 hour';
  END LOOP;
END $$;
SELECT 'track_point_1m', count(*) FROM track_point_1m;

-- ---- alert_event: 운영일마다 500건(관심 지역 기체 · 그 시각에 유효한 합성 SIGMET) — id = epoch ms × 1000 + 500(AlertIds 형식) ----
INSERT INTO alert_event (id, hex, callsign, sigmet_id, kind, entered_at, left_at, eta_s, alt_ft_at_entry, evidence, close_reason)
SELECT (floor(extract(epoch FROM t) * 1000)::bigint) * 1000 + 500, hex, 'QA' || lpad((j % 9000)::text, 4, '0'),
       'qa-' || greatest(0, floor(extract(epoch FROM t - a.t_sig0) / 108)::int - 1 - (j % 15)), kind, t,
       t + make_interval(secs => 120 + floor(3480 * pg_temp.u(j * 3 + 1))),
       CASE WHEN kind = 'PREDICTED' THEN 60 + floor(540 * pg_temp.u(j * 3 + 2))::int END, alt,
       jsonb_build_object('entry', 'lateral', 'gs_kt', 420.5, 'method', CASE WHEN kind = 'PREDICTED' THEN 'dead_reckoning_10min' ELSE 'observed_inside' END,
                          'band_ft', jsonb_build_array(0, 40000), 'seen_at', t, 'position', jsonb_build_array(37.123456, 127.654321), 'provider', 'qa_synthetic',
                          'valid_to', t + interval '3 hours', 'judged_at', t, 'track_deg', 291.03, 'vrate_fpm', 0.0, 'top_source', 'json',
                          'valid_from', t - interval '1 hour', 'base_source', 'assumed_surface', 'distance_nm', 46.3, 'polygon_index', 0,
                          'position_age_s', 4.5, 'alt_ft_at_entry', alt, 'base_assumed_surface', true),
       CASE WHEN kind = 'PREDICTED' THEN 'prediction_cleared'
            ELSE (ARRAY['left', 'left', 'left', 'left', 'left', 'left', 'signal_lost', 'signal_lost', 'sigmet_ended', 'left'])[1 + j % 10] END
FROM (
  SELECT dd * 500 + k AS j, t, CASE WHEN k % 10 < 7 THEN 'OBSERVED' ELSE 'PREDICTED' END AS kind,
         lpad(to_hex(x'f10000'::int + (k % 130) * 64 + CASE WHEN k % 130 < 10 THEN 0 ELSE k % 40 END), 6, '0') AS hex,
         (10000 + 1000 * (k % 30))::int AS alt
  FROM pg_temp.qa_anchor a0, generate_series(0, 13) dd, generate_series(0, 499) k,
       LATERAL (SELECT a0.t_14d + make_interval(days => dd, secs => k * 64.8) AS t) tt
  WHERE pg_temp.op(a0.t_14d + make_interval(days => dd)) AND a0.t_14d + make_interval(days => dd) < a0.t_start
) z, pg_temp.qa_anchor a
ON CONFLICT DO NOTHING;
SELECT 'alert_event', count(*) FROM alert_event WHERE evidence->>'provider' = 'qa_synthetic';

-- ---- ingest_run(운영 시간의 6 s 칸 8/9 — 전세계 없음) · quality_event ----
INSERT INTO ingest_run (job, provider, started_at, finished_at, status, http_status, latency_ms, records_in, records_quarantined, raw_ref, error_text, run_key)
SELECT job, prov, ts, ts + make_interval(secs => lat / 1000.0), CASE WHEN err THEN 'error' ELSE 'ok' END, CASE WHEN err THEN 503 ELSE 200 END, lat,
       CASE WHEN err THEN 0 ELSE recs END, CASE WHEN err THEN 0 ELSE (recs * 0.002)::int END, 'qa_synthetic:' || job,
       CASE WHEN err THEN 'HTTPStatusError: 503 Service Unavailable (qa synthetic)' END, gen_random_uuid()
FROM (
  SELECT ts, job, prov, recs, (80 + floor(900 * pg_temp.u(k)))::int AS lat, pg_temp.u(k * 3 + 1) < 0.01 AS err
  FROM (SELECT k, a.t_14d + make_interval(secs => k * 6) AS ts,
               CASE WHEN k % 6 = 3 THEN 'radar' WHEN k % 30 = 7 THEN 'sigmet' WHEN k % 60 = 11 THEN 'metar' WHEN k % 9 = 5 THEN 'focus' ELSE 'region' END AS job,
               CASE WHEN k % 6 = 3 THEN 'rainviewer' WHEN k % 30 = 7 OR k % 60 = 11 THEN 'awc' WHEN k % 17 = 0 THEN 'adsb_lol' ELSE 'adsb_fi' END AS prov,
               130 AS recs
        FROM pg_temp.qa_anchor a, generate_series(0, (extract(epoch FROM a.t_start - a.t_14d) / 6)::int) k) z
  WHERE z.k % 9 <> 8 AND pg_temp.op(z.ts)
) r;
INSERT INTO quality_event (run_id, rule, hex, detail, created_at)
SELECT id, (ARRAY['position_jump', 'altitude_out_of_range', 'stale_timestamp', 'duplicate_hex', 'speed_out_of_range'])[1 + (id % 5)::int],
       lpad(to_hex(x'f10000'::int + (id % 5200)::int), 6, '0'), jsonb_build_object('qa', true, 'value', id % 1000), started_at
FROM ingest_run WHERE raw_ref LIKE 'qa_synthetic:%' AND job = 'region' AND id % 8 = 0;
SELECT 'ingest_run', count(*) FROM ingest_run WHERE raw_ref LIKE 'qa_synthetic:%';

-- ---- metar_obs(공항 × 30분 · 운영 시간) · radar_frame(10분 · 7일 · 운영 시간) · ingest_gap(밤마다 정지 1건 + 짧은 공백 100건) ----
INSERT INTO metar_obs (icao, obs_time, raw, temp_c, dewp_c, wind_dir, wind_kt, vis_sm, vis_raw, ceiling_ft, flight_cat, flight_cat_source, wx_string, taf_raw,
                       provider, fetched_at, ceiling_state)
SELECT ap.icao, ts, ap.icao || ' ' || to_char(ts, 'DDHH24MI') || 'Z 27010KT 9999 FEW030 BKN045 18/12 Q1012 NOSIG', 18, 12, 270, 10, 6.2, '9999', 4500, 'VFR', 'awc', NULL,
       'TAF ' || ap.icao || ' ' || to_char(ts, 'DDHH24MI') || 'Z 0206/0312 27010KT 9999 FEW030', 'qa_synthetic', ts + interval '3 minutes', 'measured'
FROM airport ap, pg_temp.qa_anchor a, generate_series(a.t_14d, a.t_end - interval '2 hours', interval '30 minutes') ts
WHERE pg_temp.op(ts)
ON CONFLICT (icao, obs_time) DO NOTHING;
INSERT INTO radar_frame (frame_time, host, path, fetched_at)
SELECT ts, 'https://tilecache.rainviewer.com', '/v2/radar/qa' || extract(epoch FROM ts)::bigint, ts + interval '1 minute'
FROM pg_temp.qa_anchor a, generate_series(a.t_end - interval '6 days 20 hours', a.t_end - interval '3 hours', interval '10 minutes') ts
WHERE pg_temp.op(ts)
ON CONFLICT (frame_time) DO NOTHING;
INSERT INTO ingest_gap (source, started_at, ended_at, reason, provider, scope)
SELECT 'ais', d + interval '9 hours', d + interval '1 day', 'qa synthetic ais process stopped (EC2 stop)', 'qa_synthetic', NULL
FROM pg_temp.qa_anchor a, generate_series(a.t_14d, a.t_start, interval '1 day') d
UNION ALL
SELECT 'ais', ts, ts + make_interval(secs => 20 + floor(400 * pg_temp.u(k))), 'qa synthetic keepalive timeout', 'qa_synthetic', NULL
FROM pg_temp.qa_anchor a, generate_series(0, 99) k, LATERAL (SELECT a.t_14d + make_interval(secs => k * 12096) AS ts) t
ON CONFLICT DO NOTHING;

-- ---- wx_warning: 5,000행 · 14일(seed_perf_r2.sql 과 같은 꼴) ----
INSERT INTO wx_warning (zone_code, zone_name, parent_code, parent_name, sea, kind, level, command, preliminary, issued_at, effective_at,
                        raw, provider, first_seen, last_seen, ended_at)
SELECT z.code, 'QA 구역 ' || z.code, NULL, NULL, z.code LIKE 'S%', k.kind, 'Q' || (g % 4), '발표', false,
       t, t + interval '30 minutes', 'qa synthetic', 'qa_synthetic', t, t + interval '6 hours',
       CASE WHEN t + interval '6 hours' < now() THEN t + interval '6 hours' END
FROM generate_series(0, 4999) g
CROSS JOIN LATERAL (SELECT CASE WHEN g % 2 = 0 THEN 'S' ELSE 'L' END || lpad(((g % 414) + 1000000)::text, 7, '0') AS code) z
CROSS JOIN LATERAL (SELECT (ARRAY['풍랑', '강풍', '호우', '대설', '건조', '한파', '폭염', '태풍'])[(g % 8) + 1] AS kind) k
CROSS JOIN LATERAL (SELECT now() - interval '14 days' + (g * interval '14 days' / 5000) AS t) tt
ON CONFLICT DO NOTHING;

-- ---- retained_track: 지정 대상 20개(항공기 10 · 선박 10 — seed_perf_r2.sql 과 같은 대상) × 1분 × 원해상도 앞의 운영 시간 ----
INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, alt_ft, gs_kt, track_deg, sog_kn, cog_deg, provider)
SELECT CASE WHEN t.i < 10 THEN 'aircraft' ELSE 'ship' END,
       CASE WHEN t.i < 10 THEN lpad(to_hex(15794176 + t.i * 64), 6, '0') ELSE (300000000 + t.i)::text END,
       m, m + interval '7 seconds',
       ST_SetSRID(ST_MakePoint(124 + (extract(epoch FROM m)::bigint % 8000) / 1000.0, 33 + t.i * 0.25), 4326),
       CASE WHEN t.i < 10 THEN 30000 END, CASE WHEN t.i < 10 THEN 450 END, CASE WHEN t.i < 10 THEN 90 END,
       CASE WHEN t.i >= 10 THEN 12.5 END, CASE WHEN t.i >= 10 THEN 180 END, 'qa_synthetic'
FROM pg_temp.qa_anchor a, generate_series(0, 19) AS t(i)
CROSS JOIN LATERAL generate_series(a.t_14d, a.t_start - interval '1 minute', interval '1 minute') AS m
WHERE pg_temp.op(m)
ON CONFLICT DO NOTHING;
-- 따라잡기의 지정 보존 복사(MaintenanceJobs.copyRetained — 창 365일)가 실제로 일하도록 같은 20개를 운영 설정에 둔다(상한 — ADR-038)
INSERT INTO app_setting (key, value, updated_by)
VALUES ('retain_targets', to_jsonb('f10000,f10040,f10080,f100c0,f10100,f10140,f10180,f101c0,f10200,f10240,'
                                   '300000010,300000011,300000012,300000013,300000014,300000015,300000016,300000017,300000018,300000019'::text), 'qa_synthetic')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();

-- ---- stats_daily: 따라잡기 창(최근 7일) 밖의 날은 앱의 집계 문장 그대로 미리 센다(seed_perf.sql 과 같은 규칙) ----
DO $$
DECLARE a record; d date; s timestamptz; e timestamptz; today date := (now() AT TIME ZONE 'Asia/Seoul')::date;
BEGIN
  SELECT * INTO a FROM pg_temp.qa_anchor;
  FOR d IN SELECT generate_series((a.t_sig0 AT TIME ZONE 'Asia/Seoul')::date + 1, today - 8, interval '1 day')::date LOOP
    s := d::timestamp AT TIME ZONE 'Asia/Seoul'; e := s + interval '1 day';
    DELETE FROM stats_daily WHERE day = d;
    INSERT INTO stats_daily (day, metric, dim, value) SELECT d, 'sigmet_by_fir', fir_id, count(*) FROM sigmet WHERE valid_from >= s AND valid_from < e GROUP BY fir_id;
    INSERT INTO stats_daily (day, metric, dim, value) SELECT d, 'sigmet_by_hazard', hazard, count(*) FROM sigmet WHERE valid_from >= s AND valid_from < e GROUP BY hazard;
    INSERT INTO stats_daily (day, metric, dim, value) VALUES (d, 'aggregated_at', 'sigmet', extract(epoch FROM now())::bigint);
    INSERT INTO stats_daily (day, metric, dim, value) SELECT d, 'alerts_by_kind', kind, count(*) FROM alert_event WHERE entered_at >= s AND entered_at < e GROUP BY kind;
    INSERT INTO stats_daily (day, metric, dim, value)
      SELECT d, 'alert_dwell_avg_s', 'OBSERVED', avg(extract(epoch FROM (left_at - entered_at))) FROM alert_event
      WHERE kind = 'OBSERVED' AND left_at IS NOT NULL AND entered_at >= s AND entered_at < e AND close_reason = 'left' HAVING count(*) > 0;
    INSERT INTO stats_daily (day, metric, dim, value) VALUES (d, 'aggregated_at', 'alerts', extract(epoch FROM now())::bigint);
    INSERT INTO stats_daily (day, metric, dim, value) SELECT d, 'traffic_by_hour', lpad(hh::text, 2, '0'), 80 + floor(60 * pg_temp.u(hh + (d - date '2026-01-01') * 24)) FROM generate_series(9, 17) hh;
    INSERT INTO stats_daily (day, metric, dim, value) VALUES (d, 'traffic_region', 'center_lat', 36.5), (d, 'traffic_region', 'center_lon', 127.8), (d, 'traffic_region', 'radius_nm', 250),
                                                             (d, 'aggregated_at', 'traffic', extract(epoch FROM now())::bigint);
  END LOOP;
  DELETE FROM stats_daily WHERE day BETWEEN today - 7 AND today - 1 AND metric = 'aggregated_at' AND dim IN ('sigmet', 'alerts');
  FOR d IN SELECT generate_series(today - 7, today - 4, interval '1 day')::date LOOP
    IF NOT EXISTS (SELECT 1 FROM stats_daily WHERE day = d AND metric = 'aggregated_at' AND dim = 'traffic') THEN
      INSERT INTO stats_daily (day, metric, dim, value) SELECT d, 'traffic_by_hour', lpad(hh::text, 2, '0'), 80 + floor(60 * pg_temp.u(hh + (d - date '2026-01-01') * 24)) FROM generate_series(9, 17) hh;
      INSERT INTO stats_daily (day, metric, dim, value) VALUES (d, 'traffic_region', 'center_lat', 36.5), (d, 'traffic_region', 'center_lon', 127.8), (d, 'traffic_region', 'radius_nm', 250),
                                                               (d, 'aggregated_at', 'traffic', extract(epoch FROM now())::bigint);
    END IF;
  END LOOP;
END $$;
SELECT 'stats_daily', count(*) FROM stats_daily;
SELECT 'retained_track', count(*) FROM retained_track;
SELECT 'wx_warning', count(*) FROM wx_warning;
