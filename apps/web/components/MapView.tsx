"use client";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import {
  addBaseLayers, COVERAGE_PAINT, coverageTileUrl, FALLBACK_STYLE, frameDisplay, predictionFeature, predictionKey, predictionTargets,
  RADAR_SLOT, radarTileUrl, STYLE_LOAD_TIMEOUT_MS, STYLE_URL, type FrameRole,
} from "@/lib/maplayers";
import { subscriptionBbox } from "@/lib/viewport";
import { maplibre } from "@/lib/maplibre";
import { applyBasemap } from "@/lib/basemap";
import { aircraftStates, getData, serverNowMs, setData, shipStates, useServerData } from "@/lib/store";
import { addShipLayers, SHIP_LAYERS } from "@/lib/ship-layers";
import {
  aisCoverageFeatures, appendShipTrack, gridFeatures, isMmsi, mergeStatusGaps, SHIP_TRACK_WINDOW_MS, shipFeatures, shipTrackFeatures, shipTrackFromRest,
  type ShipTrack,
} from "@/lib/ships";
import { useUi } from "@/lib/ui-store";
import { WakelineWsClient } from "@/lib/ws";
import { apiGet } from "@/lib/api";
import { activeSigmetFeatures } from "@/lib/sigmet";
import { mapAttributionHtml, styleHasBasemapCredit } from "@/lib/attribution";
import { isMetarStale } from "@/lib/format";
import { aircraftTip, airportTip, renderTip, shipGridTip, shipTip, sigmetTip, type AirportProps, type Tip } from "@/lib/tooltip";
import { appendTrackPoint, mergeTrack, pointFromState, trackFeatureCollection, trackFromRest, type TrackPt } from "@/lib/track";
import type { KrRadar, RenderState, SigmetCollection } from "@/lib/types";

const REGION_CENTER: [number, number] = [127.8, 36.5];
const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
/** SIGMET 만료 재검사 주기(새 메시지가 없어도 만료된 경보를 지운다) */
const SIGMET_EXPIRY_CHECK_MS = 30_000;
/** 공항 비행 카테고리 레이어 재조회(GAP-14). collector METAR 주기(10분)보다 짧게. 경과(오래됨) 재계산은 1분마다. */
const AIRPORTS_REFRESH_MS = 300_000;
const AIRPORTS_RECHECK_MS = 60_000;
/** 호버·클릭 우선순위: 항공기 > 선박 > 선박 격자 > 공항 > SIGMET */
const PICK_LAYERS = ["aircraft-symbol", "ship-symbol", "ship-grid-circle", "airport-circle", "sigmet-fill"] as const;
/** 선박 STALE(> 15분) 재계산 주기 — 새 메시지가 없어도 오래된 선박을 반투명으로 */
const SHIP_STALE_CHECK_MS = 30_000;
/** REST 항적을 받기 전에 온 실시간 관측 보류 상한 */
const SHIP_PENDING_MAX = 500;

type ShipTrackRef = { mmsi: string | null; track: ShipTrack; pending: { ts: number; lon: number; lat: number }[]; loaded: boolean; anchor: number | null; sinceMs: number };
const emptyShipTrack = (mmsi: string | null, anchor: number | null = null, sinceMs = 0): ShipTrackRef => ({ mmsi, track: { segs: [], gaps: [] }, pending: [], loaded: false, anchor, sinceMs });

/** 선택 선박의 가장 최근 위치(WS ship_selected → 지도 목록 사본). 구역별 AIS 공백을 가를 때 쓴다(계약 v4 §D). 모르면 null */
function shipPos(mmsi: string | null): { lat: number; lon: number } | null {
  if (!mmsi) return null;
  const sel = getData().shipSelected;
  const p = (sel && sel.mmsi === mmsi ? sel.state : null) ?? shipStates.get(mmsi) ?? null;
  return p ? { lat: p.lat, lon: p.lon } : null;
}

