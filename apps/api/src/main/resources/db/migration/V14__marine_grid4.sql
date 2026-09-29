-- Wakeline 스키마 V14 — 해양수산부 해양격자 4단계 기하 캐시(연안 교통량 · ADR-023). V1~V13 은 고치지 않는다.
-- 한국해양교통안전공단 실시간 해양교통정보는 격자 번호(grid_id)와 척수만 준다. 칸의 위치는 해양수산부 격자4단계 WFS(EPSG:5179)에서
-- 칸마다 한 번 받아(collector — 모르는 칸만, 하루 예산 안에서) 위경도로 풀고 0.025° 격자에 맞는지 검사한 뒤 여기에 둔다 —
-- 다시 시작해도 다시 묻지 않는다. 칸 번호의 글자로 위치를 짐작하지 않는다(위치는 WFS 기하에서만).
-- 값의 원본은 공급자다(파생 캐시): 잃어도 collector 가 다시 채운다(해양수산부 시간 창 안에서 — 설정값으로 계산하면 약 5,100칸 ÷ 시간당 290칸 ≈ 18 h 이상, 잰 값 아님).
--
-- ==== 되돌리기(rollback) SQL — wakeline_migrator 로 실행하고 collector 코드도 되돌린다(새 코드는 표가 없으면 메모리에서만 채운다) ====
-- DROP TABLE marine_grid4;
-- DELETE FROM flyway_schema_history WHERE version = '14';
-- ==== 되돌리기 끝 ====

CREATE TABLE marine_grid4 (
  grid_no text PRIMARY KEY CONSTRAINT marine_grid4_grid_no_format CHECK (grid_no ~ '^[A-Za-z0-9_]{1,32}$'),
  lat_min double precision NOT NULL,
  lon_min double precision NOT NULL,
  lat_max double precision NOT NULL,
  lon_max double precision NOT NULL,
  gid int NULL,
  fetched_at timestamptz NOT NULL,
  -- 한 칸 = 0.025° 정사각형(격자점에서 1e-6° 안 — collector marine_grid.snap 과 같은 한도). 틀린 행은 넣지 못한다(방어선 둘째)
  CONSTRAINT marine_grid4_one_cell CHECK (
    abs(lat_max - lat_min - 0.025) <= 1e-6 AND abs(lon_max - lon_min - 0.025) <= 1e-6
    AND abs(lat_min / 0.025 - round(lat_min / 0.025)) * 0.025 <= 1e-6
    AND abs(lon_min / 0.025 - round(lon_min / 0.025)) * 0.025 <= 1e-6
    AND lat_min >= -90 AND lat_max <= 90 AND lon_min >= -180 AND lon_max <= 180)
);

-- 권한(V9 이후 기본 권한 없음 — 표마다 명시): collector 가 쓰고(upsert = INSERT · UPDATE, 기동 때 SELECT), api 는 읽기만.
-- 지우는 역할은 없다(파생 캐시 — 되돌리기는 migrator).
GRANT SELECT, INSERT, UPDATE ON marine_grid4 TO wakeline_collector;
GRANT SELECT ON marine_grid4 TO wakeline_api;
