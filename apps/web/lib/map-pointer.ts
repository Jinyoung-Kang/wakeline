/**
 * 상황판 지도의 포인터 규칙(web-review §3.3 — components/MapView 에서 옮겼다): 호버 · 클릭이 고르는 레이어(우선순위), 레이어마다의 툴팁, 클릭 동작.
 * 지도 · 스토어를 직접 읽지 않는다 — 부른 쪽(MapView)이 지금 값(TipContext)과 지도에 물은 결과를 준다.
 */
import type * as maplibregl from "maplibre-gl";
import { RECEPTION_FILL_LAYER } from "./reception-meta";
import { isMmsi, selectedShipLabel, type ShipLite } from "./ships";
import { aircraftTip, airportTip, shipGridTip, shipTip, shipTrackPointTip, sigmetTip, type AirportProps, type Tip } from "./tooltip";
import { trafficGridTip, type TrafficGrid } from "./traffic-grid";
import type { AircraftState, SelectedInfo, SigmetCollection } from "./types";

/**
 * 호버·클릭 우선순위: 항공기 > 선박 > 선택 선박(격자 모드 아이콘) > 선택 선박 항적 점 > 선박 격자 > 공항 > SIGMET > 연안 교통량 격자(ADR-023) >
 * 관측 수신 칸(ADR-027 — 켤 때 받는 조각이 레이어 · 툴팁을 붙인다, lib/map-ready)
 */
export const PICK_LAYERS = ["aircraft-symbol", "ship-symbol", "ship-selected-icon", "ship-track-point", "ship-grid-circle", "airport-circle", "sigmet-fill", "traffic-grid-fill",
  RECEPTION_FILL_LAYER] as const;

/** 지도에 물을 레이어: 있고 보이는 pick 레이어(우선순위 순서) */
export function visiblePickLayers(map: Pick<maplibregl.Map, "getLayer" | "getLayoutProperty">): string[] {
  return PICK_LAYERS.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none");
}

/** 맞은 것 중 우선순위가 가장 높은 하나(지도가 돌려준 순서와 상관없이). 없으면 null */
export function pickByPriority<F extends { layer: { id: string } }>(hits: readonly F[]): F | null {
  for (const l of PICK_LAYERS) { const h = hits.find((x) => x.layer.id === l); if (h) return h; }
  return null;
}

type Picked = { layer: { id: string }; properties?: Record<string, unknown> | null; geometry: GeoJSON.Geometry };

/** 호버가 같은 지점인지 가르는 열쇠: 레이어 + 그 지점의 id(hex · mmsi · icao · id · 칸 g, 없으면 점 좌표) */
export function hoverKey(f: Picked): string {
  const p = f.properties ?? {};
  return `${f.layer.id}:${String(p.hex ?? p.mmsi ?? p.icao ?? p.id ?? p.g ?? (f.geometry.type === "Point" ? f.geometry.coordinates.join(",") : ""))}`;
}

/** 툴팁에 쓰는 지금 값(스토어 · 선택 · 감시 공항 목록 · 켤 때 받는 조각의 툴팁) */
export interface TipContext {
  /** 서버 기준 지금(ms) */
  now: number;
  /** WS selected(선택 항공기의 full 상태) */
  selected: SelectedInfo | null;
  aircraft: ReadonlyMap<string, AircraftState>;
  ships: ReadonlyMap<string, ShipLite>;
  /** WS ship_selected */
  shipSelected: { mmsi: string; state: ShipLite | null; static: { name?: string | null } | null } | null;
  /** 지금 고른 선박(MMSI) */
  selectedShip: string | null;
  airports: readonly GeoJSON.Feature<GeoJSON.Point, AirportProps>[];
  sigmets: SigmetCollection | null;
  /** 선박 격자 칸 크기(°) — 모르면 null */
  shipsCellDeg: number | null;
  trafficGrid: TrafficGrid | null;
  /** 켤 때 받는 레이어 조각이 등록한 툴팁(lib/map-ready layerTip) */
  layerTip: (layerId: string) => ((p: Record<string, unknown>) => Tip | null) | undefined;
}

