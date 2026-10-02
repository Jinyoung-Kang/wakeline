-- QA 2026-10 성능(계획 §3.5): 격리 스택 A(wakeline-e2e) DB 에 운영 규모의 합성 시험 데이터를 넣는다. 운영 스택에는 쓰지 않는다.
--
--   docker exec -i wakeline-e2e-db-1 psql -U postgres -d wakeline -v ON_ERROR_STOP=1 < tools/qa/seed_perf.sql
--
-- 규모의 근거(docs/PERF.md · ADR):
--   track_point   관심 지역 200대 / 10 s + 전세계 10,000대 / 120 s(PERF §13 D6 '운영 모양의 입력' · §1 전세계 약 10,400–10,900대) → 시간당 372,000행
--   ship_position 분당 약 2,300행(PERF §3 분당 1,773–2,769행 · JdbcCoverageSource 주석 '한 시 약 168k 행')
--   ship          40,000척(PERF §1 '선박 약 3만 척 기록' — 표는 영구라 그보다 크게)
--   sigmet        200,000건 · 약 250일(PERF §13 P4 와 같은 크기 — 하루 800건 · 2–6 h 유효 → 같은 때 약 130건)
--   alert_event   하루 40,000건 × 29.5일(ADR-017 R-06 '알림이 하루 약 50 MB' — 이 표의 행은 약 1.2 kB)
--   track_point_1m 관심 지역 200대 × 1분 × 30일(MaintenanceJobs.summarize1m 이 매시 만드는 크기)
--   ingest_run    하루 약 12,500건 × 29.5일(격리 스택의 fixture 실행 기록 시간당 약 500건과 같은 꼴) · quality_event 하루 3,000건
--   metar_obs     감시 공항 13곳 × 30분 × 29.5일 · radar_frame 10분 × 6.9일 · ingest_gap 60일 3,000건
-- 합성 행의 표식: provider(또는 raw_ref · reason · source)가 'qa_synthetic'. 시각은 모두 실행 시각 기준이다(보존 작업이 측정 중에 지우지 않게
-- 항적 · 선박 위치는 오늘 −2일 00:00 UTC 부터, 30일 보존 표는 29.5일 안에서 시작한다).
-- 항적 · 선박 위치는 운영과 같이 시각 순서로 넣는다(BRIN(ts) 상관이 운영과 같다).
\set ON_ERROR_STOP on
SET synchronous_commit = off;
SET client_min_messages = notice;
SET TimeZone = 'UTC';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM sigmet WHERE provider = 'qa_synthetic' LIMIT 1) THEN RAISE EXCEPTION 'already seeded (sigmet.provider = qa_synthetic)'; END IF;
END $$;

-- 0..1 균등(정수 씨앗)
CREATE FUNCTION pg_temp.u(x int) RETURNS double precision IMMUTABLE LANGUAGE sql AS $f$ SELECT (hashint4(x)::bigint + 2147483648) / 4294967296.0 $f$;
-- [lo, hi] 안에서 되튀기(삼각파)
CREATE FUNCTION pg_temp.tri(x double precision, lo double precision, hi double precision) RETURNS double precision IMMUTABLE LANGUAGE sql AS $f$
  SELECT lo + (hi - lo) - abs((x - lo) - 2 * (hi - lo) * floor((x - lo) / (2 * (hi - lo))) - (hi - lo)) $f$;
CREATE FUNCTION pg_temp.wrap(x double precision) RETURNS double precision IMMUTABLE LANGUAGE sql AS $f$ SELECT x - 360 * floor((x + 180) / 360) $f$;

CREATE TABLE pg_temp.qa_anchor AS
SELECT date_trunc('hour', now()) AS t_end,
       (date_trunc('day', now()) - interval '2 days') AS t_start,
       date_trunc('hour', now() - interval '29 days 12 hours') AS t_30d,
       date_trunc('hour', now() - interval '250 days') AS t_sig0,
       timestamptz '2026-10-01 17:00:00+00' AS alerts_end;
