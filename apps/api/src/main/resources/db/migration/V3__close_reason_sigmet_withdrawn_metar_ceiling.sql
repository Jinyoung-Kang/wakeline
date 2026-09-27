-- SkyWx 스키마 V3 (계약 §3). V1·V2 는 고치지 않는다. 마이그레이션은 compose 의 migrate 서비스(--migrate)만 실행한다.
-- 기존 행에는 결정적으로 알 수 있는 값만 채운다. 알 수 없는 값을 추정해 채우지 않는다(데이터 정직성).

-- ---- alert_event: 닫힌 이유 ----
-- left(바깥 3회 관측 확정) | signal_lost(안에 있던 기체의 보고가 끊김) | restart(api 재시작으로 추적이 끊김) | prediction_cleared
-- 이미 닫힌 기존 행은 NULL(사유 미기록)로 둔다: 이전 FSM 은 신호 소실도 LEFT 로 닫았으므로 'left' 로 채우면 거짓이 될 수 있다.
ALTER TABLE alert_event ADD COLUMN close_reason text
  CONSTRAINT alert_event_close_reason_check CHECK (close_reason IN ('left', 'signal_lost', 'restart', 'prediction_cleared'));
ALTER TABLE alert_event ADD CONSTRAINT alert_event_close_reason_needs_left_at CHECK (close_reason IS NULL OR left_at IS NOT NULL);
-- 기동 시 정리(열린 행 닫기)가 전체 표를 훑지 않게
CREATE INDEX alert_event_open ON alert_event (id) WHERE left_at IS NULL;
-- 이전 id 체계(재시작마다 겹칠 수 있던 id)에서 예측 갱신(id 로 UPDATE)이 관측 알림 행을 덮어쓴 흔적(REL-1·COR-2):
-- OBSERVED 행에 예측 근거(method = dead_reckoning_10min)가 들어 있으면 그 근거는 이 행의 것이 아니다. 원래 근거는 복구할 수 없으므로
-- 지우지 않고 표시만 한다(integrity). OBSERVED 에는 eta 가 없으므로 덮어쓰인 eta_s 는 비운다. 새 id 는 겹치지 않고, UPDATE 는 자연키도 맞춘다.
UPDATE alert_event
   SET eta_s = NULL,
       evidence = evidence || '{"integrity": "evidence_overwritten_by_colliding_prediction_update"}'::jsonb
 WHERE kind = 'OBSERVED' AND evidence->>'method' = 'dead_reckoning_10min';

-- ---- sigmet: 철회 시각 · 고도대 출처 ----
-- withdrawn_at: 완전한 수신 세트에서 valid_to 전에 사라진 첫 수신 시각(취소·대체). 재생·통계의 실효 종료 = coalesce(withdrawn_at, valid_to).
ALTER TABLE sigmet ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE sigmet ADD COLUMN base_source text NOT NULL DEFAULT 'json';
ALTER TABLE sigmet ADD COLUMN top_source text NOT NULL DEFAULT 'json';
-- 기존 행(출처 필드가 없던 수집기가 만든 행) 보정:
--   top_ft NULL  → 상한 미발표/무효 = 'unknown' (계약 §4 의 정의 그대로)
--   base_ft = 0  → 이전 수집기는 JSON 하한이 null·음수일 때도 0 을 넣었다. JSON 이 0 이었는지 구분할 수 없으므로 'unknown'
--                  (DB 전용 값 — API 는 null 로 내보낸다. 새 수집기 세트가 오면 json/assumed_surface 로 덮어쓴다)
--   base_ft > 0  → 이전 수집기의 대체값은 0 뿐이므로 JSON 값이다 → 기본값 'json' 유지
UPDATE sigmet SET top_source = 'unknown' WHERE top_ft IS NULL;
UPDATE sigmet SET base_source = 'unknown' WHERE base_ft = 0;
ALTER TABLE sigmet ADD CONSTRAINT sigmet_base_source_check CHECK (base_source IN ('json', 'assumed_surface', 'unknown'));
ALTER TABLE sigmet ADD CONSTRAINT sigmet_top_source_check CHECK (top_source IN ('json', 'raw_text', 'unknown'));

-- ---- metar_obs: 실링 상태 · 비행 카테고리 출처 ----
-- measured(BKN/OVC/OVX/VV 층의 높이가 있음) | none(구름 자료는 있으나 실링 층 없음, CLR/SKC) | unknown(구름 자료 없음)
ALTER TABLE metar_obs ADD COLUMN ceiling_state text
  CONSTRAINT metar_obs_ceiling_state_check CHECK (ceiling_state IN ('measured', 'none', 'unknown'));
-- 이전 수집기는 실링 층의 높이가 있을 때만 ceiling_ft 를 넣었다 → 값이 있으면 'measured' 가 확정. NULL 은 없음/모름을 구분할 수 없어 NULL 로 둔다.
UPDATE metar_obs SET ceiling_state = 'measured' WHERE ceiling_ft IS NOT NULL;
-- 계약 §5: AWC 값도 계산 근거도 없으면 flight_cat = NULL, flight_cat_source = NULL. 기본값 'awc' 는 출처를 단정하므로 없앤다.
ALTER TABLE metar_obs ALTER COLUMN flight_cat_source DROP NOT NULL;
ALTER TABLE metar_obs ALTER COLUMN flight_cat_source DROP DEFAULT;
-- 이전 계산 경로는 모르는 시정·실링을 VFR 로 바꿨다(GAP-16). 입력이 빠진 '계산값' 은 근거가 없으므로 지운다(수집기가 다음 수신 때 다시 계산).
UPDATE metar_obs SET flight_cat = NULL, flight_cat_source = NULL
 WHERE flight_cat_source = 'computed' AND (vis_sm IS NULL OR ceiling_ft IS NULL);
-- 카테고리가 없는 행의 출처는 의미가 없다
UPDATE metar_obs SET flight_cat_source = NULL WHERE flight_cat IS NULL;
ALTER TABLE metar_obs ADD CONSTRAINT metar_obs_flight_cat_source_check CHECK (flight_cat_source IN ('awc', 'computed'));
ALTER TABLE metar_obs ADD CONSTRAINT metar_obs_flight_cat_needs_source CHECK ((flight_cat IS NULL) = (flight_cat_source IS NULL));

-- ---- 보존(retention) 삭제 권한: api 의 야간 작업이 수집 테이블의 오래된 행을 지운다(REL-11) ----
GRANT DELETE ON metar_obs, radar_frame, ingest_run, quality_event, quality_rule_count TO skywx_api;
