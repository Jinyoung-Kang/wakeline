-- QA 2026-10 AWS 성능(docs/qa/2026-10-aws QA-PLAN §3.5 '느린 쿼리'): QA 고침(QA-1200 · 1201 · 1202 · 1203)이 바꾼 경로와 특보 이력 · /watch · /alerts/{id} 의
-- 실행 계획과 걸린 시간 — 격리 QA 스택(wlqa-a)의 합성 자료(seed_perf_aws.sql 또는 seed_perf.sql + seed_perf_r2.sql) 위에서.
--   docker exec -i wlqa-a-db-1 psql -X -U postgres -d wakeline < tools/qa/perf_explain_aws.sql
-- 쓰는 문장은 모두 BEGIN … ROLLBACK 안에서 잰다(자료를 바꾸지 않는다). 문장은 api 코드 그대로, 파라미터는 리터럴(맞춤 계획 — 준비 문장의 일반 계획과
-- 다를 수 있다). 관심 지역 bbox = RegionSettings.Region.bbox()(36.5, 127.8, 250 NM): 122.6167, 32.3333, 132.9833, 40.6667.
\timing on
SET TimeZone = 'UTC';
SET statement_timeout = '600s';

\echo '== 자료 크기(표 · 색인 포함)'
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS size, reltuples::bigint AS est_rows
FROM pg_class WHERE relkind IN ('r', 'p') AND relnamespace = 'public'::regnamespace AND pg_total_relation_size(oid) > 1048576 ORDER BY pg_total_relation_size(oid) DESC;
SELECT pg_size_pretty(pg_database_size('wakeline')) AS db_size;
\echo '== 남은 일 파티션'
SELECT p.relname AS parent, c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname IN ('track_point', 'ship_position') ORDER BY 1, 2;

\echo '== 따라잡기 1: 가장 오래된 항적 파티션(MaintenanceJobs.oldestPartitionStart — 카탈로그만)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT min(substring(c.relname from '^' || 'track_point' || '_([0-9]{8})$'))
FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'track_point';

\echo '== 따라잡기 2: 옛 시간 확인(catchUpSummaries — 요약 없음 AND 원본 있음) — 12 h 전 · 가장 오래된 파티션의 첫 시간'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT NOT EXISTS (SELECT 1 FROM track_point_1m WHERE ts_minute >= date_trunc('hour', now()) - interval '12 hours' AND ts_minute < date_trunc('hour', now()) - interval '11 hours')
   AND EXISTS (SELECT 1 FROM track_point WHERE ts >= date_trunc('hour', now()) - interval '12 hours' AND ts < date_trunc('hour', now()) - interval '11 hours'
               AND geom && ST_MakeEnvelope(122.6167, 32.3333, 132.9833, 40.6667, 4326));
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT NOT EXISTS (SELECT 1 FROM track_point_1m WHERE ts_minute >= date_trunc('day', now()) - interval '2 days' AND ts_minute < date_trunc('day', now()) - interval '2 days' + interval '1 hour')
   AND EXISTS (SELECT 1 FROM track_point WHERE ts >= date_trunc('day', now()) - interval '2 days' AND ts < date_trunc('day', now()) - interval '2 days' + interval '1 hour'
               AND geom && ST_MakeEnvelope(122.6167, 32.3333, 132.9833, 40.6667, 4326));

\echo '== 따라잡기 3: 최근 6 h 다시 요약 중 한 시간(summarizeHour — 2 h 전, 이미 요약된 시간 · INSERT … ON CONFLICT DO NOTHING · 되돌림)'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
INSERT INTO track_point_1m (hex, ts_minute, geom, alt_ft, gs_kt, n)
SELECT hex, date_trunc('minute', ts) m, ST_SetSRID(ST_MakePoint(avg(ST_X(geom)), avg(ST_Y(geom))), 4326), avg(alt_ft)::int, avg(gs_kt), count(*)
FROM track_point
WHERE ts >= date_trunc('hour', now()) - interval '2 hours' AND ts < date_trunc('hour', now()) - interval '1 hour'
  AND geom && ST_MakeEnvelope(122.6167, 32.3333, 132.9833, 40.6667, 4326)
GROUP BY hex, m
ON CONFLICT (hex, ts_minute) DO NOTHING;
ROLLBACK;

\echo '== 따라잡기 4: 요약 부분 전체를 코드와 같은 순서로(창 = 가장 오래된 파티션 ~ 지금, 최근 6 h 는 다시 요약, 그 앞은 확인만 — 되돌림)'
BEGIN;
DO $$
DECLARE cur timestamptz := date_trunc('hour', now()); oldest timestamptz; first timestamptz; h timestamptz; missing boolean; n int;
        t0 timestamptz := clock_timestamp(); t1 timestamptz; t_check interval := '0'; t_sum interval := '0'; checks int := 0; sums int := 0; rows_new int := 0;
