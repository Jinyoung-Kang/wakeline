"use client";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { aircraftFeatureCollection, predictionFeature, predictionKey, predictionTargets } from "@/lib/maplayers";
import { subscriptionBbox } from "@/lib/viewport";
import { aircraftStates, getData, serverNowMs, setData, useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { WakelineWsClient } from "@/lib/ws";
import { onReady } from "@/lib/map-ready";
import type { RenderState } from "@/lib/types";

/** 지도마다의 실시간 피드(WS 클라이언트 · 보간 워커 · 예측선 갱신) — 지도가 바뀌면 새것이다. 없으면(지도 전 · 떠난 뒤) null */
export interface LiveFeed { client: WakelineWsClient; worker: Worker; refreshPrediction: () => void }
export type FeedRef = { readonly current: LiveFeed | null };

function geo(map: maplibregl.Map, id: string) {
  return map.getSource(id) as maplibregl.GeoJSONSource | undefined;
}

/**
 * 상황판 지도의 실시간 피드(web-review §3.2 — MapView 에서 뗀 묶음): 보간 워커와 WS 클라이언트를 지도와 함께 만들고 지운다.
 * - 실시간 데이터(R-01): 지도 스타일(외부 호스트)을 기다리지 않고 바로 시작한다 — 구독 bbox 는 지도 생성 직후부터 알 수 있다. 받은 값은 스토어 · 워커에 쌓이고,
 *   지도에 그리는 일(applyRender)만 기본 레이어가 준비된 뒤에 한다.
 * - WS 구독은 지도 뷰포트(bbox · zoom — 날짜변경선 처리는 lib/viewport)를 따라간다(이동이 멈추고 300 ms 뒤).
 * - 보간은 Web Worker(바뀐 것이 있을 때만 post) → 받은 렌더를 항공기 소스에 넣고 예측선을 다시 계산한다(입력이 바뀌었을 때만 setData).
 * - 탭이 숨겨지면 구독 · 워커를 멈추고 다시 보이면 잇는다.
 * 돌려주는 것: 그 피드(선택 항적 Hook 이 WS 선택 · 워커 무효화 · 예측선 갱신에 쓴다).
 */
export function useLiveFeed(map: maplibregl.Map | null): FeedRef {
  const feed = useRef<LiveFeed | null>(null);
  const alerts = useServerData((d) => d.alerts);
  const selectedHex = useUi((s) => s.selectedHex);
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selectedHex; }, [selectedHex]);

  useEffect(() => {
    if (!map) return;
    // 번들러(Turbopack)가 .ts 워커를 자산으로 취급하므로 순수 JS 워커를 public 에 둔다(tests/worker-sync 가 TS 구현과 일치를 검사).
    const worker = new Worker("/interpolate.worker.js");
    const client = new WakelineWsClient(worker);

    let predKey: string | null = null;
    const refreshPrediction = () => {
      const src = geo(map, "prediction");
      if (!src) return;
      const d = getData();
      const sel = d.selected && d.selected.hex === selectedRef.current ? d.selected : null;
      const targets = predictionTargets(sel, d.alerts.values(), aircraftStates);
      // 선은 "지금"(서버 기준)에서 시작한다(DH-12) — 엔진의 예측·알림 ETA 와 같은 시각 기준
      const now = serverNowMs(Date.now());
      const key = predictionKey(targets, now);
      if (key === predKey) return;
      predKey = key;
      src.setData({ type: "FeatureCollection", features: targets.map((t) => predictionFeature(t, now)).filter((f): f is NonNullable<typeof f> => f != null) });
    };
    feed.current = { client, worker, refreshPrediction };

    // 워커는 바뀐 것이 있을 때만 보낸다 → 받은 렌더를 잃지 않도록 마지막 것을 보관했다가 레이어가 준비되면 적용한다.
    let lastRender: RenderState[] | null = null;
    const applyRender = () => {
      const src = geo(map, "aircraft");
      if (!src || !lastRender) return;
      src.setData(aircraftFeatureCollection(lastRender, selectedRef.current));
      refreshPrediction();
    };
    worker.onmessage = (ev: MessageEvent<{ type: string; states: RenderState[] }>) => {
      if (ev.data.type !== "render") return;
      lastRender = ev.data.states;
      applyRender();
    };

    const subscribeViewport = () => {
      const b = map.getBounds();
      const bbox = subscriptionBbox(b.getWest(), b.getSouth(), b.getEast(), b.getNorth(), map.getZoom(), map.getCenter().lng); // 날짜변경선(lib/viewport)
      client.subscribe(bbox, Math.floor(map.getZoom()));
      worker.postMessage({ type: "viewport", bbox, zoom: map.getZoom() });
      // 목록에서 고른 항목이 화면 밖인지(lib/focus)는 구독 bbox 가 아니라 보이는 범위로 판단한다(R-08)
      setData({ mapBounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] });
    };
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    const onMoveEnd = () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(subscribeViewport, 300);
    };
    map.on("moveend", onMoveEnd);

    worker.postMessage({ type: "start" });
    client.connect();
    subscribeViewport();
    onReady(map, "aircraft-render", applyRender);

    const onVisibility = () => {
      if (document.hidden) { client.pause(); worker.postMessage({ type: "stop" }); }
      else { client.resume(); worker.postMessage({ type: "start" }); }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      map.off("moveend", onMoveEnd);
      if (moveTimer) clearTimeout(moveTimer);
      client.close();
      worker.terminate();
      feed.current = null;
      setData({ conn: "closed" });
    };
  }, [map]);

  // ---- 예측선: 알림(PREDICTED 추가·해제)이 바뀌면 다시 계산 ----
  useEffect(() => { feed.current?.refreshPrediction(); }, [alerts]);

  return feed;
}
