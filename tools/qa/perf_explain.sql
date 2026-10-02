-- QA 성능(계획 §3.5 '느린 쿼리'): 격리 스택 A 의 합성 데이터(seed_perf.sql) 위에서 api 가 내는 핵심 문장의 실행 계획.
--   docker exec -i wakeline-e2e-db-1 psql -U postgres -d wakeline < tools/qa/perf_explain.sql
-- 문장은 api 코드의 SQL 그대로(파라미터는 리터럴로 — 서버 준비 문장의 일반 계획과 다를 수 있다). 시각은 실행 시각 기준.
\timing on
SET TimeZone = 'UTC';
SET statement_timeout = '120s';

\echo '== replay.track_point (TrackRepository.replay) — 관심 지역 bbox, 30분 전'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT DISTINCT ON (hex) hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, on_ground, provider, false averaged
FROM track_point WHERE ts BETWEEN now() - interval '30 minutes' - interval '3 minutes' AND now() - interval '30 minutes'
  AND geom && ST_MakeEnvelope(124, 33, 132, 39, 4326) ORDER BY hex, ts DESC;

\echo '== replay.track_point — 넓은 bbox(2,500 sq°), 40 h 전'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT DISTINCT ON (hex) hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, on_ground, provider, false averaged
FROM track_point WHERE ts BETWEEN now() - interval '40 hours' - interval '3 minutes' AND now() - interval '40 hours'
  AND geom && ST_MakeEnvelope(100, 10, 150, 60, 4326) ORDER BY hex, ts DESC;

\echo '== replay.track_point_1m — 10일 전'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT DISTINCT ON (hex) hex, ts_minute ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, NULL::real track_deg, NULL::boolean on_ground, '1m_summary' provider, true averaged, n samples
FROM track_point_1m WHERE ts_minute BETWEEN now() - interval '10 days' - interval '3 minutes' AND now() - interval '10 days'
  AND geom && ST_MakeEnvelope(124, 33, 132, 39, 4326) ORDER BY hex, ts_minute DESC;

\echo '== replay.sigmet (SigmetRepository.validAt) — 넓은 bbox, 25일 전'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, fir_id, fir_name, hazard, qualifier, base_ft, top_ft, base_source, top_source, valid_from, valid_to, withdrawn_at, excluded_reason, raw_text, provider, ST_AsGeoJSON(geom)::text geometry
FROM sigmet WHERE valid_from <= now() - interval '25 days' AND valid_to > now() - interval '25 days' AND coalesce(withdrawn_at, valid_to) > now() - interval '25 days'
  AND (geom IS NULL OR geom && ST_MakeEnvelope(100, 10, 150, 60, 4326)) ORDER BY fir_id, series_id;

\echo '== aircraft.track (TrackRepository.track) — 72 h 내내 같은 hex, 기본 2 h · 24 h(상한)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, provider FROM track_point
WHERE hex = 'f10000' AND ts BETWEEN now() - interval '2 hours' AND now() ORDER BY ts LIMIT 5001;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, provider FROM track_point
WHERE hex = 'f10000' AND ts BETWEEN now() - interval '24 hours' AND now() ORDER BY ts LIMIT 5001;

\echo '== ship.track (ShipRepository.track) — 6 h'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT ts, ST_X(geom) lon, ST_Y(geom) lat, sog_kn, cog_deg, heading_deg, nav_status, position_source, provider
FROM ship_position WHERE mmsi = '300000001' AND ts BETWEEN now() - interval '6 hours' AND now() ORDER BY ts LIMIT 5001;

\echo '== alerts.history (AlertRepository.history) — 기본 24 h · 오래된 좁은 창(25일 전 1 h) · hex'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.close_reason, e.eta_s, e.alt_ft_at_entry, e.evidence::text evidence
FROM alert_event e JOIN sigmet s ON s.id = e.sigmet_id
WHERE e.entered_at BETWEEN now() - interval '1 day' AND now() AND (NULL::bigint IS NULL OR e.id < NULL::bigint) ORDER BY e.id DESC LIMIT 51;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.close_reason, e.eta_s, e.alt_ft_at_entry, e.evidence::text evidence
FROM alert_event e JOIN sigmet s ON s.id = e.sigmet_id
WHERE e.entered_at BETWEEN now() - interval '25 days' AND now() - interval '25 days' + interval '1 hour' AND (NULL::bigint IS NULL OR e.id < NULL::bigint) ORDER BY e.id DESC LIMIT 51;

\echo '== stats.days · stats.sigmet 92일'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT to_char(day, 'YYYY-MM-DD') AS day, dim, value FROM stats_daily WHERE metric = 'sigmet_by_fir' AND day BETWEEN current_date - 92 AND current_date ORDER BY 1, dim;

\echo '== 관측 수신 격자 부트스트랩 한 시(JdbcCoverageSource.SQL)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT floor(ST_X(geom) * 2)::int AS lon_idx, floor(ST_Y(geom) * 2)::int AS lat_idx, mmsi, count(*)::int AS n, max(ts) AS last
FROM ship_position WHERE ts >= date_trunc('hour', now()) - interval '5 hours' AND ts < date_trunc('hour', now()) - interval '4 hours' GROUP BY 1, 2, 3;

\echo '== 1분 요약 한 시(MaintenanceJobs.summarizeHour — SELECT 부분)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT hex, date_trunc('minute', ts) m, ST_SetSRID(ST_MakePoint(avg(ST_X(geom)), avg(ST_Y(geom))), 4326), avg(alt_ft)::int, avg(gs_kt), count(*)
FROM track_point WHERE ts >= date_trunc('hour', now()) - interval '3 hours' AND ts < date_trunc('hour', now()) - interval '2 hours'
  AND geom && ST_MakeEnvelope(122.6, 32.33, 133.0, 40.67, 4326) GROUP BY hex, m;

\echo '== 교통량 하루(MaintenanceJobs.aggregateFamilies — SELECT 부분, work_mem 64MB)'
SET work_mem = '64MB';
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT lpad(extract(hour FROM ts AT TIME ZONE 'Asia/Seoul')::int::text, 2, '0'), count(DISTINCT hex) FROM track_point
WHERE ts >= (current_date - 1)::timestamp AT TIME ZONE 'Asia/Seoul' AND ts < current_date::timestamp AT TIME ZONE 'Asia/Seoul'
  AND geom && ST_MakeEnvelope(122.6, 32.33, 133.0, 40.67, 4326) GROUP BY 1;
RESET work_mem;