SELECT t_end, t_start, t_30d, t_sig0 FROM pg_temp.qa_anchor;

-- ---- 파티션(소유자 wakeline_migrator · api 직접 권한 없음 — V5 · V9 의 함수와 같은 꼴) ----
SET ROLE wakeline_migrator;
DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT generate_series((date_trunc('day', now()) - interval '2 days')::date, (now() + interval '3 days')::date, interval '1 day')::date LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'track_point_' || to_char(d, 'YYYYMMDD')) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF track_point FOR VALUES FROM (%L) TO (%L)', 'track_point_' || to_char(d, 'YYYYMMDD'), d, d + 1);
      EXECUTE format('REVOKE ALL ON %I FROM wakeline_api', 'track_point_' || to_char(d, 'YYYYMMDD'));
      RAISE NOTICE 'created track_point_%', to_char(d, 'YYYYMMDD');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ship_position_' || to_char(d, 'YYYYMMDD')) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF ship_position FOR VALUES FROM (%L) TO (%L)', 'ship_position_' || to_char(d, 'YYYYMMDD'), d, d + 1);
      EXECUTE format('REVOKE ALL ON %I FROM wakeline_api', 'ship_position_' || to_char(d, 'YYYYMMDD'));
      RAISE NOTICE 'created ship_position_%', to_char(d, 'YYYYMMDD');
    END IF;
  END LOOP;
END $$;
RESET ROLE;

-- ---- sigmet: 200,000건(250일, 108 s 간격 · 2–6 h 유효 · 5 % 철회 · 5 % 도형 없음) ----
INSERT INTO sigmet (id, fir_id, fir_name, issuer, series_id, hazard, qualifier, base_ft, top_ft, valid_from, valid_to, geom, excluded_reason,
                    move_dir, move_spd, chng, raw_text, provider, fetched_at, first_seen, withdrawn_at, base_source, top_source)
SELECT 'qa-' || n, fir, fir || ' FIR', fir, chr(65 + n % 20) || (n % 9 + 1), hz,
       CASE WHEN hz IN ('TS', 'CONVECTIVE') THEN (ARRAY['EMBD', 'OBSC', 'FRQ', 'SQL'])[1 + n % 4] WHEN hz IN ('TURB', 'ICE', 'MTW') THEN 'SEV' END,
       base, top, vf, vt,
       CASE WHEN pg_temp.u(n * 7 + 5) < 0.05 THEN NULL
            ELSE ST_Multi(ST_MakeEnvelope(lon, lat, lon + 3, lat + 2, 4326)) END,
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
                'VOMF','SAVF','TTZP','RKRR','WIIF','SCIZ','EISN','ZJSA','CZEG','SBAZ','YMMM','FAJO','SBRE','OIIX','VABF','KZAK','SACF','FCCC','ZYSH','LPPC',
                'WBFC','WAAF','ZGZU','SBCW','UHHH','SAMF','FAJA','LTBB','KZWY','UTAA','RJJJ','SAEF','GVSC','KKCI','MMEX','WMFC','VYYF','KZMA','SUEO','SEFG',
                'SBBS','EDGG','EDWW','EDMM','LFFF','LFMM','LECM','LECB','EGTT','EHAA','EKDK','ENOR','ESAA','EFIN','EPWW','LKAA','LOVV','LHCC','LRBB','LBSR',
                'UUWV','ULLL','UNNT','UHMM','ZBPE','ZLHW','ZPKM','ZWUQ','VECF','VIDF','VCCF','OPKR','OAKX','OJAC','HECC','HSSS','HKNA','DNKK','DRRR','FMMM',
                'KZNY','KZLA','KZDC','KZJX','KZHU','KZOA','KZSE','PAZA','PHZH','CZVR','CZWG','CZUL','CZQX','MKJK','TJZS','SPIM','SLLF','SGFA','NFFF','NTTT'])
           [1 + floor(120 * pow(pg_temp.u(n * 7 + 3), 1.6))::int] AS fir,
         (ARRAY['TS','TS','TS','TS','TS','TS','TS','TS','TS','TS','TS','TURB','TURB','TURB','TURB','TURB','ICE','ICE','VA','VA','MTW','TC','CONVECTIVE'])
           [1 + floor(23 * pg_temp.u(n * 7 + 4))::int] AS hz,
         CASE WHEN n % 4 = 0 THEN 0 ELSE 1000 * (n % 20) END AS base, 20000 + 1000 * (n % 31) AS top,
         -55 + 120 * pg_temp.u(n * 11 + 1) AS lat, -180 + 357 * pg_temp.u(n * 11 + 2) AS lon
  FROM generate_series(0, 199999) n, pg_temp.qa_anchor a
) s;
SELECT 'sigmet', count(*) FROM sigmet WHERE provider = 'qa_synthetic';

