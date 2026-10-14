since 2026-10-14T09:04:07Z until 2026-10-14T10:01:00Z: 127 statements ≥ log_min_duration_statement, 13 groups
| 건수 | 가운데 ms | 최대 ms | 처음 | 마지막 | 문장(앞 160자) |
|---|---|---|---|---|---|
| 2 | 4563 | 4810 | 09:25:32 | 09:43:44 | `INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, alt_ft, gs_kt, track_deg, provider) SELECT DISTINCT ON (hex, date_trunc('minute', ts)) 'aircra` |
| 44 | 163 | 503 | 09:18:50 | 09:57:01 | `INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, vrate_fpm, on_ground, squawk, provider, fetched_at, quality) VALUES ($1, $2, ST_SetSRID(ST_Mak` |
| 32 | 121 | 228 | 09:35:18 | 09:55:25 | `/* wakeline replay.track_point limit_s=3 */ SELECT DISTINCT ON (hex) hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, on_ground, provider, fal` |
| 19 | 150 | 324 | 09:18:50 | 09:55:00 | `INSERT INTO aircraft (hex, registration, type_code, category, source, first_seen, last_seen) SELECT t.hex, t.reg, t.type, t.cat, t.src, t.seen, t.seen FROM json` |
| 10 | 261 | 530 | 09:25:26 | 09:43:39 | `INSERT INTO track_point_1m (hex, ts_minute, geom, alt_ft, gs_kt, n) SELECT hex, date_trunc('minute', ts) m, ST_SetSRID(ST_MakePoint(avg(ST_X(geom)), avg(ST_Y(ge` |
| 2 | 1440 | 1607 | 09:25:33 | 09:43:46 | `INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, sog_kn, cog_deg, provider) SELECT DISTINCT ON (mmsi, date_trunc('minute', ts)) 'ship', mmsi::t` |
| 7 | 120 | 153 | 09:24:56 | 09:43:08 | `SELECT floor(ST_X(geom) * 2)::int AS lon_idx, floor(ST_Y(geom) * 2)::int AS lat_idx, mmsi, count(*)::int AS n, max(ts) AS last FROM ship_position WHERE ts >= $1` |
| 4 | 156 | 294 | 09:27:35 | 09:53:29 | `/* wakeline replay.sigmet limit_s=3 */ SELECT id, fir_id, fir_name, hazard, qualifier, base_ft, top_ft, base_source, top_source, valid_from, valid_to, withdrawn` |
| 2 | 154 | 163 | 09:24:26 | 09:42:38 | `UPDATE alert_event SET left_at = now(), close_reason = $1 WHERE left_at IS NULL AND id < $2` |
| 2 | 118 | 128 | 09:35:18 | 09:55:19 | `/* wakeline replay.track_point_1m limit_s=3 */ SELECT DISTINCT ON (hex) hex, ts_minute ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, NULL::real track_deg, ` |
| 1 | 118 | 118 | 09:43:09 | 09:43:09 | `COMMIT;` |
| 1 | 104 | 104 | 09:54:58 | 09:54:58 | `/* wakeline aircraft.search limit_s=3 */ SELECT hex, registration, type_code, last_seen FROM aircraft WHERE (upper(hex) ~>=~ $1 AND upper(hex) ~<~ $2) OR (upper` |
| 1 | 102 | 102 | 09:24:57 | 09:24:57 | `INSERT INTO ship AS s (mmsi, name, call_sign, imo, ship_type, dim_a, dim_b, dim_c, dim_d, draught_m, destination, eta_month, eta_day, eta_hour, eta_minute, firs` |
