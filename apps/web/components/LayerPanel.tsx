"use client";
import { useEffect } from "react";
import { legendDefaultOpen, loadLayers, loadShipCats, saveLayers } from "@/lib/prefs";
import { SHIP_CATEGORIES, type ShipCategory } from "@/lib/ships";
import { useUi, type Layers } from "@/lib/ui-store";
import { MapLegend } from "./MapLegend";

const ITEMS: { k: keyof Layers; label: string }[] = [
  { k: "radar", label: "레이더" }, { k: "sigmet", label: "SIGMET" }, { k: "aircraft", label: "항공기" }, { k: "ships", label: "선박" },
  { k: "airports", label: "공항" }, { k: "tracks", label: "항적" }, { k: "prediction", label: "예측(추정)" },
];
const LEGEND_KEY = "wakeline.legend";
const LEGEND_ID = "map-legend";

/**
 * 레이어 토글 + 접을 수 있는 범례(GAP-13). 레이어 켜짐(항공기·선박 포함, 계약 v2 §B4)·범례 열림 여부·선종 필터(계약 v5 §B3)는 이 브라우저에만 기억한다
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
    // bottom-16: 펼친 범례가 지도 오른쪽 아래 출처 표기(AttributionControl)를 가리지 않게(R-31)
    <div className="pointer-events-none absolute top-3 right-3 bottom-16 left-12 z-10 flex flex-col items-end gap-1">
      <div className="pointer-events-auto flex flex-wrap justify-end gap-1" data-testid="layer-panel" role="group" aria-label="지도 레이어">
        {ITEMS.map((i) => (
          <button key={i.k} className="btn" aria-pressed={layers[i.k]} onClick={() => toggle(i.k)} data-testid={`layer-${i.k}`}>{i.label}</button>
        ))}
        {/* 선종 필터 상태(계약 v5 §B3) — 토글은 범례의 선종 항목. 누르면 범례를 펼친다 */}
        {layers.ships ? (
          <button className={`btn normal-case! ${shipCats.length < SHIP_CATEGORIES.length ? "text-warn!" : ""}`} onClick={() => { if (!legendOpen) flip(); }}
            title="선종 필터 — 범례의 선종 항목을 눌러 켜고 끕니다(이 브라우저에만 저장)" data-testid="ship-cat-filter-chip">선종 필터 {shipCats.length}/{SHIP_CATEGORIES.length}</button>
        ) : null}
        <button className="btn" aria-expanded={legendOpen} aria-controls={legendOpen ? LEGEND_ID : undefined} onClick={flip} data-testid="legend-toggle">범례 {legendOpen ? "▾" : "▸"}</button>
      </div>
      {legendOpen ? <div className="pointer-events-auto min-h-0 max-w-full"><MapLegend id={LEGEND_ID} /></div> : null}
    </div>
  );
}