-- ---- aircraft(정적): 관심 지역 · 전세계 합성 hex 전부 + 과거 기체 → 200,000행 ----
INSERT INTO aircraft (hex, registration, type_code, category, source, first_seen, last_seen)
SELECT lpad(to_hex(h), 6, '0'),
       (ARRAY['HL', 'JA', 'B-', 'N', 'D-A', 'G-', 'F-G', 'VH-', 'C-F', 'RP-C'])[1 + (h % 10)] || upper(lpad(to_hex((h * 2654435761::bigint % 65536)::int), 4, '0')),
       (ARRAY['A320', 'A321', 'B738', 'B77W', 'A333', 'B789', 'A359', 'B744', 'E190', 'AT76', 'B38M', 'A20N'])[1 + (h % 12)],
       (ARRAY['A3', 'A3', 'A5', 'A3', 'A2'])[1 + (h % 5)], 'qa_synthetic',
       now() - make_interval(days => (h % 300)), now() - make_interval(hours => (h % 72))
FROM (SELECT x'f10000'::int + s * 64 + f AS h FROM generate_series(0, 199) s, generate_series(0, 39) f WHERE s >= 10 OR f = 0
      UNION ALL SELECT x'f20000'::int + s * 12 + f FROM generate_series(0, 9999) s, generate_series(0, 11) f
      UNION ALL SELECT x'f60000'::int + k FROM generate_series(0, 72389) k) z
ON CONFLICT (hex) DO NOTHING;
SELECT 'aircraft', count(*) FROM aircraft WHERE source = 'qa_synthetic';

-- ---- ship(정적): 40,000척 ----
INSERT INTO ship (mmsi, name, call_sign, imo, ship_type, dim_a, dim_b, dim_c, dim_d, draught_m, destination, eta_month, eta_day, eta_hour, eta_minute,
                  first_seen, last_seen, updated_at, provider)
SELECT (300000000 + i)::text, 'QA VESSEL ' || i, 'Q' || upper(lpad(to_hex(i), 5, '0')), 9000000 + i,
       (ARRAY[70, 70, 70, 80, 80, 60, 30, 52, 79, 89])[1 + i % 10], 20 + i % 200, 10 + i % 60, 5 + i % 20, 5 + i % 20, round((2 + (i % 150) / 10.0)::numeric, 1),
       (ARRAY['BUSAN', 'ULSAN', 'INCHEON', 'SHANGHAI', 'NINGBO', 'SINGAPORE', 'ROTTERDAM', 'KR PUS', 'JP TYO', 'CN QZH>KR USN', 'LOS ANGELES', 'HOUSTON'])[1 + i % 12],
       1 + i % 12, 1 + i % 28, i % 24, (i * 7) % 60,
       now() - make_interval(days => 1 + i % 120), now() - make_interval(mins => i % 600), now() - make_interval(mins => i % 1800), 'qa_synthetic'
FROM generate_series(0, 39999) i
ON CONFLICT (mmsi) DO NOTHING;
SELECT 'ship', count(*) FROM ship WHERE provider = 'qa_synthetic';

