"use client";
import * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import {
  addBaseLayers, COVERAGE_PAINT, coverageTileUrl, frameDisplay, MAPLIBRE_WORKER_URL, predictionFeature, predictionKey, predictionTargets,
  RADAR_SLOT, radarTileUrl, STYLE_URL, type FrameRole,
} from "@/lib/maplayers";
import { aircraftStates, getData, serverNowMs, setData, useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { SkyWsClient } from "@/lib/ws";
import { apiGet } from "@/lib/api";
import { activeSigmetFeatures } from "@/lib/sigmet";
import { mapAttributionHtml, styleHasBasemapCredit } from "@/lib/attribution";
import { isMetarStale } from "@/lib/format";
import { aircraftTip, airportTip, renderTip, sigmetTip, type AirportProps, type Tip } from "@/lib/tooltip";
import { appendTrackPoint, mergeTrack, pointFromState, trackFeatureCollection, trackFromRest, type TrackPt } from "@/lib/track";
import type { KrRadar, RenderState, SigmetCollection } from "@/lib/types";

const REGION_CENTER: [number, number] = [127.8, 36.5];
const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
/** SIGMET 만료 재검사 주기(새 메시지가 없어도 만료된 경보를 지운다) */
const SIGMET_EXPIRY_CHECK_MS = 30_000;
/** 공항 비행 카테고리 레이어 재조회(GAP-14). collector METAR 주기(10분)보다 짧게. 경과(오래됨) 재계산은 1분마다. */
const AIRPORTS_REFRESH_MS = 300_000;
const AIRPORTS_RECHECK_MS = 60_000;
const HOVER_LAYERS = ["aircraft-symbol", "airport-circle", "sigmet-fill"] as const;

type Frame = { id: string; add: (map: maplibregl.Map) => void };
/**
 * 레이더 프레임 레이어 동기화(PERF-12). 보일 프레임(현재·재생 중 미리 받기)만 소스를 만들고(지연 추가) visible,
 * 나머지는 visibility none — MapLibre 는 불투명도 0 레이어의 타일도 받으므로 visibility 로 끈다. 목록에서 빠진 프레임은 제거.
 */
function syncFrames(map: maplibregl.Map, prev: string[], frames: Frame[], display: Map<number, FrameRole>, opacity: number): string[] {
  const wanted = frames.map((f) => f.id);
  for (const id of prev) if (!wanted.includes(id)) { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); }
  frames.forEach((f, i) => {
    const role = display.get(i);
    if (!role) { if (map.getLayer(f.id)) map.setLayoutProperty(f.id, "visibility", "none"); return; }
    if (!map.getLayer(f.id)) f.add(map);
    map.setPaintProperty(f.id, "raster-opacity", role === "current" ? opacity : 0);
    map.setLayoutProperty(f.id, "visibility", "visible");
  });
  return wanted;
}

/** 기본 레이어(addBaseLayers)가 준비됐으면 바로, 아니면 load 뒤에 실행. isStyleLoaded() 는 타일을 받는 동안 false 라 갱신을 잃는다. */
function onReady(map: maplibregl.Map, fn: () => void) {
  if (map.getSource("aircraft")) fn(); else map.once("load", fn);
}
function geo(map: maplibregl.Map, id: string) {
  return map.getSource(id) as maplibregl.GeoJSONSource | undefined;
}

/**
 * 상황판 지도(클라이언트 컴포넌트). WS 구독은 지도 뷰포트(bbox·zoom)를 따라간다.
 * 보간은 Web Worker(바뀐 것이 있을 때만 post) → 이 컴포넌트는 setData 만 한다. 탭이 숨겨지면 구독을 멈춘다.
 */
