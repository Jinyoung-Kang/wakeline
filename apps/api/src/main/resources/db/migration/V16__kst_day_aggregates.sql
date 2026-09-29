-- Wakeline 스키마 V16 — 우리 일 집계의 날짜 = KST 날짜(Asia/Seoul 00:00–24:00) (계약 v5 §G20 · 사용자 결정 2026-09-30 "화면 시각은 UTC 지우고 KST").
-- V1~V15 는 고치지 않는다.
-- stats_daily(api 가 센다 — 통계 화면)와 quality_rule_count(collector 가 센다 — 운영 화면 격리 수)는 지금까지 UTC 날짜로 셌다. 그 행의 날짜 값은
-- KST 날짜와 모양이 같지만 다른 하루(09:00 KST 에 바뀌던 날)라서, 날짜 이름만 KST 로 바꾸면 틀린 집계가 된다. 그래서 옛 행은 보관 표
-- (*_utc_legacy — 서비스 역할은 아무 권한 없음, 읽는 코드 없음, 운영자가 psql 로 볼 수 있다)로 옮기고, 같은 이름 · 같은 모양의 새 표는 KST 날짜로
-- 센 행만 담는다.
-- 교통량(traffic_by_hour)은 옛 행에서 정확히 옮겨 싣는다(리뷰 2026-09-30): 옛 행은 UTC 시마다 센 서로 다른 항공기 수(dim = UTC 시)이고 KST = UTC + 9시간
-- (정시 차이)이라, KST 날짜 D 의 h 시는 옛 행 하나와 같다 — h < 9 이면 (D − 1, h + 15), h ≥ 9 이면 (D, h − 9). 두 UTC 날이 모두 교통량 완료 표식을 가졌고
-- 센 지역(traffic_region)이 같은 KST 날만 싣는다(시 · 지역 · 완료 표식 — 표식 값은 두 날 표식 중 늦은 것). 한쪽이라도 표식이 없거나 지역이 다르면 싣지
-- 않는다(화면은 '집계되지 않은 날짜'). 1분 요약(track_point_1m)으로는 다시 세지 않는다 — 행마다 어느 지역으로 셌는지 없고, 빠진 시간을 알 수 없다.
-- 나머지 통계는 api 따라잡기(기동 1분 뒤 · 3시간마다)가 원본이 남은 계열을 KST 날짜로 다시 채운다 — 최근 7일은 모든 계열, 그보다 오래된 날은
-- SIGMET(영구) · 알림(30일 안)을 한 번에 92일까지(MaintenanceJobs.backfillStats). 원해상도 항적이 남은 날(그날 첫 순간이 든 UTC 파티션이 보존 72 h 안)은
-- 교통량도 항적에서 다시 센다(옮겨 실은 값과 같다). SIGMET · 알림의 옛 행은 옮길 수 없다 — UTC 날 하루의 수는 KST 날짜 둘에 걸친 사건을 섞어 셌다.
-- 그래서 V16 뒤 비는 것은 끝난 알림이 지워진 30일 밖 날의 알림 통계, 옮겨 실을 조건을 못 채웠고(두 UTC 날 중 한쪽에 완료 표식이 없거나 센 지역이 다름)
-- 원해상도 항적도 지워진 날의 교통량, V16 앞의 격리 수(실행마다의 규칙별 수는 이 표에만 있었다)다 — 값은 보관 표에 남는다.
-- 격리 수는 V16 이 적용된 순간(kst_day_cutover)부터 KST 날짜로 센다 — 그 KST 날짜는 이 시각 뒤 실행만 든 부분 값이고(운영 화면이 '부분' 으로 적는다),
-- 그보다 앞 날짜의 행(배포 중 아직 돌던 이전 수집기가 UTC 날짜로 쓴 것)은 api 가 내지 않는다. 공급자 예산 날(provider_budget_day)은 수집기의 UTC 날 예산 키
-- 그대로다(바꾸지 않는다 — 화면이 창을 KST 로 적는다).
-- 배포(계약 v5 §G20 '배포'): 이전 api · collector 를 멈춘 뒤 이 마이그레이션을 돌린다 — 둘이 돌던 채면 그 사이 이전 api 의 집계가 UTC 날 통계와 완료 표식을,
-- 이전 collector 가 UTC 날짜 격리 수를 새 표에 쓸 수 있다.
-- 권한(V9 R-88 — 새 표는 명시 GRANT 만): 새 표는 옛 표와 같다(api 통계 DML · collector 규칙별 수 SELECT · INSERT · UPDATE · api 규칙별 수 SELECT · DELETE),
-- kst_day_cutover 는 api SELECT 만.
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행하고 api · collector 코드도 되돌린다(이전 코드는 UTC 날짜로 센다) ====
-- DROP TABLE kst_day_cutover;
-- DROP TABLE stats_daily;
-- ALTER TABLE stats_daily_utc_legacy RENAME TO stats_daily;
-- ALTER TABLE stats_daily RENAME CONSTRAINT stats_daily_utc_legacy_pkey TO stats_daily_pkey;
-- COMMENT ON TABLE stats_daily IS NULL;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON stats_daily TO wakeline_api;
-- DROP TABLE quality_rule_count;
-- ALTER TABLE quality_rule_count_utc_legacy RENAME TO quality_rule_count;
-- ALTER TABLE quality_rule_count RENAME CONSTRAINT quality_rule_count_utc_legacy_pkey TO quality_rule_count_pkey;
-- COMMENT ON TABLE quality_rule_count IS NULL;
-- GRANT SELECT, DELETE ON quality_rule_count TO wakeline_api;
-- GRANT SELECT, INSERT, UPDATE ON quality_rule_count TO wakeline_collector;
-- DELETE FROM flyway_schema_history WHERE version = '16';
-- ==== 되돌리기 끝 ====

