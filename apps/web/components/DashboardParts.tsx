"use client";
import { lazyPart } from "./LazyPart";

/**
 * 상황판에서 상호작용 뒤에만 보이는 화면(ADR-026 — 첫 화면 JS NFR-04). 첫 로드에는 이 목록(import() 호출)만 싣고, 각 조각은 처음 그릴 때 받는다.
 * 어느 것이 여기 있어야 하는지는 tests/first-screen-lazy.test.ts 가 본다(첫 화면의 정적 import 그래프에 없어야 한다).
 * 지도 컴포넌트(app/page.tsx)는 첫 화면이라 여기 없다 — 범례(MapLegend)도 넓은 화면에서는 처음부터 펼쳐지므로(lib/prefs legendDefaultOpen) 정적으로 둔다.
 */
export const AircraftCardPart = lazyPart("항공기 카드", () => import("./AircraftCard").then((m) => m.AircraftCard));
export const ShipPanelPart = lazyPart("선박 패널", () => import("./ShipCard").then((m) => m.ShipPanel));
export const SigmetCardPart = lazyPart("SIGMET 카드", () => import("./SigmetCard").then((m) => m.SigmetCard));
export const SigmetListPart = lazyPart("SIGMET 목록", () => import("./SigmetList").then((m) => m.SigmetList));
export const AirportCardPart = lazyPart("공항 카드", () => import("./AirportCard").then((m) => m.AirportCard));
export const AirportListPart = lazyPart("공항 목록", () => import("./AirportList").then((m) => m.AirportList));
/** 알림 행을 펼친 뒤의 근거(행 안 — 여백을 줄인다) */
export const EvidenceCardPart = lazyPart("알림 근거", () => import("./EvidenceCard").then((m) => m.EvidenceCard), { frameClassName: "py-1 text-[11px]" });
/** 레이더 줄의 '범례·정합' — 떠 있는 패널과 같은 자리 · 폭에 진행 표시(components/KrRadarPanel 의 바깥 틀) */
export const KrRadarPanelPart = lazyPart("기상청 레이더 범례·정합", () => import("./KrRadarPanel").then((m) => m.KrRadarPanel), {
  frameClassName: "panel absolute bottom-full left-3 z-10 mb-3 w-[380px] max-w-[calc(100vw-1.5rem)] p-2 text-[11px]",
});
/** 통합 검색 결과의 선박 표 — 검색창에 초점이 오면 미리 받는다(components/AircraftSearch) */
export const ShipTablePart = lazyPart("선박 표", () => import("./ShipTable").then((m) => m.ShipTable), { frameClassName: "px-2 py-1.5 text-[11px]" });

/** 모든 조각(시험이 미리 받을 때 · 목록 점검) */
export const DASHBOARD_PARTS = [
  AircraftCardPart, ShipPanelPart, SigmetCardPart, SigmetListPart, AirportCardPart, AirportListPart, EvidenceCardPart, KrRadarPanelPart, ShipTablePart,
] as const;

/**
 * 첫 화면이 다 그려졌다는 표시(performance mark). 이 뒤에 받는 스크립트는 첫 화면 JS(NFR-04)가 아니다 — 측정 도구
 * (scripts/measure-first-screen-js.mjs)가 같은 이름으로 앞뒤를 가른다(tests/parts-prefetch.test.ts).
 */
export const AFTER_FIRST_SCREEN_MARK = "wakeline:after-first-screen";
/** 한가해지기를 기다리는 최대 시간(requestIdleCallback 의 timeout — 선택값: 그동안 한가하지 않아도 이 뒤에는 받는다) */
export const PREFETCH_IDLE_TIMEOUT_MS = 5_000;

interface PrefetchDeps {
  idle?: (cb: () => void) => void;
  mark?: (name: string) => void;
  parts?: readonly { preload(): Promise<void> }[];
}

function defaultIdle(cb: () => void) {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(() => cb(), { timeout: PREFETCH_IDLE_TIMEOUT_MS });
  else setTimeout(cb, 1_000); // requestIdleCallback 이 없는 브라우저(Safari) — 1 s 뒤(선택값)
}

/**
 * 첫 화면 뒤 미리 받기(ADR-026): 지도가 처음 다 그려진 뒤(app/page.tsx 가 MapView 의 onFirstLoad 로 부른다) 브라우저가 한가할 때
 * 표시를 남기고 조각을 모두 받아 둔다 — 첫 클릭에 기다리지 않고, 오래 열어 둔 상황판이 새 배포 뒤(옛 청크 404)에도 카드 · 목록을 열 수 있다.
 * 미리 받기 실패는 여기서 알리지 않는다: 그 조각을 그릴 때 다시 받고, 그때도 실패하면 LazyPart 가 까닭 · 청크 확인과 함께 보이고 보고한다.
 */
export function prefetchDashboardPartsWhenIdle(deps: PrefetchDeps = {}): void {
  const idle = deps.idle ?? defaultIdle;
  const mark = deps.mark ?? ((n: string) => { try { performance.mark(n); } catch { /* 표시는 측정용 — 없어도 받는다 */ } });
  const parts = deps.parts ?? DASHBOARD_PARTS;
  idle(() => {
    mark(AFTER_FIRST_SCREEN_MARK);
    for (const p of parts) p.preload().catch(() => {});
  });
}
