/**
 * 시험용 MapLibre 대역: 지도가 받은 소스·레이어·이벤트만 기록한다(그리기·스타일 요청·워커 없음).
 * 'load'·'style.load'·'error' 는 시험이 fire() 로 직접 낸다 — 외부 스타일이 오지 않는 상황을 그대로 만들 수 있다.
 */
type Handler = (ev?: unknown) => void;

export class FakeSource {
  data: unknown;
  constructor(public spec: Record<string, unknown>) { this.data = spec.data; }
  setData(d: unknown) { this.data = d; return this; }
}

export class FakeMap {
  static instances: FakeMap[] = [];
  handlers = new Map<string, Handler[]>();
  sources = new Map<string, FakeSource>();
  layers = new Map<string, { id: string; type: string; source?: string; layout: Record<string, unknown>; paint: Record<string, unknown>; before?: string }>();
  images: string[] = [];
  /** setFilter 로 받은 레이어 필터(null = 필터 없음) */
  filters = new Map<string, unknown>();
  controls: unknown[] = [];
  styleSet: unknown[] = [];
  removed = false;
  constructor(public opts: Record<string, unknown>) { FakeMap.instances.push(this); }
  on(t: string, fn: Handler) { (this.handlers.get(t) ?? this.handlers.set(t, []).get(t)!).push(fn); return this; }
  once(t: string, fn: Handler) { const w: Handler = (e) => { this.off(t, w); fn(e); }; return this.on(t, w); }
  off(t: string, fn: Handler) { const l = this.handlers.get(t); if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return this; }
  fire(t: string, ev: unknown = { type: t }) { for (const h of [...(this.handlers.get(t) ?? [])]) h(ev); }
  listenerCount(t: string) { return this.handlers.get(t)?.length ?? 0; }
  addControl(c: unknown) { this.controls.push(c); return this; }
  getCanvas() { return { setAttribute: () => {}, style: {} as Record<string, string> }; }
  getBounds() { return { getWest: () => 120, getSouth: () => 30, getEast: () => 135, getNorth: () => 43 }; }
  getZoom() { return 6; }
  getCenter() { return { lng: 127.8, lat: 36.5 }; }
  addImage(id: string) { this.images.push(id); }
  addSource(id: string, spec: Record<string, unknown>) { this.sources.set(id, new FakeSource(spec)); }
  getSource(id: string) { return this.sources.get(id); }
  removeSource(id: string) { this.sources.delete(id); }
  addLayer(spec: { id: string; type: string; source?: string; layout?: Record<string, unknown>; paint?: Record<string, unknown> }, before?: string) {
    this.layers.set(spec.id, { ...spec, layout: { ...(spec.layout ?? {}) }, paint: { ...(spec.paint ?? {}) }, before });
  }
  getLayer(id: string) { return this.layers.get(id); }
  removeLayer(id: string) { this.layers.delete(id); }
  setLayoutProperty(id: string, k: string, v: unknown) { const l = this.layers.get(id); if (l) l.layout[k] = v; }
  getLayoutProperty(id: string, k: string) { return this.layers.get(id)?.layout[k]; }
  setPaintProperty(id: string, k: string, v: unknown) { const l = this.layers.get(id); if (l) l.paint[k] = v; }
  setFilter(id: string, f: unknown) { this.filters.set(id, f ?? null); }
  getStyle() { return { version: 8, sources: {}, layers: [...this.layers.values()].map((l) => ({ id: l.id, type: l.type })) }; }
  setStyle(s: unknown) { this.styleSet.push(s); return this; }
  queryRenderedFeatures() { return []; }
  jumpTo() { return this; }
  flyTo() { return this; }
  easeTo() { return this; }
  remove() { this.removed = true; }
  /** 이름이 prefix 로 시작하는 레이어 id */
  layerIds(prefix: string) { return [...this.layers.keys()].filter((id) => id.startsWith(prefix)); }
}

class Ctl { constructor(public opts?: unknown) {} }
class FakePopup {
  open = false;
  constructor(public opts?: unknown) {}
  setDOMContent() { return this; }
  setLngLat() { return this; }
  addTo() { this.open = true; return this; }
  isOpen() { return this.open; }
  remove() { this.open = false; return this; }
}

export const workerUrls: string[] = [];
/** vi.mock 에 넘기는 모듈 모양(maplibre-gl 의 쓰는 부분만) */
export const fakeMaplibreModule = {
  Map: FakeMap,
  NavigationControl: Ctl,
  AttributionControl: Ctl,
  Popup: FakePopup,
  setWorkerUrl: (u: string) => { workerUrls.push(u); },
};