BEGIN
  SELECT to_date(min(substring(c.relname from '^track_point_([0-9]{8})$')), 'YYYYMMDD')::timestamp AT TIME ZONE 'UTC' INTO oldest
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'track_point';
  first := greatest(oldest, cur - interval '30 days');
  h := first;
  WHILE h < cur LOOP
    t1 := clock_timestamp();
    IF h >= cur - interval '6 hours' THEN
      INSERT INTO track_point_1m (hex, ts_minute, geom, alt_ft, gs_kt, n)
      SELECT hex, date_trunc('minute', ts) m, ST_SetSRID(ST_MakePoint(avg(ST_X(geom)), avg(ST_Y(geom))), 4326), avg(alt_ft)::int, avg(gs_kt), count(*)
      FROM track_point WHERE ts >= h AND ts < h + interval '1 hour' AND geom && ST_MakeEnvelope(122.6167, 32.3333, 132.9833, 40.6667, 4326)
      GROUP BY hex, m ON CONFLICT (hex, ts_minute) DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT; rows_new := rows_new + n; sums := sums + 1; t_sum := t_sum + (clock_timestamp() - t1);
    ELSE
      SELECT NOT EXISTS (SELECT 1 FROM track_point_1m WHERE ts_minute >= h AND ts_minute < h + interval '1 hour')
         AND EXISTS (SELECT 1 FROM track_point WHERE ts >= h AND ts < h + interval '1 hour' AND geom && ST_MakeEnvelope(122.6167, 32.3333, 132.9833, 40.6667, 4326))
        INTO missing;
      checks := checks + 1; t_check := t_check + (clock_timestamp() - t1);
      IF missing THEN RAISE NOTICE 'hour % has raw rows but no summary', h; END IF;
    END IF;
    h := h + interval '1 hour';
  END LOOP;
  RAISE NOTICE 'catch-up summaries: window % → % (% h) · checks % in % · re-summarized % h in % (new rows %) · total %',
    first, cur, extract(epoch FROM cur - first) / 3600, checks, t_check, sums, t_sum, rows_new, clock_timestamp() - t0;
END $$;
ROLLBACK;

\echo '== 따라잡기 5: 지정 보존 복사 — 창 365일(QA-1201 — 대상 20 · 이미 옮긴 뒤 = 평상시의 비용 · 되돌림)'
SELECT value #>> '{}' AS retain_targets FROM app_setting WHERE key = 'retain_targets';
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, alt_ft, gs_kt, track_deg, provider)
SELECT DISTINCT ON (hex, date_trunc('minute', ts)) 'aircraft', hex::text, date_trunc('minute', ts), ts, geom, alt_ft, gs_kt, track_deg, provider
FROM track_point WHERE hex IN ('f10000','f10040','f10080','f100c0','f10100','f10140','f10180','f101c0','f10200','f10240')
  AND ts >= date_trunc('hour', now()) - interval '365 days' AND ts < date_trunc('hour', now())
ORDER BY hex, date_trunc('minute', ts), ts
ON CONFLICT (kind, target_id, ts_minute) DO NOTHING;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, sog_kn, cog_deg, provider)
SELECT DISTINCT ON (mmsi, date_trunc('minute', ts)) 'ship', mmsi::text, date_trunc('minute', ts), ts, geom, sog_kn, cog_deg, provider
FROM ship_position WHERE mmsi IN ('300000010','300000011','300000012','300000013','300000014','300000015','300000016','300000017','300000018','300000019')
  AND ts >= date_trunc('hour', now()) - interval '365 days' AND ts < date_trunc('hour', now())
ORDER BY mmsi, date_trunc('minute', ts), ts
ON CONFLICT (kind, target_id, ts_minute) DO NOTHING;
ROLLBACK;

\echo '== 매시 지정 보존 복사 — 창 3 h(copyRetained() — 비교)'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, alt_ft, gs_kt, track_deg, provider)
SELECT DISTINCT ON (hex, date_trunc('minute', ts)) 'aircraft', hex::text, date_trunc('minute', ts), ts, geom, alt_ft, gs_kt, track_deg, provider
FROM track_point WHERE hex IN ('f10000','f10040','f10080','f100c0','f10100','f10140','f10180','f101c0','f10200','f10240')
  AND ts >= date_trunc('hour', now()) - interval '3 hours' AND ts < date_trunc('hour', now())
ORDER BY hex, date_trunc('minute', ts), ts
ON CONFLICT (kind, target_id, ts_minute) DO NOTHING;
ROLLBACK;

