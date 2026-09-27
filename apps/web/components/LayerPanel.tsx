"use client";
import { useEffect } from "react";
import { useUi, type Layers } from "@/lib/ui-store";
import { MapLegend } from "./MapLegend";

const ITEMS: { k: keyof Layers; label: string }[] = [
  { k: "radar", label: "레이더" }, { k: "sigmet", label: "SIGMET" }, { k: "aircraft", label: "항공기" },
  { k: "airports", label: "공항" }, { k: "tracks", label: "항적" }, { k: "prediction", label: "예측(추정)" },
];
const LEGEND_KEY = "skywx.legend";
const LEGEND_ID = "map-legend";

/** 레이어 토글 + 접을 수 있는 범례(GAP-13). 범례 열림 여부는 이 브라우저에만 기억한다(localStorage, 실패해도 동작). */
export function LayerPanel() {
  const layers = useUi((s) => s.layers);
  const toggle = useUi((s) => s.toggleLayer);
  const legendOpen = useUi((s) => s.legendOpen);
  const setLegendOpen = useUi((s) => s.setLegendOpen);
  useEffect(() => {
    try { const v = window.localStorage.getItem(LEGEND_KEY); if (v === "0" || v === "1") setLegendOpen(v === "1"); } catch { /* 저장소 없음 */ }
  }, [setLegendOpen]);
  const flip = () => {
    const next = !legendOpen;
    setLegendOpen(next);
    try { window.localStorage.setItem(LEGEND_KEY, next ? "1" : "0"); } catch { /* 저장소 없음 */ }
  };
  return (
    <div className="pointer-events-none absolute top-3 right-3 bottom-3 z-10 flex flex-col items-end gap-1">
      <div className="pointer-events-auto flex gap-1" data-testid="layer-panel" role="group" aria-label="지도 레이어">
        {ITEMS.map((i) => (
          <button key={i.k} className="btn" aria-pressed={layers[i.k]} onClick={() => toggle(i.k)}>{i.label}</button>
        ))}
        <button className="btn" aria-expanded={legendOpen} aria-controls={legendOpen ? LEGEND_ID : undefined} onClick={flip} data-testid="legend-toggle">범례 {legendOpen ? "▾" : "▸"}</button>
      </div>
      {legendOpen ? <div className="pointer-events-auto min-h-0"><MapLegend id={LEGEND_ID} /></div> : null}
    </div>
  );
}
