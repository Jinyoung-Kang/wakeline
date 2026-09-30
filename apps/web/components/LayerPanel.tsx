"use client";
import { useEffect } from "react";
import { legendDefaultOpen, loadLayers, loadShipCats, saveLayers } from "@/lib/prefs";
import { SHIP_CATEGORIES, type ShipCategory } from "@/lib/ships";
import { useUi, type Layers } from "@/lib/ui-store";
import { MapChipsView } from "./MapChips";
import { MapLegend } from "./MapLegend";
import { TrafficGridStatus } from "./TrafficGridStatus";
import { ReceptionStatusPart } from "./DashboardParts";
import { TRAFFIC_LAYER_LABEL } from "@/lib/traffic-grid";
import { RECEPTION_LAYER_LABEL } from "@/lib/reception-meta";

const ITEMS: { k: keyof Layers; label: string }[] = [
  { k: "radar", label: "레이더" }, { k: "sigmet", label: "SIGMET" }, { k: "aircraft", label: "항공기" }, { k: "ships", label: "선박" },
  { k: "reception", label: RECEPTION_LAYER_LABEL }, // ADR-027 — 이 서비스가 최근 24 h 에 실제로 선박 위치를 받은 0.5° 칸(기본 끔 · 켤 때 조각을 받는다)
  { k: "airports", label: "공항" }, { k: "tracks", label: "항적" }, { k: "prediction", label: "예측(추정)" },
  { k: "traffic", label: TRAFFIC_LAYER_LABEL }, // ADR-023 — 5분 집계 격자별 선박 척수(기본 끔)
];
const LEGEND_KEY = "wakeline.legend";
const LEGEND_ID = "map-legend";

/**
 * 지도 위 겹쳐 그리는 것의 배치 한 곳 + 레이어 토글 + 접을 수 있는 범례(GAP-13).
 * 배치(2026-09-30 — 레이어 단추 줄과 왼쪽 위 선박 칩이 따로 absolute 로 같은 높이에 있어 1024 · 1280 px 에서 단추가 칩을 덮었다):
 *   1줄 = 레이어 단추(오른쪽 정렬, 줄바꿈) · 그 아래 두 칸 = 왼쪽 상태 칸(배경지도 실패 알림 · 수요 칩 · 선박 칩 — MapChips) | 오른쪽(교통량 상태 · 관측 수신 범위 상태 · 범례).
 *   단추 줄이 두 줄이 되어도 아래 칸이 함께 내려가므로 서로 덮지 않는다. 왼쪽 칸은 폭의 절반까지, 오른쪽 칸은 범례 폭(264 px)까지. 레이어 켜짐(항공기·선박 포함, 계약 v2 §B4)·범례 열림 여부·선종 필터(계약 v5 §B3)는 이 브라우저에만 기억한다
 * (localStorage, 읽기·쓰기 실패해도 기본값으로 동작 — lib/prefs.ts). 저장된 선택이 없으면 넓은 화면에서만 범례를 펼친다.
 * 버튼 줄은 지도 안(왼쪽 확대 버튼 옆까지)에서 줄바꿈한다 — 좁은 화면에서 화면 밖으로 나가지 않게(R-39).
 */
export function LayerPanel() {
  const layers = useUi((s) => s.layers);
  const setLayers = useUi((s) => s.setLayers);
  const legendOpen = useUi((s) => s.legendOpen);
  const setLegendOpen = useUi((s) => s.setLegendOpen);
  const shipCats = useUi((s) => s.shipCats);
  const setShipCats = useUi((s) => s.setShipCats);
  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(LEGEND_KEY); } catch { /* 저장소 없음 */ }
    setLegendOpen(stored === "0" || stored === "1" ? stored === "1" : legendDefaultOpen(window.innerWidth));
    const saved = loadLayers();
    if (saved) setLayers(saved);
    const cats = loadShipCats();
    if (cats) setShipCats(cats);
  }, [setLegendOpen, setLayers, setShipCats]);
  return <LayerPanelView layers={layers} shipCats={shipCats} legendOpen={legendOpen} />;
}

/** 표시 부분(레이어·선종 필터·범례 열림을 인자로 — 서버 렌더 시험용) */
export function LayerPanelView({ layers, shipCats, legendOpen }: { layers: Layers; shipCats: readonly ShipCategory[]; legendOpen: boolean }) {
  const toggleLayer = useUi((s) => s.toggleLayer);
  const setLegendOpen = useUi((s) => s.setLegendOpen);
  const hex = useUi((s) => s.selectedHex);
  const basemapFailed = useUi((s) => s.basemapFailed);
  const toggle = (k: keyof Layers) => {
    toggleLayer(k);
    saveLayers(useUi.getState().layers);
  };
  const flip = () => {
    const next = !legendOpen;
    setLegendOpen(next);
    try { window.localStorage.setItem(LEGEND_KEY, next ? "1" : "0"); } catch { /* 저장소 없음 */ }
  };
  return (
    // bottom-16: 펼친 범례가 지도 오른쪽 아래 출처 표기(AttributionControl)를 가리지 않게(R-31).
    // left-[48px]: 왼쪽 위 줌 단추(여백 10 + 단추 29 + 테두리 2 = 41 px) 옆 — left-12 는 13 px 글꼴 기준 3 rem = 39 px 라 단추와 2 px 겹쳤다(하네스로 잼)
    <div className="pointer-events-none absolute top-3 right-3 bottom-16 left-[48px] z-10 flex flex-col gap-1">
      <div className="pointer-events-auto flex flex-wrap justify-end gap-1 self-end" data-testid="layer-panel" role="group" aria-label="지도 레이어">
        {ITEMS.map((i) => (
          <button key={i.k} className={i.k === "reception" ? "btn normal-case!" : "btn"} aria-pressed={layers[i.k] === true} onClick={() => toggle(i.k)}
            data-testid={`layer-${i.k}`}>{i.label}</button>
        ))}
        {/* 선종 필터 상태(계약 v5 §B3) — 토글은 범례의 선종 항목. 누르면 범례를 펼친다 */}
        {layers.ships ? (
          <button className={`btn normal-case! ${shipCats.length < SHIP_CATEGORIES.length ? "text-warn!" : ""}`} onClick={() => { if (!legendOpen) flip(); }}
            title="선종 필터 — 범례의 선종 항목을 눌러 켜고 끕니다(이 브라우저에만 저장)" data-testid="ship-cat-filter-chip">선종 필터 {shipCats.length}/{SHIP_CATEGORIES.length}</button>
        ) : null}
        <button className="btn" aria-expanded={legendOpen} aria-controls={legendOpen ? LEGEND_ID : undefined} onClick={flip} data-testid="legend-toggle">범례 {legendOpen ? "▾" : "▸"}</button>
      </div>
      {/* 두 칸은 남은 높이를 채운다(stretch) — 범례가 그 높이 안에서 줄어들고 스크롤된다(지도 아래 타임라인 · 출처 줄을 덮지 않게) */}
      <div className="flex min-h-0 flex-1 justify-between gap-2">
        <div className="min-w-0 max-w-[50%]"><MapChipsView hex={hex} shipsOn={layers.ships} shipCats={shipCats} basemapFailed={basemapFailed} /></div>
        <div className="flex min-h-0 min-w-0 flex-col items-end gap-1">
          {layers.traffic ? <TrafficGridStatus /> : null}
          {layers.reception ? <ReceptionStatusPart /> : null}
          {legendOpen ? <div className="pointer-events-auto min-h-0 max-w-full"><MapLegend id={LEGEND_ID} /></div> : null}
        </div>
      </div>
    </div>
  );
}
