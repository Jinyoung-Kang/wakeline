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
/** 범례가 읽는 관측 수신 상태(lib/store ReceptionInView 의 부분 — 레이어 조각이 채운다) */
export interface ReceptionLegendState { covered: "full" | "partial" | "since_api_start"; since: string; stale: boolean; truncated?: boolean }

/**
 * 범례의 센 구간 글(리뷰 2026-09-30 밤 — 계약 v5 §G27 '창 전체인 척하지 않는다'): 전에는 범례가 늘 '최근 24 h'라 적어, api 재시작 직후처럼 창의 일부만 셌을 때
 * 바로 위 상태 줄('창의 일부만 셈 — … 부터')과 어긋났다. span = 척 수 설명의 구간 · empty = 빈 곳의 뜻 · warn = 따로 알릴 것(메모리 상한 · 조회 실패).
 * 자료를 아직 모르면(레이어 조각이 받는 중) '센 구간(상태 줄)'. since 는 KST 글자로 받는다(부르는 쪽이 lib/time 으로 만든다).
 */
export function receptionLegendSpan(o: ReceptionLegendState | null, sinceKst: string | null): { span: string; empty: string; warn: string[] } {
  const warn: string[] = [];
  if (o?.truncated) warn.push("메모리 상한 — 세지 못한 위치가 있어 빈 칸이 '받은 적 없음'이 아닐 수 있음(상태 줄)");
  if (o?.stale) warn.push("조회 실패 — 마지막 값(상태 줄)");
  if (!o) return { span: "센 구간", empty: "빈 곳 = 센 구간(상태 줄의 창) 동안 받은 위치 없음(구독 범위 안이어도)", warn };
  if (o.covered === "full") return { span: "최근 24 h", empty: "빈 곳 = 최근 24 h 에 받은 위치 없음(구독 범위 안이어도)", warn };
  const from = `${sinceKst ?? "—"} 부터`;
  return { span: from, empty: `빈 곳 = ${from} 받은 위치 없음(창의 일부만 셈 — 까닭은 상태 줄 · 구독 범위 안이어도)`, warn };
}

export const RECEPTION_LEGEND_NOTE =
  "잰 값: 이 서비스가 최근 24 h 에 실제로 선박 위치를 받은 0.5° 칸(aisstream 은 육상 수신국이 받은 것만 보낸다) — 구독 범위(점선)가 아니다";
