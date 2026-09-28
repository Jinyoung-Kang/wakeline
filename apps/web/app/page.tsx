"use client";
import dynamic from "next/dynamic";
import { AlertPanel } from "@/components/AlertPanel";
import { AircraftCard } from "@/components/AircraftCard";
import { AirportCard } from "@/components/AirportCard";
import { LayerPanel } from "@/components/LayerPanel";
import { MapChips } from "@/components/MapChips";
import { ShipPanel } from "@/components/ShipCard";
import { RadarTimeline } from "@/components/RadarTimeline";
import { SigmetCard } from "@/components/SigmetCard";
import { StatusBar } from "@/components/StatusBar";
import { useUi } from "@/lib/ui-store";
import { loadMaplibre } from "@/lib/maplibre";

// 지도 컴포넌트 청크와 MapLibre(public 배포본 — 지도 워커와 공용 청크를 한 번만 받는다, R-02)를 함께 받는다
const MapView = dynamic(() => Promise.all([import("@/components/MapView"), loadMaplibre()]).then(([m]) => m.MapView), {
  ssr: false, loading: () => <div className="grid-bg h-full w-full" />,
});

export default function Dashboard() {
  const panel = useUi((s) => s.panel);
  const hex = useUi((s) => s.selectedHex);
  const sigmet = useUi((s) => s.selectedSigmet);
  const airport = useUi((s) => s.selectedAirport);
  const setPanel = useUi((s) => s.setPanel);
  return (
    <div className="flex h-full flex-col">
      <StatusBar />
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <MapView />
          <MapChips />
          <LayerPanel />
        </div>
        <aside className="flex w-[380px] shrink-0 flex-col border-l border-line bg-bg-1">
          <div className="flex border-b border-line">
            {(["alerts", "aircraft", "ship", "sigmet", "airport"] as const).map((p) => (
              <button key={p} className="btn flex-1 border-0 border-r border-line" aria-pressed={panel === p} onClick={() => setPanel(p)} data-testid={`tab-${p}`}>{p}</button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {panel === "alerts" ? <AlertPanel /> : null}
            {panel === "aircraft" ? (hex ? <AircraftCard hex={hex} /> : <div className="p-3 text-[11px] text-fg-3">지도에서 항공기를 클릭하세요.</div>) : null}
            {panel === "ship" ? <ShipPanel /> : null}
            {panel === "sigmet" ? (sigmet ? <SigmetCard id={sigmet} /> : <div className="p-3 text-[11px] text-fg-3">지도에서 SIGMET 폴리곤을 클릭하세요.</div>) : null}
            {panel === "airport" ? (airport ? <AirportCard icao={airport} /> : <div className="p-3 text-[11px] text-fg-3">지도에서 공항을 클릭하세요(줌 6 이상).</div>) : null}
          </div>
        </aside>
      </div>
      <RadarTimeline />
    </div>
  );
}
