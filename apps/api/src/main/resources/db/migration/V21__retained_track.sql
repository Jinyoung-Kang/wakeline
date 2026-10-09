-- Wakeline 스키마 V21 — 지정 대상 기록 보존 연장(ADR-038 · 계약 v5 §G52 · SPEC F7). V1~V20 은 고치지 않는다.
-- 운영 설정 retain_targets(항공기 hex · 선박 MMSI, 합쳐 20개)의 원해상도 점(track_point · ship_position — 72 h 일 파티션)을 1분에 첫 점 하나로
-- 이 표에 옮겨 365일 남긴다. 매시간 유지보수 작업(MaintenanceJobs)이 지난 몇 시간을 다시 옮긴다(겹치면 무시 — 같은 결과). 지정을 풀면 새로 옮기지 않고,
-- 옮긴 점은 보존 기간까지 남는다. 1분 평균이 아니라 그 분의 첫 실제 점이다(지어낸 위치가 아니다).
-- 크기: 대상 20개가 1년 내내 끊김 없이 보이면 약 1,050만 행(행 약 100 B + 색인 — 1 GB 남짓 · 추정, 실제 수는 PERF §20). 월 파티션 대신 하루 한 번
-- 묶음 삭제로 보존한다(작은 표 · 운영 1인 — ADR-038).
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행하고 api 코드도 되돌린다(보존한 항적을 지우므로 운영자에게 묻는다) ====
-- DROP TABLE retained_track;
-- DELETE FROM app_setting WHERE key = 'retain_targets';
-- DELETE FROM flyway_schema_history WHERE version = '21';
-- ==== 되돌리기 끝 ====

CREATE TABLE retained_track (
  kind text NOT NULL CONSTRAINT retained_track_kind CHECK (kind IN ('aircraft', 'ship')),
  target_id text NOT NULL,
  ts_minute timestamptz NOT NULL,
  ts timestamptz NOT NULL,          -- 그 분의 첫 점의 실제 시각
  geom geometry(Point, 4326) NOT NULL,
  alt_ft int,
  gs_kt real,
  track_deg real,
  sog_kn real,
  cog_deg real,
  provider text,
  copied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, target_id, ts_minute),
  CONSTRAINT retained_track_id_format CHECK ((kind = 'aircraft' AND target_id ~ '^[0-9a-f]{6}$') OR (kind = 'ship' AND target_id ~ '^[0-9]{9}$')),
  CONSTRAINT retained_track_minute CHECK (ts_minute = date_trunc('minute', ts))
);
CREATE INDEX retained_track_ts_minute ON retained_track (ts_minute);

-- 운영 설정(기본 빈 목록 — 아무것도 옮기지 않는다)
INSERT INTO app_setting (key, value) VALUES ('retain_targets', '""') ON CONFLICT (key) DO NOTHING;

-- 권한(V9 이후 기본 권한 없음): api 의 유지보수 작업이 옮기고 · 지우고, 항적 조회가 읽는다. collector 는 닿지 않는다.
GRANT SELECT, INSERT, DELETE ON retained_track TO wakeline_api;
