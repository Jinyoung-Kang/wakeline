-- Wakeline 스키마 V18 — 공역(국토교통부 '공역정보 지도자료', AIP 차수 기준 · ADR-034 · SPEC F1). V1~V17 은 고치지 않는다.
-- 자료는 운영자가 가져온다(make airspace-import — collector 의 tools.airspace_import 가 표준 입력의 KMZ/KML 을 읽어 한 트랜잭션으로 쓴다).
-- 국토교통부 저작물이라 저장소(공개)에는 원본도, 원본에서 만든 좌표도 없다 — 이 표는 운영 DB 에만 채워진다.
-- 차수(edition)마다 행을 따로 두고 켜진 차수는 하나뿐이다(airspace_edition_one_active). 옛 차수는 지우지 않는다 — 옛 공역 알림(V19)이 가리킨다.
-- 고도 한계는 원문(*_raw)과 정규화한 값(*_ft · *_basis)을 함께 둔다. basis: MSL(해면) · FL(×100 ft) · AGL(지면 기준 — 판정에 쓰지 않음) · SFC(0) ·
-- UNL(무제한, ft NULL) · UNKNOWN(기준을 알 수 없음 — 판정에 쓰지 않음). 정규화 규칙은 collector airspace.limit.
-- geom 은 판정용 원래 도형(고칠 수 없는 자기 교차만 ST_MakeValid), geom_display 는 표시용(ST_SimplifyPreserveTopology 0.0005° ≈ 50 m).
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행하고 api · collector 코드도 되돌린다(V19 를 먼저 되돌린다) ====
-- DROP TABLE airspace; DROP TABLE airspace_edition;
-- DELETE FROM flyway_schema_history WHERE version = '18';
-- ==== 되돌리기 끝 ====

CREATE TABLE airspace_edition (
  id bigserial PRIMARY KEY,
  label text NOT NULL CONSTRAINT airspace_edition_label_len CHECK (char_length(label) BETWEEN 1 AND 80),
  document_name text,
  source_sha256 char(64) NOT NULL UNIQUE CONSTRAINT airspace_edition_sha_hex CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT false,
  counts jsonb NOT NULL,   -- 종류별 도형 수
  skipped jsonb NOT NULL   -- 건너뛴 까닭별 수(해석 · 도형 고침 실패)
);
CREATE UNIQUE INDEX airspace_edition_one_active ON airspace_edition ((true)) WHERE active;

CREATE TABLE airspace (
  id bigserial PRIMARY KEY,
  edition_id bigint NOT NULL REFERENCES airspace_edition(id),
  category text NOT NULL CONSTRAINT airspace_category_format CHECK (category ~ '^[a-z_]{1,32}$'),
  type_ko text NOT NULL,
  folder text NOT NULL,
  type_code text,
  ident text,
  name text NOT NULL,
  class_code text,
  remarks text,
  gfid text,
  kind text NOT NULL CHECK (kind IN ('polygon', 'line')),
  lower_ft int, lower_basis text NOT NULL, lower_raw text NOT NULL,
  upper_ft int, upper_basis text NOT NULL, upper_raw text NOT NULL,
  geom geometry(Geometry, 4326) NOT NULL,
  geom_display geometry(Geometry, 4326) NOT NULL,
  CONSTRAINT airspace_lower_basis CHECK (lower_basis IN ('MSL', 'FL', 'AGL', 'SFC', 'UNL', 'UNKNOWN')),
  CONSTRAINT airspace_upper_basis CHECK (upper_basis IN ('MSL', 'FL', 'AGL', 'SFC', 'UNL', 'UNKNOWN')),
  -- 값이 있어야 하는 기준(MSL · FL · AGL · SFC)에는 값, 없는 기준(UNL · UNKNOWN)에는 NULL
  CONSTRAINT airspace_lower_ft CHECK ((lower_ft IS NULL) = (lower_basis IN ('UNL', 'UNKNOWN'))),
  CONSTRAINT airspace_upper_ft CHECK ((upper_ft IS NULL) = (upper_basis IN ('UNL', 'UNKNOWN'))),
  CONSTRAINT airspace_geom_kind CHECK (
    (kind = 'polygon' AND GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON'))
    OR (kind = 'line' AND GeometryType(geom) IN ('LINESTRING', 'MULTILINESTRING')))
);
CREATE INDEX airspace_edition_idx ON airspace (edition_id);
CREATE INDEX airspace_geom_gist ON airspace USING GIST (geom);

-- 권한(V9 이후 기본 권한 없음 — 표마다 명시): collector 가 쓰고(가져오기 — 차수 행 INSERT · 켜고 끄기 UPDATE, 도형 INSERT), api 는 읽기만.
-- 지우는 역할은 없다(차수 지우기는 운영자에게 묻고 migrator 로).
GRANT SELECT, INSERT, UPDATE ON airspace_edition TO wakeline_collector;
GRANT SELECT, INSERT ON airspace TO wakeline_collector;
GRANT USAGE ON SEQUENCE airspace_edition_id_seq, airspace_id_seq TO wakeline_collector;
GRANT SELECT ON airspace_edition, airspace TO wakeline_api;