-- ---- track_point: 시간마다 한 문장(시각 순) — 관심 지역 200대 / 10 s + 전세계 10,000대 / 120 s ----
DO $$
DECLARE a record; h timestamptz; n bigint; t0 timestamptz;
BEGIN
  SELECT * INTO a FROM pg_temp.qa_anchor;
  h := a.t_start;
  WHILE h < a.t_end LOOP
    t0 := clock_timestamp();
    INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, vrate_fpm, on_ground, squawk, provider, fetched_at, quality)
    SELECT hex, ts, ST_SetSRID(ST_MakePoint(lon, lat), 4326), alt, spd, hdg, 0, false, NULL, 'qa_synthetic', ts + interval '15 seconds', 1
    FROM (
      -- 관심 지역: 2 h 비행마다 새 hex(0..9 번 칸은 72 h 내내 같은 hex — 긴 항적)
      SELECT lpad(to_hex(x'f10000'::int + s * 64 + CASE WHEN s < 10 THEN 0 ELSE (fl % 40)::int END), 6, '0') AS hex, ts,
             pg_temp.tri(33 + 7 * pg_temp.u(sd + 1) + d * cos(radians(360 * pg_temp.u(sd + 3))), 32.6, 40.4) AS lat,
             pg_temp.tri(124 + 7.5 * pg_temp.u(sd + 2) + d * sin(radians(360 * pg_temp.u(sd + 3))) / 0.8, 123.2, 132.4) AS lon,
             (5000 + 1000 * floor(35 * pg_temp.u(sd + 5)))::int AS alt, (250 + 230 * pg_temp.u(sd + 4))::real AS spd, (360 * pg_temp.u(sd + 3))::real AS hdg
      FROM (SELECT s, ts, fl, (s * 31 + (fl % 100000)::int * 7919) AS sd, (250 + 230 * pg_temp.u((s * 31 + (fl % 100000)::int * 7919) + 4)) * (e - fl * 7200) / 3600.0 / 60.0 AS d
            FROM (SELECT s, ts, extract(epoch FROM ts) AS e, floor(extract(epoch FROM ts) / 7200)::bigint AS fl
                  FROM generate_series(0, 199) s, generate_series(0, 359) k, LATERAL (SELECT h + make_interval(secs => k * 10 + s % 10) AS ts) t) q) r
      UNION ALL
      -- 전세계: 6 h 비행마다 새 hex, 위치는 전세계(앞 200칸은 동아시아에서 출발)
      SELECT lpad(to_hex(x'f20000'::int + s * 12 + (fl % 12)::int), 6, '0'), ts,
             pg_temp.tri(CASE WHEN s < 200 THEN 30 + 12 * pg_temp.u(sd + 1) ELSE -50 + 110 * pg_temp.u(sd + 1) END + d * cos(radians(360 * pg_temp.u(sd + 3))), -60, 72),
             pg_temp.wrap(CASE WHEN s < 200 THEN 118 + 22 * pg_temp.u(sd + 2) ELSE -180 + 360 * pg_temp.u(sd + 2) END + d * sin(radians(360 * pg_temp.u(sd + 3))) / 0.7),
             (28000 + 1000 * floor(13 * pg_temp.u(sd + 5)))::int, (380 + 120 * pg_temp.u(sd + 4))::real, (360 * pg_temp.u(sd + 3))::real
      FROM (SELECT s, ts, fl, (s * 31 + (fl % 100000)::int * 7919 + 500000) AS sd,
                   (380 + 120 * pg_temp.u((s * 31 + (fl % 100000)::int * 7919 + 500000) + 4)) * (e - fl * 21600) / 3600.0 / 60.0 AS d
            FROM (SELECT s, ts, extract(epoch FROM ts) AS e, floor(extract(epoch FROM ts) / 21600)::bigint AS fl
                  FROM generate_series(0, 9999) s, generate_series(0, 29) k, LATERAL (SELECT h + make_interval(secs => k * 120 + s % 60) AS ts) t) q) r
    ) rows
    ORDER BY ts
    ON CONFLICT (hex, ts) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    COMMIT;
    RAISE NOTICE 'track_point % +% rows in % s', h, n, round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1);
    h := h + interval '1 hour';
  END LOOP;
