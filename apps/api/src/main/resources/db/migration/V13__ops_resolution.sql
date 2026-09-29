-- Wakeline 스키마 V13 — 운영자의 '해결' 표시(계약 v5 §G13 · ADR-022). V1~V12 는 고치지 않는다.
-- 사용자 요청: 해결한 오류를 [운영/로그] 화면에서 지우는 기능. 증거(로그 스트림 wakeline:logs* · ingest_run · 공급자 해시)는 지우지 않는다 —
-- 이 표에 "이 fp(또는 공급자)의 upto 이하 오류는 해결됨" 을 적고, 조회가 그 이하를 가린다(resolved=show 로 다시 본다). upto 뒤의 새 발생은
-- 다시 보인다(재발을 숨기지 않는다). 되돌림은 행을 지우지 않고 revoked_at · revoked_by 를 채운다(누가 언제 해결 · 되돌렸는지 남는다).
-- 같은 key 에 활성 행이 여럿이면 upto 가 가장 늦은 행이 유효하다(가장 최근 해결을 되돌리면 앞선 해결의 범위로 돌아간다 — ResolutionService).
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행한 뒤 코드도 되돌린다(가림이 없어져 모든 오류가 다시 보인다 · 감사 행은 남는다) ====
-- DROP TABLE ops_resolution;
-- DELETE FROM flyway_schema_history WHERE version = '13';
-- ==== 되돌리기 끝 ====

CREATE TABLE ops_resolution (
  id bigserial PRIMARY KEY,
  -- log_group: key = 로그 지문 fp(16자리 소문자 16진 — 스키마 log_event.v1) · provider_error: key = 공급자 이름(api 가 목록으로 거른다)
  kind text NOT NULL CONSTRAINT ops_resolution_kind CHECK (kind IN ('log_group', 'provider_error')),
  key text NOT NULL CONSTRAINT ops_resolution_key CHECK (char_length(key) BETWEEN 1 AND 64 AND (kind <> 'log_group' OR key ~ '^[0-9a-f]{16}$')),
  upto timestamptz NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  resolved_by text NOT NULL CONSTRAINT ops_resolution_resolved_by CHECK (resolved_by <> ''),
  note text NULL CONSTRAINT ops_resolution_note CHECK (char_length(note) <= 200),
  revoked_at timestamptz NULL,
  revoked_by text NULL,
  CONSTRAINT ops_resolution_revoked_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_by IS NULL OR revoked_by <> ''))
);
-- 활성 해결 찾기(api 는 5 s 캐시로 모두 읽는다 — 표가 작아도 되돌린 행이 쌓이는 만큼 활성 행만 훑는다)
CREATE INDEX ops_resolution_active ON ops_resolution (kind, key) WHERE revoked_at IS NULL;

-- 권한(V9 이후 기본 권한 없음 — 표마다 명시): api 는 읽고 · 적고 · 되돌림 두 열만 고친다(지우지 않는다 · 이미 적은 kind · key · upto · 메모 ·
-- 누가는 바꾸지 못한다 — 감사와 같은 증거). collector 는 없음(가림은 api 조회만의 일).
GRANT SELECT, INSERT ON ops_resolution TO wakeline_api;
GRANT UPDATE (revoked_at, revoked_by) ON ops_resolution TO wakeline_api;
GRANT USAGE ON SEQUENCE ops_resolution_id_seq TO wakeline_api;
