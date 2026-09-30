/**
 * 상황판 지도 한 곳(MapView)과, 나중에 받는 레이어 조각(ADR-026 — 예: 관측 수신 범위 components/ReceptionLayer)이 그 지도에 그리는 창구.
 * - 지금 지도: MapView 가 만들 때 알리고 지우기 전에 비운다 — 조각은 useDashboardMap() 으로 받는다(없으면 그리지 않는다).
 * - onReady: 기본 레이어가 준비됐으면 바로, 아니면 load 뒤에 실행(같은 key 는 마지막 요청만 — 각 그리기는 그 레이어의 전체 상태를 쓴다).
 * - 레이어 툴팁: 조각이 붙인 레이어의 툴팁 함수를 등록한다 — MapView 의 호버 처리가 레이어 id 로 찾는다(조각 코드를 첫 화면에 싣지 않게).
 */
import type * as maplibregl from "maplibre-gl";
import { useSyncExternalStore } from "react";
import type { Tip } from "./tooltip";

let current: maplibregl.Map | null = null;
const listeners = new Set<() => void>();

/** MapView: 지도를 만든 뒤 map, 지우기 전에 null */
export function setDashboardMap(map: maplibregl.Map | null): void {
  if (current === map) return;
  current = map;
  for (const l of [...listeners]) l();
}

export function dashboardMap(): maplibregl.Map | null { return current; }

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const serverSnapshot = () => null;
/** 지금 상황판 지도(없으면 null) — 바뀌면 다시 그린다 */
export function useDashboardMap(): maplibregl.Map | null {
  return useSyncExternalStore(subscribe, dashboardMap, serverSnapshot);
}

/** load 전에 요청된 그리기 — 키마다 마지막 것만 둔다(데이터는 스타일과 무관하게 오므로(R-01) 스타일이 늦거나 오지 않아도 쌓이지 않는다) */
const deferredDraws = new WeakMap<maplibregl.Map, Map<string, () => void>>();
/**
 * 기본 레이어(addBaseLayers)가 준비됐으면 바로, 아니면 load 뒤에 실행(같은 key 는 마지막 요청만 — 각 그리기는 그 레이어의 전체 상태를 쓴다).
 * isStyleLoaded() 는 타일을 받는 동안 false 라 갱신을 잃는다. 대기열의 load 처리기는 지도 생성 effect 의 load 처리기(기본 레이어 추가) 뒤에 등록된다.
 */
export function onReady(map: maplibregl.Map, key: string, fn: () => void): void {
  if (map.getSource("aircraft")) { fn(); return; }
  let queue = deferredDraws.get(map);
  if (!queue) {
    const q = new Map<string, () => void>();
    deferredDraws.set(map, q);
    map.once("load", () => { deferredDraws.delete(map); for (const f of q.values()) f(); });
    queue = q;
  }
  queue.delete(key);
  queue.set(key, fn);
}

type LayerTip = (props: Record<string, unknown>) => Tip | null;
const tips = new Map<string, LayerTip>();
/** 레이어 툴팁 등록. 되돌리는 함수로 뺀다(그사이 같은 레이어에 다른 함수가 등록됐으면 건드리지 않는다) */
export function registerLayerTip(layerId: string, fn: LayerTip): () => void {
  tips.set(layerId, fn);
  return () => { if (tips.get(layerId) === fn) tips.delete(layerId); };
}
export function layerTip(layerId: string): LayerTip | undefined { return tips.get(layerId); }
