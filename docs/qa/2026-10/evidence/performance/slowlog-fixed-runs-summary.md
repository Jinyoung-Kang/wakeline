<!-- tools/qa/perf_slowlog.py 2026-10-01T22:05:30Z 2026-10-01T22:32:20Z 의 출력(22:4x UTC 에 실행 · 표준 출력에서 옮김). db 컨테이너 로그는 json-file 10 MB × 3 으로
     돌아가고, 전세계 항공기 정적 정보 upsert(2분마다)의 바인드 파라미터(약 1 MB JSON)가 느린 문장 DETAIL 로 함께 찍혀 약 1시간 뒤 이 구간이 지워졌다 —
     그래서 원문(raw) 로그는 남지 않았다. 이 구간 = REST 50 rps × 3 · 100 rps × 3 (22:09–22:32). -->
since 2026-10-01T22:05:30Z until 2026-10-01T22:32:20Z: 116 statements ≥ log_min_duration_statement, 7 groups
| 건수 | 가운데 ms | 최대 ms | 처음 | 마지막 | 문장(앞 160자) |
|---|---|---|---|---|---|
| 37 | 176 | 717 | 22:19:41 | 22:31:44 | `INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, vrate_fpm, on_ground, squawk, provider, fetched_at, quality) VALUES ($1, $2, ST_SetSRID(ST_Mak` |
| 53 | 130 | 308 | 22:19:40 | 22:31:13 | `/* wakeline replay.track_point limit_s=3 */ SELECT DISTINCT ON (hex) hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, on_ground, provider, fal` |
| 8 | 183 | 328 | 22:21:41 | 22:31:43 | `INSERT INTO aircraft (hex, registration, type_code, category, source, first_seen, last_seen) SELECT t.hex, t.reg, t.type, t.cat, t.src, t.seen, t.seen FROM json` |
| 11 | 114 | 160 | 22:20:47 | 22:29:42 | `/* wakeline ship.track limit_s=3 */ SELECT ts, ST_X(geom) lon, ST_Y(geom) lat, sog_kn, cog_deg, heading_deg, nav_status, position_source, provider FROM ship_pos` |
| 4 | 134 | 242 | 22:21:41 | 22:28:28 | `/* wakeline replay.sigmet limit_s=3 */ SELECT id, fir_id, fir_name, hazard, qualifier, base_ft, top_ft, base_source, top_source, valid_from, valid_to, withdrawn` |
| 2 | 117 | 125 | 22:23:40 | 22:29:41 | `/* wakeline aircraft.search limit_s=3 */ SELECT hex, registration, type_code, last_seen FROM aircraft WHERE (upper(hex) ~>=~ $1 AND upper(hex) ~<~ $2) OR (upper` |
| 1 | 124 | 124 | 22:21:41 | 22:21:41 | `/* wakeline aircraft.track limit_s=3 */ SELECT hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, provider FROM track_point WHERE hex = $1 AND t` |
