"use client";
import type * as GeoJSON from "geojson";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useMemo, useState } from "react";
import {
  addAirspaceLayers, AIRSPACE_LABEL_LAYER, AIRSPACE_LAYERS, AIRSPACE_POLL_NONE, AIRSPACE_SOURCE, airspacePoller, airspaceStatusLine, airspaceTip, categoriesPresent,
  categoryFilter, DEFAULT_CATEGORIES, loadCategories, saveCategories, styleOf, type Airspace, type AirspacePollState,
} from "@/lib/airspace";
import { AIRSPACE_FILL_LAYER, AIRSPACE_LAYER_LABEL, AIRSPACE_LINE_LAYER } from "@/lib/airspace-meta";
import { dashboardMap, onReady, registerLayerTip, useDashboardMap } from "@/lib/map-ready";
import { RADAR_SLOT } from "@/lib/maplayers";

const TONE = { ok: "text-fg-2", warn: "text-warn", bad: "text-bad", muted: "text-fg-3" } as const;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** 마지막으로 받은 공역(툴팁 · 지도 싣기가 읽는다 — 상황판 지도는 하나라 조각도 하나다). 조각이 빠지면 비운다 */
let latest: Airspace | null = null;

function source(map: maplibregl.Map) {
  return map.getSource(AIRSPACE_SOURCE) as maplibregl.GeoJSONSource | undefined;
}

/**
 * 공역 레이어(ADR-034 · 계약 v5 §G47 · SPEC F1) — 레이어 단추를 켤 때 받는 조각(ADR-026 — components/DashboardParts). 켜져 있는(그려진) 동안:
 * - /api/v1/airspace 를 ETag 로 조회(lib/airspace — 10분 · 숨긴 탭 제외 · 다시 보이면 곧바로)한다.
 * - 상황판 지도(lib/map-ready)에 소스 하나 · 채움 · 선 · 이름표(줌 8+)를 레이더 자리 아래에 싣는다. 내용이 바뀔 때(version)만 다시 싣는다.
 * - 종류 단추(이 칸 안 — 이 브라우저에만 저장)로 보이는 종류를 고른다. 기본: 비행금지 · 원전 · 안보 · 비행제한 · 위험구역.
 * - 툴팁: 이름 · 종류 · 고도 범위(기준) · 원문 · 기준 차수 · 출처.
 * 끄면(이 조각이 빠지면) 조회를 멈추고, 레이어를 숨기고 비우고, 툴팁을 지운다. 지도가 먼저 지워졌으면 그 지도는 건드리지 않는다.
 */
export function AirspaceStatus() {
  const map = useDashboardMap();
  const [poll, setPoll] = useState<AirspacePollState>(AIRSPACE_POLL_NONE);
  // 이 조각은 클라이언트에서만 그린다(켤 때 받는다) — 저장된 선택을 처음 값으로 읽어도 서버 렌더와 어긋나지 않는다
  const [cats, setCats] = useState<readonly string[]>(() => loadCategories() ?? DEFAULT_CATEGORIES);

  useEffect(() => {
    const p = airspacePoller((s) => { latest = s.data; setPoll(s); });
    p.start();
    return () => { p.stop(); latest = null; };
  }, []);

  useEffect(() => {
    const off = [AIRSPACE_FILL_LAYER, AIRSPACE_LINE_LAYER].map((id) => registerLayerTip(id, (props) => airspaceTip(props, latest)));
    return () => off.forEach((f) => f());
  }, []);

  const version = poll.version;
  useEffect(() => {
    if (!map) return;
    const data = latest;
    onReady(map, "airspace", () => {
      addAirspaceLayers(map, RADAR_SLOT);
      for (const id of AIRSPACE_LAYERS) map.setLayoutProperty(id, "visibility", "visible");
      source(map)?.setData(data ? { type: "FeatureCollection", features: data.features } : EMPTY);
    });
  }, [map, version]);

  useEffect(() => {
    if (!map) return;
    const f = categoryFilter(cats);
    onReady(map, "airspace-filter", () => {
      if (!map.getLayer(AIRSPACE_LINE_LAYER)) return;
      map.setFilter(AIRSPACE_FILL_LAYER, f.polygons as maplibregl.FilterSpecification);
      map.setFilter(AIRSPACE_LABEL_LAYER, f.polygons as maplibregl.FilterSpecification);
      map.setFilter(AIRSPACE_LINE_LAYER, f.all as maplibregl.FilterSpecification);
    });
  }, [map, cats, version]);

  useEffect(() => {
    if (!map) return;
    return () => {
      if (dashboardMap() !== map) return; // 상황판을 떠나 지도가 지워졌다
      onReady(map, "airspace", () => {
        for (const id of AIRSPACE_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
        source(map)?.setData(EMPTY);
      });
    };
  }, [map]);

  const present = useMemo(() => categoriesPresent(poll.data), [poll.data]);
  const shown = poll.data ? poll.data.features.filter((f) => cats.includes(f.properties.category)).length : null;
  const line = airspaceStatusLine(poll.data, poll.error, shown);
  const toggle = (c: string) => {
    const next = cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c];
    setCats(next);
    saveCategories(next);
  };
  return <AirspaceStatusView line={line} present={present} cats={cats} onToggle={toggle} />;
}

/** 표시 부분(서버 렌더 시험용) */
export function AirspaceStatusView({ line, present, cats, onToggle }: {
  line: { text: string; tone: keyof typeof TONE }; present: readonly { code: string; label: string }[]; cats: readonly string[]; onToggle: (c: string) => void;
}) {
  return (
    <div className="pointer-events-auto panel max-w-full px-2 py-1 text-[11px] leading-snug sm:max-w-[440px]" role="status" aria-live="polite" data-testid="airspace-status"
      title="국토교통부 공역정보 지도자료(AIP 차수 기준) — 비상업 표시 · 최신 여부(AIRAC)는 확인하지 않음">
      <span className="label mr-1.5 text-[9px] normal-case!">{AIRSPACE_LAYER_LABEL}</span>
      <span className={TONE[line.tone]} data-testid="airspace-status-text">{line.text}</span>
      {present.length ? (
        <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label="공역 종류" data-testid="airspace-categories">
          {present.map(({ code, label }) => {
            const s = styleOf(code);
            const on = cats.includes(code);
            return (
              <button key={code} className="btn normal-case! px-1.5! py-0! text-[10px]!" aria-pressed={on} onClick={() => onToggle(code)} data-testid={`airspace-cat-${code}`}
                title={on ? `${label} 숨기기` : `${label} 보이기`}>
                <span aria-hidden className="mr-1 inline-block h-2 w-2 align-middle" style={{ background: on ? s.color : "transparent", border: `1px ${s.dash ? "dashed" : "solid"} ${s.color}` }} />
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
