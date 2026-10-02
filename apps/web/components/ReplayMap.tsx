"use client";
import type * as maplibregl from "maplibre-gl";
import { memo, useEffect, useRef } from "react";
import { subscriptionBbox } from "@/lib/viewport";
import { addBaseLayers, radarTileUrl, STYLE_URL } from "@/lib/maplayers";
import { maplibre } from "@/lib/maplibre";
import { watchBasemapStyle } from "@/lib/basemap-fallback";
import { mapAttributionHtml, styleHasBasemapCredit } from "@/lib/attribution";
import { mapAttributionControl } from "@/lib/map-attribution";
import { renderTip } from "@/lib/tooltip";
import { fmtReplayBbox, replayAircraftTip, replayQueryBbox, replaySigmetTip, type ReplayAircraft, type ReplayFrame } from "@/lib/replay";

export type { ReplayFrame } from "@/lib/replay";
export type ReplayPick = { kind: "aircraft"; hex: string } | { kind: "sigmet"; id: string } | null;

/**
 * 재생 지도: 보간 없음(기록된 위치 그대로). 레이더는 API 가 그 시각(±10분)의 RainViewer 프레임을 줄 때만 그린다
 * (RainViewer 는 2 h 만 보관 — 없으면 그리지 않고 화면에 "레이더 이력 없음"). 호출부호는 기록에 없으면 비운다(hex 로 채우지 않는다).
 * 클릭하면 onPick(항공기/SIGMET), 호버하면 툴팁.
 * 조회 영역은 서버 면적 상한(2500 sq°) 안으로 줄여 보낸다 — 줄였으면 점선 상자로 조회한 영역을 그린다(R-05). frame 이 null 이면 지도를 비운다.
 * memo: 슬라이더를 끄는 동안 재생 화면은 입력마다 다시 그려지지만(시각 라벨), 지도는 frame · 레이더 · 콜백이 바뀔 때만.
 * 배경지도 스타일(외부 호스트)을 받지 못하면 상황판과 같은 규칙(R-01 — lib/basemap-fallback)으로 로컬 대체 스타일에 그 시각의 기록을 그리고
 * onBasemapFailed(true) 로 알린다(재생 화면이 "배경지도를 불러오지 못함"을 띄운다). 전에는 'load' 가 오지 않아 지도가 빈 채로 알림도 없었다(QA-301).
 * MapLibre 는 상황판과 같은 public 배포본(R-02 — lib/maplibre): 재생 화면이 이 컴포넌트를 불러올 때 loadMaplibre() 를 함께 기다린다(app/replay/page.tsx).
 * 전에는 maplibre-gl 을 번들해 공용 코드를 두 벌(번들 청크 286 KB + 워커가 받는 공용 청크 149 KB, gzip) 받고 해석했다(PERF §15).
 */
export const ReplayMap = memo(function ReplayMap({ frame, onBbox, onPick, showRadar, onBasemapFailed }: {
  frame: ReplayFrame | null; onBbox: (bbox: string, clamped: boolean) => void; onPick: (p: ReplayPick) => void; showRadar: boolean; onBasemapFailed?: (failed: boolean) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const frameRef = useRef<ReplayFrame | null>(frame);
  const pickRef = useRef(onPick);
  const basemapRef = useRef(onBasemapFailed);
  useEffect(() => { frameRef.current = frame; pickRef.current = onPick; basemapRef.current = onBasemapFailed; });
  useEffect(() => {
    if (!el.current) return;
    const ml = maplibre(); // 워커 경로는 loadMaplibre() 가 지정했다
    const map = new ml.Map({ container: el.current, style: STYLE_URL, center: [127.8, 36.5], zoom: 6, minZoom: 2, maxZoom: 12, attributionControl: false });
    map.addControl(new ml.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;
    // 배경지도 시인성(계약 v4 §E — 상황판 지도와 같은 색) · 스타일을 받지 못하면(오류 · 시간 제한) 로컬 대체 스타일로 한 번 바꾸고 알린다(R-01 — 상황판과 같은 규칙)
    const basemap = watchBasemapStyle(map, () => basemapRef.current?.(true));
    // REST 는 −180~180 만 받는다: 날짜변경선을 넘으면 화면 중심 쪽만. 재생은 minZoom 2 라 화면이 면적 상한을 넘을 수 있다 → 가운데만 조회(R-05)
    const emit = () => {
      const b = map.getBounds(), c = map.getCenter();
      const view = subscriptionBbox(b.getWest(), b.getSouth(), b.getEast(), b.getNorth(), Infinity, c.lng);
      const lng = ((((c.lng + 180) % 360) + 360) % 360) - 180;
      const q = replayQueryBbox(view, [lng, c.lat]);
      const [w, s, e, n] = q.bbox;
      (map.getSource("replay-query") as maplibregl.GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: q.clamped ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] } }] : [],
      });
      onBbox(fmtReplayBbox(q.bbox), q.clamped);
    };
    const popup = new ml.Popup({ closeButton: false, closeOnClick: false, className: "wakeline-tip", offset: 14, maxWidth: "320px" });
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
      // 조회 영역(화면이 면적 상한보다 넓을 때만): 상자 밖의 기록은 조회하지 않았다
      map.addSource("replay-query", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "replay-query", type: "line", source: "replay-query", paint: { "line-color": "#f2b33d", "line-width": 1.5, "line-dasharray": [3, 2] } });
      const styleCredits = Object.keys(map.getStyle().sources ?? {}).map((id) => (map.getSource(id) as { attribution?: string } | undefined)?.attribution);
      map.addControl(mapAttributionControl(ml, mapAttributionHtml({ extra: "Replay: 로컬 PostGIS 기록", includeMap: !basemap.failed && !styleHasBasemapCredit(styleCredits) })), "bottom-right");
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
    return () => { if (raf) cancelAnimationFrame(raf); popup.remove(); basemap.dispose(); basemapRef.current?.(false); map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      (map.getSource("aircraft") as maplibregl.GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        // 프레임이 없으면(오류·아직 없음) 비운다 — 이전 시각·영역의 항공기를 남기지 않는다(R-05)
        features: (frame?.aircraft ?? []).map((a: ReplayAircraft) => ({
          type: "Feature", id: a.hex,
          // 방위가 없으면(1분 요약 행 등) 방향 없는 기호, 지상이면 지상 색 — 상황판과 같은 규칙(maplayers)
          properties: { hex: a.hex, alt_ft: a.alt_ft ?? null, track_deg: a.track_deg ?? null, on_ground: a.on_ground ?? null, estimated: false, stale: false, callsign: a.callsign ?? null },
          geometry: { type: "Point", coordinates: [a.lon, a.lat] },
        })),
      });
      (map.getSource("sigmets") as maplibregl.GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: (frame?.sigmets ?? []).filter((s) => s.geometry).map((s) => ({ type: "Feature", id: s.id, properties: { ...s, geometry: undefined }, geometry: s.geometry! })),
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
});
