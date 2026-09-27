/** 서버 데이터 스토어 — useSyncExternalStore 기반(리렌더 최소화). UI 상태는 ui-store(zustand). */
import { useSyncExternalStore } from "react";
import type { AircraftState, Alert, PublicStatus, RadarFrames, SigmetCollection } from "./types";

export type ConnState = "connecting" | "open" | "closed" | "paused";

export interface ServerData {
  conn: ConnState;
  reconnectAttempt: number;
  snapshotVersion: number;
  snapshotAt: string | null;
  provider: string;
  lagS: number | null;
  stale: boolean;
  scope: "region" | "world";
  aircraftCount: number;
  sigmets: SigmetCollection | null;
  sigmetsVersion: number;
  sigmetsFetchedAt: string | null;
  sigmetsProvider: string;
  radar: RadarFrames | null;
  alerts: Map<number, Alert>;
  status: PublicStatus | null;
  lastEvent: { type: string; alert: Alert; at: number } | null;
}

let data: ServerData = {
  conn: "connecting",
  reconnectAttempt: 0,
  snapshotVersion: 0,
  snapshotAt: null,
  provider: "-",
  lagS: null,
  stale: true,
  scope: "region",
  aircraftCount: 0,
  sigmets: null,
  sigmetsVersion: 0,
  sigmetsFetchedAt: null,
  sigmetsProvider: "-",
  radar: null,
  alerts: new Map(),
  status: null,
  lastEvent: null,
};

/** 항공기 원본 상태(메인 스레드 사본) — 상세 카드·검색용. React 상태가 아니다. */
export const aircraftStates = new Map<string, AircraftState>();

const listeners = new Set<() => void>();
export function setData(patch: Partial<ServerData>) {
  data = { ...data, ...patch };
  for (const l of listeners) l();
}
export function getData() {
  return data;
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useServerData<T>(selector: (d: ServerData) => T): T {
  return useSyncExternalStore(subscribe, () => selector(data), () => selector(data));
}
