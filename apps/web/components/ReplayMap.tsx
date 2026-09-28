"use client";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { subscriptionBbox } from "@/lib/viewport";
import { addBaseLayers, MAPLIBRE_WORKER_URL, radarTileUrl, STYLE_URL } from "@/lib/maplayers";
import { applyBasemap } from "@/lib/basemap";
import { mapAttributionHtml, styleHasBasemapCredit } from "@/lib/attribution";
import { renderTip } from "@/lib/tooltip";
import { replayAircraftTip, replaySigmetTip, type ReplayAircraft, type ReplayFrame } from "@/lib/replay";

export type { ReplayFrame } from "@/lib/replay";
export type ReplayPick = { kind: "aircraft"; hex: string } | { kind: "sigmet"; id: string } | null;

/**
 * 재생 지도: 보간 없음(기록된 위치 그대로). 레이더는 API 가 그 시각(±10분)의 RainViewer 프레임을 줄 때만 그린다
 * (RainViewer 는 2 h 만 보관 — 없으면 그리지 않고 화면에 "레이더 이력 없음"). 호출부호는 기록에 없으면 비운다(hex 로 채우지 않는다).
 * 클릭하면 onPick(항공기/SIGMET), 호버하면 툴팁.
 */
export function ReplayMap({ frame, onBbox, onPick, showRadar }: { frame: ReplayFrame | null; onBbox: (bbox: string) => void; onPick: (p: ReplayPick) => void; showRadar: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const frameRef = useRef<ReplayFrame | null>(frame);
  const pickRef = useRef(onPick);
  useEffect(() => { frameRef.current = frame; pickRef.current = onPick; });
  useEffect(() => {
    if (!el.current) return;
    maplibregl.setWorkerUrl(MAPLIBRE_WORKER_URL);
    const map = new maplibregl.Map({ container: el.current, style: STYLE_URL, center: [127.8, 36.5], zoom: 6, minZoom: 2, maxZoom: 12, attributionControl: false });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;
    // 배경지도 시인성(계약 v4 §E) — 상황판 지도와 같은 색
    map.on("style.load", () => applyBasemap(map));
    // REST 는 −180~180 만 받는다: 날짜변경선을 넘으면 화면 중심 쪽만(재생은 minZoom 2 라 띠 전체는 요청 크기 상한을 넘을 수 있다)
    const emit = () => { const b = map.getBounds(); const q = subscriptionBbox(b.getWest(), b.getSouth(), b.getEast(), b.getNorth(), Infinity, map.getCenter().lng); onBbox(q.map((v) => v.toFixed(3)).join(",")); };
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "wakeline-tip", offset: 14, maxWidth: "320px" });
    let raf = 0;
    let last: maplibregl.MapMouseEvent | null = null;
    const pickAt = (pt: maplibregl.PointLike) => {
      const layers = ["aircraft-symbol", "sigmet-fill"].filter((l) => map.getLayer(l));
      const hits = layers.length ? map.queryRenderedFeatures(pt, { layers }) : [];
      return hits.find((h) => h.layer.id === "aircraft-symbol") ?? hits.find((h) => h.layer.id === "sigmet-fill") ?? null;
    };
    const hover = () => {
      raf = 0;
      const e = last;
      const fr = frameRef.current;
      if (!e || !fr) return;
      const f = pickAt(e.point);
      map.getCanvas().style.cursor = f ? "pointer" : "";
      const p = (f?.properties ?? {}) as Record<string, unknown>;
      const tip = !f ? null : f.layer.id === "aircraft-symbol"
        ? (() => { const a = fr.aircraft.find((x) => x.hex === p.hex); return a ? replayAircraftTip(a, fr.at) : null; })()
        : (() => { const s = fr.sigmets.find((x) => x.id === p.id); return s ? replaySigmetTip(s, fr.at) : null; })();
      if (!tip) { popup.remove(); return; }
      popup.setDOMContent(renderTip(tip)).setLngLat(e.lngLat);
      if (!popup.isOpen()) popup.addTo(map);
    };
    map.on("load", () => {
      addBaseLayers(map);
      const styleCredits = Object.keys(map.getStyle().sources ?? {}).map((id) => (map.getSource(id) as { attribution?: string } | undefined)?.attribution);
      map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: mapAttributionHtml({ extra: "Replay: 로컬 PostGIS 기록", includeMap: !styleHasBasemapCredit(styleCredits) }) }), "bottom-right");
      emit();
      map.on("mousemove", (e: maplibregl.MapMouseEvent) => { last = e; if (!raf) raf = requestAnimationFrame(hover); });
      map.on("mouseout", () => { popup.remove(); last = null; });
      map.on("click", (e: maplibregl.MapMouseEvent) => {
        const f = pickAt(e.point);
        const p = (f?.properties ?? {}) as Record<string, unknown>;
        pickRef.current(!f ? null : f.layer.id === "aircraft-symbol" ? { kind: "aircraft", hex: String(p.hex) } : { kind: "sigmet", id: String(p.id) });
      });
    });
    map.on("moveend", emit);
    return () => { if (raf) cancelAnimationFrame(raf); popup.remove(); map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !frame) return;
    const apply = () => {
      (map.getSource("aircraft") as maplibregl.GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: frame.aircraft.map((a: ReplayAircraft) => ({
          type: "Feature", id: a.hex,
          // 방위가 없으면(1분 요약 행 등) 방향 없는 기호, 지상이면 지상 색 — 상황판과 같은 규칙(maplayers)
          properties: { hex: a.hex, alt_ft: a.alt_ft ?? null, track_deg: a.track_deg ?? null, on_ground: a.on_ground ?? null, estimated: false, stale: false, callsign: a.callsign ?? null },
          geometry: { type: "Point", coordinates: [a.lon, a.lat] },
        })),
      });
      (map.getSource("sigmets") as maplibregl.GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: frame.sigmets.filter((s) => s.geometry).map((s) => ({ type: "Feature", id: s.id, properties: { ...s, geometry: undefined }, geometry: s.geometry! })),
      });
    };
    if (map.getSource("aircraft")) apply(); else map.once("load", apply);
  }, [frame]);
  // 그 시각의 레이더 프레임(있을 때만). 없으면 레이어를 숨긴다.
  const radarKey = frame?.radar ? `${frame.radar.host}${frame.radar.path}` : "";
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const r = frame?.radar ?? null;
    const apply = () => {
      const url = r ? radarTileUrl(r.host, r.path) : null;
      const src = map.getSource("replay-radar") as maplibregl.RasterTileSource | undefined;
      if (url && !src) {
        map.addSource("replay-radar", { type: "raster", tiles: [url], tileSize: 512, maxzoom: 7 });
        map.addLayer({ id: "replay-radar", type: "raster", source: "replay-radar", paint: { "raster-opacity": 0.6 } }, "sigmet-fill");
      } else if (url && src) src.setTiles([url]);
      if (map.getLayer("replay-radar")) map.setLayoutProperty("replay-radar", "visibility", url && showRadar ? "visible" : "none");
    };
    if (map.getSource("aircraft")) apply(); else map.once("load", apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radarKey, showRadar]);
  return <div ref={el} className="h-full w-full" data-testid="replay-map" />;
}
