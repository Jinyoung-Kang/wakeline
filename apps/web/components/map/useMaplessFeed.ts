"use client";
import { useEffect } from "react";
import { WatchRunnerPart } from "@/components/DashboardParts";
import { setData } from "@/lib/store";
import { WakelineWsClient } from "@/lib/ws";

/**
 * 지도 없는 실시간 피드(Q4 — 상황판이 지도를 띄우지 못했을 때, docs/plans/mapless-feed-2026-10): 지도와 함께 만드는 피드(useLiveFeed)가 없어도
 * 상태 바 · 알림 패널 · 관심 대상이 실시간 자료를 받게 WS 클라이언트 하나를 연다.
 * - 보간 워커는 없다(받은 항공기 렌더를 그릴 지도가 없다 — 워커 자리에는 아무것도 하지 않는 받는 쪽). 공개 워커 목록은 그대로다(tests/first-screen-js).
 * - 구독은 lib/ws 의 subscribeWithoutMap: 두 레이어를 끄고 고정 영역을 zoom 5 로 — 알림 · SIGMET · 레이더 · 피드 상태만 받고 서버 수요(핫 리전)를
 *   만들지 않는다. 그 클라이언트는 select · selectShip 을 보내지 않는다(집중 추적 안 함 — 사용자 결정 Q-B). 지도 화면 구독이 아니라 스토어 viewport 는 쓰지 않는다.
 * - 스토어 mapless 를 켠다 — 상태 바 · 지도 자리 칩이 항공기 · 선박 위치를 받지 않는다고 적는다(lib/statusbar · components/MapChips). 닫으면 끈다.
 * - 탭이 숨겨지면 멈추고(pause) 다시 보이면 잇는다(resume) — 지도 피드와 같다.
 * - 관심 대상 실행기 조각(ADR-037)을 곧바로 받는다(사용자 결정 Q-C): 보통은 지도 'load' 뒤 미리 받기가 받는데, 지도가 없으면 그 받기가 오지 않아
 *   SidePanel 의 다시 받기(1분 뒤부터)에만 기댔다. 같은 받기를 함께 쓰므로(LazyPart preload — 진행 중이면 그것을 기다린다) 겹치지 않고, 실패하면
 *   알리지 않는다(미리 받기와 같은 규칙) — 그때는 SidePanel 의 다시 받기가 그대로 받는다.
 * on: 지도를 띄우지 못함이 정해졌다(MapView 의 noWebgl). false 면 아무것도 하지 않는다.
 */
export function useMaplessFeed(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    WatchRunnerPart.preload().catch(() => {});
    const client = new WakelineWsClient({ postMessage() {} });
    client.subscribeWithoutMap();
    setData({ mapless: true });
    client.connect();
    const onVisibility = () => {
      if (document.hidden) client.pause();
      else client.resume();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      client.close();
      setData({ mapless: false });
    };
  }, [on]);
}

/** 지도 없는 피드만 여는 빈 컴포넌트 — 지도 컴포넌트를 그리지 못한 자리용(MapLibre 만 받지 못했을 때 app/page.tsx 가 지도 청크에서 받아 실패 자리 옆에 둔다 — Q4 b1) */
export function MaplessFeed(): null {
  useMaplessFeed(true);
  return null;
}
