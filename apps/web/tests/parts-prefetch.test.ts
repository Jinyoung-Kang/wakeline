/**
 * 첫 화면 뒤 미리 받기(ADR-026): 상호작용 뒤에만 보이는 조각(components/DashboardParts)을 지도가 처음 다 그려진 뒤, 브라우저가 한가할 때 모두 받아 둔다.
 * - 까닭: 첫 클릭에 기다리지 않게, 그리고 오래 열어 둔 상황판이 새 배포 뒤에도(옛 청크 404) 아직 열지 않은 카드 · 목록을 열 수 있게.
 * - 첫 화면 JS(NFR-04)는 이 시점 앞까지다: 미리 받기 직전에 performance mark 를 남기고, 측정 도구가 그 뒤 요청을 따로 센다.
 * - 미리 받기 실패는 여기서 알리지 않는다 — 그 조각을 그릴 때 다시 받고, 그때도 실패하면 화면이 까닭과 함께 보인다(LazyPart).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AFTER_FIRST_SCREEN_MARK, DASHBOARD_PARTS, prefetchDashboardPartsWhenIdle } from "@/components/DashboardParts";
import { AFTER_FIRST_SCREEN_MARK as MEASURE_MARK } from "../scripts/first-screen-js-lib.mjs";

describe("prefetch after the first screen", () => {
  it("waits for idle, leaves the mark first, then preloads every part once — a failing preload does not escape", async () => {
    const log: string[] = [];
    let idle: (() => void) | null = null;
    const parts = [
      { label: "a", preload: () => { log.push("preload a"); return Promise.resolve(); } },
      { label: "b", preload: () => { log.push("preload b"); return Promise.reject(new Error("offline")); } },
    ];
    prefetchDashboardPartsWhenIdle({ idle: (cb) => { log.push("idle scheduled"); idle = cb; }, mark: (n) => log.push(`mark ${n}`), parts });
    expect(log).toEqual(["idle scheduled"]); // 아무것도 받지 않았다 — 한가할 때까지
    idle!();
    await Promise.resolve();
    expect(log).toEqual(["idle scheduled", `mark ${AFTER_FIRST_SCREEN_MARK}`, "preload a", "preload b"]);
  });
  it("defaults cover every dashboard part", () => {
    expect(DASHBOARD_PARTS.length).toBe(10); // 9 + 관측 수신 범위 레이어(ADR-027 — 계약 v5 §G27)
    expect(AFTER_FIRST_SCREEN_MARK).toBe("wakeline:after-first-screen");
  });
  it("the dashboard starts it when the map has loaded for the first time (first screen complete), not earlier", () => {
    const page = readFileSync(resolve(__dirname, "../app/page.tsx"), "utf8");
    expect(page).toMatch(/<MapView onFirstLoad=\{prefetchDashboardPartsWhenIdle\} \/>/);
    expect(MEASURE_MARK).toBe(AFTER_FIRST_SCREEN_MARK); // 측정 도구가 같은 이름으로 가른다
  });
});
