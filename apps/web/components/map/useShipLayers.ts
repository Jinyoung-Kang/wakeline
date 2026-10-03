"use client";
import type * as GeoJSON from "geojson";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { getData, serverNowMs, setData, shipStates, useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { onReady } from "@/lib/map-ready";
import { shipCategoryFilter } from "@/lib/ship-layers";
import { aisCoverageFeatures, filterGridCells, gridFeatures, selectedShipFeatures, shipCategory, shipFeatures } from "@/lib/ships";
import { trafficDrawable, TrafficGridPoller, trafficGridFeatures, trafficStaleAt } from "@/lib/traffic-grid";

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
/** 선박 STALE(> 15분) 재계산 주기 — 새 메시지가 없어도 오래된 선박을 반투명으로 */
const SHIP_STALE_CHECK_MS = 30_000;

function geo(map: maplibregl.Map, id: string) {
  return map.getSource(id) as maplibregl.GeoJSONSource | undefined;
}

/**
 * 상황판 지도의 선박 레이어(web-review §3.2 — MapView 에서 뗀 묶음): 선박 점 · 격자(선종 필터로 다시 센 칸), 선택 선박의 고리 · 라벨, 점 모드의 선종 필터,
 * AIS 수신 범위 외곽선, 연안 교통량 격자(ADR-023 — 켜져 있을 때만 조회). 그린 수신 범위의 키는 그 지도와 함께 둔다(다른 지도면 다시 그린다 — web-review B8).
 */
export function useShipLayers(map: maplibregl.Map | null): void {
  const ships = useServerData((d) => d.ships);
  const shipSelected = useServerData((d) => d.shipSelected);
  const ais = useServerData((d) => d.ais);
  const trafficVersion = useServerData((d) => d.trafficGrid.version);
  const layers = useUi((s) => s.layers);
  const selectedShip = useUi((s) => s.selectedShip);
  const shipCats = useUi((s) => s.shipCats);
  const [shipClock, setShipClock] = useState(0);
  /** 이 지도에 그린 AIS 수신 범위(그 지도와 키) */
  const coverageDrawn = useRef<{ map: maplibregl.Map | null; key: string }>({ map: null, key: "" });

  // ---- 연안 교통량(ADR-023): 켜져 있을 때만 조회(90 s · ETag · 숨긴 탭 제외 · 다시 보이면 곧바로). 지도는 내용이 바뀔 때(version)만 다시 그리고,
  // 끄면 칸을 비운다. 받아 둔 값이 이 시계로 오래되면(regDt + stale_after_s) 그리지 않고, 그리는 중이면 그 순간 비운다 — 조회가 실패해 api 가 '멈춤'을
  // 말할 수 없을 때도 지난 칸을 지금처럼 두지 않는다 ----
  useEffect(() => {
    if (!layers.traffic) return;
    const poller = new TrafficGridPoller((s) => setData({ trafficGrid: s }), getData().trafficGrid);
    poller.start();
    return () => poller.stop();
  }, [layers.traffic]);
  useEffect(() => {
    if (!map) return;
    const g = getData().trafficGrid.data;
    const now = serverNowMs(Date.now());
    const draw = layers.traffic === true && trafficDrawable(g, now);
    onReady(map, "traffic-grid", () => geo(map, "traffic-grid")?.setData(draw ? trafficGridFeatures(g.cells) : EMPTY_FC));
    const at = draw ? trafficStaleAt(g) : null;
    if (at == null) return;
    const t = setTimeout(() => onReady(map, "traffic-grid", () => geo(map, "traffic-grid")?.setData(EMPTY_FC)), Math.max(0, at - now) + 50);
    return () => clearTimeout(t);
  }, [map, trafficVersion, layers.traffic]);

  // ---- 선박·격자 그리기: 서버 메시지(ships.version)·선택·STALE 재계산(30 s) ----
  useEffect(() => {
    const t = setInterval(() => setShipClock(Date.now()), SHIP_STALE_CHECK_MS);
    return () => clearInterval(t);
  }, []);
  // 격자는 선종 필터(계약 v5 §B3)로 칸 수를 다시 센다 — 선종별 수가 없는 칸(구 서버)은 그대로(칸 툴팁·칩이 밝힌다)
  useEffect(() => {
    if (!map) return;
    const now = serverNowMs(Date.now());
    const enabled = new Set(shipCats);
    onReady(map, "ships", () => {
      geo(map, "ships")?.setData(ships.mode === "points" ? shipFeatures(shipStates.values(), selectedShip, now) : EMPTY_FC);
      geo(map, "ship-grid")?.setData(ships.mode === "grid" ? gridFeatures(filterGridCells(ships.grid, enabled).cells) : EMPTY_FC);
    });
  }, [map, ships, selectedShip, shipClock, shipCats]);

  // ---- 선택 선박(계약 v5 §B3): 격자 모드·선종 필터와 상관없이 고리 + 라벨(선박 기호가 그리지 않으면 아이콘도). 위치를 모르면 그리지 않는다 ----
  useEffect(() => {
    if (!map) return;
    const listed = selectedShip ? shipStates.get(selectedShip) ?? null : null;
    const live = shipSelected && shipSelected.mmsi === selectedShip ? shipSelected.state : null;
    const symbolDraws = ships.mode === "points" && listed != null && shipCats.includes(shipCategory(listed.ship_type));
    const staticName = shipSelected && shipSelected.mmsi === selectedShip ? shipSelected.static?.name ?? null : null;
    const fc = selectedShipFeatures(selectedShip, live, listed, symbolDraws, serverNowMs(Date.now()), staticName);
    onReady(map, "ship-selected", () => geo(map, "ship-selected")?.setData(fc));
  }, [map, ships, selectedShip, shipSelected, shipClock, shipCats]);

  // ---- 선종 필터(계약 v5 §B3): 점 모드는 MapLibre filter(모두 켜져 있으면 없음) ----
  useEffect(() => {
    if (!map) return;
    const filter = shipCategoryFilter(new Set(shipCats));
    onReady(map, "ship-filter", () => { if (map.getLayer("ship-symbol")) map.setFilter("ship-symbol", filter); });
  }, [map, shipCats]);

  // ---- 선박 수신 범위(계약 v3 §A): 선박 레이어가 켜져 있고 status 가 범위를 줄 때만 경계 점선. 모르면 그리지 않는다 ----
  const coverage = ais?.coverage ?? null;
  useEffect(() => {
    if (!map) return;
    const fc = layers.ships ? aisCoverageFeatures(coverage) : EMPTY_FC;
    const key = JSON.stringify(fc.features.map((f) => f.geometry));
    if (coverageDrawn.current.map === map && coverageDrawn.current.key === key) return;
    coverageDrawn.current = { map, key };
    onReady(map, "ship-coverage", () => geo(map, "ship-coverage")?.setData(fc));
  }, [map, coverage, layers.ships]);
}
