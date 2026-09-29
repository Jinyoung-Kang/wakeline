-- Wakeline 스키마 V16 — 우리 일 집계의 날짜 = KST 날짜(Asia/Seoul 00:00–24:00) (계약 v5 §G19 · 사용자 결정 2026-09-30 "화면 시각은 UTC 지우고 KST").
-- V1~V15 는 고치지 않는다.
-- stats_daily(api 가 센다 — 통계 화면)와 quality_rule_count(collector 가 센다 — 운영 화면 격리 수)는 지금까지 UTC 날짜로 셌다. 그 행의 날짜 값은
-- KST 날짜와 모양이 같지만 다른 하루(09:00 KST 에 바뀌던 날)라서, 날짜 이름만 KST 로 바꾸면 틀린 집계가 된다. 그래서 옛 행은 보관 표
-- (*_utc_legacy — 서비스 역할은 아무 권한 없음, 읽는 코드 없음, 운영자가 psql 로 볼 수 있다)로 옮기고, 같은 이름 · 같은 모양의 새 표는 KST 날짜로
-- 센 행만 담는다. 통계는 api 따라잡기(기동 1분 뒤 · 3시간마다 — 최근 7일 중 원본이 남은 계열: SIGMET 영구 · 알림 30일 · 항적 72 h)가 KST 날짜로
-- 다시 채운다. 원본이 사라진 날(그보다 오래된 교통량 · 알림)과 격리 수(실행마다의 규칙별 수는 이 표에만 있다)는 다시 셀 수 없어 비어 있다 —
-- 화면은 '집계되지 않은 날짜' 로 말한다. 공급자 예산 날(provider_budget_day)은 수집기의 UTC 날 예산 키 그대로다(바꾸지 않는다 — 화면이 창을 KST 로 적는다).
-- 권한(V9 R-88 — 새 표는 명시 GRANT 만): 새 표는 옛 표와 같다(api 통계 DML · collector 규칙별 수 SELECT · INSERT · UPDATE · api 규칙별 수 SELECT · DELETE).
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행하고 api · collector 코드도 되돌린다(이전 코드는 UTC 날짜로 센다) ====
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
COMMENT ON TABLE stats_daily_utc_legacy IS 'V16 전 일 통계 — day 는 UTC 날짜(KST 날짜가 아니다, 09:00 KST 에 바뀌던 날). 보관만 — 서비스가 읽지 않는다(계약 v5 §G19)';

CREATE TABLE stats_daily (
  day date NOT NULL, metric text NOT NULL, dim text NOT NULL, value numeric NOT NULL,
  PRIMARY KEY (day, metric, dim)
);
COMMENT ON TABLE stats_daily IS '일 통계 — day 는 KST 날짜(Asia/Seoul 00:00–24:00), traffic_by_hour 의 dim 은 KST 시(00–23). api MaintenanceJobs 가 센다(계약 v5 §G19)';
GRANT SELECT, INSERT, UPDATE, DELETE ON stats_daily TO wakeline_api;

-- ---- 품질 규칙 일별 수(collector) ----
ALTER TABLE quality_rule_count RENAME TO quality_rule_count_utc_legacy;
ALTER TABLE quality_rule_count_utc_legacy RENAME CONSTRAINT quality_rule_count_pkey TO quality_rule_count_utc_legacy_pkey;
REVOKE ALL ON quality_rule_count_utc_legacy FROM wakeline_api, wakeline_collector;
COMMENT ON TABLE quality_rule_count_utc_legacy IS 'V16 전 품질 규칙 일별 수 — day 는 UTC 날짜(KST 날짜가 아니다). 보관만 — 서비스가 읽지 않는다(계약 v5 §G19)';

CREATE TABLE quality_rule_count (
  day date NOT NULL, rule text NOT NULL, count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, rule)
);
COMMENT ON TABLE quality_rule_count IS '품질 규칙 일별 격리 수 — day 는 실행이 시작된 KST 날짜(Asia/Seoul). collector db.py 가 센다(계약 v5 §G19)';
GRANT SELECT, INSERT, UPDATE ON quality_rule_count TO wakeline_collector;
GRANT SELECT, DELETE ON quality_rule_count TO wakeline_api;
