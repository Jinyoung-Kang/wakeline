import { create } from "zustand";
import { SHIP_CATEGORIES, type ShipCategory, type ShipTrackHours } from "./ships";

export interface Layers {
  radar: boolean;
  sigmet: boolean;
  aircraft: boolean;
  /** 선박(AIS) — 기본 끔(서버 기본과 같게). 켜면 서버가 선박을 보내기 시작한다. */
  ships: boolean;
  airports: boolean;
  tracks: boolean;
  prediction: boolean;
  /**
   * 연안 교통량(ADR-023 — 5분 집계 격자별 선박 척수, 개별 위치 아님) — 기본 끔. 켜면 /api/v1/traffic/grid 를 조회한다.
   * 선택 필드: 이 필드 전에 만든 레이어 객체(저장된 설정 · 시험의 리터럴)도 그대로 '끔'으로 읽힌다(undefined = 끔).
   */
  traffic?: boolean;
  /**
   * 관측 수신 범위(ADR-027 — 이 서비스가 최근 24 h 에 실제로 선박 위치를 받은 0.5° 칸, 구독 범위 아님) — 기본 끔. 켜면 /api/v1/ships/coverage 를 조회하는
   * 조각(components/ReceptionLayer)을 받는다. 선택 필드(없으면 끔 — traffic 과 같다).
   */
  reception?: boolean;
  /** 공역(ADR-034 · 계약 v5 §G47) — 켤 때 조각(components/AirspaceLayer)을 받는다. 선택 필드(없으면 끔) */
  airspace?: boolean;
}

export type UiPanel = "alerts" | "aircraft" | "ship" | "sigmet" | "airport" | "wx" | "watch";

