/**
 * 지도를 그리지 못한 상황판(ADR-041 · Q4 의 Q-D 를 이어서): 지도에 그리는 것만 다루는 조작은 동작하지 않으므로 보이지 않게 · 끈다.
 * - 레이어 단추 · 선종 필터 · 범례(와 레이어 상태 칸)는 지도가 없으면 그리지 않는다 — 지도 자리 칩(MapChips 의 '지도 없음')은 남는다.
 *   지도 없음 = 지도 없는 피드(스토어 mapless) 또는 피드가 아예 없음(conn 'off' — 지도 조각을 받지 못함, R9).
 * - 레이더 줄은 프레임 상태(출처 · 프레임 수 · 기상청 합성)가 지도 없는 피드로도 오므로 남기고, 그리는 쪽 조작(애니메이션 · 프레임 막대 · latest)만 끄고 까닭을 적는다.
 * 지도가 있으면 모두 그대로다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { LayerPanelView } from "@/components/LayerPanel";
import { RadarTimeline } from "@/components/RadarTimeline";

const NOW_S = Date.parse("2026-10-19T03:00:00Z") / 1000;
const RADAR = { host: "h", generated: NOW_S, past: [{ time: NOW_S - 600, path: "/a" }, { time: NOW_S, path: "/b" }], fetched_at: "2026-10-19T03:00:10Z" };
const panel = () => renderToStaticMarkup(createElement(LayerPanelView, { layers: { ...useUi.getState().layers, ships: true }, shipCats: useUi.getState().shipCats, legendOpen: true }));
const tag = (html: string, id: string) => new RegExp(`<[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? null;

afterEach(() => { resetData(); });

describe("layer buttons, ship filter and legend need the map", () => {
  it("with the map: the layer buttons, the ship filter chip and the legend are there", () => {
    setData({ conn: "open" });
    const html = panel();
    for (const id of ["layer-panel", "layer-radar", "layer-ships", "ship-cat-filter-chip", "legend-toggle", "map-legend"]) expect(tag(html, id), id).not.toBeNull();
    expect(tag(html, "mapless-chip")).toBeNull();
  });

  it("map-less feed or no feed at all ('off'): none of them is drawn; the map slot's chip stays", () => {
    for (const d of [{ conn: "open" as const, mapless: true }, { conn: "off" as const }]) {
      setData(d);
      const html = panel();
      for (const id of ["layer-panel", "layer-radar", "ship-cat-filter-chip", "legend-toggle", "map-legend"]) expect(tag(html, id), `${id} (${JSON.stringify(d)})`).toBeNull();
      if (d.conn === "open") expect(tag(html, "mapless-chip")).not.toBeNull();
      resetData();
    }
  });
});

describe("radar timeline without the map", () => {
  it("with the map: animation, frame slider and latest work when there are frames", () => {
    setData({ conn: "open", radar: RADAR });
    const html = renderToStaticMarkup(createElement(RadarTimeline));
    expect(tag(html, "radar-play")).not.toContain("disabled");
    expect(tag(html, "radar-latest")).not.toContain("disabled");
    expect(html).not.toMatch(/<input[^>]*type="range"[^>]*disabled/);
    expect(tag(html, "radar-no-map")).toBeNull();
  });

  it("map-less or 'off': the frame status stays, the drawing controls are off and say why", () => {
    for (const d of [{ conn: "open" as const, mapless: true }, { conn: "off" as const }]) {
      setData({ ...d, radar: RADAR });
      const html = renderToStaticMarkup(createElement(RadarTimeline));
      expect(tag(html, "radar-frame-time"), "frame status stays").not.toBeNull();
      expect(html).toContain("2 frames");
      expect(tag(html, "radar-src-rv")).not.toContain("disabled"); // 출처는 상태를 고른다 — 그대로
      expect(tag(html, "radar-play")).toContain("disabled");
      expect(tag(html, "radar-latest")).toContain("disabled");
      expect(html).toMatch(/<input[^>]*type="range"[^>]*disabled/);
      expect(tag(html, "radar-no-map")).not.toBeNull();
      expect(html).toContain("지도 없음 — 레이더를 그리지 않음(프레임 상태만)");
      resetData();
    }
  });
});