-- ---- 통계(api) ----
ALTER TABLE stats_daily RENAME TO stats_daily_utc_legacy;
ALTER TABLE stats_daily_utc_legacy RENAME CONSTRAINT stats_daily_pkey TO stats_daily_utc_legacy_pkey;
REVOKE ALL ON stats_daily_utc_legacy FROM wakeline_api, wakeline_collector;
COMMENT ON TABLE stats_daily_utc_legacy IS 'V16 전 일 통계 — day 는 UTC 날짜(KST 날짜가 아니다, 09:00 KST 에 바뀌던 날). 보관만 — 서비스가 읽지 않는다(계약 v5 §G20)';

CREATE TABLE stats_daily (
  day date NOT NULL, metric text NOT NULL, dim text NOT NULL, value numeric NOT NULL,
  PRIMARY KEY (day, metric, dim)
);
COMMENT ON TABLE stats_daily IS '일 통계 — day 는 KST 날짜(Asia/Seoul 00:00–24:00), traffic_by_hour 의 dim 은 KST 시(00–23). api MaintenanceJobs 가 센다(계약 v5 §G20)';
GRANT SELECT, INSERT, UPDATE, DELETE ON stats_daily TO wakeline_api;

-- 교통량 옮겨 싣기(위 머리 주석): 옛 UTC 날 m 의 표식 · 지역 → KST 날 k(= 앞 UTC 날 a 와 같은 UTC 날 b 가 모두 표식 · 같은 지역) → 시 · 지역 · 표식.
-- dim 이 "00"–"23" 이 아닌 행은 없다(api 가 lpad 로 만든다) — 그래도 CASE 로 먼저 걸러 형식이 틀린 행이 마이그레이션을 멈추지 않게, 그런 행이 든 UTC 날은 싣지 않는다.
WITH m AS (
  SELECT day,
         max(value) FILTER (WHERE metric = 'aggregated_at' AND dim = 'traffic') AS at,
         jsonb_object_agg(dim, value) FILTER (WHERE metric = 'traffic_region') AS region,
         coalesce(bool_and(dim ~ '^([01][0-9]|2[0-3])$') FILTER (WHERE metric = 'traffic_by_hour'), true) AS hours_ok
  FROM stats_daily_utc_legacy
  WHERE metric IN ('aggregated_at', 'traffic_region', 'traffic_by_hour')
  GROUP BY day
), k AS (
  SELECT b.day, greatest(a.at, b.at) AS at, b.region
  FROM m a JOIN m b ON b.day = a.day + 1
  WHERE a.at IS NOT NULL AND b.at IS NOT NULL AND a.hours_ok AND b.hours_ok AND a.region IS NOT DISTINCT FROM b.region
), hours AS (
  INSERT INTO stats_daily (day, metric, dim, value)
  SELECT k.day, 'traffic_by_hour', lpad(((h.utc_hour + 9) % 24)::text, 2, '0'), h.value
  FROM (SELECT day, value, CASE WHEN dim ~ '^([01][0-9]|2[0-3])$' THEN dim::int END AS utc_hour
        FROM stats_daily_utc_legacy WHERE metric = 'traffic_by_hour') h
  JOIN k ON k.day = (h.day + make_interval(hours => h.utc_hour + 9))::date
  WHERE h.utc_hour IS NOT NULL
  RETURNING 1
), regions AS (
  INSERT INTO stats_daily (day, metric, dim, value)
  SELECT k.day, 'traffic_region', r.key, r.value::numeric FROM k CROSS JOIN LATERAL jsonb_each_text(k.region) r
  RETURNING 1
)
INSERT INTO stats_daily (day, metric, dim, value) SELECT day, 'aggregated_at', 'traffic', at FROM k;

-- ---- 품질 규칙 일별 수(collector) ----
ALTER TABLE quality_rule_count RENAME TO quality_rule_count_utc_legacy;
ALTER TABLE quality_rule_count_utc_legacy RENAME CONSTRAINT quality_rule_count_pkey TO quality_rule_count_utc_legacy_pkey;
REVOKE ALL ON quality_rule_count_utc_legacy FROM wakeline_api, wakeline_collector;
COMMENT ON TABLE quality_rule_count_utc_legacy IS 'V16 전 품질 규칙 일별 수 — day 는 UTC 날짜(KST 날짜가 아니다). 보관만 — 서비스가 읽지 않는다(계약 v5 §G20)';

CREATE TABLE quality_rule_count (
  day date NOT NULL, rule text NOT NULL, count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, rule)
);
COMMENT ON TABLE quality_rule_count IS '품질 규칙 일별 격리 수 — day 는 실행이 시작된 KST 날짜(Asia/Seoul). collector db.py 가 센다(계약 v5 §G20)';
GRANT SELECT, INSERT, UPDATE ON quality_rule_count TO wakeline_collector;
GRANT SELECT, DELETE ON quality_rule_count TO wakeline_api;

-- 격리 수를 KST 날짜로 세기 시작한 순간(위 머리 주석) — 운영 화면이 그 KST 날짜를 '부분' 으로 적고, api 는 그보다 앞 날짜의 행을 내지 않는다
CREATE TABLE kst_day_cutover (
  table_name text PRIMARY KEY,
  cut_at timestamptz NOT NULL
);
COMMENT ON TABLE kst_day_cutover IS 'V16 이 이 표를 KST 날짜 셈으로 바꾼 순간(계약 v5 §G20) — quality_rule_count 의 그 KST 날짜는 이 순간 뒤 실행만 든 부분 값';
INSERT INTO kst_day_cutover (table_name, cut_at) VALUES ('quality_rule_count', now());
GRANT SELECT ON kst_day_cutover TO wakeline_api;