interface UiState {
  layers: Layers;
  toggleLayer: (k: keyof Layers) => void;
  /** 저장된 레이어 설정 적용(lib/prefs.ts) */
  setLayers: (l: Partial<Layers>) => void;
  radarOpacity: number;
  radarFrameIndex: number | null; // null = 최신
  setRadarFrame: (i: number | null) => void;
  radarPlaying: boolean;
  setRadarPlaying: (b: boolean) => void;
  radarSource: "rainviewer" | "kma";
  setRadarSource: (s: "rainviewer" | "kma") => void;
  krFrameIndex: number | null;
  setKrFrame: (i: number | null) => void;
  selectedHex: string | null;
  /**
   * 항공기를 고를 때마다 오르는 값(같은 hex 를 다시 골라도 — 해제 null 에는 그대로). selectedHex 가 같아도 '다시 골랐다'를 알린다:
   * components/map/useSelectionTracks 가 WS select 를 다시 보내 서버가 선택 시각을 새로 잡는다(집중 추적 30분 상한 뒤 "다시 선택하면 이어짐").
   */
  selectNonce: number;
  select: (hex: string | null) => void;
  selectedSigmet: string | null;
  selectSigmet: (id: string | null) => void;
  selectedAirport: string | null;
  selectAirport: (icao: string | null) => void;
  /** 선택 선박 MMSI(9자리) */
  selectedShip: string | null;
  selectShip: (mmsi: string | null) => void;
  panel: UiPanel;
  setPanel: (p: UiPanel) => void;
  /** 지도 이동 요청(검색 결과 선택 등). id 가 바뀔 때마다 MapView 가 한 번 이동한다(따른 id 는 flyHandled). */
  flyTo: { lon: number; lat: number; zoom: number; id: number } | null;
  requestFlyTo: (lon: number, lat: number, zoom?: number) => void;
  /**
   * 지도가 따른 마지막 이동 요청 id(flyTo.id — components/map/useMapLifecycle 이 옮길 때 적는다). 지도 컴포넌트 밖(여기)에 두어, 지도를 다시 만들어도(다른
   * 화면에서 돌아옴) 따른 요청은 되풀이하지 않고, 지도가 마운트되기 전의 요청(지도 조각 · MapLibre 를 받기 전의 상단 검색 — app/page.tsx)은 따른다(IM-14).
   */
  flyHandled: number;
  setFlyHandled: (id: number) => void;
  legendOpen: boolean;
  setLegendOpen: (b: boolean) => void;
  /** 선종 필터(계약 v5 §B3): 켜진 선종(SHIP_CATEGORIES 순서). 저장은 lib/prefs.ts(브라우저에만) */
  shipCats: ShipCategory[];
  toggleShipCat: (c: ShipCategory) => void;
  setShipCats: (cats: readonly ShipCategory[]) => void;
  /** 선택 선박 항적 기간(계약 v5 §B3 — 6 · 12 · 24 h). 바꾸면 MapView 가 그 창으로 다시 받는다 */
  shipTrackHours: ShipTrackHours;
  setShipTrackHours: (h: ShipTrackHours) => void;
  /** 배경지도 스타일(외부)을 받지 못해 로컬 최소 스타일로 그리는 중(R-01) — MapView 가 정하고 지도 위 왼쪽 상태 칸(MapChips)이 알린다 */
  basemapFailed: boolean;
  setBasemapFailed: (b: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  layers: { radar: true, sigmet: true, aircraft: true, ships: false, airports: true, tracks: true, prediction: true, traffic: false, reception: false, airspace: false },
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  setLayers: (l) => set((s) => ({ layers: { ...s.layers, ...l } })),
  radarOpacity: 0.6,
  radarFrameIndex: null,
  setRadarFrame: (i) => set({ radarFrameIndex: i }),
  radarPlaying: false,
  setRadarPlaying: (b) => set({ radarPlaying: b }),
  radarSource: "rainviewer",
  setRadarSource: (s) => set({ radarSource: s, radarPlaying: false }),
  krFrameIndex: null,
  setKrFrame: (i) => set({ krFrameIndex: i }),
  selectedHex: null,
  selectNonce: 0,
  select: (hex) => set((s) => ({ selectedHex: hex, selectNonce: hex ? s.selectNonce + 1 : s.selectNonce, panel: hex ? "aircraft" : "alerts" })),
  selectedSigmet: null,
  // 카드를 닫으면 같은 탭의 목록으로 돌아간다(R-40 — SIGMET·공항 탭에 목록이 있다)
  selectSigmet: (id) => set((s) => ({ selectedSigmet: id, panel: id ? "sigmet" : s.panel })),
  selectedAirport: null,
  selectAirport: (icao) => set((s) => ({ selectedAirport: icao, panel: icao ? "airport" : s.panel })),
  selectedShip: null,
  // 해제할 때 다른 패널을 보고 있었으면 그대로 둔다(선박 레이어를 끄면서 해제하는 경우 등)
  selectShip: (mmsi) => set((s) => ({ selectedShip: mmsi, panel: mmsi ? "ship" : s.panel === "ship" ? "alerts" : s.panel })),
  panel: "alerts",
  setPanel: (p) => set({ panel: p }),
  flyTo: null,
  requestFlyTo: (lon, lat, zoom = 8) => set((s) => ({ flyTo: { lon, lat, zoom, id: (s.flyTo?.id ?? 0) + 1 } })),
  flyHandled: 0,
  setFlyHandled: (id) => set({ flyHandled: id }),
  legendOpen: false, // 처음 값은 LayerPanel 이 저장된 선택 또는 화면 폭으로 정한다(lib/prefs legendDefaultOpen)
  setLegendOpen: (b) => set({ legendOpen: b }),
  shipCats: [...SHIP_CATEGORIES],
  toggleShipCat: (c) => set((s) => {
    const on = new Set(s.shipCats);
    if (on.has(c)) on.delete(c); else on.add(c);
    return { shipCats: SHIP_CATEGORIES.filter((x) => on.has(x)) };
  }),
  setShipCats: (cats) => set({ shipCats: SHIP_CATEGORIES.filter((x) => cats.includes(x)) }),
  shipTrackHours: 6,
  setShipTrackHours: (h) => set({ shipTrackHours: h }),
  basemapFailed: false,
  setBasemapFailed: (b) => set({ basemapFailed: b }),
}));
