-- Wakeline 스키마 V19 — 알림을 SIGMET 밖의 판정 구역(공역 — ADR-035 · 계약 v5 §G48)으로 넓힌다. V1~V18 은 고치지 않는다.
-- SIGMET 알림의 행 · 자연키(hex, sigmet_id, kind, entered_at) · INSERT 는 그대로다. 공역 알림은 sigmet_id 대신 airspace_id(V18)를 가리키고,
-- 자연키는 부분 유일 색인(hex, airspace_id, kind, entered_at)이다. 기존 행은 모두 SIGMET 알림이다(zone_type 'sigmet' · level 'alert' 기본값).
-- 알림 수준(level): alert = 배너 · 브라우저 알림 대상, info = 목록 · 카드에만(비행제한구역 — SPEC F2). 닫힘 사유 'zone_ended' = 구역 쪽이 끝났다
-- (공역 차수 교체 · 공역 판정 끔 — 까닭은 근거의 end_cause). 항공기가 나간 것(left)이 아니다.
-- 운영 설정 airspace_alerts(off · shadow · on): 기본 shadow — 판정은 하되 저장 · 방송하지 않고 건수만 센다(PLAN 결정 D4 — 24 h 수치를 본 뒤 운영자가 on).
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행하고 api 코드도 되돌린다(공역 알림 행이 있으면 먼저 지운다 — 데이터를 지우므로 운영자에게 묻는다) ====
-- DELETE FROM alert_event WHERE zone_type <> 'sigmet';
-- DROP INDEX alert_event_airspace_uk;
-- ALTER TABLE alert_event DROP CONSTRAINT alert_event_zone_ck;
-- ALTER TABLE alert_event ALTER COLUMN sigmet_id SET NOT NULL;
-- ALTER TABLE alert_event DROP COLUMN airspace_id, DROP COLUMN level, DROP COLUMN zone_type;
-- ALTER TABLE alert_event DROP CONSTRAINT alert_event_close_reason_check;
-- ALTER TABLE alert_event ADD CONSTRAINT alert_event_close_reason_check
--   CHECK (close_reason IN ('left', 'signal_lost', 'restart', 'sigmet_ended', 'prediction_cleared'));
-- DELETE FROM app_setting WHERE key = 'airspace_alerts';
-- DELETE FROM flyway_schema_history WHERE version = '19';
-- ==== 되돌리기 끝 ====

ALTER TABLE alert_event ADD COLUMN zone_type text NOT NULL DEFAULT 'sigmet' CONSTRAINT alert_event_zone_type_check CHECK (zone_type IN ('sigmet', 'airspace'));
ALTER TABLE alert_event ADD COLUMN level text NOT NULL DEFAULT 'alert' CONSTRAINT alert_event_level_check CHECK (level IN ('alert', 'info'));
ALTER TABLE alert_event ADD COLUMN airspace_id bigint REFERENCES airspace(id);
ALTER TABLE alert_event ALTER COLUMN sigmet_id DROP NOT NULL;
ALTER TABLE alert_event ADD CONSTRAINT alert_event_zone_ck CHECK (
  (zone_type = 'sigmet' AND sigmet_id IS NOT NULL AND airspace_id IS NULL)
  OR (zone_type = 'airspace' AND airspace_id IS NOT NULL AND sigmet_id IS NULL));
CREATE UNIQUE INDEX alert_event_airspace_uk ON alert_event (hex, airspace_id, kind, entered_at) WHERE airspace_id IS NOT NULL;

ALTER TABLE alert_event DROP CONSTRAINT alert_event_close_reason_check;
ALTER TABLE alert_event ADD CONSTRAINT alert_event_close_reason_check
  CHECK (close_reason IN ('left', 'signal_lost', 'restart', 'sigmet_ended', 'prediction_cleared', 'zone_ended'));

INSERT INTO app_setting (key, value) VALUES ('airspace_alerts', '"shadow"') ON CONFLICT (key) DO NOTHING;
