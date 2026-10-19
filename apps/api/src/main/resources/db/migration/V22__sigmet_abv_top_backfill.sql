-- Wakeline 스키마 V22 — 지난 SIGMET 행의 상한 출처 다시 분류(개선 작업 IM-01 · 사용자 결정 Q1 2026-10-19 · 계약 v5 §G57). V1~V21 은 고치지 않는다.
-- 원문 "TOP ABV FLnnn" 은 상한이 아니라 '상한의 하한'(FLnnn 이상)이다(V4 · 계약 v4 DH-4). V4 는 그때까지의 행을 고쳤지만, 그 뒤에도 수집기가 AWC JSON 상한이
-- 그 값과 같을 때 `json` 으로 냈다(IM-01 — 수집기는 2026-10-18 에 고쳤다). 그동안 쌓인 지난 행은 재생 · 이력 · 근거 화면이 고정 상한("FLnnn 까지")으로 보인다.
-- 살아 있는 행은 다음 수신 때 수집기의 upsert 가 고치지만 지난 행은 그대로라, V4 와 같은 조건으로 한 번 더 고친다(결정적 — 추정 없음):
-- 상한 출처가 json · raw_text 이고 저장된 상한이 원문 "TOP ABV FLnnn" 의 값(nnn × 100 ft)과 같은 행만. 값이 다르면 · "TOPS ABV" · 이미 하한인 행은 그대로다.
-- 알림 기록(alert_event — 판정 당시의 근거)은 바꾸지 않는다. 바꾼 행의 id 와 이전 값은 같은 문장에서 감사 기록 한 줄(시스템 — user_id NULL,
-- SIGMET_TOP_SOURCE_V22)에 남긴다(바꿀 행이 없으면 남기지 않는다). 이 파일을 이미 적용한 DB 가 있으면 글자를 고치지 않는다(주석도 체크섬에 든다).
--
-- 되돌리기: 감사 기록의 이전 값으로 그 행들만 돌린다. flyway_schema_history 의 V22 행은 **지우지 않는다** — 지우면 다음 migrate 가 V22 를 다시 적용한다(V17 과 같다).
-- 그 사이 수집기가 다시 받은 살아 있는 SIGMET 은 수집기 규칙으로 이미 하한이므로, 되돌리면 그 행도 이전 값이 된다(다음 수신 때 수집기가 다시 고친다).
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행한다(코드는 되돌리지 않아도 된다 — 수집기 규칙은 IM-01 그대로) ====
-- WITH b AS (
--   SELECT e.key AS id, e.value AS old FROM audit_log a, jsonb_each_text(a.before) e WHERE a.action = 'SIGMET_TOP_SOURCE_V22'
-- ), back AS (
--   UPDATE sigmet s SET top_source = b.old FROM b WHERE s.id = b.id AND s.top_source = 'raw_text_lower_bound'
--   RETURNING s.id, b.old)
-- INSERT INTO audit_log (user_id, action, target, before, after)
--   SELECT NULL, 'SIGMET_TOP_SOURCE_V22_ROLLBACK', 'sigmet.top_source', jsonb_build_object('top_source', 'raw_text_lower_bound', 'rows', count(*)), jsonb_object_agg(id, old)
--     FROM back HAVING count(*) > 0;
-- ==== 되돌리기 끝 ====
WITH changed AS (
  UPDATE sigmet s SET top_source = 'raw_text_lower_bound'
    FROM sigmet o
   WHERE o.id = s.id
     AND s.top_source IN ('json', 'raw_text')
     AND s.top_ft IS NOT NULL
     AND substring(s.raw_text FROM '\yTOP\s+ABV\s+FL(\d{3})\y')::int * 100 = s.top_ft
  RETURNING s.id, o.top_source AS old)
INSERT INTO audit_log (user_id, action, target, before, after)
  SELECT NULL, 'SIGMET_TOP_SOURCE_V22', 'sigmet.top_source', jsonb_object_agg(id, old), jsonb_build_object('top_source', 'raw_text_lower_bound', 'rows', count(*))
    FROM changed HAVING count(*) > 0;
