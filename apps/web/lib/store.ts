/** 서버 데이터 스토어 — useSyncExternalStore 기반(리렌더 최소화). UI 상태는 ui-store(zustand). */
import { useSyncExternalStore } from "react";
import { ServerClock } from "./server-clock";
import type { DemandInfo } from "./demand";
import type { PortCallsInfo } from "./portcalls";
import type { AisGap, AisStatus, DestinationInfo, ShipGridCell, ShipLite, ShipState, ShipStatic, StaticSource } from "./ships";
import type { AircraftState, Alert, AlertEventType, FeedInfo, KrRadar, PublicStatus, RadarFrames, SelectedInfo, SigmetCollection } from "./types";
import { TRAFFIC_POLL_NONE, type TrafficPollState } from "./traffic-grid";

export type ConnState = "connecting" | "open" | "closed" | "paused";

/**
 * 선박 레이어 표시 상태(계약 v2 §B3). mode 는 서버가 마지막으로 보낸 메시지 종류:
 * "points" = ships_snapshot/diff(줌 ≥ 7, 개별 선박 → shipStates), "grid" = ships_grid(줌 < 7 또는 상한 초과 capped), "waiting" = 레이어를 켰고 아직 받은 것 없음, "off" = 레이어 꺼짐.
 * version 은 shipStates·grid 가 바뀔 때마다 1씩 — 지도는 이 값이 바뀔 때만 다시 그린다.
 */
export interface ShipsView {
  mode: "off" | "waiting" | "points" | "grid";
  version: number;
  /** points: 선박 수 · grid: 칸 수 */
  count: number;
  /** grid: 칸 선박 수의 합 */
  total: number;
  ts: string | null;
  cell_deg: number | null;
  capped: boolean;
  grid: ShipGridCell[];
}

/** WS "ship_selected" — 선택 선박의 최신 상태(ShipState)·정적 정보(ShipStatic) */
export interface ShipSelectedInfo {
  mmsi: string;
  /** null = 실시간 목록에 없음(30분 넘게 수신 없음) */
  state: ShipState | null;
  static: ShipStatic | null;
  /** 계약 v5 §G17 static 의 출처(live · stored · none · stored_unavailable). 서버가 보내지 않았거나 어긋나면 null — 카드는 출처를 말하지 않는다 */
  static_source?: StaticSource | null;
  /** static_source 가 stored 일 때만: 저장 행의 updated_at(DB 에 기록된 수신 시각 — 첫 수신도 마지막 수신도 아님, lib/ships STORED_STATIC_TIME_LABEL) */
  static_updated_at?: string | null;
  /** 계약 v4 §B 목적지 풀이(api 결정적 규칙). 없거나 형식이 틀리면 null — 원문만 보인다 */
  destination_info?: DestinationInfo | null;
  /** ADR-022 한국 항만 입출항(서버 색인을 호출부호로 찾은 것, 해양수산부 PORT-MIS). 서버가 보내지 않았거나 형식이 틀리면 null — 카드는 "—" */
  port_calls?: PortCallsInfo | null;
  received_at: number;
}

/** 선택 선박 항적 요약(지도는 MapView 가 그리고, 카드는 공백 목록을 보여 준다). gapsTruncated = 공백 목록이 잘림(개수는 하한) */
export interface ShipTrackInfo {
  mmsi: string; loaded: boolean; error: string | null; gaps: AisGap[]; gapsTruncated: boolean; segments: number;
  /** 항적 조회 실패의 요청 id(계약 v5 §G5 — 서버가 준 것만, 없으면 null/없음) */
  requestId?: string | null;
  /** 항적 창 시작(ms) — 공백 요약을 이 창으로 자른다 */
  fromMs: number | null;
  /** 항적 창 길이(h, 계약 v5 §B3 — 6 · 12 · 24). 없으면 기본 6 h */
  hours?: number;
}

