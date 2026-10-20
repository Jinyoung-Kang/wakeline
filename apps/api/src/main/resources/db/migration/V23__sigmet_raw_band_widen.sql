-- Wakeline 스키마 V23 — SIGMET 하한 출처 'raw_text' · 지난 행의 고도대를 원문 고도대만큼 넓히기(VERIFICATION #156 · 계약 v5 §G59 · 사용자 위임 2026-10-20
-- "권장안대로"). V1~V22 는 고치지 않는다.
-- AWC 가 원문 고도대 "A/B" 보다 좁은 base/top 을 오류 없이 줬다 — 역순 'FL400/280' 에 base 40000 · top null, 'SFC/10000FT' 에 top 100, 'TOP FL230/250' 에
-- top 23000, 구역 둘의 'SFC/FL070 … SFC/FL120' 에 top 7000(로컬 12,209행 중 11행, 그중 둘은 수집기가 'TOP FL320/370' 을 FL320 으로 읽은 것). 그 사이 항공기가
-- 경보 밖이었다. 수집기는 2026-10-20 에 고쳤다(sigmet_parse 모듈 설명 3 — 살아 있는 행은 다음 수신 때 upsert 가 고친다). 지난 행은 재생 · 이력 · 근거 화면이
-- 좁은 고도대로 보여, 수집기와 같은 규칙으로 한 번 고친다(결정적 — 원문에 적힌 값만 쓴다):
--   원문 고도대 "A/B"(A = SFC · FLnnn · nnnFT · nnnM, B = FLnnn · nnnFT · nnnM, A 가 FL 이면 FL 을 뺀 nnn 도. 앞뒤가 영문 대문자 · 숫자 · '/' 이면 고도대가
--   아니다. 'ABV' 가 붙은 것은 뺀다) 가운데 가장 높은 값이 고정 상한(top_source json · raw_text)보다 높으면 상한을 그 값으로(top_source raw_text),
--   가장 낮은 값('TOP' 이 붙은 상한 범위는 빼고)이 발표된 하한(base_source json)보다 낮으면 하한을 그 값으로(base_source raw_text). 순서는 보지 않는다.
--   m 는 1 ft = 0.3048 m 로 넓히는 쪽(상한 올림 · 하한 내림).
-- 좁히는 쪽으로는 바꾸지 않는다(상한 없음 · 'ABV' 하한 · SFC 가정 · DB 전용 하한 'unknown' 은 그대로). 알림 기록(alert_event — 판정 당시의 근거)은 바꾸지 않는다.
-- 바꾼 행의 id 와 이전 값은 같은 문장에서 감사 기록 한 줄(시스템 — user_id NULL, SIGMET_BAND_V23)에 남긴다(바꿀 행이 없으면 남기지 않는다).
-- 이 파일을 이미 적용한 DB 가 있으면 글자를 고치지 않는다(주석도 체크섬에 든다).
--
-- 되돌리기: 감사 기록의 이전 값으로 그 행들만 돌린다(V23 이 쓴 값 그대로인 행만 — 그 뒤 다시 받은 행은 건드리지 않는다). 출처 CHECK 는 넓힌 채 둔다 — 수집기가
-- 'raw_text' 를 계속 보낸다(코드까지 되돌릴 때만 'raw_text' 행이 없는지 보고 CHECK 를 V3 의 값으로 되돌린다). flyway_schema_history 의 V23 행은 **지우지 않는다**
-- — 지우면 다음 migrate 가 V23 을 다시 적용한다(V17 · V22 와 같다).
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행한다 ====
-- WITH b AS (
--   SELECT e.key AS id, e.value AS old, a.after -> 'sigmets' -> e.key AS new FROM audit_log a, jsonb_each(a.before) e WHERE a.action = 'SIGMET_BAND_V23'
-- ), back AS (
--   UPDATE sigmet s SET base_ft = (b.old ->> 'base_ft')::int, base_source = b.old ->> 'base_source',
--                       top_ft = (b.old ->> 'top_ft')::int, top_source = b.old ->> 'top_source'
--     FROM b
--    WHERE s.id = b.id AND s.base_ft = (b.new ->> 'base_ft')::int AND s.base_source = b.new ->> 'base_source'
--      AND s.top_ft IS NOT DISTINCT FROM (b.new ->> 'top_ft')::int AND s.top_source = b.new ->> 'top_source'
--   RETURNING s.id, b.new)
-- INSERT INTO audit_log (user_id, action, target, before, after)
--   SELECT NULL, 'SIGMET_BAND_V23_ROLLBACK', 'sigmet.base_ft,top_ft', jsonb_object_agg(id, new), jsonb_build_object('rows', count(*))
--     FROM back HAVING count(*) > 0;
-- ==== 되돌리기 끝 ====

