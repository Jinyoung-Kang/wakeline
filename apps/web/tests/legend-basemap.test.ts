/**
 * 범례 '바탕 지도' 묶음(2026-09-30 대시보드 점검): 줌 6–7 의 동해에 보이는 회색 원(울릉도 · 독도 둘레)과 바다 위 회색 선은 우리 층이 아니라
 * 바탕 지도(OpenFreeMap · OpenMapTiles)의 boundary 층 — 타일에서 확인한 속성 admin_level 2 · maritime 1 · adm0_r KOR(해상 국경)이다.
 * 범례가 이 선들을 설명하지 않아 무엇인지 알 수 없었다 — 색은 lib/basemap 의 실제 칠 값과 같아야 한다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MapLegendView } from "@/components/MapLegend";
import { BASEMAP_BOUNDARY_COUNTRY, BASEMAP_BOUNDARY_STATE, BASEMAP_COAST } from "@/lib/basemap";
import { useUi } from "@/lib/ui-store";

const legend = () =>
  renderToStaticMarkup(createElement(MapLegendView, { id: "lg", layers: useUi.getState().layers, radarSource: "rainviewer", shipCats: useUi.getState().shipCats }));

describe("legend: basemap lines", () => {
  it("names the national boundary incl. maritime boundaries (the rings around islands), admin boundaries and the coastline, in their painted colours", () => {
    const html = legend();
    expect(html).toContain('data-testid="legend-basemap"');
    const sec = html.slice(html.indexOf('data-testid="legend-basemap"'));
    expect(sec).toContain("해상 국경");
    expect(sec).toMatch(/섬 둘레/);
    expect(sec).toContain("행정 경계");
    expect(sec).toContain("해안선");
    for (const c of [BASEMAP_BOUNDARY_COUNTRY, BASEMAP_BOUNDARY_STATE, BASEMAP_COAST]) expect(sec.toLowerCase()).toContain(c.toLowerCase());
    expect(sec).toContain("OpenMapTiles");
  });
});
