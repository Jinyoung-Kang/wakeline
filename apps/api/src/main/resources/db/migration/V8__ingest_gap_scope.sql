-- Wakeline 스키마 V8 — AIS 구역별 공백(계약 v4 §D, ADR-014 부록 B). V1~V7 은 고치지 않는다.
-- ais 가 구역('|' 로 나눈 ais_bboxes)마다 연결 하나를 쓰므로 공백도 구역마다 따로 난다. scope = 그 구역의 정규화된 상자 문자열
-- (ais/bbox.py 형식, api 가 같은 규칙으로 검사한 값). NULL = 구역 나누기 전 기록 — 모든 구역에 적용한다(기존 행은 모두 NULL).
-- 고유성: 같은 공백의 재발행은 (source, 구역, started_at) 으로 거른다. 구역이 다르면 같은 시각에 시작해도 다른 공백이다.
-- NULL 끼리도 같은 것으로 보도록 coalesce(scope, '') 식 인덱스로 한다(UNIQUE 제약은 NULL 을 서로 다르게 본다).
-- 되돌리기(ADR-014 부록 B): DROP INDEX ingest_gap_source_scope_started_uq; 기존 UNIQUE (source, started_at) 제약을 다시 만든 뒤 scope 열 삭제
-- (scope 가 다른 같은 시각 공백이 있으면 먼저 하나만 남긴다).
ALTER TABLE ingest_gap ADD COLUMN scope text NULL
  CONSTRAINT ingest_gap_scope_len CHECK (scope IS NULL OR length(scope) BETWEEN 1 AND 1024);
ALTER TABLE ingest_gap DROP CONSTRAINT ingest_gap_source_started;
CREATE UNIQUE INDEX ingest_gap_source_scope_started_uq ON ingest_gap (source, coalesce(scope, ''), started_at);

-- 권한은 그대로(V5): api 는 INSERT·SELECT 만 — 새 열도 표 권한을 따른다. 고치거나 지울 수 없는 영구 이력.
REVOKE ALL ON ingest_gap FROM wakeline_api;
GRANT SELECT, INSERT ON ingest_gap TO wakeline_api;
