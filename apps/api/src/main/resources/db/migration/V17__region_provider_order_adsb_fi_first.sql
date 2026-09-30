-- Wakeline 스키마 V17 — 관심 지역 공급자 순서의 기본값 adsb_lol,adsb_fi,opensky → adsb_fi,adsb_lol,opensky (계약 v5 §G25 · ADR-011 개정 2026-09-30 저녁).
-- V1~V16 은 고치지 않는다.
-- 까닭(운영/로그 2026-09-30): adsb.lol 은 미룸이 끝나 체인이 돌아올 때마다 1–2분 안에 HTTP 429 였다(05:46 · 11:48 · 12:16/12:22 · 18:24 KST) — 돌아올
-- 때마다 WARN 한 줄 · 전환 두 번 · 곧 거절할 공급자에 몇 분. adsb.fi 는 그날 관심 지역을 하루 내내 맡았다(운영 RUNS region adsb_fi ok 7,797). 그래서
-- adsb.fi 를 1순위로, adsb.lol 은 폴백으로만 쓴다(그때의 429 쉼 · 미룸 — R-17 — 은 그대로). 수집기 설정 기본값(config.py) · .env.example · compose
-- 기본값도 같은 순서다(infra test_compose_policy 가 넷을 견준다).
-- 운영자가 바꾼 적 없는 값만 바꾼다: updated_by 가 NULL(V1 시드 그대로) 또는 'env'(SettingsService.seedFromEnv 가 쓴 값 — 운영자 변경이 아니다)이고
-- 값이 옛 기본값 그대로일 때. 운영자가 /ops 에서 고른 순서(updated_by = 사용자명)는 옛 기본값과 같은 글자여도 그대로 둔다. 바꾸면 같은 문장에서
-- 감사 기록(시스템 — user_id NULL, SETTING_DEFAULT_V17)을 남기고 낙관적 잠금 version 을 올린다(열려 있던 운영 화면의 저장은 VERSION_MISMATCH).
-- updated_by 는 그대로 둔다 — 여전히 운영자가 고른 값이 아니다. api 가 기동 때와 60 s 마다 DB → Redis wakeline:settings 로 미러하고 수집기는 다음
-- 주기에 따른다(StartupMirror).
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행한다(코드는 되돌리지 않아도 된다 — 순서는 운영 설정 값이다. 수집기 · compose 기본값은 설정이 없을 때만 쓰인다) ====
-- WITH back AS (
--   UPDATE app_setting SET value = '"adsb_lol,adsb_fi,opensky"', version = version + 1, updated_at = now()
--   WHERE key = 'aircraft_providers' AND (updated_by IS NULL OR updated_by = 'env') AND value = '"adsb_fi,adsb_lol,opensky"'::jsonb
--   RETURNING key)
-- INSERT INTO audit_log (user_id, action, target, before, after)
--   SELECT NULL, 'SETTING_DEFAULT_V17_ROLLBACK', key, '"adsb_fi,adsb_lol,opensky"'::jsonb, '"adsb_lol,adsb_fi,opensky"'::jsonb FROM back;
-- DELETE FROM flyway_schema_history WHERE version = '17';
-- ==== 되돌리기 끝 ====
WITH moved AS (
  UPDATE app_setting SET value = '"adsb_fi,adsb_lol,opensky"', version = version + 1, updated_at = now()
  WHERE key = 'aircraft_providers' AND (updated_by IS NULL OR updated_by = 'env') AND value = '"adsb_lol,adsb_fi,opensky"'::jsonb
  RETURNING key)
INSERT INTO audit_log (user_id, action, target, before, after)
  SELECT NULL, 'SETTING_DEFAULT_V17', key, '"adsb_lol,adsb_fi,opensky"'::jsonb, '"adsb_fi,adsb_lol,opensky"'::jsonb FROM moved;
