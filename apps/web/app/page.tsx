"use client";
import dynamic from "next/dynamic";
import { LayerPanel } from "@/components/LayerPanel";
import { MapChips } from "@/components/MapChips";
import { RadarTimeline } from "@/components/RadarTimeline";
import { SidePanel } from "@/components/SidePanel";
import { StatusBar } from "@/components/StatusBar";
import { loadMaplibre } from "@/lib/maplibre";

// 지도 컴포넌트 청크와 MapLibre(public 배포본 — 지도 워커와 공용 청크를 한 번만 받는다, R-02)를 함께 받는다
const MapView = dynamic(() => Promise.all([import("@/components/MapView"), loadMaplibre()]).then(([m]) => m.MapView), {
  ssr: false, loading: () => <div className="grid-bg h-full w-full" />,
});

export default function Dashboard() {
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
          <SidePanel />
        </aside>
      </div>
      <RadarTimeline />
    </div>
  );
}
