// 서버가 준 값을 경로 조각으로 쓸 때는 인코딩한다(web-review B11 · PLAN W11) — 공급자 이름 · 설정 키 · 공항 ICAO.
// '/' · '?' · '#' 가 든 값이 CSRF 헤더가 실린 운영 쓰기를 다른 경로로 보내거나 링크를 다른 화면으로 보내지 않게.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter, propsOf } from "./helpers/mount";

const dom = installMiniDom();
const m = mounter(dom);
let ops: typeof import("@/lib/ops");
beforeAll(async () => { await m.load(); ops = await import("@/lib/ops"); });
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ops write paths encode their server-supplied segment", () => {
  it("provider switch and setting paths", () => {
    expect(ops.providerSwitchPath("adsbdb", "disable")).toBe("/api/v1/ops/providers/adsbdb/disable");
    expect(ops.providerSwitchPath("a/b", "enable")).toBe("/api/v1/ops/providers/a%2Fb/enable");
    expect(ops.providerSwitchPath("x?y#z", "disable")).toBe("/api/v1/ops/providers/x%3Fy%23z/disable");
    expect(ops.settingPath("region_poll_s")).toBe("/api/v1/ops/settings/region_poll_s");
    expect(ops.settingPath("a/../b")).toBe("/api/v1/ops/settings/a%2F..%2Fb");
  });

  it("the ops page sends the encoded paths for a provider toggle and a settings save", async () => {
    (dom.document as unknown as { cookie: string }).cookie = "WAKELINE_CSRF=t";
    const writes: string[] = [];
    const BODY: Record<string, unknown> = {
      "/api/v1/ops/session": { username: "op" },
      "/api/v1/ops/providers": { providers: [{ name: "a/b" }], active: {}, collector: {}, switches: [], budget_days: [],
        provider_switch: [{ provider: "a/b", disabled: false, version: 1, updated_at: "2026-09-28T00:59:00Z", updated_by: "op", redis_disabled: "0", mirror_differs: false }] },
      "/api/v1/ops/runs?limit=50&resolved=hide": { items: [], summary_24h: [] },
      "/api/v1/ops/quality": { rule_counts: [], recent: [] },
      "/api/v1/ops/settings": { items: [{ key: "x/y", value: "1", version: 3, updated_by: "op", updated_at: "2026-09-28T15:00:00Z" }] },
      "/api/v1/ops/audit": { items: [] },
      "/api/v1/ops/dlq": { items: [] },
      "/api/v1/ops/pipeline": { collector: {}, api: {} },
    };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") { writes.push(`${method} ${url}`); return json(200, { provider: "a/b", disabled: true, version: 2, updated_at: "2026-09-28T01:00:05Z", mirrored: true }); }
      return url in BODY ? json(200, BODY[url]) : json(404, { detail: "no such resource" });
    });
    vi.stubGlobal("self", globalThis);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-09-28T01:00:00Z") });
    const OpsPage = (await import("@/app/ops/page")).default;
    await m.render(m.React.createElement(OpsPage));
    await m.settle();
    await m.settle();
    await m.click(m.button("disable"));
    await m.click(m.byTestId("ops-tab-settings"));
    await m.act(() => propsOf(m.find((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "x/y 값")!).onChange({ target: { value: "2" } }));
    await m.click(m.button("save"));
    expect(writes).toEqual(["POST /api/v1/ops/providers/a%2Fb/disable", "PUT /api/v1/ops/settings/x%2Fy"]);
  });
});

describe("the airport card's history link encodes the ICAO", () => {
  it("links to /airports/<encoded icao> (Next decodes the dynamic param back)", async () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    vi.stubGlobal("self", globalThis);
    const { AirportCard } = await import("@/components/AirportCard");
    await m.render(m.React.createElement(AirportCard, { icao: "RK/SI?x#y" }));
    expect(m.find((e) => e.tagName === "A" && e.textContent === "이력")!.getAttribute("href")).toBe("/airports/RK%2FSI%3Fx%23y");
    await m.render(m.React.createElement(AirportCard, { icao: "RKSI" }));
    expect(m.find((e) => e.tagName === "A" && e.textContent === "이력")!.getAttribute("href")).toBe("/airports/RKSI");
  });
});
