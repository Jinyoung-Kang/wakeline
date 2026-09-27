/** 서버 데이터 스토어 — useSyncExternalStore 기반(리렌더 최소화). UI 상태는 ui-store(zustand). */
import { useSyncExternalStore } from "react";
import type { AircraftState, Alert, AlertEventType, FeedInfo, KrRadar, PublicStatus, RadarFrames, SelectedInfo, SigmetCollection } from "./types";

export type ConnState = "connecting" | "open" | "closed" | "paused";

export interface ServerData {
  conn: ConnState;
  reconnectAttempt: number;
  snapshotVersion: number;
  snapshotAt: string | null;
  /** 지역·전세계 피드의 공급자·수집 시각·지연(스냅샷 sources 와 status 중 최근 것). global=null 이면 전세계 피드 없음 */
  feeds: { region: FeedInfo | null; global: FeedInfo | null };
  aircraftCount: number;
  sigmets: SigmetCollection | null;
  sigmetsVersion: number;
  sigmetsFetchedAt: string | null;
  sigmetsProvider: string;
  radar: RadarFrames | null;
  radarKr: KrRadar | null;
  alerts: Map<number, Alert>;
  alertsVersion: number | null;
  status: PublicStatus | null;
  lastEvent: { type: AlertEventType; alert: Alert; at: number } | null;
  /** WS "selected" — 선택 항공기의 최신 full 상태와 예측 가능 여부 */
  selected: SelectedInfo | null;
}

const initial: ServerData = {
  conn: "connecting",
  reconnectAttempt: 0,
  snapshotVersion: 0,
  snapshotAt: null,
  feeds: { region: null, global: null },
  aircraftCount: 0,
  sigmets: null,
  sigmetsVersion: 0,
  sigmetsFetchedAt: null,
  sigmetsProvider: "-",
  radar: null,
  radarKr: null,
  alerts: new Map(),
  alertsVersion: null,
  status: null,
  lastEvent: null,
  selected: null,
};
let data: ServerData = initial;

/** 항공기 원본 상태(메인 스레드 사본) — 상세 카드·검색·예측선용. React 상태가 아니다. */
export const aircraftStates = new Map<string, AircraftState>();

const listeners = new Set<() => void>();
export function setData(patch: Partial<ServerData>) {
  data = { ...data, ...patch };
  for (const l of listeners) l();
}
export function getData() {
  return data;
}
/** 테스트용: 스토어 초기화 */
export function resetData() {
  data = { ...initial, alerts: new Map(), feeds: { region: null, global: null } };
  aircraftStates.clear();
  clockOffsetMs = null;
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useServerData<T>(selector: (d: ServerData) => T): T {
  return useSyncExternalStore(subscribe, () => selector(data), () => selector(data));
}

// ---- 서버 시계 보정 ----
// ETA 카운트다운·SIGMET 만료처럼 서버 절대 시각(eta_at, valid_to)과 비교할 때 브라우저 시계 오차를 줄인다.
// 서버 메시지의 ts/server_time − 수신 시각(네트워크 지연만큼 작게 추정됨). 리렌더를 일으키지 않도록 React 상태가 아니다.
let clockOffsetMs: number | null = null;
export function observeServerTime(serverIso: unknown, receivedAtMs: number) {
  if (typeof serverIso !== "string") return;
  const t = Date.parse(serverIso);
  if (Number.isNaN(t)) return;
  const est = t - receivedAtMs;
  // 큰 점프(시계 변경·서버 교체)는 즉시 반영, 평소에는 완만하게(지터 억제)
  clockOffsetMs = clockOffsetMs == null || Math.abs(est - clockOffsetMs) > 5000 ? est : clockOffsetMs * 0.8 + est * 0.2;
}
/** 브라우저 시각(ms) → 서버 기준 추정 시각(ms). 서버 시각을 아직 모르면 그대로. */
export function serverNowMs(clientNowMs: number): number {
  return clientNowMs + (clockOffsetMs ?? 0);
}
