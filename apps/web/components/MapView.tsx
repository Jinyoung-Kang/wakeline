"use client";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import {
  addBaseLayers, aircraftFeatureCollection, FALLBACK_STYLE, predictionFeature, predictionKey, predictionTargets, RADAR_SLOT, STYLE_LOAD_TIMEOUT_MS, STYLE_URL,
} from "@/lib/maplayers";
import { subscriptionBbox } from "@/lib/viewport";
import { maplibre } from "@/lib/maplibre";
import { applyBasemap } from "@/lib/basemap";
import { aircraftStates, getData, serverNowMs, setData, shipStates, useServerData } from "@/lib/store";
import { addShipLayers, SHIP_LAYERS, shipCategoryFilter } from "@/lib/ship-layers";
import { aisCoverageFeatures, filterGridCells, gridFeatures, selectedShipFeatures, shipCategory, shipFeatures } from "@/lib/ships";
import { useUi } from "@/lib/ui-store";
import { WakelineWsClient } from "@/lib/ws";
import { mapAttributionHtml, styleHasBasemapCredit } from "@/lib/attribution";
import { mapAttributionControl } from "@/lib/map-attribution";
import { onReady, setDashboardMap, useDashboardMap } from "@/lib/map-ready";
import { addTrafficGridLayers, TRAFFIC_LAYERS, trafficDrawable, TrafficGridPoller, trafficGridFeatures, trafficStaleAt } from "@/lib/traffic-grid";
import { useMapPointer } from "./map/useMapPointer";
import { useSelectionTracks, type LiveFeed } from "./map/useSelectionTracks";
import { useWeatherLayers } from "./map/useWeatherLayers";
import type { RenderState } from "@/lib/types";

const REGION_CENTER: [number, number] = [127.8, 36.5];
const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
/** 선박 STALE(> 15분) 재계산 주기 — 새 메시지가 없어도 오래된 선박을 반투명으로 */
const SHIP_STALE_CHECK_MS = 30_000;

function geo(map: maplibregl.Map, id: string) {
  return map.getSource(id) as maplibregl.GeoJSONSource | undefined;
}

/**
 * 상황판 지도(클라이언트 컴포넌트). WS 구독은 지도 뷰포트(bbox·zoom)를 따라간다.
 * 보간은 Web Worker(바뀐 것이 있을 때만 post) → 이 컴포넌트는 setData 만 한다. 탭이 숨겨지면 구독을 멈춘다.
 * onFirstLoad: 지도가 처음 다 그려졌을 때(MapLibre 'load' — 한 번) — 상황판은 여기서 첫 화면 뒤 미리 받기를 시작한다(ADR-026).
 */