export interface ServerData {
  conn: ConnState;
  reconnectAttempt: number;
  /** 마지막으로 WS 메시지(ping 포함)를 받은 브라우저 시각(ms, 5 s 단위로만 갱신). null = 이 연결에서 아직 없음 */
  lastRxAt: number | null;
  snapshotVersion: number;
  snapshotAt: string | null;
  /** 지역·전세계 피드의 공급자·수집 시각·지연(스냅샷 sources 와 status 중 최근 것). global=null 이면 전세계 피드 없음 */
  feeds: { region: FeedInfo | null; global: FeedInfo | null };
  /** 구독 bbox 안 항공기 수(마지막 snapshot/diff). null = 모름(첫 스냅샷 전 · 항공기 레이어 꺼짐) */
  aircraftCount: number | null;
  sigmets: SigmetCollection | null;
  sigmetsVersion: number;
  sigmetsFetchedAt: string | null;
  sigmetsProvider: string;
  radar: RadarFrames | null;
  radarKr: KrRadar | null;
  alerts: Map<number, Alert>;
  /** 가진 알림 목록이 완전한 버전(전체 목록 + 이어진 배치). null = 모름(이 연결에서 아직 전체 목록 없음 · 빠진 것이 있음) — 수를 "—" 로 */
  alertsVersion: number | null;
  /**
   * 이 연결에서 알림 목록에 빠진 것이 있다(계약 v5 §E2): 형식 오류로 버린 alerts/alerts_batch · 버린 알림 원소 · 배치 버전 틈. 받은 배치는 반영하지만
   * 수는 모름 — 전체 목록(resync scope alerts · resume · 재연결)을 받으면 false.
   */
  alertsIncomplete: boolean;
  status: PublicStatus | null;
  lastEvent: { type: AlertEventType; alert: Alert; at: number } | null;
  /** WS "selected" — 선택 항공기의 최신 full 상태와 예측 가능 여부 */
  selected: SelectedInfo | null;
  /** WS "demand" — 이 세션의 핫 리전·집중 추적 상태(서버 보고값 그대로). 연결이 끊기면 null */
  demand: DemandInfo | null;
  ships: ShipsView;
  shipSelected: ShipSelectedInfo | null;
  shipTrack: ShipTrackInfo | null;
  /** status.sources.ais — AIS 수신 상태(없으면 null) */
  ais: AisStatus | null;
  /** 마지막으로 구독한 화면(WS subscribe 의 bbox [w,s,e,n]·정수 줌). 선박 칩이 규칙·수신 범위를 말할 때 쓴다. null = 아직 없음 */
  viewport: { bbox: [number, number, number, number]; zoom: number } | null;
  /**
   * 지도에 실제로 보이는 화면 [west, south, east, north] — MapLibre getBounds() 그대로(날짜변경선을 넘으면 경도를 펼친 값, 예: 49 ~ 207).
   * 구독 bbox(viewport)는 낮은 줌에서 날짜변경선을 넘으면 위도 띠 전체라 "화면 안" 판정에 쓸 수 없다(R-08). null = 지도 없음·아직 모름
   */
  mapBounds: [number, number, number, number] | null;
  /** WS 수신 검증(계약 v5 §E2) — 페이지를 연 뒤 누적(재접속해도 지우지 않는다). 상태 바가 0 이 아닐 때만 보인다 */
  wsInvalid: WsInvalid;
  /** 연안 교통량(ADR-023) 조회 상태 — 레이어가 켜져 있을 때만 갱신. 지도는 version 이 바뀔 때만 다시 그린다 */
  trafficGrid: TrafficPollState;
}

/**
 * elements = 버린 원소(형식이 틀린 항공기 · 선박 · 알림 · SIGMET · 격자 칸 · 선택 상태 등 — 메시지의 나머지는 적용했다),
 * messages = 버린 메시지(봉투가 틀림 · JSON 이 아님 — resync 요청), errors = 처리 중 예외(resync 요청 · 브라우저 오류로 보고).
 * last = 마지막 사유("type: 사유"), at = 그때의 브라우저 시각(ms).
 */
export interface WsInvalid { elements: number; messages: number; errors: number; last: string | null; at: number | null }
export const WS_INVALID_NONE: WsInvalid = { elements: 0, messages: 0, errors: 0, last: null, at: null };

export const SHIPS_OFF: ShipsView = { mode: "off", version: 0, count: 0, total: 0, ts: null, cell_deg: null, capped: false, grid: [] };

const initial: ServerData = {
  conn: "connecting",
  reconnectAttempt: 0,
  lastRxAt: null,
  snapshotVersion: 0,
  snapshotAt: null,
  feeds: { region: null, global: null },
  aircraftCount: null,
  sigmets: null,
  sigmetsVersion: 0,
  sigmetsFetchedAt: null,
  sigmetsProvider: "-",
  radar: null,
  radarKr: null,
  alerts: new Map(),
  alertsVersion: null,
  alertsIncomplete: false,
  status: null,
  lastEvent: null,
  selected: null,
  demand: null,
  ships: SHIPS_OFF,
  shipSelected: null,
  shipTrack: null,
  ais: null,
  viewport: null,
  mapBounds: null,
  wsInvalid: WS_INVALID_NONE,
  trafficGrid: TRAFFIC_POLL_NONE,
};
let data: ServerData = initial;

/** 항공기 원본 상태(메인 스레드 사본) — 상세 카드·검색·예측선용. React 상태가 아니다. */
export const aircraftStates = new Map<string, AircraftState>();
/** 선박(ShipLite, MMSI → 상태) — 줌 ≥ 7 에서 서버가 보낸 화면 안 선박. React 상태가 아니다(바뀌면 ships.version 증가). */
export const shipStates = new Map<string, ShipLite>();

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
  shipStates.clear();
  serverClock.reset();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
/** 스토어 변경 구독(useSyncExternalStore 로 파생 값을 만드는 훅용 — lib/clock.ts useRxFresh) */
export const subscribeData = subscribe;
export function useServerData<T>(selector: (d: ServerData) => T): T {
  return useSyncExternalStore(subscribe, () => selector(data), () => selector(data));
}

// ---- 서버 시계 보정(WS-3 · DH-1) ----
// 항공기 경과·stale·외삽(워커 포함), ETA 카운트다운, SIGMET 발효·만료, METAR·레이더 경과처럼 서버 절대 시각과 비교하는 모든 계산이
// 이 오프셋 하나를 쓴다. 추정 방법은 server-clock.ts(작은 메시지 표본의 최댓값). 리렌더를 일으키지 않도록 React 상태가 아니다.
const serverClock = new ServerClock();
/** 서버 시각 표본(welcome·status·작은 diff). 오프셋이 바뀌었으면 true. monoMs = performance.now()(벽시계 변경 감지용, 선택) */
export function observeServerTime(serverIso: unknown, receivedAtMs: number, monoMs?: number | null): boolean {
  return serverClock.observe(serverIso, receivedAtMs, monoMs);
}
/** 서버 − 브라우저(ms). 아직 모르면 null. */
export function clockOffsetMs(): number | null {
  return serverClock.offsetMs;
}
/** 브라우저 시각(ms) → 서버 기준 추정 시각(ms). 서버 시각을 아직 모르면 그대로. */
export function serverNowMs(clientNowMs: number): number {
  return clientNowMs + (serverClock.offsetMs ?? 0);
}