/** 선택 선박 항적 요약(카드의 공백 목록·구간 수)을 스토어에 — 같은 선박일 때만, 불러오기 상태·오류는 그대로 */
function publishShipTrack(ref: ShipTrackRef) {
  const cur = getData().shipTrack;
  if (!cur || cur.mmsi !== ref.mmsi) return;
  setData({ shipTrack: { ...cur, gaps: ref.track.gaps.slice(), gapsTruncated: ref.track.gapsTruncated === true, segments: ref.track.segs.length } });
}

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

/** load 전에 요청된 그리기 — 키마다 마지막 것만 둔다(데이터는 스타일과 무관하게 오므로(R-01) 스타일이 늦거나 오지 않아도 쌓이지 않는다) */
const deferredDraws = new WeakMap<maplibregl.Map, Map<string, () => void>>();
/**
 * 기본 레이어(addBaseLayers)가 준비됐으면 바로, 아니면 load 뒤에 실행(같은 key 는 마지막 요청만 — 각 그리기는 그 레이어의 전체 상태를 쓴다).
 * isStyleLoaded() 는 타일을 받는 동안 false 라 갱신을 잃는다. 대기열의 load 처리기는 지도 생성 effect 의 load 처리기(기본 레이어 추가) 뒤에 등록된다.
 */
