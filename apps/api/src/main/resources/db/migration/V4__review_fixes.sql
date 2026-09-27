-- Wakeline 스키마 V4 — 리뷰(2026-09-28) 수정. V1~V3 은 고치지 않는다. V5 는 선박(AIS) 표를 위해 비워 둔다.
-- 기존 행에는 저장된 값에서 결정적으로 알 수 있는 것만 채운다(데이터 정직성 — 추정해 채우지 않는다).

-- ---- alert_event: 닫힌 이유 'sigmet_ended' (DH-6 · API-CONC-4) ----
-- 경보(SIGMET)가 만료되었거나 철회(취소·대체)되어 알림이 끝났다 — 항공기가 나간 것(left)이 아니다.
-- 기존 'left' 행은 바꾸지 않는다: 근거에 sigmet_expired 가 있어도 항공기가 만료 전에 실제로 나갔을 수 있어 구분할 수 없다
-- (그런 행은 체류 통계에서만 뺀다 — 아래 재계산과 MaintenanceJobs.CONFIRMED_EXIT).
ALTER TABLE alert_event DROP CONSTRAINT alert_event_close_reason_check;
ALTER TABLE alert_event ADD CONSTRAINT alert_event_close_reason_check
  CHECK (close_reason IN ('left', 'signal_lost', 'restart', 'sigmet_ended', 'prediction_cleared'));

-- ---- sigmet: 상한 출처 'raw_text_lower_bound' (DH-4) ----
-- 원문 "TOP ABV FLnnn" 은 상한이 아니라 '상한의 하한'(FLnnn 이상)이다. 판정은 상한 무제한을 가정하고 화면은 "FLnnn 이상" 으로 쓴다.
ALTER TABLE sigmet DROP CONSTRAINT sigmet_top_source_check;
ALTER TABLE sigmet ADD CONSTRAINT sigmet_top_source_check
  CHECK (top_source IN ('json', 'raw_text', 'raw_text_lower_bound', 'unknown'));
-- 기존 행 보정(결정적): 원문에 "TOP ABV FLnnn" 이 있고 저장된 상한이 바로 그 값(nnn × 100 ft)이면 그 상한은 하한이다.
-- JSON 상한이 그 값인 경우(AWC 가 ABV 값을 top 으로 준 경우)도 같다. 정규식은 수집기(sigmet_parse._TOP_RE)의 ABV 형태와 같다(단어 경계, 공백·줄바꿈 허용).
UPDATE sigmet
   SET top_source = 'raw_text_lower_bound'
 WHERE top_source IN ('json', 'raw_text')
   AND top_ft IS NOT NULL
   AND substring(raw_text FROM '\yTOP\s+ABV\s+FL(\d{3})\y')::int * 100 = top_ft;

-- ---- alert_event: 예측 갱신이 남긴 열 불일치 (API-CONC-5) ----
-- 이전 PREDICTION_UPDATED 는 eta_s·근거만 바꾸고 alt_ft_at_entry 를 첫 예측 값으로 남겼다. 근거(evidence)는 마지막 예측의 것이므로
-- 그 값이 이 행의 진입 고도다(결정적 — 같은 예측의 값으로 맞춘다).
UPDATE alert_event
   SET alt_ft_at_entry = (evidence->>'alt_ft_at_entry')::int
 WHERE kind = 'PREDICTED'
   AND jsonb_typeof(evidence->'alt_ft_at_entry') = 'number'
   AND alt_ft_at_entry IS DISTINCT FROM (evidence->>'alt_ft_at_entry')::int;

-- ---- stats_daily: 체류 평균 재계산 (DH-5 · API-CONC-3) ----
-- 이전 규칙은 사유 미기록(NULL — V3 가 밝혔듯 신호 소실도 LEFT 로 닫혔을 수 있다) 행을 넣어 확인된 이탈보다 큰 값을 영구 통계로 남겼다.
-- 이미 집계된 날만 새 규칙(close_reason = 'left' 이고 경보 만료 뒤 닫힌 옛 행 제외)으로 다시 만든다. 해당 알림이 없는 날은 행이 없다(0 을 지어내지 않는다).
DELETE FROM stats_daily WHERE metric = 'alert_dwell_avg_s';
INSERT INTO stats_daily (day, metric, dim, value)
SELECT (entered_at AT TIME ZONE 'UTC')::date, 'alert_dwell_avg_s', 'OBSERVED', avg(extract(epoch FROM (left_at - entered_at)))
  FROM alert_event
 WHERE kind = 'OBSERVED' AND left_at IS NOT NULL
   AND close_reason = 'left' AND NOT coalesce((evidence->>'sigmet_expired')::boolean, false)
   AND (entered_at AT TIME ZONE 'UTC')::date IN (SELECT DISTINCT day FROM stats_daily)
 GROUP BY 1;
