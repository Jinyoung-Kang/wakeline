import { afterEach, describe, expect, it, vi } from "vitest";

const reported: { message: string; component?: string | null }[] = [];
vi.mock("@/lib/errorReport", async (orig) => ({
  ...(await orig<typeof import("@/lib/errorReport")>()),
  reportClientError: (e: { message: string; component?: string | null }) => { reported.push(e); return "sent"; },
}));

import type * as maplibregl from "maplibre-gl";
import { onReady } from "@/lib/map-ready";

/** load 전 지도: 기본 레이어 없음(getSource → undefined), once("load") 처리기만 모은다 */
function fakeMap() {
  const loads: (() => void)[] = [];
  const map = {
    getSource: () => undefined,
    once: (ev: string, fn: () => void) => { if (ev === "load") loads.push(fn); },
  };
  return { map: map as unknown as maplibregl.Map, fireLoad: () => { for (const f of loads.splice(0)) f(); } };
}

afterEach(() => { reported.length = 0; });

describe("onReady queue (draws requested before the map's load)", () => {
  it("a draw that throws does not skip the draws queued after it, and the failure is reported", () => {
    const { map, fireLoad } = fakeMap();
    const ran: string[] = [];
    onReady(map, "layers", () => { ran.push("layers"); });
    onReady(map, "sigmets", () => { throw new Error("addLayer: style is not done loading"); });
    onReady(map, "pointer", () => { ran.push("pointer"); });
    fireLoad();
    // 전: sigmets 가 던지면 반복이 끝나 pointer(호버 · 클릭 연결)가 이 지도에서 영영 실행되지 않았다
    expect(ran).toEqual(["layers", "pointer"]);
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain("sigmets");
    expect(reported[0].message).toContain("addLayer: style is not done loading");
    expect(reported[0].component).toBe("lib/map-ready");
  });

  it("keeps the last request per key and runs each queued draw once", () => {
    const { map, fireLoad } = fakeMap();
    const ran: string[] = [];
    onReady(map, "a", () => { ran.push("a1"); });
    onReady(map, "b", () => { ran.push("b"); });
    onReady(map, "a", () => { ran.push("a2"); });
    fireLoad();
    expect(ran).toEqual(["b", "a2"]);
    expect(reported).toEqual([]);
  });
});
