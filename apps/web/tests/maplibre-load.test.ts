/**
 * R-02: 상황판 첫 화면이 MapLibre 공용 코드(maplibre-gl-shared, 약 145 KiB gzip)를 두 번 받지 않는다.
 * 번들러가 maplibre-gl 을 번들하면 공용 코드가 메인 청크에 들어가고, 지도 워커는 public 에서 같은 코드를 또 받는다.
 * 그래서 상황판 쪽 모듈은 maplibre-gl 을 타입으로만 import 하고, 실행 코드는 public 배포본을 lib/maplibre.ts 로 불러온다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { MAPLIBRE_MODULE_URL, MAPLIBRE_VERSION, MAPLIBRE_WORKER_URL } from "@/lib/maplibre";
import { MAPLIBRE_WORKER_URL as LAYERS_WORKER_URL } from "@/lib/maplayers";

const root = new URL("..", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
/** `import ... from "maplibre-gl"` 중 타입 전용이 아닌 것 */
const runtimeImports = (src: string) => [...src.matchAll(/^import\s+(?!type\b)[^;]*from\s+["']maplibre-gl["']/gm)].map((m) => m[0]);

describe("MapLibre is loaded once from public (R-02)", () => {
  it("dashboard modules import maplibre-gl only as types (no bundled copy of the shared chunk)", () => {
    const files = ["components/MapView.tsx", "app/page.tsx", ...readdirSync(new URL("components/map/", root)).map((f) => `components/map/${f}`), ...readdirSync(new URL("lib/", root)).filter((f) => f.endsWith(".ts")).map((f) => `lib/${f}`)];
    const offenders = files.flatMap((f) => runtimeImports(read(f)).map((i) => `${f}: ${i}`));
    expect(offenders).toEqual([]);
  });

  it("the versioned public path matches the installed maplibre-gl (the copy script writes that folder)", () => {
    const pkg = createRequire(import.meta.url)("maplibre-gl/package.json") as { version: string };
    expect(MAPLIBRE_VERSION).toBe(pkg.version);
    expect(MAPLIBRE_MODULE_URL).toBe(`/maplibre/${pkg.version}/maplibre-gl.mjs`);
    expect(MAPLIBRE_WORKER_URL).toBe(`/maplibre/${pkg.version}/maplibre-gl-worker.mjs`);
    expect(LAYERS_WORKER_URL).toBe(MAPLIBRE_WORKER_URL); // 재생 화면도 같은 워커·공용 청크
    expect(read("scripts/copy-maplibre-worker.mjs")).toMatch(/maplibre-gl\.mjs/);
  });

  it("the dashboard waits for the public MapLibre module together with the map component chunk", () => {
    expect(read("app/page.tsx")).toMatch(/loadMaplibre\(\)/);
  });

  it("the CSP comment in proxy.ts states how MapLibre is loaded now (same origin /maplibre/<version>/, allowed through 'strict-dynamic')", () => {
    const src = read("proxy.ts");
    const doc = src.slice(0, src.indexOf("export function proxy"));
    // 수정 전: "외부 스크립트 없음(MapLibre 는 번들)" — 상황판은 public 배포본을 import() 로 불러온다(R-02)
    expect(doc).not.toMatch(/MapLibre 는 번들\)/);
    expect(doc).toContain("/maplibre/<버전>/");
    expect(doc).toContain("'strict-dynamic'");
    // 주석이 기대는 정책 자체
    expect(src).toMatch(/script-src 'self' 'nonce-\$\{nonce\}' 'strict-dynamic'/);
    expect(src).toContain("worker-src 'self' blob:");
  });
});