END $$;

-- ---- ship_position: 시간마다 한 문장(시각 순) — 12,000척, 0..299 번은 매분, 나머지는 분마다 17.1 % → 분당 약 2,300행 ----
DO $$
DECLARE a record; h timestamptz; n bigint; t0 timestamptz;
BEGIN
  SELECT * INTO a FROM pg_temp.qa_anchor;
  h := a.t_start;
  WHILE h < a.t_end LOOP
    t0 := clock_timestamp();
    INSERT INTO ship_position (mmsi, ts, geom, sog_kn, cog_deg, heading_deg, nav_status, position_source, provider)
    SELECT (300000000 + i)::text, ts, ST_SetSRID(ST_MakePoint(lon, lat), 4326), sog, cog, cog::int % 360, CASE WHEN sog < 0.5 THEN 1 ELSE 0 END,
           CASE WHEN i % 7 = 0 THEN NULL ELSE 'epfs' END, 'qa_synthetic'
    FROM (
      SELECT i, ts, sog, cog,
             CASE WHEN i % 20 = 0 THEN pg_temp.tri(33 + 6 * pg_temp.u(i * 5 + 1) + d * cos(radians(cog)), 33.05, 38.95)
                  WHEN i % 3 = 0 THEN pg_temp.tri(28 + 14 * pg_temp.u(i * 5 + 1) + d * cos(radians(cog)), 28, 42)
                  ELSE pg_temp.tri(-45 + 105 * pg_temp.u(i * 5 + 1) + d * cos(radians(cog)), -45, 62) END AS lat,
             CASE WHEN i % 20 = 0 THEN pg_temp.tri(124 + 8 * pg_temp.u(i * 5 + 2) + d * sin(radians(cog)) / 0.8, 124.05, 131.95)
                  WHEN i % 3 = 0 THEN pg_temp.tri(118 + 22 * pg_temp.u(i * 5 + 2) + d * sin(radians(cog)) / 0.8, 118, 140)
                  ELSE pg_temp.wrap(-180 + 360 * pg_temp.u(i * 5 + 2) + d * sin(radians(cog)) / 0.7) END AS lon
      FROM (SELECT i, ts, (20 * pg_temp.u(i * 5 + 3))::real AS sog, floor(360 * pg_temp.u(i * 5 + 4))::real AS cog,
                   20 * pg_temp.u(i * 5 + 3) * (extract(epoch FROM ts) - 1790000000) / 3600.0 / 60.0 AS d
            FROM generate_series(0, 59) m, generate_series(0, 11999) i,
                 LATERAL (SELECT (extract(epoch FROM h)::bigint / 60 + m)::int AS mi) mm,
                 LATERAL (SELECT h + make_interval(mins => m, secs => floor(60 * pg_temp.u(i * 13 + mm.mi))) AS ts) t
            WHERE i < 300 OR pg_temp.u(i * 7 + (mm.mi % 1000000) * 131) < 0.171) q
    ) r
    ORDER BY ts
    ON CONFLICT (mmsi, ts) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    COMMIT;
    RAISE NOTICE 'ship_position % +% rows in % s', h, n, round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1);
    h := h + interval '1 hour';
  END LOOP;
END $$;