/** 레이어 · 속성 → 툴팁. 보일 것이 없으면(목록에 없는 선박 · 공항 · SIGMET) null */
export function tipFor(layerId: string, p: Record<string, unknown>, c: TipContext): Tip | null {
  if (layerId === "aircraft-symbol") {
    const hex = String(p.hex);
    const st = c.selected && c.selected.hex === hex && c.selected.state ? c.selected.state : c.aircraft.get(hex);
    return aircraftTip({
      hex, callsign: (p.callsign as string) ?? null, alt_ft: typeof p.alt_ft === "number" ? p.alt_ft : null, stale: p.stale === true, estimated: p.estimated === true,
      emergency: p.emergency === true, age_unknown: p.age_unknown === true, on_ground: typeof p.on_ground === "boolean" ? p.on_ground : null,
      track_deg: typeof p.track_deg === "number" ? p.track_deg : null,
    }, st, c.now);
  }
  if (layerId === "ship-symbol") {
    const st = c.ships.get(String(p.mmsi));
    return st ? shipTip(st, c.now) : null;
  }
  if (layerId === "ship-selected-icon") {
    const m = String(p.mmsi);
    const st = (c.shipSelected && c.shipSelected.mmsi === m ? c.shipSelected.state : null) ?? c.ships.get(m);
    return st ? shipTip(st, c.now) : null;
  }
  if (layerId === "ship-track-point") return shipTrackPointTip(p, selectedShipLabel(c.selectedShip, c.shipSelected, c.ships));
  if (layerId === "ship-grid-circle") return shipGridTip(p, c.shipsCellDeg);
  if (layerId === "airport-circle") {
    const ap = c.airports.find((x) => x.properties.icao === p.icao);
    return ap ? airportTip(ap.properties, c.now) : null;
  }
  if (layerId === "traffic-grid-fill") return trafficGridTip(p, c.trafficGrid);
  const registered = c.layerTip(layerId);
  if (registered) return registered(p); // 켤 때 받는 레이어 조각이 등록한 툴팁(관측 수신 칸)
  const sg = c.sigmets?.features.find((x) => x.properties.id === p.id);
  return sg ? sigmetTip({ ...sg.properties, inside: p.inside === true }, c.now) : null;
}

/** 클릭이 할 일 */
export type ClickAction =
  | { kind: "aircraft"; hex: string }
  | { kind: "ship"; mmsi: string }
  | { kind: "zoom"; center: [number, number]; zoom: number }
  | { kind: "airport"; icao: string }
  | { kind: "sigmet"; id: string }
  /** 이미 고른 선박(아이콘 · 항적 점) · MMSI 가 아닌 선박 기호 — 아무것도 하지 않는다 */
  | { kind: "keep" }
  /** 빈 곳 · 다른 레이어 — 선택 해제(집중 추적도 멈춘다) */
  | { kind: "clear" };

/**
 * 고른 지점 → 할 일. 선박 격자 칸은 그 칸으로 확대 — 줌 7 이상에서 서버가 개별 선박을 보낸다(화면 안 5,000척 이하일 때 — 계약 v4 §C):
 * 지금 줌 + 2(7 – 12). zoom = 지금 지도 줌
 */
export function clickAction(f: Picked | null, zoom: number): ClickAction {
  const id = f?.layer.id;
  const p = f?.properties ?? {};
  if (id === "aircraft-symbol") return { kind: "aircraft", hex: String(p.hex) };
  if (id === "ship-symbol") { const m = String(p.mmsi); return isMmsi(m) ? { kind: "ship", mmsi: m } : { kind: "keep" }; }
  if (id === "ship-selected-icon" || id === "ship-track-point") return { kind: "keep" };
  if (id === "ship-grid-circle" && f!.geometry.type === "Point") {
    const [lon, lat] = f!.geometry.coordinates as [number, number];
    return { kind: "zoom", center: [lon, lat], zoom: Math.min(12, Math.max(7, zoom + 2)) };
  }
  if (id === "airport-circle") return { kind: "airport", icao: String(p.icao) };
  if (id === "sigmet-fill") return { kind: "sigmet", id: String(p.id) };
  return { kind: "clear" };
}
