-- Wakeline 스키마 V6 — AIS 구독 영역 런타임 설정(ADR-014 §7). V1~V5 는 고치지 않는다.
-- 값 형식은 "lat1,lon1,lat2,lon2" 를 ';' 로 이어 쓴 문자열(ais/bbox.py parse_bboxes · api SettingsService 가 같은 규칙으로 검사).
-- 빈 문자열 = 운영자가 정하지 않음 → ais 프로세스는 .env AIS_BBOXES 를 쓴다. 운영 API 로 바꾸면 감사 기록과 함께 wakeline:settings 에 미러된다.
INSERT INTO app_setting (key, value) VALUES ('ais_bboxes', '""') ON CONFLICT (key) DO NOTHING;