export function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const clientRef = useRef<SkyWsClient | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const radarLayers = useRef<string[]>([]);
  const sigmets = useServerData((d) => d.sigmets);
  const alerts = useServerData((d) => d.alerts);
  const radar = useServerData((d) => d.radar);
  const radarKr = useServerData((d) => d.radarKr);
  const selectedInfo = useServerData((d) => d.selected);
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
  const radarPlaying = useUi((s) => s.radarPlaying);
  const flyTo = useUi((s) => s.flyTo);
  /** 마운트 전에 처리된 이동 요청은 다시 하지 않는다(다른 화면에서 돌아올 때) */
  const flyHandled = useRef(useUi.getState().flyTo?.id ?? 0);
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selectedHex; }, [selectedHex]);
  /** 예측선 갱신(입력이 바뀌었을 때만 setData) — 지도 생성 effect 가 채운다 */
  const refreshPrediction = useRef<() => void>(() => {});
  /** 선택 항공기 항적: REST 한 번 + WS selected 로 연장 */
  const track = useRef<{ hex: string | null; pts: TrackPt[]; pending: TrackPt[]; loaded: boolean }>({ hex: null, pts: [], pending: [], loaded: false });
  const sigmetApplied = useRef<{ fc: SigmetCollection | null; key: string }>({ fc: null, key: "" });
  const [sigClock, setSigClock] = useState(0);

  // ---- 지도·WS·워커 생명주기 ----
  useEffect(() => {
    if (!el.current) return;
    maplibregl.setWorkerUrl(MAPLIBRE_WORKER_URL);
    const map = new maplibregl.Map({
      container: el.current, style: STYLE_URL, center: REGION_CENTER, zoom: 6, minZoom: 1, maxZoom: 12,
      hash: true, // #zoom/lat/lon — 지도 위치를 링크로 공유
      attributionControl: false, canvasContextAttributes: { antialias: false },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;
    map.getCanvas().setAttribute("aria-label", "실시간 항공기·위험기상 지도. 화살표 키로 이동, +/- 로 확대. 항공기는 상단 검색(/)으로 선택할 수 있습니다.");

    // 번들러(Turbopack)가 .ts 워커를 자산으로 취급하므로 순수 JS 워커를 public 에 둔다(tests/worker-sync 가 TS 구현과 일치를 검사).
    const worker = new Worker("/interpolate.worker.js");
    workerRef.current = worker;
    const client = new SkyWsClient(worker);
    clientRef.current = client;

    let predKey: string | null = null;
    refreshPrediction.current = () => {
      const src = geo(map, "prediction");
      if (!src) return;
      const d = getData();
      const sel = d.selected && d.selected.hex === selectedRef.current ? d.selected : null;
      const targets = predictionTargets(sel, d.alerts.values(), aircraftStates);
      const key = predictionKey(targets);
      if (key === predKey) return;
      predKey = key;
      src.setData({ type: "FeatureCollection", features: targets.map(predictionFeature).filter((f): f is NonNullable<typeof f> => f != null) });
    };

    // 워커는 바뀐 것이 있을 때만 보낸다 → 받은 렌더를 잃지 않도록 마지막 것을 보관했다가 레이어가 준비되면 적용한다.
    let lastRender: RenderState[] | null = null;
    const applyRender = () => {
      const src = geo(map, "aircraft");
      if (!src || !lastRender) return;
      const sel = selectedRef.current;
      src.setData({
        type: "FeatureCollection",
        features: lastRender.map((s) => ({
          type: "Feature", id: s.hex,
          properties: { hex: s.hex, callsign: s.callsign, alt_ft: s.alt_ft, track_deg: s.track_deg, stale: s.stale, age_unknown: s.age_unknown, estimated: s.estimated, emergency: s.emergency, selected: s.hex === sel },
          geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        })),
      });
      refreshPrediction.current();
    };
    worker.onmessage = (ev: MessageEvent<{ type: string; states: RenderState[] }>) => {
      if (ev.data.type !== "render") return;
      lastRender = ev.data.states;
      applyRender();
    };

    const subscribeViewport = () => {
      const b = map.getBounds();
      const bbox: [number, number, number, number] = [
        Math.max(-180, b.getWest()), Math.max(-90, b.getSouth()), Math.min(180, b.getEast()), Math.min(90, b.getNorth()),
      ];
      client.subscribe(bbox, Math.floor(map.getZoom()));
      worker.postMessage({ type: "viewport", bbox, zoom: map.getZoom() });
    };
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    map.on("moveend", () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(subscribeViewport, 300);
    });

    // ---- 공항 레이어(GAP-14): 5분마다 재조회, 1분마다 METAR 경과로 "오래됨"(> 2 h) 재계산 ----
    let airportFeatures: GeoJSON.Feature<GeoJSON.Point, AirportProps>[] = [];
    let airportsFetchedAt = 0;
    let airportsKey = "";
    const applyAirports = () => {
      const src = geo(map, "airports");
      if (!src) return;
      const now = serverNowMs(Date.now());
      const features = airportFeatures.map((f) => ({ ...f, properties: { ...f.properties, stale: isMetarStale(f.properties, now) } }));
      const key = features.map((f) => `${f.properties.icao}:${f.properties.flight_cat ?? "-"}:${f.properties.stale ? 1 : 0}:${f.properties.obs_time ?? ""}`).join("|");
      if (key === airportsKey) return;
      airportsKey = key;
      src.setData({ type: "FeatureCollection", features });
    };
    const pollAirports = () => {
      airportsFetchedAt = Date.now();
      apiGet<GeoJSON.FeatureCollection<GeoJSON.Point, AirportProps>>("/api/v1/airports?watched=true")
        .then((fc) => { airportFeatures = Array.isArray(fc.features) ? fc.features.filter((f) => f.properties && typeof f.properties.icao === "string") : []; applyAirports(); })
        .catch(() => { /* 실패하면 마지막 값을 유지하고 경과로 "오래됨"을 드러낸다 */ applyAirports(); });
    };

    // ---- 호버 툴팁(GAP-26): 항공기 > 공항 > SIGMET. rAF 로 묶어 이동당 한 번만 조회. 내용은 텍스트 노드로만. ----
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "wakeline-tip", offset: 14, maxWidth: "320px" });
    let hoverKey = "";
    let hoverAt = 0;
    let hoverRaf = 0;
    let hoverEvt: maplibregl.MapMouseEvent | null = null;
    const hideTip = () => { popup.remove(); hoverKey = ""; hoverEvt = null; map.getCanvas().style.cursor = ""; };
    const doHover = () => {
      hoverRaf = 0;
      const e = hoverEvt;
      if (!e) return;
      const present = HOVER_LAYERS.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none");
      const hits = present.length ? map.queryRenderedFeatures(e.point, { layers: [...present] }) : [];
      const f = hits.find((h) => h.layer.id === "aircraft-symbol") ?? hits.find((h) => h.layer.id === "airport-circle") ?? hits.find((h) => h.layer.id === "sigmet-fill");
      map.getCanvas().style.cursor = f ? "pointer" : "";
      if (!f) { popup.remove(); hoverKey = ""; return; }
      const p = (f.properties ?? {}) as Record<string, unknown>;
      const now = serverNowMs(Date.now());
      const key = `${f.layer.id}:${String(p.hex ?? p.icao ?? p.id)}`;
      if (key !== hoverKey || now - hoverAt > 1000) {
        let tip: Tip | null = null;
        if (f.layer.id === "aircraft-symbol") {
          const hex = String(p.hex);
          const sel = getData().selected;
          const st = sel && sel.hex === hex && sel.state ? sel.state : aircraftStates.get(hex);
          tip = aircraftTip({ hex, callsign: (p.callsign as string) ?? null, alt_ft: typeof p.alt_ft === "number" ? p.alt_ft : null, stale: p.stale === true, estimated: p.estimated === true, emergency: p.emergency === true, age_unknown: p.age_unknown === true }, st, now);
        } else if (f.layer.id === "airport-circle") {
          const ap = airportFeatures.find((x) => x.properties.icao === p.icao);
          if (ap) tip = airportTip(ap.properties, now);
        } else {
          const sg = getData().sigmets?.features.find((x) => x.properties.id === p.id);
          if (sg) tip = sigmetTip({ ...sg.properties, inside: p.inside === true }, now);
        }
        if (!tip) { popup.remove(); hoverKey = ""; return; }
        popup.setDOMContent(renderTip(tip));
        hoverKey = key;
        hoverAt = now;
      }
      popup.setLngLat(e.lngLat);
      if (!popup.isOpen()) popup.addTo(map);
    };

    let krTimer: ReturnType<typeof setInterval> | null = null;
    let apTimer: ReturnType<typeof setInterval> | null = null;
    map.on("load", () => {
      addBaseLayers(map);
      // 출처(FR-20): 스타일이 배경지도 크레딧을 이미 붙였으면 중복하지 않는다. 데이터 출처는 항상 전부(OpenSky·기상청 포함).
      const styleCredits = Object.keys(map.getStyle().sources ?? {}).map((id) => (map.getSource(id) as { attribution?: string } | undefined)?.attribution);
      map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: mapAttributionHtml({ includeMap: !styleHasBasemapCredit(styleCredits) }) }), "bottom-right");
      applyRender();
      worker.postMessage({ type: "start" });
      client.connect();
      subscribeViewport();
      const pollKr = () => apiGet<KrRadar>("/api/v1/radar/kr").then((d) => setData({ radarKr: d })).catch(() => {});
      pollKr();
      krTimer = setInterval(() => { if (!document.hidden) pollKr(); }, 60_000); // 숨긴 탭에서는 받지 않는다
      pollAirports();
      apTimer = setInterval(() => {
        if (document.hidden) return;
        if (Date.now() - airportsFetchedAt >= AIRPORTS_REFRESH_MS) pollAirports(); else applyAirports();
      }, AIRPORTS_RECHECK_MS);
      map.on("mousemove", (e: maplibregl.MapMouseEvent) => { hoverEvt = e; if (!hoverRaf) hoverRaf = requestAnimationFrame(doHover); });
      map.on("mouseout", hideTip);
      map.on("dragstart", hideTip);
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
    });

    const onVisibility = () => {
      if (document.hidden) { client.pause(); worker.postMessage({ type: "stop" }); }
      else { client.resume(); worker.postMessage({ type: "start" }); }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (moveTimer) clearTimeout(moveTimer);
      if (krTimer) clearInterval(krTimer);
      if (apTimer) clearInterval(apTimer);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      popup.remove();
      client.close();
      worker.terminate();
      map.remove();
      mapRef.current = null;
      workerRef.current = null;
      clientRef.current = null;
      refreshPrediction.current = () => {};
      setData({ conn: "closed" });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- SIGMET 만료 재검사 타이머 ----
  useEffect(() => {
    const tick = () => setSigClock(Date.now());
    const t = setInterval(tick, SIGMET_EXPIRY_CHECK_MS);
    const raf = requestAnimationFrame(tick);
    return () => { clearInterval(t); cancelAnimationFrame(raf); };
  }, []);

  // ---- SIGMET 갱신(만료 제외) + 안에 항공기가 있는 경보 강조 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sigmets) return;
    const nowMs = serverNowMs(sigClock || Date.now());
    const inside = new Set([...alerts.values()].filter((a) => a.kind === "OBSERVED").map((a) => a.sigmet_id));
    const active = activeSigmetFeatures(sigmets, nowMs);
    // 같은 컬렉션·같은 강조·같은 만료 결과면 다시 넣지 않는다(알림 배치마다 폴리곤 전체 재색인 방지)
    const key = `${active.length}|${active.filter((f) => inside.has(f.properties.id)).map((f) => f.properties.id).sort().join(",")}`;
    if (sigmetApplied.current.fc === sigmets && sigmetApplied.current.key === key) return;
    sigmetApplied.current = { fc: sigmets, key };
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: active.map((f) => ({ ...f, properties: { ...f.properties, inside: inside.has(f.properties.id) } })) as GeoJSON.Feature[],
    };
    onReady(map, () => geo(map, "sigmets")?.setData(fc));
  }, [sigmets, alerts, sigClock]);

  // ---- 예측선: 알림(PREDICTED 추가·해제)이 바뀌면 다시 계산 ----
  useEffect(() => { refreshPrediction.current(); }, [alerts]);

  // ---- 레이더(PERF-12): 현재 프레임만 visible, 재생 중에는 다음 프레임을 불투명도 0 으로 미리 받는다. 소스는 필요할 때 만든다. ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !radar) return;
    const display = frameDisplay(radar.past.length, radarFrameIndex, layers.radar && radarSource === "rainviewer", radarPlaying);
    const frames: Frame[] = radar.past.map((f) => ({
      id: `radar-${f.time}`,
      add: (m) => {
        const id = `radar-${f.time}`;
        m.addSource(id, { type: "raster", tiles: [radarTileUrl(radar.host, f.path)], tileSize: 512, maxzoom: 7 });
        m.addLayer({ id, type: "raster", source: id, layout: { visibility: "none" }, paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: 150 } } }, "sigmet-fill");
      },
    }));
    onReady(map, () => { radarLayers.current = syncFrames(map, radarLayers.current, frames, display, radarOpacity); });
  }, [radar, radarFrameIndex, radarOpacity, layers.radar, radarSource, radarPlaying]);

  // ---- RainViewer 커버리지 마스크(GAP-15): 레이더가 RainViewer 일 때만. 커버리지 밖 = 회색 베일, 안 · 에코 없음 = 투명 ----
  const coverageHost = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const host = radar?.host ?? null;
    const show = layers.radar && radarSource === "rainviewer" && !!host && (radar?.past.length ?? 0) > 0;
    onReady(map, () => {
      if (coverageHost.current && coverageHost.current !== host && map.getSource("rv-coverage")) {
        map.removeLayer("rv-coverage"); map.removeSource("rv-coverage"); coverageHost.current = null;
      }
      if (show && host && !map.getSource("rv-coverage")) {
        map.addSource("rv-coverage", { type: "raster", tiles: [coverageTileUrl(host)], tileSize: 512, maxzoom: 7 });
        map.addLayer({ id: "rv-coverage", type: "raster", source: "rv-coverage", layout: { visibility: "none" }, paint: { ...COVERAGE_PAINT } }, RADAR_SLOT);
        coverageHost.current = host;
      }
      if (map.getLayer("rv-coverage")) map.setLayoutProperty("rv-coverage", "visibility", show ? "visible" : "none");
    });
  }, [radar, layers.radar, radarSource]);

  // ---- 기상청 레이더(FR-31): 재투영된 PNG 를 image source 로. 좌표는 서버가 문서 기반 LCC 정의로 계산한 웹 메르카토르 경계 ----
  // image source 는 추가하는 순간 PNG 를 받으므로 보일 프레임만 지연 추가한다(PERF-12). 경계가 바뀌면 다시 만든다.
  const krCoordsKey = useRef("");
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !radarKr?.available || !radarKr.coordinates || radarKr.coordinates.length !== 4) return;
    const c = radarKr.coordinates;
    const coords: [[number, number], [number, number], [number, number], [number, number]] = [c[0], c[1], c[2], c[3]];
    const display = frameDisplay(radarKr.frames.length, krFrameIndex, layers.radar && radarSource === "kma", radarPlaying);
    const frames: Frame[] = radarKr.frames.map((f) => ({
      id: `kmar-${f.tm}`,
      add: (m) => {
        const id = `kmar-${f.tm}`;
        m.addSource(id, { type: "image", url: f.url, coordinates: coords });
        m.addLayer({ id, type: "raster", source: id, layout: { visibility: "none" }, paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: 150 }, "raster-resampling": "nearest" } }, "sigmet-fill");
      },
    }));
    const key = JSON.stringify(coords);
    onReady(map, () => {
      if (krCoordsKey.current && krCoordsKey.current !== key) {
        for (const id of krLayers.current) { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); }
        krLayers.current = [];
      }
      krCoordsKey.current = key;
      krLayers.current = syncFrames(map, krLayers.current, frames, display, Math.min(1, radarOpacity + 0.25));
    });
  }, [radarKr, krFrameIndex, radarSource, radarOpacity, layers.radar, radarPlaying]);

  // ---- 검색 등에서 요청한 지도 이동(움직임 줄이기 설정이면 바로 이동) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo || flyTo.id <= flyHandled.current) return;
    flyHandled.current = flyTo.id;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const opts = { center: [flyTo.lon, flyTo.lat] as [number, number], zoom: Math.max(map.getZoom(), flyTo.zoom) };
    onReady(map, () => (reduce ? map.jumpTo(opts) : map.flyTo({ ...opts, duration: 1200, essential: true })));
  }, [flyTo]);

  // ---- 레이어 토글 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    onReady(map, () => {
      const vis = (ids: string[], on: boolean) => ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
      vis(["sigmet-fill", "sigmet-line"], layers.sigmet);
      vis(["aircraft-symbol"], layers.aircraft);
      vis(["airport-circle", "airport-label"], layers.airports);
      vis(["track-line"], layers.tracks);
      vis(["prediction-line", "prediction-label"], layers.prediction);
    });
  }, [layers]);

  // ---- 선택 항공기: WS select + 항적(REST 한 번, 이후 selected 로 연장) ----
  useEffect(() => {
    clientRef.current?.select(selectedHex);
    workerRef.current?.postMessage({ type: "invalidate" }); // 선택 강조를 바로 다시 그린다
    track.current = { hex: selectedHex, pts: [], pending: [], loaded: false };
    const map = mapRef.current;
    if (!map) return;
    onReady(map, () => { geo(map, "tracks")?.setData(EMPTY_FC); refreshPrediction.current(); });
    if (!selectedHex) return;
    let cancelled = false;
    const finish = (rest: TrackPt[]) => {
      if (cancelled || track.current.hex !== selectedHex) return;
      const pts = mergeTrack(rest, track.current.pending);
      track.current = { hex: selectedHex, pts, pending: [], loaded: true };
      onReady(map, () => geo(map, "tracks")?.setData(trackFeatureCollection(pts)));
    };
    apiGet<{ points: { ts?: string | null; lon: number; lat: number; alt_ft?: number | null }[] }>(`/api/v1/aircraft/${encodeURIComponent(selectedHex)}/track`)
      .then((t) => finish(trackFromRest(t.points)))
      .catch(() => finish([])); // DB 기록이 없거나(전세계 항공기) DB 장애 → 실시간 관측만으로 잇는다
    return () => { cancelled = true; };
  }, [selectedHex]);

  useEffect(() => {
    refreshPrediction.current();
    const map = mapRef.current;
    const t = track.current;
    if (!map || !selectedInfo || selectedInfo.hex !== t.hex) return;
    const p = pointFromState(selectedInfo.state);
    if (!p) return;
    if (!t.loaded) { appendTrackPoint(t.pending, p); return; }
    if (appendTrackPoint(t.pts, p)) onReady(map, () => geo(map, "tracks")?.setData(trackFeatureCollection(t.pts)));
  }, [selectedInfo]);

  return <div ref={el} className="h-full w-full" data-testid="map" />;
}
