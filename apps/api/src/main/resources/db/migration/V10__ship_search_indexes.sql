-- Wakeline 스키마 V10 — 선박 검색 인덱스(계약 v5 §B1). V1~V9 는 고치지 않는다. 적용은 운영과 같은 --migrate(wakeline_migrator)만.
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 위에서부터 순서대로 실행한 뒤 이력 행을 지운다 ====
-- DROP INDEX IF EXISTS ship_imo;
-- DROP INDEX IF EXISTS ship_call_sign_prefix;
-- DROP INDEX IF EXISTS ship_name_prefix;
-- DELETE FROM flyway_schema_history WHERE version = '10';
-- ==== 되돌리기 끝 ====

-- ---- 선박 검색(GET /api/v1/ships/search — ShipRepository.search) ----
-- ship 은 보존 없이 커진다(MMSI 마다 한 행, 영구). 선명·호출부호 앞부분 일치는 바이트 순서 범위(~>=~ · ~<~)로 묻는다 — text_pattern_ops 식 인덱스는
-- 그 연산자를 파라미터 그대로(일반 계획에서도) 쓰고, 두 조건은 BitmapOr 로 합친다(V9 의 항공기 검색과 같은 방식). 대소문자 무시는 upper(...) 식으로.
-- IMO 는 정확 일치. MMSI 정확·앞부분(9자리 숫자열 범위)은 기본 키(ship_pkey)를 쓴다 — 인덱스를 따로 만들지 않는다.
-- 권한(V9 R-88 — 새 표·시퀀스는 명시 GRANT 만): 여기서는 인덱스만 만든다. 인덱스는 따로 권한이 없고 표 권한(ship: api SELECT·INSERT·UPDATE, V5)을
-- 따르므로 GRANT 가 필요 없다. 이 파일은 표·시퀀스·함수를 만들지 않는다.
CREATE INDEX ship_name_prefix ON ship (upper(name) text_pattern_ops);
CREATE INDEX ship_call_sign_prefix ON ship (upper(call_sign) text_pattern_ops);
CREATE INDEX ship_imo ON ship (imo);
