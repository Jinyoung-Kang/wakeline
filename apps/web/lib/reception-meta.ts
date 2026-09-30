/**
 * 관측 수신 범위 레이어(계약 v5 §G27 · ADR-027)의 이름 · 색 · 범례 문구 — 첫 화면(레이어 단추 · 범례)이 쓰는 작은 부분만. 조회 · 해석 · 칸 그리기 ·
 * 툴팁 · 상태 줄은 레이어를 켤 때 받는 조각(lib/reception · components/ReceptionLayer — ADR-026)에 있다.
 * 이 레이어는 '구독 범위(운영 설정 — 선박 레이어의 점선)'가 아니라 이 서비스가 최근 24 h 에 실제로 선박 위치를 받은 0.5° 칸이다(api /ships/coverage).
 */

export const RECEPTION_LAYER_LABEL = "관측 수신 범위(최근 24 h)";
/** 지도 레이어 id(호버 우선순위 목록 PICK_LAYERS 가 이름으로 쓴다 — 레이어는 조각이 붙인다) */
export const RECEPTION_FILL_LAYER = "reception-fill";
export const RECEPTION_LINE_LAYER = "reception-line";
/** 칸 색(한 가지 — 옅은 파랑). 연안 교통량(주황) · 선종 색 · 수신 범위 점선(회청)과 겹치지 않게 고른 표시용 값 */
export const RECEPTION_COLOR = "#5fb4e0";
/**
 * 칸 선박 수(창 안 서로 다른 MMSI) 구간 → 채움 불투명도. 옅게 — 선박 · 항공기 기호가 위에서 보이게. 구간 · 불투명도는 표시용 선택값이다(잰 값 아님):
 * 실DB 측정(2026-09-30, 최근 24 h — 한국 상자의 선박 304척이 모두 인천 · 경기만 1° 칸 하나 · 시간당 80–130척, 도쿄만 상자 769척)의 한 자리 · 두 자리 ·
 * 세 자리 수가 서로 다르게 보이도록 나눴다.
 */
export const RECEPTION_BINS: readonly { min: number; label: string; opacity: number }[] = [
  { min: 1, label: "1–2", opacity: 0.1 },
  { min: 3, label: "3–9", opacity: 0.16 },
  { min: 10, label: "10–29", opacity: 0.23 },
  { min: 30, label: "30–99", opacity: 0.3 },
  { min: 100, label: "100+", opacity: 0.38 },
];
export const RECEPTION_LEGEND_NOTE =
  "잰 값: 이 서비스가 최근 24 h 에 실제로 선박 위치를 받은 0.5° 칸(aisstream 은 육상 수신국이 받은 것만 보낸다) — 구독 범위(점선)가 아니다";
