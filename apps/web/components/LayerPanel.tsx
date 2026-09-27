"use client";
import { useUi, type Layers } from "@/lib/ui-store";

const ITEMS: { k: keyof Layers; label: string }[] = [
  { k: "radar", label: "레이더" }, { k: "sigmet", label: "SIGMET" }, { k: "aircraft", label: "항공기" },
  { k: "airports", label: "공항" }, { k: "tracks", label: "항적" }, { k: "prediction", label: "예측(추정)" },
];

export function LayerPanel() {
  const layers = useUi((s) => s.layers);
  const toggle = useUi((s) => s.toggleLayer);
  return (
    <div className="absolute top-3 right-3 z-10 flex gap-1" data-testid="layer-panel">
      {ITEMS.map((i) => (
        <button key={i.k} className="btn" aria-pressed={layers[i.k]} onClick={() => toggle(i.k)}>{i.label}</button>
      ))}
    </div>
  );
}
