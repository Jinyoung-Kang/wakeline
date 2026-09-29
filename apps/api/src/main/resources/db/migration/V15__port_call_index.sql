-- Wakeline 스키마 V15 — 한국 항만 입출항 색인(ADR-022 개정 · 계약 v5 §G16). V1~V14 는 고치지 않는다.
-- 해양수산부 선박운항정보(PORT-MIS Info5)의 clsgn(호출부호) 파라미터는 거르지 않는다(docs/review/evidence/public-data-apis-2026-09-29.txt 마지막 절 —
-- clsgn=V7A3884 는 어느 기간이든 0건, 같은 항만청 · 기간을 clsgn 없이 부르면 494건 중에 있다). 그래서 선택할 때 묻지 않고, collector 가 항만청 10곳의
-- (KST 날짜 하루)씩 모든 신고를 받아 여기에 두고 api 가 AIS 호출부호로 찾는다. 값의 원본은 공급자다(파생 색인 — 잃어도 collector 가 최근 30일을 다시 채운다).
-- port_call: 입항 신고 한 건(자연 키 = 항만청 · 호출부호 · 입항년도 · 입항횟수). listed_date = 원천이 그 행을 올린 KST 날짜(sde = ede = 그 날 · deGb=I
-- 입항일 기준으로 받았다). entry_at · exit_at 은 판(최종 → 최초) 순서로 고른 +09:00 신고 시각(모르면 NULL). fetched_at = 이 행을 마지막으로 받은 응답
-- 시각, updated_at = 값이 마지막으로 바뀐 때. 보존은 listed_date 기준 60일(collector 유지보수 — 범위의 covered_from 도 함께 올린다).
-- port_call_coverage: 항만청마다 [covered_from, covered_to](KST 날짜)의 모든 날을 끝까지 받아 색인했다 · refreshed_at = 마지막으로 끝난 꼬리 갱신
-- (최근 3일)이 시작한 때. api 는 10곳이 모두 30일 창을 덮고 refreshed_at 이 2시간 안일 때만 '기록 없음' 이라 말한다.
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행하고 collector · api 코드도 되돌린다(이전 코드는 이 표를 쓰지 않는다) ====
-- DROP TABLE port_call_coverage;
-- DROP TABLE port_call;
-- DELETE FROM flyway_schema_history WHERE version = '15';
-- ==== 되돌리기 끝 ====

CREATE TABLE port_call (
  prt_ag_cd text NOT NULL CONSTRAINT port_call_prt_ag_cd_format CHECK (prt_ag_cd ~ '^[0-9]{3}$'),
  -- 정규화한 호출부호(collector portcalls.normalize_call_sign — 앞뒤 공백 제거 · 대문자 · 영문 대문자와 숫자 3–7자). 모양이 다르면 넣지 못한다
  clsgn text NOT NULL CONSTRAINT port_call_clsgn_format CHECK (clsgn ~ '^[A-Z0-9]{3,7}$'),
  etrypt_year text NOT NULL CONSTRAINT port_call_etrypt_year_format CHECK (etrypt_year ~ '^[0-9A-Za-z]{1,16}$'),
  etrypt_co text NOT NULL CONSTRAINT port_call_etrypt_co_format CHECK (etrypt_co ~ '^[0-9A-Za-z]{1,16}$'),
  listed_date date NOT NULL,
  prt_ag_nm text NULL,
  vssl_nm text NULL,
  nationality_cd text NULL CONSTRAINT port_call_nationality_cd_format CHECK (nationality_cd ~ '^[A-Z0-9]{1,10}$'),
  nationality_nm text NULL,
  kind_cd text NULL CONSTRAINT port_call_kind_cd_format CHECK (kind_cd ~ '^[A-Z0-9]{1,10}$'),
  kind_nm text NULL,
  purpose_nm text NULL,
  first_port_cd text NULL CONSTRAINT port_call_first_port_cd_format CHECK (first_port_cd ~ '^[A-Z0-9]{2,10}$'),
  first_port_nm text NULL,
  prev_port_cd text NULL CONSTRAINT port_call_prev_port_cd_format CHECK (prev_port_cd ~ '^[A-Z0-9]{2,10}$'),
  prev_port_nm text NULL,
  next_port_cd text NULL CONSTRAINT port_call_next_port_cd_format CHECK (next_port_cd ~ '^[A-Z0-9]{2,10}$'),
  next_port_nm text NULL,
  dest_port_cd text NULL CONSTRAINT port_call_dest_port_cd_format CHECK (dest_port_cd ~ '^[A-Z0-9]{2,10}$'),
  dest_port_nm text NULL,
  entry_at timestamptz NULL,
  entry_revision text NULL CONSTRAINT port_call_entry_revision CHECK (entry_revision IN ('최종', '최초')),
  exit_at timestamptz NULL,
  exit_revision text NULL CONSTRAINT port_call_exit_revision CHECK (exit_revision IN ('최종', '최초')),
  berth text NULL,
  fetched_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT port_call_pkey PRIMARY KEY (prt_ag_cd, clsgn, etrypt_year, etrypt_co),
  -- 판 이름은 시각이 있을 때만(시각 없이 판만 있으면 무엇의 판인지 모른다)
  CONSTRAINT port_call_revision_needs_time CHECK ((entry_revision IS NULL OR entry_at IS NOT NULL) AND (exit_revision IS NULL OR exit_at IS NOT NULL)),
  -- 글은 collector 가 80자로 자른다(route.clean_text) — 둘째 방어선
  CONSTRAINT port_call_text_len CHECK (
    char_length(coalesce(prt_ag_nm, '')) <= 80 AND char_length(coalesce(vssl_nm, '')) <= 80 AND char_length(coalesce(nationality_nm, '')) <= 80
    AND char_length(coalesce(kind_nm, '')) <= 80 AND char_length(coalesce(purpose_nm, '')) <= 80 AND char_length(coalesce(first_port_nm, '')) <= 80
    AND char_length(coalesce(prev_port_nm, '')) <= 80 AND char_length(coalesce(next_port_nm, '')) <= 80 AND char_length(coalesce(dest_port_nm, '')) <= 80
    AND char_length(coalesce(berth, '')) <= 80)
);
-- api 가 선택한 선박의 호출부호로 찾는다(30일 창 · 최근 순)
CREATE INDEX port_call_clsgn_idx ON port_call (clsgn, listed_date DESC);
-- collector 가 하루를 다시 받으면 그 날 목록에서 빠진 행(철회된 신고)을 지운다 · 보존 정리
CREATE INDEX port_call_day_idx ON port_call (prt_ag_cd, listed_date);

CREATE TABLE port_call_coverage (
  prt_ag_cd text PRIMARY KEY CONSTRAINT port_call_coverage_prt_ag_cd_format CHECK (prt_ag_cd ~ '^[0-9]{3}$'),
  covered_from date NOT NULL,
  covered_to date NOT NULL,
  refreshed_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT port_call_coverage_range CHECK (covered_from <= covered_to)
);

-- 권한(V9 이후 기본 권한 없음 — 표마다 명시): collector 가 쓰고(upsert · 철회된 신고와 보존 기간이 지난 행 삭제 · 범위 갱신), api 는 읽기만.
GRANT SELECT, INSERT, UPDATE, DELETE ON port_call TO wakeline_collector;
GRANT SELECT, INSERT, UPDATE ON port_call_coverage TO wakeline_collector;
GRANT SELECT ON port_call, port_call_coverage TO wakeline_api;