export function MapView({ onFirstLoad }: { onFirstLoad?: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const onFirstLoadRef = useRef(onFirstLoad);
  useEffect(() => { onFirstLoadRef.current = onFirstLoad; }, [onFirstLoad]);
  const mapRef = useRef<maplibregl.Map | null>(null);
  /** 이 지도의 실시간 피드(WS 클라이언트 · 워커 · 예측선 갱신) — 지도 생성 effect 가 채우고 정리할 때 비운다 */
  const feed = useRef<LiveFeed | null>(null);
  const alerts = useServerData((d) => d.alerts);
  const ships = useServerData((d) => d.ships);
  const shipSelected = useServerData((d) => d.shipSelected);
  const ais = useServerData((d) => d.ais);
  const layers = useUi((s) => s.layers);
  const selectedHex = useUi((s) => s.selectedHex);
  const selectedShip = useUi((s) => s.selectedShip);
  const shipCats = useUi((s) => s.shipCats);
  const flyTo = useUi((s) => s.flyTo);
  /** 마운트 전에 처리된 이동 요청은 다시 하지 않는다(다른 화면에서 돌아올 때) */
  const flyHandled = useRef(useUi.getState().flyTo?.id ?? 0);
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selectedHex; }, [selectedHex]);
  /** 그린 AIS 수신 범위 키 — '이 지도에 그린 것'의 기록 */
  const coverageKey = useRef("");
  const [shipClock, setShipClock] = useState(0);

  // ---- 지도·WS·워커 생명주기 ----
  useEffect(() => {
    if (!el.current) return;
    // MapLibre 는 public 배포본(워커와 공용 청크를 나눠 쓴다 — R-02). 상황판은 이 컴포넌트를 불러올 때 loadMaplibre() 를 함께 기다린다(app/page.tsx).
    const ml = maplibre();
    const map = new ml.Map({
      container: el.current, style: STYLE_URL, center: REGION_CENTER, zoom: 6, minZoom: 1, maxZoom: 12,
      hash: true, // #zoom/lat/lon — 지도 위치를 링크로 공유
      attributionControl: false, canvasContextAttributes: { antialias: false },
    });
    map.addControl(new ml.NavigationControl({ showCompass: false }), "top-left");
    mapRef.current = map;
    setDashboardMap(map); // 켤 때 받는 레이어 조각(관측 수신 범위)이 이 지도에 그린다
    let styleLoaded = false;
    let noBasemap = false;
    // R-01: 배경지도 스타일(외부 호스트)을 받지 못하면 load 가 오지 않아 우리 레이어도 그려지지 않는다 → 로컬 최소 스타일로 바꾸고 화면에 알린다.
    // 한 번만 바꾼다: 바꾼 뒤에는 늦게 온 이벤트·오류·타이머가 다시 바꾸지 않는다(setStyle 은 이전 스타일의 요청을 취소하고 그 이벤트를 떼어 낸다).
    const fallBack = () => {
      if (styleLoaded || noBasemap) return;
      noBasemap = true;
      // 알림은 지도 위 왼쪽 상태 칸(MapChips — LayerPanel 의 배치 안)이 그린다: 레이어 단추 줄 · 칩과 겹치지 않게 한 배치로
      useUi.getState().setBasemapFailed(true);
      map.setStyle(FALLBACK_STYLE, { diff: false });
    };
    // 오류 없이 멈춘 요청(패킷 DROP·DNS 블랙홀)도 STYLE_LOAD_TIMEOUT_MS 뒤에 같은 길로
    const styleTimer = setTimeout(fallBack, STYLE_LOAD_TIMEOUT_MS);
    // 배경지도 시인성(계약 v4 §E): 스타일을 받을 때마다 알려진 층의 색만 바꾼다(대체 스타일에는 칠할 지형이 없다)
    map.on("style.load", () => { styleLoaded = true; clearTimeout(styleTimer); if (!noBasemap) applyBasemap(map); });
    // 스타일이 오기 전의 sourceId 없는 오류만 스타일 실패다(타일·소스 오류는 sourceId 가 있고, 스프라이트·글꼴 오류는 style.load 뒤에 온다).
    // 처리기를 달면 MapLibre 가 오류를 콘솔에 찍지 않으므로 그대로 찍는다.
    map.on("error", (e: { error?: unknown; sourceId?: string }) => {
      console.error(e?.error ?? e);
      if (e?.sourceId) return;
      fallBack();
    });
    map.getCanvas().setAttribute("aria-label", "실시간 항공기·위험기상 지도. 화살표 키로 이동, +/- 로 확대. 항공기는 상단 검색(/)으로 선택할 수 있습니다.");

    // 번들러(Turbopack)가 .ts 워커를 자산으로 취급하므로 순수 JS 워커를 public 에 둔다(tests/worker-sync 가 TS 구현과 일치를 검사).
    const worker = new Worker("/interpolate.worker.js");
    const client = new WakelineWsClient(worker);

    let predKey: string | null = null;
    const refreshPrediction = () => {
      const src = geo(map, "prediction");
      if (!src) return;
      const d = getData();
      const sel = d.selected && d.selected.hex === selectedRef.current ? d.selected : null;
      const targets = predictionTargets(sel, d.alerts.values(), aircraftStates);
      // 선은 "지금"(서버 기준)에서 시작한다(DH-12) — 엔진의 예측·알림 ETA 와 같은 시각 기준
      const now = serverNowMs(Date.now());
      const key = predictionKey(targets, now);
      if (key === predKey) return;
      predKey = key;
      src.setData({ type: "FeatureCollection", features: targets.map((t) => predictionFeature(t, now)).filter((f): f is NonNullable<typeof f> => f != null) });
    };
    feed.current = { client, worker, refreshPrediction };

    // 워커는 바뀐 것이 있을 때만 보낸다 → 받은 렌더를 잃지 않도록 마지막 것을 보관했다가 레이어가 준비되면 적용한다.
    let lastRender: RenderState[] | null = null;
    const applyRender = () => {
      const src = geo(map, "aircraft");
      if (!src || !lastRender) return;
      src.setData(aircraftFeatureCollection(lastRender, selectedRef.current));
      refreshPrediction();
    };
    worker.onmessage = (ev: MessageEvent<{ type: string; states: RenderState[] }>) => {
      if (ev.data.type !== "render") return;
      lastRender = ev.data.states;
      applyRender();
    };

    const subscribeViewport = () => {
      const b = map.getBounds();
      const bbox = subscriptionBbox(b.getWest(), b.getSouth(), b.getEast(), b.getNorth(), map.getZoom(), map.getCenter().lng); // 날짜변경선(lib/viewport)
      client.subscribe(bbox, Math.floor(map.getZoom()));
      worker.postMessage({ type: "viewport", bbox, zoom: map.getZoom() });
      // 목록에서 고른 항목이 화면 밖인지(lib/focus)는 구독 bbox 가 아니라 보이는 범위로 판단한다(R-08)
      setData({ mapBounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] });
    };
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    map.on("moveend", () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(subscribeViewport, 300);
    });

    // ---- 실시간 데이터(R-01): 지도 스타일(외부 호스트)을 기다리지 않고 바로 시작한다. 구독 bbox 는 지도 생성 직후부터 알 수 있다.
    // 받은 값은 스토어·워커에 쌓이고, 지도에 그리는 일(applyRender·onReady)만 load 뒤에 한다(기상청 레이더 · 감시 공항 조회는 useWeatherLayers).
    worker.postMessage({ type: "start" });
    client.connect();
    subscribeViewport();

    map.on("load", () => {
      onFirstLoadRef.current?.();
      addBaseLayers(map);
      addShipLayers(map);
      addTrafficGridLayers(map, RADAR_SLOT); // 연안 교통량(ADR-023) — 레이더 · SIGMET · 항공기 · 선박 아래
      // 출처(FR-20): 스타일이 배경지도 크레딧을 이미 붙였으면 중복하지 않는다. 배경지도를 못 받았으면(대체 스타일) 배경지도 크레딧을 붙이지 않는다.
      // 데이터 출처는 항상 전부(OpenSky·기상청 포함).
      const styleCredits = Object.keys(map.getStyle().sources ?? {}).map((id) => (map.getSource(id) as { attribution?: string } | undefined)?.attribution);
      // 지도 위 표기는 compact(ⓘ) — 좁은 지도에서는 접힌 채로 시작한다. 전체 출처는 화면 아래 SOURCES 줄에 늘 보인다(lib/map-attribution)
      map.addControl(mapAttributionControl(ml, mapAttributionHtml({ includeMap: !noBasemap && !styleHasBasemapCredit(styleCredits) })), "bottom-right");
      applyRender();
    });

    const onVisibility = () => {
      if (document.hidden) { client.pause(); worker.postMessage({ type: "stop" }); }
      else { client.resume(); worker.postMessage({ type: "start" }); }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      useUi.getState().setBasemapFailed(false); // 떠난 지도의 상태를 남기지 않는다
      clearTimeout(styleTimer);
      if (moveTimer) clearTimeout(moveTimer);
      client.close();
      worker.terminate();
      setDashboardMap(null); // 지우기 전에 — 조각이 지운 지도에 그리지 않게
      map.remove();
      mapRef.current = null;
      // '이 지도에 그린 것'의 기록은 지도와 함께 버린다 — 다음 지도(StrictMode 의 두 번째 마운트 · 다시 마운트)에는 아무것도 그려져 있지 않다.
      // 남기면 같은 SIGMET · AIS 범위를 '이미 그림'으로 건너뛰어 새 지도에 그리지 않았다(web-review B8)
      coverageKey.current = "";
      feed.current = null;
      setData({ conn: "closed" });
    };
  }, []);

  // ---- 기상 레이어(SIGMET · 레이더 · 커버리지 · 기상청 · 감시 공항 — components/map/useWeatherLayers), 포인터(호버 · 클릭 — useMapPointer).
  // 지도는 상황판 지도 손잡이(lib/map-ready)로 받는다 ----
  const dashMap = useDashboardMap();
  const airports = useWeatherLayers(dashMap);
  useMapPointer(dashMap, airports);

  // ---- 예측선: 알림(PREDICTED 추가·해제)이 바뀌면 다시 계산 ----
  useEffect(() => { feed.current?.refreshPrediction(); }, [alerts]);

  // ---- 검색 등에서 요청한 지도 이동(움직임 줄이기 설정이면 바로 이동) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo || flyTo.id <= flyHandled.current) return;
    flyHandled.current = flyTo.id;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const opts = { center: [flyTo.lon, flyTo.lat] as [number, number], zoom: Math.max(map.getZoom(), flyTo.zoom) };
    onReady(map, "fly", () => (reduce ? map.jumpTo(opts) : map.flyTo({ ...opts, duration: 1200, essential: true })));
  }, [flyTo]);

  // ---- 레이어 토글 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    onReady(map, "layers", () => {
      const vis = (ids: string[], on: boolean) => ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
      vis(["sigmet-fill", "sigmet-line"], layers.sigmet);
      vis(["aircraft-symbol"], layers.aircraft);
      vis(["airport-circle", "airport-label"], layers.airports);
      vis(["track-line", "track-gap", "track-gap-label"], layers.tracks);
      vis(["prediction-line", "prediction-label"], layers.prediction);
      vis([...TRAFFIC_LAYERS], layers.traffic === true);
      vis(SHIP_LAYERS.filter((l) => !l.startsWith("ship-track")), layers.ships);
      vis(SHIP_LAYERS.filter((l) => l.startsWith("ship-track")), layers.ships && layers.tracks);
    });
  }, [layers]);

  // ---- 연안 교통량(ADR-023): 켜져 있을 때만 조회(90 s · ETag · 숨긴 탭 제외 · 다시 보이면 곧바로). 지도는 내용이 바뀔 때(version)만 다시 그리고,
  // 끄면 칸을 비운다. 받아 둔 값이 이 시계로 오래되면(regDt + stale_after_s) 그리지 않고, 그리는 중이면 그 순간 비운다 — 조회가 실패해 api 가 '멈춤'을
  // 말할 수 없을 때도 지난 칸을 지금처럼 두지 않는다 ----
  const trafficVersion = useServerData((d) => d.trafficGrid.version);
  useEffect(() => {
    if (!layers.traffic) return;
    const poller = new TrafficGridPoller((s) => setData({ trafficGrid: s }), getData().trafficGrid);
    poller.start();
    return () => poller.stop();
  }, [layers.traffic]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const g = getData().trafficGrid.data;
    const now = serverNowMs(Date.now());
    const draw = layers.traffic === true && trafficDrawable(g, now);
    onReady(map, "traffic-grid", () => geo(map, "traffic-grid")?.setData(draw ? trafficGridFeatures(g.cells) : EMPTY_FC));
    const at = draw ? trafficStaleAt(g) : null;
    if (at == null) return;
    const t = setTimeout(() => onReady(map, "traffic-grid", () => geo(map, "traffic-grid")?.setData(EMPTY_FC)), Math.max(0, at - now) + 50);
    return () => clearTimeout(t);
  }, [trafficVersion, layers.traffic]);

  // ---- 선박·격자 그리기: 서버 메시지(ships.version)·선택·STALE 재계산(30 s) ----
  useEffect(() => {
    const t = setInterval(() => setShipClock(Date.now()), SHIP_STALE_CHECK_MS);
    return () => clearInterval(t);
  }, []);
  // 격자는 선종 필터(계약 v5 §B3)로 칸 수를 다시 센다 — 선종별 수가 없는 칸(구 서버)은 그대로(칸 툴팁·칩이 밝힌다)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const now = serverNowMs(Date.now());
    const enabled = new Set(shipCats);
    onReady(map, "ships", () => {
      geo(map, "ships")?.setData(ships.mode === "points" ? shipFeatures(shipStates.values(), selectedShip, now) : EMPTY_FC);
      geo(map, "ship-grid")?.setData(ships.mode === "grid" ? gridFeatures(filterGridCells(ships.grid, enabled).cells) : EMPTY_FC);
    });
  }, [ships, selectedShip, shipClock, shipCats]);

  // ---- 선택 선박(계약 v5 §B3): 격자 모드·선종 필터와 상관없이 고리 + 라벨(선박 기호가 그리지 않으면 아이콘도). 위치를 모르면 그리지 않는다 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const listed = selectedShip ? shipStates.get(selectedShip) ?? null : null;
    const live = shipSelected && shipSelected.mmsi === selectedShip ? shipSelected.state : null;
    const symbolDraws = ships.mode === "points" && listed != null && shipCats.includes(shipCategory(listed.ship_type));
    const staticName = shipSelected && shipSelected.mmsi === selectedShip ? shipSelected.static?.name ?? null : null;
    const fc = selectedShipFeatures(selectedShip, live, listed, symbolDraws, serverNowMs(Date.now()), staticName);
    onReady(map, "ship-selected", () => geo(map, "ship-selected")?.setData(fc));
  }, [ships, selectedShip, shipSelected, shipClock, shipCats]);

  // ---- 선종 필터(계약 v5 §B3): 점 모드는 MapLibre filter(모두 켜져 있으면 없음) ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const filter = shipCategoryFilter(new Set(shipCats));
    onReady(map, "ship-filter", () => { if (map.getLayer("ship-symbol")) map.setFilter("ship-symbol", filter); });
  }, [shipCats]);

  // ---- 선박 수신 범위(계약 v3 §A): 선박 레이어가 켜져 있고 status 가 범위를 줄 때만 경계 점선. 모르면 그리지 않는다 ----
  const coverage = ais?.coverage ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const fc = layers.ships ? aisCoverageFeatures(coverage) : EMPTY_FC;
    const key = JSON.stringify(fc.features.map((f) => f.geometry));
    if (key === coverageKey.current) return;
    coverageKey.current = key;
    onReady(map, "ship-coverage", () => geo(map, "ship-coverage")?.setData(fc));
  }, [coverage, layers.ships]);

  // ---- 선택 항적: WS 선택 · 켜진 레이어 알림, 항공기 · 선박 항적(components/map/useSelectionTracks) ----
  useSelectionTracks(dashMap, feed);

  return <div ref={el} className="h-full w-full" data-testid="map" />;
}
