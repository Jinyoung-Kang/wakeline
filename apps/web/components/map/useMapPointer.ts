"use client";
import type * as maplibregl from "maplibre-gl";
import { useEffect } from "react";
import { maplibre } from "@/lib/maplibre";
import { aircraftStates, getData, serverNowMs, shipStates } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { layerTip, onReady } from "@/lib/map-ready";
import { renderTip, type AirportProps } from "@/lib/tooltip";
import { clickAction, hoverKey as pointKey, pickByPriority, tipFor, visiblePickLayers, type TipContext } from "@/lib/map-pointer";

/** 지금 그린 감시 공항(공항 툴팁이 이름 · 관측을 찾는다) — 기상 레이어 Hook 이 채운다 */
export type AirportFeatures = { readonly current: GeoJSON.Feature<GeoJSON.Point, AirportProps>[] };

/**
 * 상황판 지도의 포인터(web-review §3.2 — MapView 에서 뗀 묶음): 호버 툴팁과 클릭. 무엇을 고르고 무엇을 보일지는 lib/map-pointer(순수 규칙),
 * 이 Hook 은 지도 이벤트 · 팝업 · rAF 만 맡는다.
 * - 호버 툴팁(GAP-26): 항공기 > 선박 > 선박 격자 > 공항 > SIGMET. rAF 로 묶어 이동당 한 번만 조회. 내용은 텍스트 노드로만(lib/tooltip renderTip).
 *   같은 지점이면 1 s 안에는 다시 만들지 않고 위치만 옮긴다.
 * - 클릭: 항공기 · 선박 · 공항 · SIGMET 선택, 격자 칸은 그 칸으로 확대(움직임 줄이기 설정이면 바로), 빈 곳은 선택 해제(이미 선택된 선박 · 그 항적은 그대로).
 * - 처리기는 기본 레이어가 준비된 뒤(load) 단다 — 그 전의 클릭이 선택을 지우지 않게. 지도가 바뀌거나 화면을 떠나면 떼고 팝업 · rAF 를 정리한다.
 */
export function useMapPointer(map: maplibregl.Map | null, airports: AirportFeatures): void {
  useEffect(() => {
    if (!map) return;
    /** 보이는 레이어에서 우선순위대로 한 개(lib/map-pointer) */
    const pick = (pt: maplibregl.PointLike) => {
      const present = visiblePickLayers(map);
      return present.length ? pickByPriority(map.queryRenderedFeatures(pt, { layers: present })) : null;
    };
    /** 툴팁에 쓰는 지금 값 */
    const tipContext = (now: number): TipContext => {
      const d = getData();
      return {
        now, selected: d.selected, aircraft: aircraftStates, ships: shipStates, shipSelected: d.shipSelected, selectedShip: useUi.getState().selectedShip,
        airports: airports.current, sigmets: d.sigmets, shipsCellDeg: d.ships.cell_deg, trafficGrid: d.trafficGrid.data, layerTip,
      };
    };
    const popup = new (maplibre().Popup)({ closeButton: false, closeOnClick: false, className: "wakeline-tip", offset: 14, maxWidth: "320px" });
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
      const now = serverNowMs(Date.now());
      const key = pointKey(f);
      if (key !== hoverKey || now - hoverAt > 1000) {
        const tip = tipFor(f.layer.id, (f.properties ?? {}) as Record<string, unknown>, tipContext(now));
        if (!tip) { popup.remove(); hoverKey = ""; return; }
        popup.setDOMContent(renderTip(tip));
        hoverKey = key;
        hoverAt = now;
      }
      popup.setLngLat(e.lngLat);
      if (!popup.isOpen()) popup.addTo(map);
    };
    const onMove = (e: maplibregl.MapMouseEvent) => { hoverEvt = e; if (!hoverRaf) hoverRaf = requestAnimationFrame(doHover); };
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const ui = useUi.getState();
      const a = clickAction(pick(e.point), map.getZoom()); // lib/map-pointer — 이미 선택된 선박 · 그 항적은 그대로(keep)
      if (a.kind === "aircraft") ui.select(a.hex);
      else if (a.kind === "ship") ui.selectShip(a.mmsi);
      else if (a.kind === "zoom") {
        // 격자 칸을 누르면 그 칸으로 확대(움직임 줄이기 설정이면 바로)
        const opts = { center: a.center, zoom: a.zoom };
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        if (reduce) map.jumpTo(opts); else map.easeTo({ ...opts, duration: 800, essential: true });
      } else if (a.kind === "airport") ui.selectAirport(a.icao);
      else if (a.kind === "sigmet") ui.selectSigmet(a.id);
      else if (a.kind === "clear") { ui.select(null); ui.selectShip(null); } // 빈 곳 클릭 = 선택 해제(집중 추적도 멈춘다)
    };
    let live = true;
    onReady(map, "pointer", () => {
      if (!live) return;
      map.on("mousemove", onMove);
      map.on("mouseout", hideTip);
      map.on("dragstart", hideTip);
      map.on("click", onClick);
    });
    return () => {
      live = false;
      map.off("mousemove", onMove);
      map.off("mouseout", hideTip);
      map.off("dragstart", hideTip);
      map.off("click", onClick);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      popup.remove();
    };
  }, [map, airports]);
}
