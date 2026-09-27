"use client";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { addBaseLayers, MAPLIBRE_WORKER_URL, predictionFeature, radarTileUrl, STYLE_URL } from "@/lib/maplayers";
import { aircraftStates, getData, setData, useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { SkyWsClient } from "@/lib/ws";
import { apiGet } from "@/lib/api";
import type { KrRadar, RenderState } from "@/lib/types";

const REGION_CENTER: [number, number] = [127.8, 36.5];

/**
 * 상황판 지도(클라이언트 컴포넌트). WS 구독은 지도 뷰포트(bbox·zoom)를 따라간다.
 * 보간은 Web Worker(250 ms) → 이 컴포넌트는 setData 만 한다. 탭이 숨겨지면 구독을 멈춘다.
 */
export function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const clientRef = useRef<SkyWsClient | null>(null);
  const radarLayers = useRef<string[]>([]);
  const sigmets = useServerData((d) => d.sigmets);
  const alerts = useServerData((d) => d.alerts);
  const radar = useServerData((d) => d.radar);
  const radarKr = useServerData((d) => d.radarKr);
  const radarSource = useUi((s) => s.radarSource);
  const krFrameIndex = useUi((s) => s.krFrameIndex);
  const krLayers = useRef<string[]>([]);
  const layers = useUi((s) => s.layers);
  const radarFrameIndex = useUi((s) => s.radarFrameIndex);
  const radarOpacity = useUi((s) => s.radarOpacity);
  const selectedHex = useUi((s) => s.selectedHex);
  const select = useUi((s) => s.select);
  const selectSigmet = useUi((s) => s.selectSigmet);
  const selectAirport = useUi((s) => s.selectAirport);
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selectedHex; }, [selectedHex]);

  // ---- 지도·WS·워커 생명주기 ----
  useEffect(() => {
    if (!el.current) return;
    maplibregl.setWorkerUrl(MAPLIBRE_WORKER_URL);
    const map = new maplibregl.Map({
      container: el.current, style: STYLE_URL, center: REGION_CENTER, zoom: 6, minZoom: 1, maxZoom: 12,
      hash: true, // #zoom/lat/lon — 지도 위치를 링크로 공유
      attributionControl: false, canvasContextAttributes: { antialias: false },
    });
    map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: "Aircraft: adsb.lol (ODbL) · adsb.fi · SIGMET/METAR: AviationWeather.gov · Radar: RainViewer" }), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;

    // 번들러(Turbopack)가 .ts 워커를 자산으로 취급하므로 순수 JS 워커를 public 에 둔다(tests/worker-sync 가 TS 구현과 일치를 검사).
    const worker = new Worker("/interpolate.worker.js");
    const client = new SkyWsClient(worker);
    clientRef.current = client;

    worker.onmessage = (ev: MessageEvent<{ type: string; states: RenderState[] }>) => {
      if (ev.data.type !== "render" || !map.isStyleLoaded()) return;
      const src = map.getSource("aircraft") as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      const sel = selectedRef.current;
      src.setData({
        type: "FeatureCollection",
        features: ev.data.states.map((s) => ({
          type: "Feature", id: s.hex,
          properties: { hex: s.hex, callsign: s.callsign, alt_ft: s.alt_ft, track_deg: s.track_deg, stale: s.stale, estimated: s.estimated, emergency: s.emergency, selected: s.hex === sel },
          geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        })),
      });
      if (sel) {
        const a = aircraftStates.get(sel);
        const psrc = map.getSource("prediction") as maplibregl.GeoJSONSource | undefined;
        if (psrc) psrc.setData({ type: "FeatureCollection", features: a ? [predictionFeature(a)].filter(Boolean) as GeoJSON.Feature[] : [] });
      }
    };

    const subscribeViewport = () => {
      const b = map.getBounds();
      const bbox: [number, number, number, number] = [
        Math.max(-180, b.getWest()), Math.max(-90, b.getSouth()), Math.min(180, b.getEast()), Math.min(90, b.getNorth()),
      ];
      client.subscribe(bbox, Math.floor(map.getZoom()));
      worker.postMessage({ type: "viewport", bbox });
    };
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    map.on("moveend", () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(subscribeViewport, 300);
    });

    map.on("load", () => {
      addBaseLayers(map);
      worker.postMessage({ type: "start" });
      client.connect();
      subscribeViewport();
      const pollKr = () => apiGet<KrRadar>("/api/v1/radar/kr").then((d) => setData({ radarKr: d })).catch(() => {});
      pollKr();
      const krTimer = setInterval(pollKr, 60_000);
      map.once("remove", () => clearInterval(krTimer));
      apiGet<GeoJSON.FeatureCollection>("/api/v1/airports?watched=true").then((fc) => {
        (map.getSource("airports") as maplibregl.GeoJSONSource | undefined)?.setData(fc);
      }).catch(() => {});
      map.on("click", (e: maplibregl.MapMouseEvent) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ["aircraft-symbol", "airport-circle", "sigmet-fill"] });
        const ac = hits.find((f) => f.layer.id === "aircraft-symbol");
        if (ac) { select(String(ac.properties?.hex)); return; }
        const ap = hits.find((f) => f.layer.id === "airport-circle");
        if (ap) { selectAirport(String(ap.properties?.icao)); return; }
        const sg = hits.find((f) => f.layer.id === "sigmet-fill");
        if (sg) { selectSigmet(String(sg.properties?.id)); return; }
        select(null);
      });
      for (const l of ["aircraft-symbol", "airport-circle", "sigmet-fill"]) {
        map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
      }
    });

    const onVisibility = () => {
      if (document.hidden) { client.pause(); worker.postMessage({ type: "stop" }); }
      else { client.resume(); worker.postMessage({ type: "start" }); }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      client.close();
      worker.terminate();
      map.remove();
      mapRef.current = null;
      setData({ conn: "closed" });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- SIGMET 갱신 + 안에 항공기가 있는 경보 강조 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sigmets) return;
    const inside = new Set([...alerts.values()].filter((a) => a.kind === "OBSERVED").map((a) => a.sigmet_id));
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: sigmets.features.filter((f) => f.geometry).map((f) => ({ ...f, properties: { ...f.properties, inside: inside.has(f.properties.id) } })) as GeoJSON.Feature[],
    };
    const apply = () => (map.getSource("sigmets") as maplibregl.GeoJSONSource | undefined)?.setData(fc);
    if (map.isStyleLoaded()) apply(); else map.once("load", apply);
  }, [sigmets, alerts]);

  // ---- 레이더 프레임 소스 사전 생성, 현재 프레임만 불투명 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !radar) return;
    const apply = () => {
      const wanted = radar.past.map((f) => `radar-${f.time}`);
      for (const id of radarLayers.current) if (!wanted.includes(id)) { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); }
      const beforeId = map.getLayer("sigmet-fill") ? "sigmet-fill" : undefined;
      for (const f of radar.past) {
        const id = `radar-${f.time}`;
        if (!map.getSource(id)) {
          map.addSource(id, { type: "raster", tiles: [radarTileUrl(radar.host, f.path)], tileSize: 512, maxzoom: 7, attribution: "RainViewer" });
          map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: 150 } } }, beforeId);
        }
      }
      radarLayers.current = wanted;
    };
    if (map.isStyleLoaded()) apply(); else map.once("load", apply);
  }, [radar]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !radar) return;
    const idx = radarFrameIndex ?? radar.past.length - 1;
    radar.past.forEach((f, i) => {
      const id = `radar-${f.time}`;
      if (map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", layers.radar && radarSource === "rainviewer" && i === idx ? radarOpacity : 0);
    });
  }, [radar, radarFrameIndex, radarOpacity, layers.radar, radarSource]);

  // ---- 기상청 레이더(FR-31): 재투영된 PNG 를 image source 로. 좌표는 서버가 문서 기반 LCC 정의로 계산한 웹 메르카토르 경계 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !radarKr?.available || !radarKr.coordinates || radarKr.coordinates.length !== 4) return;
    const c = radarKr.coordinates;
    const coords: [[number, number], [number, number], [number, number], [number, number]] = [c[0], c[1], c[2], c[3]];
    const apply = () => {
      const wanted = radarKr.frames.map((f) => `kmar-${f.tm}`);
      for (const id of krLayers.current) if (!wanted.includes(id)) { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); }
      const beforeId = map.getLayer("sigmet-fill") ? "sigmet-fill" : undefined;
      for (const f of radarKr.frames) {
        const id = `kmar-${f.tm}`;
        if (!map.getSource(id)) {
          map.addSource(id, { type: "image", url: f.url, coordinates: coords });
          map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: 150 }, "raster-resampling": "nearest" } }, beforeId);
        }
      }
      krLayers.current = wanted;
    };
    if (map.isStyleLoaded()) apply(); else map.once("load", apply);
  }, [radarKr]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !radarKr?.frames) return;
    const idx = krFrameIndex ?? radarKr.frames.length - 1;
    radarKr.frames.forEach((f, i) => {
      const id = `kmar-${f.tm}`;
      if (map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", layers.radar && radarSource === "kma" && i === idx ? Math.min(1, radarOpacity + 0.25) : 0);
    });
  }, [radarKr, krFrameIndex, radarSource, radarOpacity, layers.radar]);

  // ---- 레이어 토글 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const vis = (ids: string[], on: boolean) => ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
    vis(["sigmet-fill", "sigmet-line"], layers.sigmet);
    vis(["aircraft-symbol"], layers.aircraft);
    vis(["airport-circle", "airport-label"], layers.airports);
    vis(["track-line"], layers.tracks);
    vis(["prediction-line"], layers.prediction);
  }, [layers]);

  // ---- 선택 항공기: 항적(REST) + WS select ----
  useEffect(() => {
    const map = mapRef.current;
    clientRef.current?.select(selectedHex);
    if (!map) return;
    const tsrc = () => map.getSource("tracks") as maplibregl.GeoJSONSource | undefined;
    if (!selectedHex) { tsrc()?.setData({ type: "FeatureCollection", features: [] }); (map.getSource("prediction") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] }); return; }
    let cancelled = false;
    apiGet<{ points: { lon: number; lat: number; alt_ft: number | null }[] }>(`/api/v1/aircraft/${selectedHex}/track`).then((t) => {
      if (cancelled) return;
      const features: GeoJSON.Feature[] = [];
      for (let i = 1; i < t.points.length; i++) {
        features.push({ type: "Feature", properties: { alt_ft: t.points[i].alt_ft }, geometry: { type: "LineString", coordinates: [[t.points[i - 1].lon, t.points[i - 1].lat], [t.points[i].lon, t.points[i].lat]] } });
      }
      tsrc()?.setData({ type: "FeatureCollection", features });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedHex]);

  // 상태바가 쓰는 스냅샷 메타는 store 에 있음; 여기서는 지도만.
  useEffect(() => { void getData; }, []);

  return <div ref={el} className="h-full w-full" data-testid="map" />;
}
