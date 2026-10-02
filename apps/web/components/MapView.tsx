"use client";
import { useRef } from "react";
import { useMapLifecycle } from "./map/useMapLifecycle";
import { useLiveFeed } from "./map/useLiveFeed";
import { useWeatherLayers } from "./map/useWeatherLayers";
import { useMapPointer } from "./map/useMapPointer";
import { useShipLayers } from "./map/useShipLayers";
import { useSelectionTracks } from "./map/useSelectionTracks";
// 지도 전용 CSS(MapLibre 기본 + 덮어쓰기) — 이 컴포넌트 조각과 함께 받는다(PERF §15 — 전역 CSS 에서 뺐다)
import "./map/map.css";

/**
 * 상황판 지도(클라이언트 컴포넌트) — Hook 여섯 묶음(components/map, web-review §3.2)을 잇는다. 묶음마다 자기 effect · 기록을 갖고, 지도는
 * 상황판 지도 손잡이(lib/map-ready)로 받는다 — 지도가 바뀌면(StrictMode · 다시 마운트) 그 지도에 다시 그린다(그린 것의 기록은 그 지도와 함께).
 * - useMapLifecycle: 지도 · 배경지도 대체 스타일 · 기본 레이어 · 출처 표기 · 레이어 보이기 · 지도 이동. onFirstLoad = 지도가 처음 다 그려졌을 때
 *   (MapLibre 'load' — 한 번) — 상황판은 여기서 첫 화면 뒤 미리 받기를 시작한다(ADR-026).
 * - useLiveFeed: 보간 워커 · WS(구독은 지도 뷰포트를 따라간다, 탭이 숨겨지면 멈춘다) · 항공기 렌더 · 예측선.
 * - useWeatherLayers: SIGMET · RainViewer · 커버리지 · 기상청 레이더 · 감시 공항(조회 포함). useMapPointer: 호버 툴팁 · 클릭.
 * - useShipLayers: 선박 · 격자 · 선택 선박 · 선종 필터 · AIS 수신 범위 · 연안 교통량. useSelectionTracks: WS 선택 · 항공기 · 선박 항적.
 */
export function MapView({ onFirstLoad }: { onFirstLoad?: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useMapLifecycle(el, onFirstLoad);
  const feed = useLiveFeed(map);
  const airports = useWeatherLayers(map);
  useMapPointer(map, airports);
  useShipLayers(map);
  useSelectionTracks(map, feed);
  // data-escape-neutral: 지도에 초점이 있을 때의 Esc 는 맨 위 패널(카드 · 범례)을 닫는다(lib/escape-stack)
  return <div ref={el} className="h-full w-full" data-testid="map" data-escape-neutral="" />;
}
