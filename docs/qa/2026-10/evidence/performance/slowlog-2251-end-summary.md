since 2026-10-01T22:51:00Z: 174 statements ≥ log_min_duration_statement, 16 groups
| 건수 | 가운데 ms | 최대 ms | 처음 | 마지막 | 문장(앞 160자) |
|---|---|---|---|---|---|
| 3 | 8774 | 9508 | 23:16:01 | 23:16:32 | `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.close_rea` |
| 10 | 2002 | 2829 | 23:17:15 | 23:56:56 | `/* wakeline alerts.history limit_s=3 */ SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.close_r` |
| 3 | 5120 | 5678 | 23:16:07 | 23:16:38 | `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT lpad(extract(hour FROM ts AT TIME ZONE 'Asia/Seoul')::int::text, 2, '0'), count(DISTINCT hex) FROM track_point WHER` |
| 55 | 155 | 529 | 23:15:54 | 23:56:08 | `INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, vrate_fpm, on_ground, squawk, provider, fetched_at, quality) VALUES ($1, $2, ST_SetSRID(ST_Mak` |
| 55 | 126 | 378 | 23:18:59 | 23:56:45 | `/* wakeline replay.sigmet limit_s=3 */ SELECT id, fir_id, fir_name, hazard, qualifier, base_ft, top_ft, base_source, top_source, valid_from, valid_to, withdrawn` |
| 15 | 194 | 558 | 23:17:55 | 23:56:06 | `INSERT INTO aircraft (hex, registration, type_code, category, source, first_seen, last_seen) SELECT t.hex, t.reg, t.type, t.cat, t.src, t.seen, t.seen FROM json` |
| 2 | 836 | 862 | 23:16:08 | 23:16:24 | `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, provider FROM track_point WHERE hex = 'f10000' A` |
| 10 | 139 | 207 | 23:39:33 | 23:39:35 | `SELECT floor(ST_X(geom) * 2)::int AS lon_idx, floor(ST_Y(geom) * 2)::int AS lat_idx, mmsi, count(*)::int AS n, max(ts) AS last FROM ship_position WHERE ts >= $1` |
| 8 | 131 | 192 | 23:18:59 | 23:27:12 | `/* wakeline replay.track_point limit_s=3 */ SELECT DISTINCT ON (hex) hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, on_ground, provider, fal` |
| 3 | 279 | 500 | 23:16:02 | 23:16:33 | `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT hex, date_trunc('minute', ts) m, ST_SetSRID(ST_MakePoint(avg(ST_X(geom)), avg(ST_Y(geom))), 4326), avg(alt_ft)::int` |
| 3 | 194 | 228 | 23:16:02 | 23:16:32 | `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT floor(ST_X(geom) * 2)::int AS lon_idx, floor(ST_Y(geom) * 2)::int AS lat_idx, mmsi, count(*)::int AS n, max(ts) AS ` |
| 2 | 150 | 190 | 23:21:58 | 23:23:28 | `/* wakeline ship.track limit_s=3 */ SELECT ts, ST_X(geom) lon, ST_Y(geom) lat, sog_kn, cog_deg, heading_deg, nav_status, position_source, provider FROM ship_pos` |
| 1 | 256 | 256 | 23:39:04 | 23:39:04 | `UPDATE alert_event SET left_at = now(), close_reason = $1 WHERE left_at IS NULL AND id < $2` |
| 2 | 107 | 110 | 23:16:07 | 23:16:23 | `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id, fir_id, fir_name, hazard, qualifier, base_ft, top_ft, base_source, top_source, valid_from, valid_to, withdrawn_` |
| 1 | 135 | 135 | 23:16:23 | 23:16:23 | `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT DISTINCT ON (hex) hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, on_ground, provider, false ave` |
| 1 | 104 | 104 | 23:47:19 | 23:47:19 | `UPDATE sigmet SET withdrawn_at = $1 WHERE withdrawn_at IS NULL AND valid_to > $2 AND first_seen <= $3 AND provider IN (SELECT jsonb_array_elements_text($4::json` |
