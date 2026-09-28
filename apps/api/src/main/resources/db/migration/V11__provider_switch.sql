-- Wakeline 스키마 V11 — 공급자 스위치의 원본을 DB 로(계약 v5 §D1 · 리뷰 R-94 · ADR-019). V1~V10 은 고치지 않는다.
-- 이전에는 운영자의 켜고 끄기가 Redis 해시 wakeline:provider:{name} 의 disabled 에만 있었다(DB 에는 감사 행뿐) — Redis 볼륨을 잃으면 조용히 '켜짐'으로
-- 돌아가고, 같은 해시에 상태 필드를 쓰는 collector 가 감사 없이 값을 바꿀 수 있었다. 이제 이 표가 원본이고 Redis 는 미러다:
-- 토글은 감사 행과 한 트랜잭션, 커밋 뒤 미러, 60 s 마다 다시 미러(StartupMirror). 행이 없는 공급자는 api 가 그때의 Redis 값을 한 번 옮겨 담는다
-- (ProviderSwitchService — SQL 로는 Redis 를 읽을 수 없어서 이관은 코드가 한다). updated_by NULL = 시스템(이관).
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행한 뒤 코드도 되돌린다(Redis 값은 그대로 남아 이전처럼 동작한다) ====
-- -- V12 가 적용돼 있으면 V12 의 되돌리기를 먼저 한다(최신부터 역순).
-- DROP TABLE provider_switch;
-- DELETE FROM flyway_schema_history WHERE version = '11';
-- ==== 되돌리기 끝 ====

CREATE TABLE provider_switch (
  provider text PRIMARY KEY,
  disabled boolean NOT NULL,
  version int NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by int NULL REFERENCES ops_user(id)
);

-- 권한(V9 이후 기본 권한 없음 — 표마다 명시): api 는 읽고·만들고·바꾸기만(지우지 않는다 — 스위치는 공급자마다 한 행). collector 는 없음(Redis 미러만 본다).
GRANT SELECT, INSERT, UPDATE ON provider_switch TO wakeline_api;