-- ---- track_point_1m: 원해상도가 없는 30일(관심 지역 200대 × 1분) — 하루마다 한 문장 ----
DO $$
DECLARE a record; d timestamptz; n bigint;
BEGIN
  SELECT * INTO a FROM pg_temp.qa_anchor;
  d := a.t_30d;
  WHILE d < a.t_start LOOP
    INSERT INTO track_point_1m (hex, ts_minute, geom, alt_ft, gs_kt, n)
    SELECT lpad(to_hex(x'f10000'::int + s * 64 + CASE WHEN s < 10 THEN 0 ELSE (fl % 40)::int END), 6, '0'), ts,
           ST_SetSRID(ST_MakePoint(pg_temp.tri(124 + 7.5 * pg_temp.u(sd + 2) + dd * sin(radians(360 * pg_temp.u(sd + 3))) / 0.8, 123.2, 132.4),
                                   pg_temp.tri(33 + 7 * pg_temp.u(sd + 1) + dd * cos(radians(360 * pg_temp.u(sd + 3))), 32.6, 40.4)), 4326),
           (5000 + 1000 * floor(35 * pg_temp.u(sd + 5)))::int, (250 + 230 * pg_temp.u(sd + 4))::real, 6
    FROM (SELECT s, ts, fl, (s * 31 + (fl % 100000)::int * 7919) AS sd,
                 (250 + 230 * pg_temp.u((s * 31 + (fl % 100000)::int * 7919) + 4)) * (extract(epoch FROM ts) - fl * 7200) / 3600.0 / 60.0 AS dd
          FROM generate_series(0, 199) s, generate_series(0, 1439) k,
               LATERAL (SELECT d + make_interval(mins => k) AS ts) t, LATERAL (SELECT floor(extract(epoch FROM t.ts) / 7200)::bigint AS fl) f
          WHERE d + make_interval(mins => k) < a.t_start) q
    ORDER BY ts
    ON CONFLICT (hex, ts_minute) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    COMMIT;
    RAISE NOTICE 'track_point_1m % +% rows', d, n;
    d := d + interval '1 day';
  END LOOP;
END $$;
-- 원해상도가 있는 구간은 앱의 요약 문장 그대로(MaintenanceJobs.summarizeHour — 관심 지역 bbox 36.5,127.8 r=250 NM)
DO $$
DECLARE a record; h timestamptz; n bigint;
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
    GET DIAGNOSTICS n = ROW_COUNT;
    COMMIT;
    h := h + interval '1 hour';
  END LOOP;
END $$;
SELECT 'track_point_1m', count(*) FROM track_point_1m;

-- ---- alert_event: 하루 40,000건 × 29.5일(2026-10-01 17:00 UTC 까지 — 격리 스택이 실제로 쓴 알림 앞) ----
-- id = epoch ms × 1000 + 500(AlertIds 형식, 실제 알림 id 와 겹치지 않는 시각). sigmet_id 는 그 시각에 유효한 합성 SIGMET.
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
  SELECT j, t, CASE WHEN j % 10 < 7 THEN 'OBSERVED' ELSE 'PREDICTED' END AS kind,
         lpad(to_hex(CASE WHEN j % 4 = 0 THEN x'f10000'::int + (j % 200) * 64 ELSE x'f20000'::int + (j % 10000) * 12 + (j % 12) END), 6, '0') AS hex,
         (10000 + 1000 * (j % 30))::int AS alt
  FROM pg_temp.qa_anchor a0, generate_series(0, (extract(epoch FROM a0.alerts_end - a0.t_30d) / 2.16)::int - 1) j,
       LATERAL (SELECT a0.t_30d + make_interval(secs => j * 2.16) AS t) tt
) z, pg_temp.qa_anchor a
ON CONFLICT DO NOTHING;
SELECT 'alert_event', count(*) FROM alert_event WHERE evidence->>'provider' = 'qa_synthetic';

-- ---- ingest_run(6 s 칸의 8/9 = 하루 약 12,800건) · quality_event(하루 약 3,000건) ----
INSERT INTO ingest_run (job, provider, started_at, finished_at, status, http_status, latency_ms, records_in, records_quarantined, raw_ref, error_text, run_key)
SELECT job, prov, ts, ts + make_interval(secs => lat / 1000.0), CASE WHEN err THEN 'error' ELSE 'ok' END, CASE WHEN err THEN 503 ELSE 200 END, lat,
       CASE WHEN err THEN 0 ELSE recs END, CASE WHEN err THEN 0 ELSE (recs * 0.002)::int END, 'qa_synthetic:' || job,
       CASE WHEN err THEN 'HTTPStatusError: 503 Service Unavailable (qa synthetic)' END, gen_random_uuid()
