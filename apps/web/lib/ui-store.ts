import { create } from "zustand";

export interface Layers {
  radar: boolean;
  sigmet: boolean;
  aircraft: boolean;
  airports: boolean;
  tracks: boolean;
  prediction: boolean;
}

interface UiState {
  layers: Layers;
  toggleLayer: (k: keyof Layers) => void;
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
  panel: "alerts" | "aircraft" | "sigmet" | "airport";
  setPanel: (p: UiState["panel"]) => void;
  /** 지도 이동 요청(검색 결과 선택 등). id 가 바뀔 때마다 MapView 가 한 번 이동한다. */
  flyTo: { lon: number; lat: number; zoom: number; id: number } | null;
  requestFlyTo: (lon: number, lat: number, zoom?: number) => void;
  legendOpen: boolean;
  setLegendOpen: (b: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  layers: { radar: true, sigmet: true, aircraft: true, airports: true, tracks: true, prediction: true },
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
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
  selectSigmet: (id) => set({ selectedSigmet: id, panel: id ? "sigmet" : "alerts" }),
  selectedAirport: null,
  selectAirport: (icao) => set({ selectedAirport: icao, panel: icao ? "airport" : "alerts" }),
  panel: "alerts",
  setPanel: (p) => set({ panel: p }),
  flyTo: null,
  requestFlyTo: (lon, lat, zoom = 8) => set((s) => ({ flyTo: { lon, lat, zoom, id: (s.flyTo?.id ?? 0) + 1 } })),
  legendOpen: true,
  setLegendOpen: (b) => set({ legendOpen: b }),
}));
