"use client";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import { addBaseLayers, RADAR_SLOT, STYLE_URL } from "@/lib/maplayers";
import { maplibre } from "@/lib/maplibre";
import { watchBasemapStyle } from "@/lib/basemap-fallback";
import { addShipLayers, SHIP_LAYERS } from "@/lib/ship-layers";
import { useUi } from "@/lib/ui-store";
import { mapAttributionHtml, styleHasBasemapCredit } from "@/lib/attribution";
import { mapAttributionControl } from "@/lib/map-attribution";
import { onReady, setDashboardMap, useDashboardMap } from "@/lib/map-ready";
import { addTrafficGridLayers, TRAFFIC_LAYERS } from "@/lib/traffic-grid";

const REGION_CENTER: [number, number] = [127.8, 36.5];

/**
 * 상황판 지도의 수명(web-review §3.2 — MapView 에서 뗀 묶음): el 에 MapLibre 지도를 만들고 상황판 지도 손잡이(lib/map-ready)에 알린다 — 다른 Hook ·
 * 나중에 받는 레이어 조각은 그 손잡이로 지도를 받는다. 화면을 떠나면 손잡이를 비운 뒤 지도를 지운다(조각이 지운 지도에 그리지 않게).
 * - 배경지도 스타일(외부 호스트)을 받지 못하면(오류 · STYLE_LOAD_TIMEOUT_MS) 로컬 최소 스타일로 한 번 바꾸고 알린다(R-01). 받으면 알려진 층의 색만 바꾼다(계약 v4 §E).
 * - 'load' 에서: onFirstLoad(상황판의 미리 받기 — ADR-026), 기본 · 선박 · 연안 교통량 레이어, 출처 표기(compact ⓘ — FR-20).
 * - 레이어 단추에 따른 기본 레이어 보이기, 검색 등이 요청한 지도 이동(움직임 줄이기 설정이면 바로).
 * 돌려주는 것: 지금 지도(손잡이 — 만들기 전 · 떠난 뒤 null).
 */
export function useMapLifecycle(el: RefObject<HTMLDivElement | null>, onFirstLoad?: () => void): maplibregl.Map | null {
  const firstLoad = useEffectEvent(() => onFirstLoad?.());
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
    setDashboardMap(map); // 다른 Hook 과 켤 때 받는 레이어 조각(관측 수신 범위)이 이 지도에 그린다
    // R-01: 배경지도 스타일(외부 호스트)을 받지 못하면(오류 · 시간 제한) 로컬 최소 스타일로 한 번 바꾸고 화면에 알린다 · 받으면 알려진 층의 색만 바꾼다(lib/basemap-fallback).
    // 알림은 지도 위 왼쪽 상태 칸(MapChips — LayerPanel 의 배치 안)이 그린다: 레이어 단추 줄 · 칩과 겹치지 않게 한 배치로
    const basemap = watchBasemapStyle(map, () => useUi.getState().setBasemapFailed(true));
    map.getCanvas().setAttribute("aria-label", "실시간 항공기·위험기상 지도. 화살표 키로 이동, +/- 로 확대. 항공기는 상단 검색(/)으로 선택할 수 있습니다.");

    map.on("load", () => {
      firstLoad();
      addBaseLayers(map);
      addShipLayers(map);
      addTrafficGridLayers(map, RADAR_SLOT); // 연안 교통량(ADR-023) — 레이더 · SIGMET · 항공기 · 선박 아래
      // 출처(FR-20): 스타일이 배경지도 크레딧을 이미 붙였으면 중복하지 않는다. 배경지도를 못 받았으면(대체 스타일) 배경지도 크레딧을 붙이지 않는다.
      // 데이터 출처는 항상 전부(OpenSky·기상청 포함).
      const styleCredits = Object.keys(map.getStyle().sources ?? {}).map((id) => (map.getSource(id) as { attribution?: string } | undefined)?.attribution);
      // 지도 위 표기는 compact(ⓘ) — 좁은 지도에서는 접힌 채로 시작한다. 전체 출처는 화면 아래 SOURCES 줄에 늘 보인다(lib/map-attribution)
      map.addControl(mapAttributionControl(ml, mapAttributionHtml({ includeMap: !basemap.failed && !styleHasBasemapCredit(styleCredits) })), "bottom-right");
    });

    return () => {
      useUi.getState().setBasemapFailed(false); // 떠난 지도의 상태를 남기지 않는다
      basemap.dispose();
      setDashboardMap(null); // 지우기 전에 — 조각이 지운 지도에 그리지 않게
      map.remove();
    };
  }, [el]);

  const map = useDashboardMap();
  const layers = useUi((s) => s.layers);
  const flyTo = useUi((s) => s.flyTo);
  /** 마운트 전에 처리된 이동 요청은 다시 하지 않는다(다른 화면에서 돌아올 때) */
  const flyHandled = useRef(useUi.getState().flyTo?.id ?? 0);

  // ---- 검색 등에서 요청한 지도 이동(움직임 줄이기 설정이면 바로 이동) ----
  useEffect(() => {
    if (!map || !flyTo || flyTo.id <= flyHandled.current) return;
    flyHandled.current = flyTo.id;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const opts = { center: [flyTo.lon, flyTo.lat] as [number, number], zoom: Math.max(map.getZoom(), flyTo.zoom) };
    onReady(map, "fly", () => (reduce ? map.jumpTo(opts) : map.flyTo({ ...opts, duration: 1200, essential: true })));
  }, [map, flyTo]);

  // ---- 레이어 토글 ----
  useEffect(() => {
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
  }, [map, layers]);

  return map;
}
