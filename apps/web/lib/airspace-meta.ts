/**
 * 공역 레이어(계약 v5 §G47 · ADR-034)의 이름 · 지도 레이어 id — 첫 화면(레이어 단추 · 호버 우선순위)이 쓰는 작은 부분만. 조회 · 그리기 · 거르기 · 툴팁 ·
 * 상태 줄은 레이어를 켤 때 받는 조각(lib/airspace · components/AirspaceLayer — ADR-026)에 있다.
 */
export const AIRSPACE_LAYER_LABEL = "공역";
/** 지도 레이어 id(호버 우선순위 목록 PICK_LAYERS 가 이름으로 쓴다 — 레이어는 조각이 붙인다) */
export const AIRSPACE_FILL_LAYER = "airspace-fill";
export const AIRSPACE_LINE_LAYER = "airspace-line";
