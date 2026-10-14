-- QA 2026-10 AWS 성능: 따라잡기의 지정 보존 복사(MaintenanceJobs.runCatchUp → copyRetained) 창을 고치기 전(70 h)과 고친 뒤(365일 — QA-1201)로 번갈아 잰다.
-- 같은 자료 · 같은 연결에서 두 번씩(캐시 순서 효과를 나눠 본다). 쓰는 문장은 BEGIN … ROLLBACK. 끝에 특보 끝내기 UPDATE(기본 키 한 건)도.
--   docker exec -i wlqa-a-db-1 psql -X -U postgres -d wakeline < tools/qa/perf_explain_retained_window.sql
\timing on
SET TimeZone = 'UTC';
\echo '== 특보 끝내기 UPDATE(기본 키 한 건 — 고친 측정)'
SELECT min(id) AS open_id FROM wx_warning WHERE ended_at IS NULL AND last_seen < now() \gset
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
UPDATE wx_warning SET ended_at = CASE WHEN now() - interval '10 minutes' > last_seen THEN now() - interval '10 minutes' ELSE now() END
WHERE id = :open_id AND ended_at IS NULL AND last_seen < now();
ROLLBACK;
\echo '== 지정 보존 복사(항공기 10) — 창 70 hours'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, alt_ft, gs_kt, track_deg, provider)
SELECT DISTINCT ON (hex, date_trunc('minute', ts)) 'aircraft', hex::text, date_trunc('minute', ts), ts, geom, alt_ft, gs_kt, track_deg, provider
FROM track_point WHERE hex IN ('f10000','f10040','f10080','f100c0','f10100','f10140','f10180','f101c0','f10200','f10240')
  AND ts >= date_trunc('hour', now()) - interval '70 hours' AND ts < date_trunc('hour', now())
ORDER BY hex, date_trunc('minute', ts), ts ON CONFLICT (kind, target_id, ts_minute) DO NOTHING;
ROLLBACK;
\echo '== 지정 보존 복사(항공기 10) — 창 365 days'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, alt_ft, gs_kt, track_deg, provider)
SELECT DISTINCT ON (hex, date_trunc('minute', ts)) 'aircraft', hex::text, date_trunc('minute', ts), ts, geom, alt_ft, gs_kt, track_deg, provider
FROM track_point WHERE hex IN ('f10000','f10040','f10080','f100c0','f10100','f10140','f10180','f101c0','f10200','f10240')
  AND ts >= date_trunc('hour', now()) - interval '365 days' AND ts < date_trunc('hour', now())
ORDER BY hex, date_trunc('minute', ts), ts ON CONFLICT (kind, target_id, ts_minute) DO NOTHING;
ROLLBACK;
\echo '== 지정 보존 복사(항공기 10) — 창 70 hours'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, alt_ft, gs_kt, track_deg, provider)
SELECT DISTINCT ON (hex, date_trunc('minute', ts)) 'aircraft', hex::text, date_trunc('minute', ts), ts, geom, alt_ft, gs_kt, track_deg, provider
FROM track_point WHERE hex IN ('f10000','f10040','f10080','f100c0','f10100','f10140','f10180','f101c0','f10200','f10240')
  AND ts >= date_trunc('hour', now()) - interval '70 hours' AND ts < date_trunc('hour', now())
ORDER BY hex, date_trunc('minute', ts), ts ON CONFLICT (kind, target_id, ts_minute) DO NOTHING;
ROLLBACK;
\echo '== 지정 보존 복사(항공기 10) — 창 365 days'
BEGIN;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, alt_ft, gs_kt, track_deg, provider)
SELECT DISTINCT ON (hex, date_trunc('minute', ts)) 'aircraft', hex::text, date_trunc('minute', ts), ts, geom, alt_ft, gs_kt, track_deg, provider
FROM track_point WHERE hex IN ('f10000','f10040','f10080','f100c0','f10100','f10140','f10180','f101c0','f10200','f10240')
  AND ts >= date_trunc('hour', now()) - interval '365 days' AND ts < date_trunc('hour', now())
ORDER BY hex, date_trunc('minute', ts), ts ON CONFLICT (kind, target_id, ts_minute) DO NOTHING;
ROLLBACK;