ALTER TABLE sigmet DROP CONSTRAINT sigmet_base_source_check;
ALTER TABLE sigmet ADD CONSTRAINT sigmet_base_source_check CHECK (base_source IN ('json', 'assumed_surface', 'unknown', 'raw_text'));

WITH m AS (
  SELECT s.id, r[1] AS lead, r[2] AS a,
         CASE WHEN r[3] !~ '^\d{3}$' THEN r[3] WHEN r[2] LIKE 'FL%' THEN 'FL' || r[3] END AS b   -- FL 을 뺀 nnn 은 앞이 FL 일 때만
    FROM sigmet s,
         LATERAL regexp_matches(s.raw_text,
           '(?<![A-Z0-9/])((?:TOP\s+)?(?:ABV\s+)?)(SFC|FL\d{3}|\d{3,5}FT|\d{3,5}M)/(FL\d{3}|\d{3,5}FT|\d{3,5}M|\d{3})(?![A-Z0-9/])', 'g') AS r
   WHERE s.raw_text LIKE '%/%'
), lv AS (
  SELECT m.id, m.lead,
         CASE WHEN x.tok = 'SFC' THEN 0 WHEN x.tok LIKE 'FL%' THEN substr(x.tok, 3)::int * 100 WHEN x.tok LIKE '%FT' THEN left(x.tok, -2)::int
              ELSE floor(left(x.tok, -1)::numeric * 10000 / 3048)::int END AS lo_ft,
         CASE WHEN x.tok = 'SFC' THEN 0 WHEN x.tok LIKE 'FL%' THEN substr(x.tok, 3)::int * 100 WHEN x.tok LIKE '%FT' THEN left(x.tok, -2)::int
              ELSE ceil(left(x.tok, -1)::numeric * 10000 / 3048)::int END AS hi_ft
    FROM m, LATERAL (VALUES (m.a), (m.b)) AS x(tok)
   WHERE m.b IS NOT NULL AND m.lead NOT LIKE '%ABV%'
), band AS (
  SELECT id, min(lo_ft) FILTER (WHERE lead NOT LIKE 'TOP%') AS lo, max(hi_ft) AS hi FROM lv GROUP BY id
), changed AS (
  UPDATE sigmet s
     SET base_ft = CASE WHEN s.base_source = 'json' AND b.lo < s.base_ft THEN b.lo ELSE s.base_ft END,
         base_source = CASE WHEN s.base_source = 'json' AND b.lo < s.base_ft THEN 'raw_text' ELSE s.base_source END,
         top_ft = CASE WHEN s.top_source IN ('json', 'raw_text') AND b.hi > s.top_ft THEN b.hi ELSE s.top_ft END,
         top_source = CASE WHEN s.top_source IN ('json', 'raw_text') AND b.hi > s.top_ft THEN 'raw_text' ELSE s.top_source END
    FROM band b, sigmet o
   WHERE b.id = s.id AND o.id = s.id
     AND ((s.base_source = 'json' AND b.lo < s.base_ft) OR (s.top_source IN ('json', 'raw_text') AND b.hi > s.top_ft))
  RETURNING s.id, o.base_ft AS old_base_ft, o.base_source AS old_base_source, o.top_ft AS old_top_ft, o.top_source AS old_top_source,
            s.base_ft, s.base_source, s.top_ft, s.top_source)
INSERT INTO audit_log (user_id, action, target, before, after)
  SELECT NULL, 'SIGMET_BAND_V23', 'sigmet.base_ft,top_ft',
         jsonb_object_agg(id, jsonb_build_object('base_ft', old_base_ft, 'base_source', old_base_source, 'top_ft', old_top_ft, 'top_source', old_top_source)),
         jsonb_build_object('rows', count(*),
                            'sigmets', jsonb_object_agg(id, jsonb_build_object('base_ft', base_ft, 'base_source', base_source, 'top_ft', top_ft, 'top_source', top_source)))
    FROM changed HAVING count(*) > 0;
