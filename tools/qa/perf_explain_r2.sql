-- 출시 QA 2차 성능(QA-PLAN §3.5): 앞선 QA 뒤 더한 SQL 의 실행 계획 — 운영 규모 합성 자료(seed_perf.sql + seed_perf_r2.sql) 위에서. 격리 스택 A 만.
--   docker exec -i wakeline-e2e-db-1 psql -X -U postgres -d wakeline < tools/qa/perf_explain_r2.sql
SET TimeZone = 'UTC';
\echo '== warnings.history 기본(최근 24 h, 200행)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT zone_code, first_seen FROM wx_warning
 WHERE first_seen <= now() AND coalesce(ended_at, last_seen) >= now() - interval '24 hours' ORDER BY first_seen DESC, id DESC LIMIT 200;
\echo '== warnings.history 옛 창(28–29일 전)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT zone_code, first_seen FROM wx_warning
 WHERE first_seen <= now() - interval '28 days' AND coalesce(ended_at, last_seen) >= now() - interval '29 days' ORDER BY first_seen DESC, id DESC LIMIT 200;
\echo '== warnings.history 구역 하나 · 30일(행이 적은 구역 — 최악)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT zone_code, first_seen FROM wx_warning
 WHERE first_seen <= now() AND coalesce(ended_at, last_seen) >= now() - interval '30 days' AND zone_code = 'S1312020' ORDER BY first_seen DESC, id DESC LIMIT 200;
\echo '== warnings.history 구역 하나 · 옛 1 h 창(행 0 — 최악)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT zone_code, first_seen FROM wx_warning
 WHERE first_seen <= now() - interval '60 days' AND coalesce(ended_at, last_seen) >= now() - interval '60 days 1 hour' AND zone_code = 'S1000001' ORDER BY first_seen DESC, id DESC LIMIT 200;
\echo '== aircraft.track_retained 24 h'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT target_id, ts FROM retained_track
 WHERE kind = 'aircraft' AND target_id = 'f10000' AND ts_minute BETWEEN now() - interval '60 days' AND now() - interval '59 days' ORDER BY ts_minute LIMIT 5001;
\echo '== alerts.by_id'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT e.id FROM alert_event e LEFT JOIN sigmet s ON s.id = e.sigmet_id
 LEFT JOIN airspace a ON a.id = e.airspace_id LEFT JOIN airspace_edition ed ON ed.id = a.edition_id WHERE e.id = (SELECT max(id) FROM alert_event);
\echo '== airports.watch 20곳'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT a.icao, m.obs_time, m.flight_cat FROM airport a
 LEFT JOIN LATERAL (SELECT obs_time, flight_cat FROM metar_obs mo WHERE mo.icao = a.icao ORDER BY obs_time DESC LIMIT 1) m ON true
 WHERE a.icao IN ('RKSI','RKSS','RKPC','RKPK','RJFF','RJTT','RJAA','RCTP','VHHH','ZSPD','RKTN','RKTU','RKJJ','RKNY','RKJB','RKPU','RKTH','RJBB','RJCC','ZBAA') ORDER BY a.icao;
\echo '== retained copy 한 시간(대상 20 — 유지보수 작업)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT DISTINCT ON (hex, date_trunc('minute', ts)) hex, ts FROM track_point
 WHERE hex IN ('f10000','f10040','f10080','f100c0','f10100','f10140','f10180','f101c0','f10200','f10240') AND ts >= date_trunc('hour', now()) - interval '3 hours' AND ts < date_trunc('hour', now())
 ORDER BY hex, date_trunc('minute', ts), ts;
