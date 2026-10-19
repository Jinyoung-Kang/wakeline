"use client";
import dynamic from "next/dynamic";
import { prefetchDashboardPartsWhenIdle } from "@/components/DashboardParts";
import { failedPart } from "@/components/LazyPart";
import { LayerPanel } from "@/components/LayerPanel";
import { RadarTimeline } from "@/components/RadarTimeline";
import { SidePanel } from "@/components/SidePanel";
import { StatusBar } from "@/components/StatusBar";
import { loadMaplibre } from "@/lib/maplibre";
import { setNoLiveFeed } from "@/lib/store";
import { afterFirstPaint } from "@/lib/after-paint";

// 지도 컴포넌트 청크와 MapLibre(public 배포본 — 지도 워커와 공용 청크를 한 번만 받는다, R-02)를 함께 받는다.
// 받기는 첫 그리기 뒤에 시작한다(lib/after-paint — ADR-026 개정 2026-10-02): 서버가 그린 화면이 먼저 보이고, 지도 라이브러리의 내려받기 · 해석 ·
// WebGL 준비가 첫 그리기를 붙잡지 않는다(소프트웨어 GL 에서 2–5 s — PERF §15). 그 사이 자리는 아래 격자 배경.
// 받지 못하면 거절하지 않고 지도 자리에 까닭 · '다시 시도'(같은 두 가지를 다시 받는다 — components/LazyPart failedPart, IM-21). 거절하면 화면 전체의 오류 경계까지
// 올라가 상태 바 · 알림 패널을 지웠고, 거절을 기억한 lazy 라 다시 시도로 돌아오지 않았다. 받지 못한 동안 지도와 함께 시작하는 실시간 피드(components/map/useLiveFeed)는 없다.
// - MapLibre 만 받지 못함(Q4 b1 — 지도 컴포넌트 청크는 받음): 같은 모듈을 다시 import() 해(이미 받은 모듈 — 새 청크 · 새 preload 대상이 아니다) 그 청크의
//   지도 없는 피드(MaplessFeed — components/map/useMaplessFeed: 알림 · SIGMET · 레이더 · 피드 상태만, 서버 수요 없음)를 실패 자리 옆에 둔다.
//   다시 시도로 지도 조각을 받으면(useLoaded) 내린다 — 그 닫기가 지도를 그린 뒤 지도 피드의 연결보다 먼저다(tests/map-load-failure 가 순서를 고정한다).
// - 지도 컴포넌트 청크도 받지 못함(Q4 b2 — 피드 코드가 그 청크에 있다): 스토어에 피드가 없다고 적는다(conn "off" — 상태 바 · 알림 패널이 '연결 중'으로
//   보이지 않게, R9). 다시 시도로 지도가 뜨면 피드가 연결부터 다시 적는다. 청크를 받지 못했는지는 처음 import() 의 거절에 붙인 표시(mapViewFailed)로 안다 —
//   그때는 같은 모듈을 다시 import() 하지 않고 곧바로 실패 자리를 보인다(Turbopack 런타임은 받지 못한 청크를 지워, 다시 부르면 내장 재시도까지 처음부터 다시 받는다).
//   표시가 없으면(MapLibre 가 먼저 실패해 Promise.all 이 곧바로 거절됨 — 청크는 받았거나 아직 받는 중) 위처럼 같은 import() 를 기다린다(받는 중인 청크는
//   런타임이 같은 약속을 돌려준다 — 새 받기 없음). 기다린 청크가 끝내 오지 않으면 그때 'off'
let mapViewFailed = false;
const markMapViewFailed = (e: unknown): never => { mapViewFailed = true; throw e; };
const MapView = dynamic(() => afterFirstPaint().then(() => Promise.all([import("@/components/MapView").catch(markMapViewFailed), loadMaplibre()])).then(([m]) => m.MapView).catch((e: unknown) => {
  const Failed = failedPart("지도", e, () => Promise.all([import("@/components/MapView"), loadMaplibre()]).then(([m]) => m.MapView), { frameClassName: "grid-bg flex h-full w-full flex-col justify-center p-3 text-[11px]" });
  const noFeed = () => {
    setNoLiveFeed();
    return Failed;
  };
  return mapViewFailed ? noFeed() : import("@/components/MapView").then(({ MaplessFeed }) => function MapFailed(p: { onFirstLoad?: () => void }) {
    return <>{Failed.useLoaded() ? null : <MaplessFeed />}<Failed {...p} /></>;
  }, noFeed);
}), {
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
