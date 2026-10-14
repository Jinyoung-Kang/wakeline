since 2026-10-14T07:30:48Z until 2026-10-14T08:20:40Z: 6 statements ≥ log_min_duration_statement, 4 groups
| 건수 | 가운데 ms | 최대 ms | 처음 | 마지막 | 문장(앞 160자) |
|---|---|---|---|---|---|
| 3 | 233 | 245 | 07:31:57 | 08:05:35 | `INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, alt_ft, gs_kt, track_deg, provider) SELECT DISTINCT ON (hex, date_trunc('minute', ts)) 'aircra` |
| 1 | 129 | 129 | 07:38:00 | 07:38:00 | `COMMIT;` |
| 1 | 103 | 103 | 08:05:35 | 08:05:35 | `INSERT INTO track_point_1m (hex, ts_minute, geom, alt_ft, gs_kt, n) SELECT hex, date_trunc('minute', ts) m, ST_SetSRID(ST_MakePoint(avg(ST_X(geom)), avg(ST_Y(ge` |
| 1 | 103 | 103 | 08:05:36 | 08:05:36 | `INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, sog_kn, cog_deg, provider) SELECT DISTINCT ON (mmsi, date_trunc('minute', ts)) 'ship', mmsi::t` |
