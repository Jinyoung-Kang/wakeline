since 2026-10-01T22:03:30Z until 2026-10-01T23:14:00Z: 126 statements ≥ log_min_duration_statement, 8 groups
| 건수 | 가운데 ms | 최대 ms | 처음 | 마지막 | 문장(앞 160자) |
|---|---|---|---|---|---|
| 87 | 142 | 638 | 22:51:47 | 22:52:24 | `/* wakeline replay.track_point limit_s=3 */ SELECT DISTINCT ON (hex) hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, on_ground, provider, fal` |
| 17 | 129 | 630 | 22:51:48 | 22:55:48 | `INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, vrate_fpm, on_ground, squawk, provider, fetched_at, quality) VALUES ($1, $2, ST_SetSRID(ST_Mak` |
| 9 | 145 | 313 | 22:51:47 | 23:09:52 | `INSERT INTO aircraft (hex, registration, type_code, category, source, first_seen, last_seen) SELECT t.hex, t.reg, t.type, t.cat, t.src, t.seen, t.seen FROM json` |
| 1 | 1115 | 1115 | 23:05:01 | 23:05:01 | `INSERT INTO track_point_1m (hex, ts_minute, geom, alt_ft, gs_kt, n) SELECT hex, date_trunc('minute', ts) m, ST_SetSRID(ST_MakePoint(avg(ST_X(geom)), avg(ST_Y(ge` |
| 4 | 131 | 506 | 22:51:55 | 22:52:12 | `/* wakeline ship.track limit_s=3 */ SELECT ts, ST_X(geom) lon, ST_Y(geom) lat, sog_kn, cog_deg, heading_deg, nav_status, position_source, provider FROM ship_pos` |
| 5 | 119 | 172 | 22:51:48 | 22:52:09 | `/* wakeline replay.sigmet limit_s=3 */ SELECT id, fir_id, fir_name, hazard, qualifier, base_ft, top_ft, base_source, top_source, valid_from, valid_to, withdrawn` |
| 2 | 150 | 177 | 22:51:51 | 22:52:23 | `/* wakeline aircraft.search limit_s=3 */ SELECT hex, registration, type_code, last_seen FROM aircraft WHERE (upper(hex) ~>=~ $1 AND upper(hex) ~<~ $2) OR (upper` |
| 1 | 109 | 109 | 22:52:24 | 22:52:24 | `UPDATE sigmet SET withdrawn_at = $1 WHERE withdrawn_at IS NULL AND valid_to > $2 AND first_seen <= $3 AND provider IN (SELECT jsonb_array_elements_text($4::json` |
