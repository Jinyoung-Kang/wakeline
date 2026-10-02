/**
 * 지도 전용 CSS(PERF §15): MapLibre 기본 스타일(원본 83 KB · gzip 약 10.6 KB)과 지도 컨트롤 · 출처 · 팝업 덮어쓰기는 components/map/map.css 에 두고
 * 지도 컴포넌트(상황판 MapView · 재생 ReplayMap)가 import 한다 — 두 컴포넌트는 첫 그리기 뒤에 받는 조각이라 이 CSS 도 그때 온다.
 * 전역 CSS(app/globals.css — 모든 화면의 첫 그리기를 막는 스타일시트)에는 MapLibre 규칙이 없어야 한다(지도 없는 /about · /stats 까지 받았다).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("map-only CSS travels with the map components, not the global stylesheet", () => {
  it("app/globals.css neither imports MapLibre's stylesheet nor styles .maplibregl-* classes", () => {
    const g = read("app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(g).not.toMatch(/maplibre-gl\.css/);
    expect(g).not.toMatch(/\.maplibregl-/);
  });
  it("components/map/map.css imports MapLibre's stylesheet first, then our overrides (same order as before — equal specificity, later wins)", () => {
    const m = read("components/map/map.css").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    expect(m.startsWith('@import "maplibre-gl/dist/maplibre-gl.css";')).toBe(true);
    for (const sel of [".maplibregl-ctrl-attrib", ".maplibregl-ctrl-group", ".maplibregl-popup-content", ".wakeline-tip .maplibregl-popup-content", ".maplibregl-canvas:focus-visible"]) expect(m).toContain(sel);
  });
  it("both map components import it", () => {
    for (const f of ["components/MapView.tsx", "components/ReplayMap.tsx"]) expect(read(f)).toMatch(/^import "\.\/map\/map\.css";$/m);
  });
});