FROM (
  SELECT ts, job, prov, recs, (80 + floor(900 * pg_temp.u(k))) ::int AS lat, pg_temp.u(k * 3 + 1) < 0.01 AS err
  FROM (SELECT k, a.t_30d + make_interval(secs => k * 6) AS ts,
               CASE WHEN k % 12 = 0 THEN 'global' WHEN k % 6 = 3 THEN 'radar' WHEN k % 30 = 7 THEN 'sigmet' WHEN k % 60 = 11 THEN 'metar' WHEN k % 9 = 5 THEN 'focus'
                    ELSE 'region' END AS job,
               CASE WHEN k % 12 = 0 THEN 'opensky' WHEN k % 6 = 3 THEN 'rainviewer' WHEN k % 30 = 7 OR k % 60 = 11 THEN 'awc' WHEN k % 17 = 0 THEN 'adsb_fi'
                    ELSE 'adsb_lol' END AS prov,
               CASE WHEN k % 12 = 0 THEN 10500 WHEN k % 30 = 7 THEN 130 ELSE 150 END AS recs
        FROM pg_temp.qa_anchor a, generate_series(0, (extract(epoch FROM a.alerts_end - a.t_30d) / 6)::int) k) z
  WHERE z.k % 9 <> 8   -- 시간당 약 530건
) r;
INSERT INTO quality_event (run_id, rule, hex, detail, created_at)
SELECT id, (ARRAY['position_jump', 'altitude_out_of_range', 'stale_timestamp', 'duplicate_hex', 'speed_out_of_range'])[1 + (id % 5)::int],
       lpad(to_hex(x'f20000'::int + (id % 120000)::int), 6, '0'), jsonb_build_object('qa', true, 'value', id % 1000), started_at
FROM ingest_run WHERE raw_ref LIKE 'qa_synthetic:%' AND job IN ('region', 'global') AND id % 4 = 0;
SELECT 'ingest_run', count(*) FROM ingest_run WHERE raw_ref LIKE 'qa_synthetic:%';
SELECT 'quality_event', count(*) FROM quality_event WHERE detail->>'qa' = 'true';

-- ---- metar_obs(감시 공항 × 30분) · radar_frame(10분 × 6.9일) · ingest_gap(60일 3,000건) ----
INSERT INTO metar_obs (icao, obs_time, raw, temp_c, dewp_c, wind_dir, wind_kt, vis_sm, vis_raw, ceiling_ft, flight_cat, flight_cat_source, wx_string, taf_raw,
                       provider, fetched_at, ceiling_state)
SELECT ap.icao, ts, ap.icao || ' ' || to_char(ts, 'DDHH24MI') || 'Z 27010KT 9999 FEW030 BKN045 18/12 Q1012 NOSIG', 18, 12, 270, 10, 6.2, '9999', 4500, 'VFR', 'awc', NULL,
       'TAF ' || ap.icao || ' ' || to_char(ts, 'DDHH24MI') || 'Z 0206/0312 27010KT 9999 FEW030', 'qa_synthetic', ts + interval '3 minutes', 'measured'
FROM airport ap, pg_temp.qa_anchor a, generate_series(a.t_30d, a.t_end - interval '2 hours', interval '30 minutes') ts
ON CONFLICT (icao, obs_time) DO NOTHING;
INSERT INTO radar_frame (frame_time, host, path, fetched_at)
SELECT ts, 'https://tilecache.rainviewer.com', '/v2/radar/qa' || extract(epoch FROM ts)::bigint, ts + interval '1 minute'
FROM pg_temp.qa_anchor a, generate_series(a.t_end - interval '6 days 20 hours', a.t_end - interval '3 hours', interval '10 minutes') ts
ON CONFLICT (frame_time) DO NOTHING;
INSERT INTO ingest_gap (source, started_at, ended_at, reason, provider, scope)
SELECT 'ais', ts, ts + make_interval(secs => 20 + floor(400 * pg_temp.u(k))), 'qa synthetic keepalive timeout', 'qa_synthetic',
       CASE WHEN k % 3 = 0 THEN NULL ELSE '-90,0,90,180' END
