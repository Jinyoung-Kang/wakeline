/**
 * R-02: 상황판 첫 화면이 MapLibre 공용 코드(maplibre-gl-shared, 약 145 KiB gzip)를 두 번 받지 않는다.
 * 번들러가 maplibre-gl 을 번들하면 공용 코드가 메인 청크에 들어가고, 지도 워커는 public 에서 같은 코드를 또 받는다.
 * 그래서 상황판 쪽 모듈은 maplibre-gl 을 타입으로만 import 하고, 실행 코드는 public 배포본을 lib/maplibre.ts 로 불러온다.
 * 재생 화면(ReplayMap)도 같다(PERF §15 — 전에는 번들본을 실어 재생 화면이 공용 코드를 번들 청크 286 KB + 워커의 공용 청크 149 KB 로 두 번 받았다).
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
  it("no module of the app imports maplibre-gl at runtime — dashboard and replay alike (no bundled copy of the shared chunk)", () => {
    const files = ["app", "components", "lib"].flatMap((d) => (readdirSync(new URL(`${d}/`, root), { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f)).map((f) => `${d}/${f}`));
    expect(files).toEqual(expect.arrayContaining(["components/ReplayMap.tsx", "app/replay/page.tsx", "components/MapView.tsx", "components/map/useMapLifecycle.ts"]));
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

  it("the dashboard and the replay page wait for the public MapLibre module together with the map component chunk", () => {
    expect(read("app/page.tsx")).toMatch(/loadMaplibre\(\)/);
    expect(read("app/replay/page.tsx")).toMatch(/Promise\.all\(\[import\("@\/components\/ReplayMap"\), loadMaplibre\(\)\]\)/);
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
