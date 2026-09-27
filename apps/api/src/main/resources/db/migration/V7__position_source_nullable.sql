-- Wakeline 스키마 V7 — ship_position.position_source 를 모름(NULL) 허용으로(계약 v3 §B, 리뷰 2026-09-28b #5·#16). V1~V6 은 고치지 않는다.
-- AIS Timestamp 0~59 = 전자 위치 장치(EPFS)가 낸 위치 → 'epfs'. 60(값 없음 기본값)·필드 없음·범위 밖은 출처를 말하지 않는다 → NULL.
-- 예전 'gnss' 는 0~60 과 누락을 한데 묶은 값이라 어느 쪽인지 알 수 없다 — 추정해 'epfs' 로 바꾸지 않고 NULL(모름)로 둔다.
-- 순서: NOT NULL·옛 CHECK 를 먼저 풀고 → 'gnss' 를 NULL 로 → 새 CHECK(기존 행 검사). 부모 표에서 바꾸면 모든 파티션에 적용되고,
-- 파티션 함수(V5)가 새로 만드는 파티션도 부모의 새 CHECK 를 물려받는다.
ALTER TABLE ship_position ALTER COLUMN position_source DROP NOT NULL;
ALTER TABLE ship_position DROP CONSTRAINT ship_position_source_check;
UPDATE ship_position SET position_source = NULL WHERE position_source = 'gnss';
ALTER TABLE ship_position ADD CONSTRAINT ship_position_source_check
  CHECK (position_source IS NULL OR position_source IN ('epfs', 'manual', 'estimated', 'inoperative'));