FROM pg_temp.qa_anchor a, generate_series(0, 2999) k, LATERAL (SELECT a.t_end - interval '60 days' + make_interval(secs => k * 1728) AS ts) t
ON CONFLICT DO NOTHING;

-- ---- stats_daily: 따라잡기 창(최근 7일) 밖의 날은 앱의 집계 문장 그대로 미리 센다(운영에서는 그날 집계됐을 값) ----
-- 최근 7일은 표식을 지워 api 기동 1분 뒤 따라잡기가 이 데이터로 다시 센다(MaintenanceJobs.catchUp).
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
    IF d >= (a.t_30d AT TIME ZONE 'Asia/Seoul')::date + 1 THEN
      INSERT INTO stats_daily (day, metric, dim, value) SELECT d, 'alerts_by_kind', kind, count(*) FROM alert_event WHERE entered_at >= s AND entered_at < e GROUP BY kind;
      INSERT INTO stats_daily (day, metric, dim, value)
        SELECT d, 'alert_dwell_avg_s', 'OBSERVED', avg(extract(epoch FROM (left_at - entered_at))) FROM alert_event
        WHERE kind = 'OBSERVED' AND left_at IS NOT NULL AND entered_at >= s AND entered_at < e AND close_reason = 'left' HAVING count(*) > 0;
      INSERT INTO stats_daily (day, metric, dim, value) VALUES (d, 'aggregated_at', 'alerts', extract(epoch FROM now())::bigint);
      -- 교통량(그날 원해상도 항적은 이미 지워졌다 — 운영에서는 그날 세어 둔 값): 시마다 150–250대
      INSERT INTO stats_daily (day, metric, dim, value) SELECT d, 'traffic_by_hour', lpad(hh::text, 2, '0'), 150 + floor(100 * pg_temp.u(hh + (d - date '2026-01-01') * 24)) FROM generate_series(0, 23) hh;
      INSERT INTO stats_daily (day, metric, dim, value) VALUES (d, 'traffic_region', 'center_lat', 36.5), (d, 'traffic_region', 'center_lon', 127.8), (d, 'traffic_region', 'radius_nm', 250),
                                                               (d, 'aggregated_at', 'traffic', extract(epoch FROM now())::bigint);
    END IF;
  END LOOP;
  -- 최근 7일: 앱이 다시 세도록 sigmet · alerts 표식을 지운다(교통량은 원해상도가 보존 안인 날만 앱이 센다 — 그 밖의 날은 위와 같이 미리 둔다)
  DELETE FROM stats_daily WHERE day BETWEEN today - 7 AND today - 1 AND metric = 'aggregated_at' AND dim IN ('sigmet', 'alerts');
  FOR d IN SELECT generate_series(today - 7, today - 4, interval '1 day')::date LOOP
    IF NOT EXISTS (SELECT 1 FROM stats_daily WHERE day = d AND metric = 'aggregated_at' AND dim = 'traffic') THEN
      INSERT INTO stats_daily (day, metric, dim, value) SELECT d, 'traffic_by_hour', lpad(hh::text, 2, '0'), 150 + floor(100 * pg_temp.u(hh + (d - date '2026-01-01') * 24)) FROM generate_series(0, 23) hh;
      INSERT INTO stats_daily (day, metric, dim, value) VALUES (d, 'traffic_region', 'center_lat', 36.5), (d, 'traffic_region', 'center_lon', 127.8), (d, 'traffic_region', 'radius_nm', 250),
                                                               (d, 'aggregated_at', 'traffic', extract(epoch FROM now())::bigint);
    END IF;
  END LOOP;
END $$;
SELECT 'stats_daily', count(*) FROM stats_daily;
