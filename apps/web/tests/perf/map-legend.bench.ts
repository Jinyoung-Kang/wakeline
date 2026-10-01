/**
 * 범례(MapLegend)의 hasCoverage 선택자가 스토어가 바뀔 때마다 하는 일(web-review §4 P6) — `npx vitest bench --run tests/perf/map-legend.bench.ts`.
 * 선택자는 setData 마다 한 번 불린다(useSyncExternalStore 가 값이 같은지 본다). vitest run 은 *.bench.ts 를 집지 않는다(include = tests/**\/*.test.ts).
 */
import { test } from "vitest";
import { aisCoverageFeatures } from "@/lib/ships";

const box = (s: number, w: number, n: number, e: number) => ({ s, w, n, e });
const ONE = [box(18, 105, 46, 150)];                                   // .env.example AIS_BBOXES
const TWO = [box(-90, -180, 90, 0), box(-90, 45, 90, 180)];            // 운영 설정 예(아메리카 · 아시아·태평양)
const FIVE = [box(18, 105, 46, 150), box(30, 120, 40, 135), box(-10, 90, 10, 120), box(50, -10, 60, 10), box(-40, 140, -10, 160)];
let sink = false;
/** 모듈 export getter 를 한 번만 거친다(벤치 안에서 getter 비용을 재지 않게 — vitest benchmarking 'module runner overhead') */
const coverage = aisCoverageFeatures;

test("MapLegend hasCoverage selector per store emit", async ({ bench }) => {
  await bench.compare(
    bench("selector builds GeoJSON — 1 box", () => { sink = coverage(ONE).features.length > 0; }),
    bench("selector builds GeoJSON — 2 boxes", () => { sink = coverage(TWO).features.length > 0; }),
    bench("selector builds GeoJSON — 5 boxes", () => { sink = coverage(FIVE).features.length > 0; }),
    bench("selector reads the coverage reference", () => { sink = (ONE ?? null) != null; }),
  );
  void sink;
});
