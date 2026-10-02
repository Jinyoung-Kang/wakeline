"use client";
import dynamic from "next/dynamic";
import { prefetchDashboardPartsWhenIdle } from "@/components/DashboardParts";
import { LayerPanel } from "@/components/LayerPanel";
import { RadarTimeline } from "@/components/RadarTimeline";
import { SidePanel } from "@/components/SidePanel";
import { StatusBar } from "@/components/StatusBar";
import { loadMaplibre } from "@/lib/maplibre";
import { afterFirstPaint } from "@/lib/after-paint";

// 지도 컴포넌트 청크와 MapLibre(public 배포본 — 지도 워커와 공용 청크를 한 번만 받는다, R-02)를 함께 받는다.
// 받기는 첫 그리기 뒤에 시작한다(lib/after-paint — ADR-026 개정 2026-10-02): 서버가 그린 화면이 먼저 보이고, 지도 라이브러리의 내려받기 · 해석 ·
// WebGL 준비가 첫 그리기를 붙잡지 않는다(소프트웨어 GL 에서 2–5 s — PERF §15). 그 사이 자리는 아래 격자 배경.
const MapView = dynamic(() => afterFirstPaint().then(() => Promise.all([import("@/components/MapView"), loadMaplibre()])).then(([m]) => m.MapView), {
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
          {/* 지도가 처음 다 그려지면(첫 화면 끝) 한가할 때 카드 · 목록 조각을 미리 받는다(ADR-026 — 첫 화면 JS 에 들지 않는다) */}
          <MapView onFirstLoad={prefetchDashboardPartsWhenIdle} />
          {/* 지도 위에 겹쳐 그리는 것(레이어 단추 · 상태 칩 · 배경지도 알림 · 교통량 상태 · 범례)은 LayerPanel 의 한 배치 안 — 서로 덮지 않게 */}
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
