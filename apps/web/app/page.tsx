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
      <h1 className="sr-only">실시간 상황판 — 항공기·선박·위험기상 지도와 알림</h1>
      <StatusBar />
      {/* 900 px 미만: 지도 위 · 패널 아래로 쌓는다(R-39) — 고정 380 px 열이 지도를 10 px 로 줄이지 않게 */}
      <div className="flex min-h-0 flex-1 flex-col min-[900px]:flex-row">
        <div className="relative min-h-0 min-w-0 flex-1">
          <MapView />
          <MapChips />
          <LayerPanel />
        </div>
        <aside id="side-panel" tabIndex={-1} aria-label="알림·상세 패널" className="flex h-[42%] w-full shrink-0 flex-col border-t border-line bg-bg-1 min-[900px]:h-auto min-[900px]:w-[380px] min-[900px]:border-t-0 min-[900px]:border-l">
          <SidePanel />
        </aside>
      </div>
      <RadarTimeline />
    </div>
  );
}
