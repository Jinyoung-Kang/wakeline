"use client";
import type * as GeoJSON from "geojson";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { airportLayerFeatures, COVERAGE_PAINT, coverageTileUrl, frameDisplay, RADAR_SLOT, radarTileUrl, syncFrames, type Frame } from "@/lib/maplayers";
import { getData, serverNowMs, setData, useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { sigmetLayerData } from "@/lib/sigmet";
import { krLayerId, parseKrRadar } from "@/lib/kr-radar";
import { reportClientError } from "@/lib/errorReport";
import { onReady } from "@/lib/map-ready";
import { EtagPoller, POLL_NONE } from "@/lib/etag-poller";
import type { AirportProps } from "@/lib/tooltip";
import type { KrRadar, SigmetCollection } from "@/lib/types";
import type { AirportFeatures } from "./useMapPointer";

/** SIGMET 만료 재검사 주기(새 메시지가 없어도 만료된 경보를 지운다) */
const SIGMET_EXPIRY_CHECK_MS = 30_000;
/** 공항 비행 카테고리 레이어 재조회(GAP-14). collector METAR 주기(10분)보다 짧게. 경과(오래됨) 재계산은 1분마다 — 다시 보일 때는 마지막 확인이 그보다 오래면 곧바로 */
const AIRPORTS_REFRESH_MS = 300_000;
const AIRPORTS_RECHECK_MS = 60_000;
/** 기상청 레이더 재조회 · 다시 보일 때 곧바로 부르지 않는 간격(탭을 빨리 오갈 때 몰아 부르지 않게 — 연안 교통량 · 관측 수신 범위와 같다) */
const KR_POLL_MS = 60_000;
const KR_VISIBLE_MIN_GAP_MS = 10_000;
type Airport = GeoJSON.Feature<GeoJSON.Point, AirportProps>;
/** 감시 공항 응답(GeoJSON) → 그릴 수 있는 지점. 모양이 틀리면 null — 조회기가 마지막 목록을 둔다(전에는 비웠다) */
const parseAirports = (fc: unknown): Airport[] | null => {
  const features = typeof fc === "object" && fc !== null ? (fc as { features?: unknown }).features : null;
  return Array.isArray(features) ? features.filter((f): f is Airport => typeof f?.properties?.icao === "string") : null;
};

function geo(map: maplibregl.Map, id: string) {
  return map.getSource(id) as maplibregl.GeoJSONSource | undefined;
}

/**
 * '이 지도에 그린 것'의 기록(SIGMET 컬렉션 · 키, 레이더 · 기상청 프레임 레이어, 기상청 경계 키, RainViewer 커버리지 host) — 그린 지도와 함께 둔다:
 * 다른 지도(StrictMode 의 두 번째 마운트 · 다시 마운트)에는 아무것도 그려져 있지 않으므로 빈 기록에서 시작한다(web-review B8 — 남기면 '이미 그림'으로 건너뛰었다).
 */
interface Drawn { map: maplibregl.Map | null; sigmet: { fc: SigmetCollection | null; key: string }; radar: string[]; kma: string[]; kmaCoords: string; rvHost: string | null }
const nothingDrawn = (map: maplibregl.Map | null): Drawn => ({ map, sigmet: { fc: null, key: "" }, radar: [], kma: [], kmaCoords: "", rvHost: null });
/** 그 지도의 기록 — 다른 지도의 것이면 빈 기록으로 바꾼다 */
function drawnOn(ref: { current: Drawn }, map: maplibregl.Map): Drawn {
  if (ref.current.map !== map) ref.current = nothingDrawn(map);
  return ref.current;
}

/**
 * 상황판 지도의 기상 레이어(web-review §3.2 — MapView 에서 뗀 묶음): SIGMET(만료 제외 · 발효 전 구분 · 안에 항공기가 있는 경보 강조), RainViewer 레이더와
 * 커버리지 베일, 기상청 레이더(재투영 PNG), 감시 공항(비행 카테고리 · 오래됨). 기상청 레이더 · 감시 공항은 조회기(lib/etag-poller)로 받는다.
 * 돌려주는 것: 지금 그린 감시 공항(공항 툴팁 — useMapPointer).
 */
export function useWeatherLayers(map: maplibregl.Map | null): AirportFeatures {
  const sigmets = useServerData((d) => d.sigmets);
  const alerts = useServerData((d) => d.alerts);
  const radar = useServerData((d) => d.radar);
  const radarKr = useServerData((d) => d.radarKr);
  const layers = useUi((s) => s.layers);
  const radarSource = useUi((s) => s.radarSource);
  const radarFrameIndex = useUi((s) => s.radarFrameIndex);
  const krFrameIndex = useUi((s) => s.krFrameIndex);
  const radarOpacity = useUi((s) => s.radarOpacity);
  const radarPlaying = useUi((s) => s.radarPlaying);
  const [sigClock, setSigClock] = useState(0);
  const drawn = useRef<Drawn>(nothingDrawn(null));
  /** 지금 그린 감시 공항 — 공항 툴팁(포인터 Hook)이 읽는다. 지도마다 비우고 조회기가 채운다 */
  const airports = useRef<Airport[]>([]);

  // ---- 기상청 레이더 · 감시 공항 조회 + 공항 레이어(GAP-14): 5분마다 재조회, 1분마다 METAR 경과로 "오래됨"(> 2 h) 재계산 ----
  // 조회기(lib/etag-poller): 진행 중이면 겹쳐 부르지 않고(응답이 멈추면 쌓였다 — web-review B9), 숨긴 탭에서는 부르지 않으며, 다시 보이면 곧바로 부른다.
  // 실패하거나 본문이 틀리면 마지막 값을 둔다. 내용이 바뀌었을 때(version)만 store · 지도에 넣는다.
  // 레이더 본문은 parseKrRadar 로 검사한다(web-review B10) — 읽을 수 없으면 WS 처럼 보고한다(시스템 로그 web-client)
  useEffect(() => {
    if (!map) return;
    airports.current = [];
    let airportsKey = "";
    const applyAirports = () => {
      const src = geo(map, "airports");
      if (!src) return;
      const { features, key } = airportLayerFeatures(airports.current, serverNowMs(Date.now()));
      if (key === airportsKey) return;
      airportsKey = key;
      src.setData({ type: "FeatureCollection", features });
    };
    let krSeen = 0;
    const krPoller = new EtagPoller<KrRadar>({
      url: "/api/v1/radar/kr", intervalMs: KR_POLL_MS, visibleMinGapMs: KR_VISIBLE_MIN_GAP_MS,
      parse: (body) => {
        const d = parseKrRadar(body);
        if (!d) reportClientError({ message: "rest: malformed /api/v1/radar/kr body ignored — the last value is kept", component: "components/MapView.tsx" });
        return d;
      },
    }, (st) => { if (st.version !== krSeen) { krSeen = st.version; setData({ radarKr: st.data }); } }, { ...POLL_NONE, data: getData().radarKr });
    let apSeen = 0;
    const apPoller = new EtagPoller({
      url: "/api/v1/airports?watched=true", accept: "application/geo+json, application/json", parse: parseAirports,
      intervalMs: AIRPORTS_REFRESH_MS, visibleMinGapMs: AIRPORTS_RECHECK_MS,
    }, (st) => {
      if (st.version !== apSeen) { apSeen = st.version; airports.current = st.data ?? []; }
      applyAirports(); // 실패해도 — 마지막 값의 경과로 "오래됨"을 드러낸다
    });
    krPoller.start();
    apPoller.start();
    const apTimer = setInterval(() => { if (!document.hidden) applyAirports(); }, AIRPORTS_RECHECK_MS);
    onReady(map, "airports", applyAirports);
    return () => {
      krPoller.stop();
      apPoller.stop();
      clearInterval(apTimer);
    };
  }, [map]);

  // ---- SIGMET 만료 재검사 타이머 ----
  useEffect(() => {
    const tick = () => setSigClock(Date.now());
    const t = setInterval(tick, SIGMET_EXPIRY_CHECK_MS);
    const raf = requestAnimationFrame(tick);
    return () => { clearInterval(t); cancelAnimationFrame(raf); };
  }, []);

  // ---- SIGMET 갱신(만료 제외 · 발효 전 구분) + 안에 항공기가 있는 경보 강조 ----
  useEffect(() => {
    if (!map || !sigmets) return;
    // 같은 컬렉션·같은 강조·같은 만료/발효 결과면 다시 넣지 않는다(알림 배치마다 폴리곤 전체 재색인 방지 — lib/sigmet sigmetLayerData 의 key)
    const { fc, key } = sigmetLayerData(sigmets, alerts.values(), serverNowMs(sigClock || Date.now()));
    const d = drawnOn(drawn, map);
    if (d.sigmet.fc === sigmets && d.sigmet.key === key) return;
    d.sigmet = { fc: sigmets, key };
    onReady(map, "sigmets", () => geo(map, "sigmets")?.setData(fc));
  }, [map, sigmets, alerts, sigClock]);

  // ---- 레이더(PERF-12): 현재 프레임만 visible, 재생 중에는 다음 프레임을 불투명도 0 으로 미리 받는다. 소스는 필요할 때 만든다. ----
  useEffect(() => {
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
    onReady(map, "radar", () => { const d = drawnOn(drawn, map); d.radar = syncFrames(map, d.radar, frames, display, radarOpacity); });
  }, [map, radar, radarFrameIndex, radarOpacity, layers.radar, radarSource, radarPlaying]);

  // ---- RainViewer 커버리지 마스크(GAP-15): 레이더가 RainViewer 일 때만. 커버리지 밖 = 회색 베일, 안 · 에코 없음 = 투명 ----
  useEffect(() => {
    if (!map) return;
    const host = radar?.host ?? null;
    const show = layers.radar && radarSource === "rainviewer" && !!host && (radar?.past.length ?? 0) > 0;
    onReady(map, "rv-coverage", () => {
      const d = drawnOn(drawn, map);
      if (d.rvHost && d.rvHost !== host && map.getSource("rv-coverage")) {
        map.removeLayer("rv-coverage"); map.removeSource("rv-coverage"); d.rvHost = null;
      }
      if (show && host && !map.getSource("rv-coverage")) {
        map.addSource("rv-coverage", { type: "raster", tiles: [coverageTileUrl(host)], tileSize: 512, maxzoom: 7 });
        map.addLayer({ id: "rv-coverage", type: "raster", source: "rv-coverage", layout: { visibility: "none" }, paint: { ...COVERAGE_PAINT } }, RADAR_SLOT);
        d.rvHost = host;
      }
      if (map.getLayer("rv-coverage")) map.setLayoutProperty("rv-coverage", "visibility", show ? "visible" : "none");
    });
  }, [map, radar, layers.radar, radarSource]);

  // ---- 기상청 레이더(FR-31): 재투영된 PNG 를 image source 로. 좌표는 서버가 문서 기반 LCC 정의로 계산한 웹 메르카토르 경계 ----
  // image source 는 추가하는 순간 PNG 를 받으므로 보일 프레임만 지연 추가한다(PERF-12). 경계가 바뀌면 다시 만든다.
  useEffect(() => {
    if (!map) return;
    if (!radarKr?.available || !radarKr.coordinates || radarKr.coordinates.length !== 4) {
      // 서버가 unavailable(프레임 없음·수집 멈춤)이라고 하면 이미 그린 에코를 지운다 — 몇 시간 전 에코를 지금처럼 남기지 않는다(R-11)
      onReady(map, "kma", () => {
        const d = drawnOn(drawn, map);
        d.kma = syncFrames(map, d.kma, [], new Map(), 0);
        d.kmaCoords = "";
      });
      return;
    }
    const c = radarKr.coordinates;
    const coords: [[number, number], [number, number], [number, number], [number, number]] = [c[0], c[1], c[2], c[3]];
    const display = frameDisplay(radarKr.frames.length, krFrameIndex, layers.radar && radarSource === "kma", radarPlaying);
    // 레이어 id 에 영상 버전(?v=)을 붙인다 — 부분 합성 프레임을 다시 받아 바꾸면(ADR-021) 새 영상이 새 레이어로 그려지고 옛 영상 레이어는 지운다
    const frames: Frame[] = radarKr.frames.map((f) => ({
      id: krLayerId(f),
      add: (m) => {
        const id = krLayerId(f);
        m.addSource(id, { type: "image", url: f.url, coordinates: coords });
        m.addLayer({ id, type: "raster", source: id, layout: { visibility: "none" }, paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: 150 }, "raster-resampling": "nearest" } }, "sigmet-fill");
      },
    }));
    const key = JSON.stringify(coords);
    onReady(map, "kma", () => {
      const d = drawnOn(drawn, map);
      if (d.kmaCoords && d.kmaCoords !== key) {
        for (const id of d.kma) { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); }
        d.kma = [];
      }
      d.kmaCoords = key;
      d.kma = syncFrames(map, d.kma, frames, display, Math.min(1, radarOpacity + 0.25));
    });
  }, [map, radarKr, krFrameIndex, radarSource, radarOpacity, layers.radar, radarPlaying]);

  return airports;
}
