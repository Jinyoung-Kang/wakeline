"use client";
import type * as maplibregl from "maplibre-gl";
import { useEffect } from "react";
import { dashboardMap, onReady, registerLayerTip, useDashboardMap } from "@/lib/map-ready";
import { RADAR_SLOT } from "@/lib/maplayers";
import {
  addReceptionLayers, cellsInView, RECEPTION_LAYERS, RECEPTION_POLL_NONE, RECEPTION_SOURCE, receptionFeatures, receptionPoller, receptionStatusLine, receptionTip,
} from "@/lib/reception";
import { RECEPTION_FILL_LAYER, RECEPTION_LAYER_LABEL, RECEPTION_LEGEND_NOTE } from "@/lib/reception-meta";
import { getData, setData, useServerData } from "@/lib/store";

const TONE = { ok: "text-fg-2", warn: "text-warn", bad: "text-bad", muted: "text-fg-3" } as const;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
/** 연안 교통량(ADR-023)의 채움 레이어 — 있으면 그 아래에 끼운다(교통량 · 레이더 · SIGMET · 선박 · 항공기가 위) */
const TRAFFIC_FILL = "traffic-grid-fill";

function source(map: maplibregl.Map) {
  return map.getSource(RECEPTION_SOURCE) as maplibregl.GeoJSONSource | undefined;
}

/**
 * 관측 수신 범위 레이어(ADR-027 · 계약 v5 §G27) — 레이어 단추를 켤 때 받는 조각(ADR-026 — components/DashboardParts). 켜져 있는(그려진) 동안:
 * - /api/v1/ships/coverage 를 ETag 로 조회(lib/reception — 120 s · 숨긴 탭 제외 · 다시 보이면 곧바로)해 스토어 reception 에 둔다.
 * - 상황판 지도(lib/map-ready)에 칸을 싣는다: 소스 하나 · 채움(선박 수 구간의 옅은 불투명도) · 테두리, 연안 교통량 아래. 내용이 바뀔 때(version)만 다시 싣는다.
 * - 이 화면과 겹치는 칸 수를 스토어 receptionInView 에(창을 다 셌는가 · 센 구간 · 마지막 조회 실패와 함께) — 선박 칩 · 0척 알림이 "이 화면에 관측 수신 칸 N개"
 *   와 센 구간(다 셌으면 "(최근 24 h)", 아니면 "(… KST 부터만 셈)")을 적는다.
 * - 칸 툴팁을 등록한다(MapView 의 호버가 레이어 id 로 찾는다).
 * 끄면(이 조각이 빠지면) 조회를 멈추고, 레이어를 숨기고 비우고, 칸 수 · 툴팁을 지운다. 지도가 먼저 지워졌으면 그 지도는 건드리지 않는다.
 * 보이는 것은 상태 줄: 칸 수 · 이 화면의 칸 수 · 창(KST), 창을 다 세지 못했으면 그 까닭(api 시작 뒤부터만 · 기동 전 기록 일부) · 메모리 상한 · 조회 실패.
 */
export function ReceptionStatus() {
  const map = useDashboardMap();
  const poll = useServerData((d) => d.reception) ?? RECEPTION_POLL_NONE;
  const bounds = useServerData((d) => d.mapBounds);
  const r = poll.data;

  useEffect(() => {
    const p = receptionPoller((s) => setData({ reception: s }), getData().reception ?? RECEPTION_POLL_NONE);
    p.start();
    return () => p.stop();
  }, []);

  useEffect(() => registerLayerTip(RECEPTION_FILL_LAYER, (props) => receptionTip(props, getData().reception?.data ?? null)), []);

  const version = poll.version;
  useEffect(() => {
    if (!map) return;
    const data = getData().reception?.data ?? null;
    onReady(map, "reception", () => {
      addReceptionLayers(map, map.getLayer(TRAFFIC_FILL) ? TRAFFIC_FILL : RADAR_SLOT);
      for (const id of RECEPTION_LAYERS) map.setLayoutProperty(id, "visibility", "visible");
      source(map)?.setData(data ? receptionFeatures(data.cells) : EMPTY);
    });
  }, [map, version]);

  useEffect(() => {
    if (!map) return;
    return () => {
      if (dashboardMap() !== map) return; // 상황판을 떠나 지도가 지워졌다
      onReady(map, "reception", () => {
        for (const id of RECEPTION_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
        source(map)?.setData(EMPTY);
      });
    };
  }, [map]);

  const inView = r && bounds ? cellsInView(r.cells, bounds) : null;
  const covered = r?.covered ?? null;
  const since = r?.since ?? null;
  const to = r?.to ?? null;
  const stale = poll.error != null; // 조회 실패 — 칸은 마지막 응답 그대로(칩 · 0척 알림이 그렇다고 적는다)
  useEffect(() => {
    setData({ receptionInView: covered != null && since != null && to != null && inView != null ? { cells: inView, covered, since, to, stale } : null });
  }, [covered, since, to, stale, inView]);
  useEffect(() => () => setData({ receptionInView: null }), []);

  const line = receptionStatusLine(r, poll.error, inView);
  return (
    <div className="pointer-events-auto panel max-w-full px-2 py-1 text-[11px] leading-snug sm:max-w-[440px]" role="status" aria-live="polite"
      data-testid="reception-status" title={RECEPTION_LEGEND_NOTE}>
      <span className="label mr-1.5 text-[9px] normal-case!">{RECEPTION_LAYER_LABEL}</span>
      <span className={TONE[line.tone]} data-testid="reception-status-text">{line.text}</span>
      {line.detail ? <div className={line.tone === "warn" ? "text-warn" : "text-fg-3"} data-testid="reception-status-detail">{line.detail}</div> : null}
    </div>
  );
}
