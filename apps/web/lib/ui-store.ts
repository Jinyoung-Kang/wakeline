import { create } from "zustand";
import { SHIP_CATEGORIES, type ShipCategory } from "./ships";

export interface Layers {
  radar: boolean;
  sigmet: boolean;
  aircraft: boolean;
  /** 선박(AIS) — 기본 끔(서버 기본과 같게). 켜면 서버가 선박을 보내기 시작한다. */
  ships: boolean;
  airports: boolean;
  tracks: boolean;
  prediction: boolean;
}

export type UiPanel = "alerts" | "aircraft" | "ship" | "sigmet" | "airport";

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
  /** 지도 이동 요청(검색 결과 선택 등). id 가 바뀔 때마다 MapView 가 한 번 이동한다. */
  flyTo: { lon: number; lat: number; zoom: number; id: number } | null;
  requestFlyTo: (lon: number, lat: number, zoom?: number) => void;
  legendOpen: boolean;
  setLegendOpen: (b: boolean) => void;
  /** 선종 필터(계약 v5 §B3): 켜진 선종(SHIP_CATEGORIES 순서). 저장은 lib/prefs.ts(브라우저에만) */
  shipCats: ShipCategory[];
  toggleShipCat: (c: ShipCategory) => void;
  setShipCats: (cats: readonly ShipCategory[]) => void;
}

export const useUi = create<UiState>((set) => ({
  layers: { radar: true, sigmet: true, aircraft: true, ships: false, airports: true, tracks: true, prediction: true },
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
  select: (hex) => set({ selectedHex: hex, panel: hex ? "aircraft" : "alerts" }),
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
  legendOpen: false, // 처음 값은 LayerPanel 이 저장된 선택 또는 화면 폭으로 정한다(lib/prefs legendDefaultOpen)
  setLegendOpen: (b) => set({ legendOpen: b }),
  shipCats: [...SHIP_CATEGORIES],
  toggleShipCat: (c) => set((s) => {
    const on = new Set(s.shipCats);
    if (on.has(c)) on.delete(c); else on.add(c);
    return { shipCats: SHIP_CATEGORIES.filter((x) => on.has(x)) };
  }),
  setShipCats: (cats) => set({ shipCats: SHIP_CATEGORIES.filter((x) => cats.includes(x)) }),
}));