\echo '== 따라잡기 6: 옛 날 통계 채우기의 시작 날(backfillStats — SIGMET · 알림의 최솟값) · 표식 읽기'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT (least((SELECT min(valid_from) FROM sigmet), (SELECT min(entered_at) FROM alert_event)) AT TIME ZONE 'Asia/Seoul')::date;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT day, dim FROM stats_daily WHERE metric = 'aggregated_at' AND day BETWEEN current_date - 400 AND current_date - 8;

\echo '== 특보 끝내기(WarningRepository.persist — QA-1203: 목록마다 이 목록 앞에 본 열린 행을 읽고, 빠진 행마다 UPDATE 한 번 · 되돌림)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id FROM wx_warning WHERE ended_at IS NULL AND last_seen < now() ORDER BY id;
SELECT min(id) AS open_id FROM wx_warning WHERE ended_at IS NULL AND last_seen < now() \gset
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
UPDATE wx_warning SET ended_at = CASE WHEN now() - interval '10 minutes' > last_seen THEN now() - interval '10 minutes' ELSE now() END
WHERE id = :open_id AND ended_at IS NULL AND last_seen < now();
ROLLBACK;

\echo '== 특보 이력(warnings.history) — 기본 24 h · 200 / 30일 × 500(상한) / 구역 하나 30일'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT zone_code, zone_name, parent_code, parent_name, sea, kind, level, command, preliminary, issued_at, effective_at, effective_from,
       effective_to, effective_text, end_notice, raw, provider, first_seen, last_seen, ended_at
FROM wx_warning WHERE first_seen <= now() AND coalesce(ended_at, last_seen) >= now() - interval '24 hours'
ORDER BY first_seen DESC, id DESC LIMIT 200;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT zone_code, zone_name, parent_code, parent_name, sea, kind, level, command, preliminary, issued_at, effective_at, effective_from,
       effective_to, effective_text, end_notice, raw, provider, first_seen, last_seen, ended_at
FROM wx_warning WHERE first_seen <= now() AND coalesce(ended_at, last_seen) >= now() - interval '30 days'
ORDER BY first_seen DESC, id DESC LIMIT 501;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT zone_code, zone_name, parent_code, parent_name, sea, kind, level, command, preliminary, issued_at, effective_at, effective_from,
       effective_to, effective_text, end_notice, raw, provider, first_seen, last_seen, ended_at
FROM wx_warning WHERE first_seen <= now() AND coalesce(ended_at, last_seen) >= now() - interval '30 days' AND zone_code = 'S1000002'
ORDER BY first_seen DESC, id DESC LIMIT 200;

\echo '== /watch — 관심 공항 20(airports.watch)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT a.icao, a.name, m.obs_time, m.flight_cat, m.flight_cat_source
FROM airport a
LEFT JOIN LATERAL (SELECT obs_time, flight_cat, flight_cat_source FROM metar_obs mo WHERE mo.icao = a.icao ORDER BY obs_time DESC LIMIT 1) m ON true
WHERE a.icao IN ('RKSI','RKSS','RKPC','RKPK','RJFF','RJTT','RJAA','RCTP','VHHH','ZSPD','RKTN','RKTU','RKJJ','RKNY','RKJB','RKPU','RKTH','RJBB','RJCC','ZBAA')
ORDER BY a.icao;

\echo '== /alerts/{id} — alerts.by_id(가장 최근 합성 알림) · alerts.sigmet_copy'
SELECT id AS alert_id, sigmet_id AS alert_sigmet FROM alert_event WHERE evidence->>'provider' = 'qa_synthetic' ORDER BY entered_at DESC LIMIT 1 \gset
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.close_reason, e.eta_s,
       CASE WHEN e.kind = 'PREDICTED' AND e.eta_s IS NOT NULL AND e.evidence->>'entry' IS NOT NULL AND e.evidence->>'judged_at' IS NOT NULL
            THEN (e.evidence->>'judged_at')::timestamptz + make_interval(secs => e.eta_s) END eta_at,
       e.alt_ft_at_entry, e.evidence::text evidence, e.zone_type, e.level,
       a.id airspace_id, a.category airspace_category, a.type_ko airspace_type_ko, a.ident airspace_ident, a.name airspace_name,
       ed.label airspace_edition
FROM alert_event e LEFT JOIN sigmet s ON s.id = e.sigmet_id
LEFT JOIN airspace a ON a.id = e.airspace_id LEFT JOIN airspace_edition ed ON ed.id = a.edition_id
WHERE e.id = :alert_id;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, fir_id, fir_name, hazard, qualifier, base_ft, top_ft, base_source, top_source, valid_from, valid_to, withdrawn_at, raw_text, provider
FROM sigmet WHERE id = :'alert_sigmet';
