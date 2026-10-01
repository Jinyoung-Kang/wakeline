/** 알림 표시 규칙(순수 함수): ETA 카운트다운(GAP-21)·종료 사유·근거의 고도대 출처. */
import type { BandSource } from "./format";
import { topAboveFromRaw } from "./sigmet";
import type { Alert, AlertEventType, CloseReason, PublicStatus, SigmetProps } from "./types";

/**
 * 남은 ETA(초, 추정). eta_at(서버 판정 시각 + eta_s)에서 서버 기준 현재 시각을 뺀다 — 목록의 ETA 가 다음 갱신까지 멈춰 있지 않게.
 * eta_at 이 없으면 evidence.judged_at + eta_s, 그것도 없으면 받은 eta_s 그대로. 모르면 null.
 */
export function etaRemainingS(a: Pick<Alert, "eta_at" | "eta_s" | "evidence">, serverNowMs: number): number | null {
  let at = a.eta_at ? Date.parse(a.eta_at) : NaN;
  if (Number.isNaN(at) && a.eta_s != null) {
    const judged = typeof a.evidence?.judged_at === "string" ? Date.parse(a.evidence.judged_at) : NaN;
    if (!Number.isNaN(judged)) at = judged + a.eta_s * 1000;
  }
  if (!Number.isNaN(at)) return Math.max(0, Math.round((at - serverNowMs) / 1000));
  return a.eta_s ?? null;
}

export const CLOSE_REASON_LABEL: Record<CloseReason, string> = {
  left: "이탈 확인(바깥 관측 3회)",
  signal_lost: "신호 끊김(이탈 미확인)",
  restart: "서버 재시작으로 종료",
  prediction_cleared: "예측 해제",
};
export function closeReasonLabel(r: string | null | undefined): string {
  return r && r in CLOSE_REASON_LABEL ? CLOSE_REASON_LABEL[r as CloseReason] : "—";
}

/** 알림 배너(마지막 이벤트)를 보이는 시간 — 이보다 오래된 이벤트는 방금 일어난 일처럼 보이지 않게 숨긴다(R-23) */
export const EVENT_BANNER_TTL_MS = 5 * 60_000;
/** 받은 시각(atMs)과 지금(nowMs, 둘 다 브라우저 시계)으로 배너를 보일지. 지금을 아직 모르면(0 — 첫 렌더) 보인다. */
export function eventBannerVisible(atMs: number, nowMs: number): boolean {
  return !nowMs || nowMs - atMs <= EVENT_BANNER_TTL_MS;
}

export const EVENT_LABEL: Record<AlertEventType, string> = {
  ENTERED: "진입",
  LEFT: "이탈",
  LOST: "신호 끊김(이탈 미확인)",
  PREDICTED: "진입 예상(추정)",
  PREDICTION_UPDATED: "예측 갱신(추정)",
  PREDICTION_CLEARED: "예측 해제",
};

/** 근거의 고도대 [base, top]. top 이 null 또는 구버전의 -1 이면 미발표. */
export function evidenceBand(ev: Record<string, unknown>): { base: number | null; top: number | null } | null {
  const b = ev.band_ft;
  if (!Array.isArray(b) || b.length < 2) return null;
  const base = typeof b[0] === "number" && b[0] >= 0 ? b[0] : null;
  const top = typeof b[1] === "number" && b[1] >= 0 ? b[1] : null;
  return { base, top };
}

/**
 * 근거의 고도대 출처: 근거에 담긴 base_source/top_source(판정 당시)를 우선, 없으면 현재 SIGMET 속성.
 * 원문 "TOP ABV FLxxx" 여부는 SIGMET 원문에서 결정적으로 읽는다.
 */
export function evidenceBandSource(ev: Record<string, unknown>, sigmet: Pick<SigmetProps, "base_source" | "top_source" | "raw_text"> | null | undefined, topFt: number | null): BandSource {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const baseSource = str(ev.base_source) ?? (ev.base_assumed_surface === true ? "assumed_surface" : null) ?? sigmet?.base_source ?? null;
  const topSource = str(ev.top_source) ?? (ev.top_assumed_unbounded === true ? "unknown" : null) ?? sigmet?.top_source ?? null;
  return { base_source: baseSource, top_source: topSource, top_above: topSource === "raw_text" && topAboveFromRaw(sigmet?.raw_text, topFt) };
}

/**
 * 알림 목록의 신뢰 상태(DH-9). "live" 일 때만 목록이 현재이고 ETA 가 카운트다운한다.
 * - waiting: 이 연결에서 아직 alerts 메시지를 받지 못함(페이지 첫 로드·재연결 직후) — 빈 목록을 "없음"으로 말하지 않는다.
 * - disconnected: 받은 적은 있으나 연결이 끊김/재연결 중 — 마지막 목록(갱신 안 됨).
 * - silent: 연결은 열려 있지만 RX_FRESH_MS 넘게 아무것도 받지 못함(반쯤 열린 연결) — 상태 바·지도 칩과 같은 규칙(isRxFresh, R-58).
 * - paused: 탭 숨김으로 서버가 보내지 않는 중.
 * - incomplete: 이 연결의 목록에 빠진 것이 있다(계약 v5 §E2 — 형식 오류로 버린 알림 메시지·원소, 배치 버전 틈). 받은 배치는 반영하지만 수는 모르고
 *   ETA 는 멈춘다 — 전체 목록을 다시 받으면 live.
 * rxFresh = isRxFresh(conn, lastRxAt, now) — 화면은 useRxFresh() 로 얻는다. incomplete = 스토어 alertsIncomplete.
 */
export type AlertListState = "live" | "waiting" | "incomplete" | "disconnected" | "silent" | "paused";
export function alertListState(conn: string, alertsVersion: number | null | undefined, rxFresh = true, incomplete = false): AlertListState {
  if (conn === "paused") return "paused";
  if (conn === "open") return alertsVersion == null ? (incomplete ? "incomplete" : "waiting") : rxFresh ? "live" : "silent";
  return alertsVersion != null ? "disconnected" : "waiting";
}

/**
 * 알림 패널의 목록(R-09): 관심 지역(region) = 서버 설정의 중심 · 반경 안(설정값이 없으면 전체). 위치(evidence.position [lat, lon])가 없는 알림은 전세계(world)에서만.
 * 관심 지역 설정(status)을 아직 받지 못했으면 범위를 모른다 — 전세계 목록을 '관심 지역'으로 보이지 않고 빈 목록(부른 쪽이 기다린다고 말한다).
 * 거리는 평면 근사(위도 1° = 60 NM, 경도는 중심 위도의 cos 로 줄임). 순서: 관측(OBSERVED) 먼저, 같은 종류는 진입 시각 최신 먼저.
 */
export function alertsInScope(all: readonly Alert[], scope: "region" | "world", status: Pick<PublicStatus, "region"> | null): Alert[] {
  if (scope === "region" && status == null) return [];
  const center = status?.region?.center, radius = status?.region?.radius_nm;
  const inRegion = (a: Alert) => {
    if (!center || !radius) return true;
    const pos = (a.evidence as { position?: number[] }).position;
    if (!pos) return false;
    const dLat = (pos[0] - center[0]) * 60, dLon = (pos[1] - center[1]) * 60 * Math.cos((center[0] * Math.PI) / 180);
    return Math.hypot(dLat, dLon) <= radius;
  };
  return all.filter((a) => scope === "world" || inRegion(a))
    .sort((a, b) => (a.kind === b.kind ? b.entered_at.localeCompare(a.entered_at) : a.kind === "OBSERVED" ? -1 : 1));
}
