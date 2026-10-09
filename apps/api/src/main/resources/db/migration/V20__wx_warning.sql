-- Wakeline 스키마 V20 — 기상특보 이력(기상청 API허브 특보현황 — ADR-036 · 계약 v5 §G49). V1~V19 는 고치지 않는다.
-- api 가 스트림 wakeline:wxwarn 의 목록(발효 중인 특보 전체)을 스트림 순서대로 받아 쓴다: 목록에 있으면 같은 자연키(구역 · 종류 · 수준 · 발표 시각)의 행을
-- 이어 쓰고(last_seen), 열린 행이 목록에서 빠지면 그 목록의 수신 시각으로 ended_at 을 채운다(해제 · 대체 — 까닭은 원문으로만 안다).
-- 시각은 UTC(원문 KST 를 바꾼 것). 예비특보는 정확한 발효 시각이 없다(effective_at NULL — 때는 effective_from · effective_to · effective_text).
-- 보존: 끝난 행 90일(MaintenanceJobs — 계획 결정 D6).
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행하고 api 코드도 되돌린다(이력을 지우므로 운영자에게 묻는다) ====
-- DROP TABLE wx_warning;
-- DELETE FROM flyway_schema_history WHERE version = '20';
-- ==== 되돌리기 끝 ====

CREATE TABLE wx_warning (
  id bigserial PRIMARY KEY,
  zone_code text NOT NULL CONSTRAINT wx_warning_zone_format CHECK (zone_code ~ '^[LS][0-9]{7}$'),
  zone_name text NOT NULL,
  parent_code text,
  parent_name text,
  sea boolean NOT NULL,
  kind text NOT NULL,
  level text NOT NULL,
  command text NOT NULL,
  preliminary boolean NOT NULL,
  issued_at timestamptz NOT NULL,
  effective_at timestamptz,
  effective_from timestamptz,
  effective_to timestamptz,
  effective_text text,
  end_notice text,
  raw text NOT NULL,
  provider text NOT NULL,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  ended_at timestamptz,
  CONSTRAINT wx_warning_natural_key UNIQUE (zone_code, kind, level, issued_at),
  CONSTRAINT wx_warning_seen_order CHECK (last_seen >= first_seen AND (ended_at IS NULL OR ended_at >= first_seen))
);
CREATE INDEX wx_warning_open ON wx_warning (zone_code) WHERE ended_at IS NULL;
CREATE INDEX wx_warning_first_seen ON wx_warning (first_seen DESC);

-- 권한(V9 이후 기본 권한 없음): api 가 쓰고(이력 · 보존 삭제) 읽는다. collector 는 스트림으로만 보낸다(이 표에 닿지 않는다).
GRANT SELECT, INSERT, UPDATE, DELETE ON wx_warning TO wakeline_api;
GRANT USAGE ON SEQUENCE wx_warning_id_seq TO wakeline_api;