function onReady(map: maplibregl.Map, key: string, fn: () => void) {
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
  const clientRef = useRef<WakelineWsClient | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const radarLayers = useRef<string[]>([]);
  const sigmets = useServerData((d) => d.sigmets);
  const alerts = useServerData((d) => d.alerts);
  const radar = useServerData((d) => d.radar);
  const radarKr = useServerData((d) => d.radarKr);
  const selectedInfo = useServerData((d) => d.selected);
  const ships = useServerData((d) => d.ships);
  const shipSelected = useServerData((d) => d.shipSelected);
  const ais = useServerData((d) => d.ais);
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
  const selectedShip = useUi((s) => s.selectedShip);
  const selectShip = useUi((s) => s.selectShip);
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
  /** 선택 선박 항적: REST 한 번 + WS ship_selected 로 연장(AIS 공백·15분 틈은 점선) */
  const shipTrack = useRef<ShipTrackRef>(emptyShipTrack(null));
  const [shipClock, setShipClock] = useState(0);
  /** 배경지도 스타일(외부)을 받지 못해 로컬 최소 스타일로 그리는 중(R-01) */
  const [basemapFailed, setBasemapFailed] = useState(false);

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
    let styleLoaded = false;
    let noBasemap = false;
    // R-01: 배경지도 스타일(외부 호스트)을 받지 못하면 load 가 오지 않아 우리 레이어도 그려지지 않는다 → 로컬 최소 스타일로 바꾸고 화면에 알린다.
    // 한 번만 바꾼다: 바꾼 뒤에는 늦게 온 이벤트·오류·타이머가 다시 바꾸지 않는다(setStyle 은 이전 스타일의 요청을 취소하고 그 이벤트를 떼어 낸다).
    const fallBack = () => {
      if (styleLoaded || noBasemap) return;
      noBasemap = true;
      setBasemapFailed(true);
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
    workerRef.current = worker;
    const client = new WakelineWsClient(worker);
    clientRef.current = client;

    let predKey: string | null = null;
    refreshPrediction.current = () => {
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
          properties: {
            hex: s.hex, callsign: s.callsign, alt_ft: s.alt_ft, track_deg: s.track_deg, on_ground: s.on_ground, stale: s.stale, age_unknown: s.age_unknown,
            estimated: s.estimated, emergency: s.emergency, selected: s.hex === sel,
          },
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

    /** 보이는 레이어에서 우선순위대로 한 개 */
    const pick = (pt: maplibregl.PointLike) => {
      const present = PICK_LAYERS.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none");
      if (!present.length) return null;
      const hits = map.queryRenderedFeatures(pt, { layers: [...present] });
      for (const l of PICK_LAYERS) { const h = hits.find((x) => x.layer.id === l); if (h) return h; }
      return null;
    };

    // ---- 호버 툴팁(GAP-26): 항공기 > 선박 > 선박 격자 > 공항 > SIGMET. rAF 로 묶어 이동당 한 번만 조회. 내용은 텍스트 노드로만. ----
    const popup = new ml.Popup({ closeButton: false, closeOnClick: false, className: "wakeline-tip", offset: 14, maxWidth: "320px" });
    let hoverKey = "";
    let hoverAt = 0;
    let hoverRaf = 0;
    let hoverEvt: maplibregl.MapMouseEvent | null = null;
    const hideTip = () => { popup.remove(); hoverKey = ""; hoverEvt = null; map.getCanvas().style.cursor = ""; };
    const doHover = () => {
      hoverRaf = 0;
      const e = hoverEvt;
      if (!e) return;
      const f = pick(e.point);
      map.getCanvas().style.cursor = f ? "pointer" : "";
      if (!f) { popup.remove(); hoverKey = ""; return; }
      const p = (f.properties ?? {}) as Record<string, unknown>;
      const now = serverNowMs(Date.now());
      const key = `${f.layer.id}:${String(p.hex ?? p.mmsi ?? p.icao ?? p.id ?? (f.geometry.type === "Point" ? f.geometry.coordinates.join(",") : ""))}`;
      if (key !== hoverKey || now - hoverAt > 1000) {
        let tip: Tip | null = null;
        if (f.layer.id === "aircraft-symbol") {
          const hex = String(p.hex);
          const sel = getData().selected;
          const st = sel && sel.hex === hex && sel.state ? sel.state : aircraftStates.get(hex);
          tip = aircraftTip({
            hex, callsign: (p.callsign as string) ?? null, alt_ft: typeof p.alt_ft === "number" ? p.alt_ft : null, stale: p.stale === true, estimated: p.estimated === true,
            emergency: p.emergency === true, age_unknown: p.age_unknown === true, on_ground: typeof p.on_ground === "boolean" ? p.on_ground : null,
            track_deg: typeof p.track_deg === "number" ? p.track_deg : null,
          }, st, now);
        } else if (f.layer.id === "ship-symbol") {
          const st = shipStates.get(String(p.mmsi));
          if (st) tip = shipTip(st, now);
        } else if (f.layer.id === "ship-grid-circle") {
          tip = shipGridTip(p, getData().ships.cell_deg);
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

    // ---- 실시간 데이터(R-01): 지도 스타일(외부 호스트)을 기다리지 않고 바로 시작한다. 구독 bbox 는 지도 생성 직후부터 알 수 있다.
    // 받은 값은 스토어·워커에 쌓이고, 지도에 그리는 일(applyRender·applyAirports·onReady)만 load 뒤에 한다.
    worker.postMessage({ type: "start" });
    client.connect();
    subscribeViewport();
    const pollKr = () => apiGet<KrRadar>("/api/v1/radar/kr").then((d) => setData({ radarKr: d })).catch(() => {});
    pollKr();
    const krTimer = setInterval(() => { if (!document.hidden) pollKr(); }, 60_000); // 숨긴 탭에서는 받지 않는다
    pollAirports();
    const apTimer = setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - airportsFetchedAt >= AIRPORTS_REFRESH_MS) pollAirports(); else applyAirports();
    }, AIRPORTS_RECHECK_MS);

    map.on("load", () => {
      addBaseLayers(map);
      addShipLayers(map);
      // 출처(FR-20): 스타일이 배경지도 크레딧을 이미 붙였으면 중복하지 않는다. 배경지도를 못 받았으면(대체 스타일) 배경지도 크레딧을 붙이지 않는다.
      // 데이터 출처는 항상 전부(OpenSky·기상청 포함).
      const styleCredits = Object.keys(map.getStyle().sources ?? {}).map((id) => (map.getSource(id) as { attribution?: string } | undefined)?.attribution);
      map.addControl(new ml.AttributionControl({ compact: false, customAttribution: mapAttributionHtml({ includeMap: !noBasemap && !styleHasBasemapCredit(styleCredits) }) }), "bottom-right");
      applyRender();
      applyAirports();
      map.on("mousemove", (e: maplibregl.MapMouseEvent) => { hoverEvt = e; if (!hoverRaf) hoverRaf = requestAnimationFrame(doHover); });
      map.on("mouseout", hideTip);
      map.on("dragstart", hideTip);
      map.on("click", (e: maplibregl.MapMouseEvent) => {
        const f = pick(e.point);
        const id = f?.layer.id;
        if (id === "aircraft-symbol") { select(String(f!.properties?.hex)); return; }
        if (id === "ship-symbol") { const m = String(f!.properties?.mmsi); if (isMmsi(m)) selectShip(m); return; }
        if (id === "ship-grid-circle" && f!.geometry.type === "Point") {
          // 격자 칸을 누르면 그 칸으로 확대 — 줌 7 이상에서 서버가 개별 선박을 보낸다(화면 안 5,000척 이하일 때 — 계약 v4 §C)
          const [lon, lat] = f!.geometry.coordinates as [number, number];
          const opts = { center: [lon, lat] as [number, number], zoom: Math.min(12, Math.max(7, map.getZoom() + 2)) };
          const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
          if (reduce) map.jumpTo(opts); else map.easeTo({ ...opts, duration: 800, essential: true });
          return;
        }
        if (id === "airport-circle") { selectAirport(String(f!.properties?.icao)); return; }
        if (id === "sigmet-fill") { selectSigmet(String(f!.properties?.id)); return; }
        // 빈 곳 클릭 = 선택 해제(집중 추적도 멈춘다)
        select(null);
        selectShip(null);
      });
    });

    const onVisibility = () => {
      if (document.hidden) { client.pause(); worker.postMessage({ type: "stop" }); }
      else { client.resume(); worker.postMessage({ type: "start" }); }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(styleTimer);
      if (moveTimer) clearTimeout(moveTimer);
      clearInterval(krTimer);
      clearInterval(apTimer);
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

  // ---- SIGMET 갱신(만료 제외 · 발효 전 구분) + 안에 항공기가 있는 경보 강조 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !sigmets) return;
    const nowMs = serverNowMs(sigClock || Date.now());
    const inside = new Set([...alerts.values()].filter((a) => a.kind === "OBSERVED").map((a) => a.sigmet_id));
    const active = activeSigmetFeatures(sigmets, nowMs);
    // 같은 컬렉션·같은 강조·같은 만료/발효 결과면 다시 넣지 않는다(알림 배치마다 폴리곤 전체 재색인 방지)
    const ids = (pred: (f: (typeof active)[number]) => boolean) => active.filter(pred).map((f) => f.properties.id).sort().join(",");
    const key = `${active.length}|${ids((f) => inside.has(f.properties.id))}|${ids((f) => f.properties.pending === true)}`;
    if (sigmetApplied.current.fc === sigmets && sigmetApplied.current.key === key) return;
    sigmetApplied.current = { fc: sigmets, key };
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      // 발효 전 경보는 엔진이 판정하지 않으므로 "안에 항공기" 강조도 하지 않는다
      features: active.map((f) => ({ ...f, properties: { ...f.properties, inside: !f.properties.pending && inside.has(f.properties.id) } })) as GeoJSON.Feature[],
    };
    onReady(map, "sigmets", () => geo(map, "sigmets")?.setData(fc));
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
    onReady(map, "radar", () => { radarLayers.current = syncFrames(map, radarLayers.current, frames, display, radarOpacity); });
  }, [radar, radarFrameIndex, radarOpacity, layers.radar, radarSource, radarPlaying]);

  // ---- RainViewer 커버리지 마스크(GAP-15): 레이더가 RainViewer 일 때만. 커버리지 밖 = 회색 베일, 안 · 에코 없음 = 투명 ----
  const coverageHost = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const host = radar?.host ?? null;
    const show = layers.radar && radarSource === "rainviewer" && !!host && (radar?.past.length ?? 0) > 0;
    onReady(map, "rv-coverage", () => {
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
    if (!map) return;
    if (!radarKr?.available || !radarKr.coordinates || radarKr.coordinates.length !== 4) {
      // 서버가 unavailable(프레임 없음·수집 멈춤)이라고 하면 이미 그린 에코를 지운다 — 몇 시간 전 에코를 지금처럼 남기지 않는다(R-11)
      onReady(map, "kma", () => {
        krLayers.current = syncFrames(map, krLayers.current, [], new Map(), 0);
        krCoordsKey.current = "";
      });
      return;
    }
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
    onReady(map, "kma", () => {
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
      vis(SHIP_LAYERS.filter((l) => !l.startsWith("ship-track")), layers.ships);
      vis(SHIP_LAYERS.filter((l) => l.startsWith("ship-track")), layers.ships && layers.tracks);
    });
  }, [layers]);

  // ---- 서버에 켜진 레이어 알림(선박은 켠 세션에만 온다). 선박을 끄면 선택도 해제 ----
  useEffect(() => {
    clientRef.current?.setLayers(layers.aircraft, layers.ships);
    if (!layers.ships && useUi.getState().selectedShip) selectShip(null);
  }, [layers.aircraft, layers.ships, selectShip]);

  // ---- 선박·격자 그리기: 서버 메시지(ships.version)·선택·STALE 재계산(30 s) ----
  useEffect(() => {
    const t = setInterval(() => setShipClock(Date.now()), SHIP_STALE_CHECK_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const now = serverNowMs(Date.now());
    onReady(map, "ships", () => {
      geo(map, "ships")?.setData(ships.mode === "points" ? shipFeatures(shipStates.values(), selectedShip, now) : EMPTY_FC);
      geo(map, "ship-grid")?.setData(ships.mode === "grid" ? gridFeatures(ships.grid) : EMPTY_FC);
    });
  }, [ships, selectedShip, shipClock]);

  // ---- 선택 선박: WS select_ship + 항적(REST 한 번, 이후 ship_selected 로 연장) ----
  useEffect(() => {
    clientRef.current?.selectShip(selectedShip);
    // 이어 붙일 기준: 선택한 순간 알던 선박의 마지막 관측 시각(REST 구간 끝 시각을 서버가 주지 않을 때만 쓴다)
    const lite = selectedShip ? shipStates.get(selectedShip) : undefined;
    const anchor = lite?.seen_at ? Date.parse(lite.seen_at) : NaN;
    const to = serverNowMs(Date.now());
    const from = to - SHIP_TRACK_WINDOW_MS;
    shipTrack.current = emptyShipTrack(selectedShip, Number.isNaN(anchor) ? null : anchor, from);
    setData({ shipTrack: selectedShip ? { mmsi: selectedShip, loaded: false, error: null, gaps: [], gapsTruncated: false, segments: 0, fromMs: from } : null });
    const map = mapRef.current;
    if (!map) return;
    onReady(map, "ship-track", () => geo(map, "ship-track")?.setData(EMPTY_FC));
    if (!selectedShip) return;
    let cancelled = false;
    const finish = (track: ShipTrack, error: string | null) => {
      const ref = shipTrack.current;
      if (cancelled || ref.mmsi !== selectedShip) return;
      // REST 공백(scope 포함)과 상태 공백을 이 선박 위치로 가른다 — 다른 구역의 공백은 이 선박 카드·연결선에 넣지 않는다(계약 v4 §G)
      mergeStatusGaps(track, getData().ais, ref.sinceMs, shipPos(selectedShip));
      for (const p of ref.pending) appendShipTrack(track, p, ref.anchor);
      shipTrack.current = { ...ref, track, pending: [], loaded: true };
      setData({ shipTrack: { mmsi: selectedShip, loaded: true, error, gaps: track.gaps.slice(), gapsTruncated: track.gapsTruncated === true, segments: track.segs.length, fromMs: from } });
      onReady(map, "ship-track", () => geo(map, "ship-track")?.setData(shipTrackFeatures(track)));
    };
    const q = `from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`;
    apiGet<unknown>(`/api/v1/ships/${encodeURIComponent(selectedShip)}/track?${q}`)
      .then((r) => finish(shipTrackFromRest(r), null))
      .catch((e: Error) => finish({ segs: [], gaps: [] }, String(e.message))); // 기록이 없거나 DB 장애 → 실시간 관측만으로 잇는다
    return () => { cancelled = true; };
  }, [selectedShip]);

  useEffect(() => {
    const map = mapRef.current;
    const ref = shipTrack.current;
    const st = shipSelected?.state;
    if (!map || !shipSelected || shipSelected.mmsi !== ref.mmsi || !st?.seen_at) return;
    const ts = Date.parse(st.seen_at);
    if (Number.isNaN(ts)) return;
    const p = { ts, lon: st.lon, lat: st.lat };
    if (!ref.loaded) { if (ref.pending.length < SHIP_PENDING_MAX) ref.pending.push(p); return; }
    const segs = ref.track.segs.length;
    const merged = mergeStatusGaps(ref.track, getData().ais, ref.sinceMs, { lat: st.lat, lon: st.lon });
    const appended = appendShipTrack(ref.track, p, ref.anchor);
    if (merged || appended) onReady(map, "ship-track", () => geo(map, "ship-track")?.setData(shipTrackFeatures(ref.track)));
    if (merged || ref.track.segs.length !== segs) publishShipTrack(ref);
  }, [shipSelected]);

  // ---- AIS 상태가 바뀌면(공백 열림·닫힘) 선택 선박 항적의 공백 목록도 바로 고친다 — 닫힌 공백을 "진행 중"으로 남기지 않는다 ----
  useEffect(() => {
    const map = mapRef.current;
    const ref = shipTrack.current;
    if (!map || !ref.mmsi || !ref.loaded || !mergeStatusGaps(ref.track, ais, ref.sinceMs, shipPos(ref.mmsi))) return;
    onReady(map, "ship-track", () => geo(map, "ship-track")?.setData(shipTrackFeatures(ref.track)));
    publishShipTrack(ref);
  }, [ais]);

  // ---- 선박 수신 범위(계약 v3 §A): 선박 레이어가 켜져 있고 status 가 범위를 줄 때만 경계 점선. 모르면 그리지 않는다 ----
  const coverageKey = useRef("");
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

  // ---- 선택 항공기: WS select + 항적(REST 한 번, 이후 selected 로 연장) ----
  useEffect(() => {
    clientRef.current?.select(selectedHex);
    workerRef.current?.postMessage({ type: "invalidate" }); // 선택 강조를 바로 다시 그린다
    track.current = { hex: selectedHex, pts: [], pending: [], loaded: false };
    const map = mapRef.current;
    if (!map) return;
    onReady(map, "tracks", () => { geo(map, "tracks")?.setData(EMPTY_FC); refreshPrediction.current(); });
    if (!selectedHex) return;
    let cancelled = false;
    const finish = (rest: TrackPt[]) => {
      if (cancelled || track.current.hex !== selectedHex) return;
      const pts = mergeTrack(rest, track.current.pending);
      track.current = { hex: selectedHex, pts, pending: [], loaded: true };
      onReady(map, "tracks", () => geo(map, "tracks")?.setData(trackFeatureCollection(pts)));
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
    if (appendTrackPoint(t.pts, p)) onReady(map, "tracks", () => geo(map, "tracks")?.setData(trackFeatureCollection(t.pts)));
  }, [selectedInfo]);

  return (
    <>
      <div ref={el} className="h-full w-full" data-testid="map" />
      {basemapFailed ? (
        <div className="pointer-events-none absolute bottom-10 left-3 z-10 border border-line-2 bg-bg-1/90 px-2 py-1 text-[11px] text-warn" role="status" data-testid="basemap-failed">
          배경지도를 불러오지 못함 — 항공기·기상 데이터는 계속 수신·표시합니다(새로고침하면 다시 시도)
        </div>
      ) : null}
    </>
  );
}
