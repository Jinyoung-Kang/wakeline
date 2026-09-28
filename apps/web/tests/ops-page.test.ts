/**
 * 운영 화면 새로고침(실제 react-dom 으로 마운트 — 최소 DOM + fetch 대역). R-12: 탭마다 마지막 성공 시각·실패를 따로 보인다.
 * 한 엔드포인트만 계속 실패하면(예: /ops/providers 500, /ops/runs 성공) 그 탭이 옛 값을 새 '갱신' 시각 아래 보이지 않는다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";

const dom = installMiniDom();
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let OpsPage: typeof import("@/app/ops/page").default;

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  OpsPage = (await import("@/app/ops/page")).default;
});
afterAll(() => dom.restore());

let root: Root | null = null;
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const BODY: Record<string, unknown> = {
  "/api/v1/ops/session": { username: "op" },
  "/api/v1/ops/providers": { providers: [], active: {}, collector: {}, switches: [], budget_days: [] },
  "/api/v1/ops/runs?limit=50": { items: [], summary_24h: [] },
  "/api/v1/ops/quality": { rule_counts: [], recent: [] },
  "/api/v1/ops/settings": { items: [] },
  "/api/v1/ops/audit": { items: [] },
  "/api/v1/ops/dlq": { items: [] },
  "/api/v1/ops/pipeline": { collector: {}, api: {} },
};
/** 경로 → 응답. failing 에 든 경로는 500(인증 문제 아님) */
function stubFetch(failing: Set<string>) {
  vi.stubGlobal("fetch", async (url: string) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (failing.has(url)) return json(500, { detail: "provider status unavailable" });
    return url in BODY ? json(200, BODY[url]) : json(404, { detail: "no such resource" });
  });
}
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const byTestId = (id: string, from: MiniElement = dom.container): MiniElement | null => {
  if (from.getAttribute?.("data-testid") === id) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? byTestId(id, c) : null; if (f) return f; }
  return null;
};
const alertText = (): string => {
  const walk = (n: MiniElement): string | null => {
    if (n.getAttribute?.("role") === "alert") return n.textContent;
    for (const c of n.childNodes) { const f = c instanceof MiniElement ? walk(c) : null; if (f != null) return f; }
    return null;
  };
  return walk(dom.container) ?? "";
};

describe("R-12 ops: last success per tab, the failing endpoint is named", () => {
  it("a tab whose endpoint keeps failing keeps its old time and is marked, while other endpoints succeed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-09-28T01:00:00Z") });
    const failing = new Set<string>();
    stubFetch(failing);
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(OpsPage)); });
    await settle(); // 세션 확인 → 대시보드 → 첫 새로고침(setTimeout 0)
    await settle();
    expect(byTestId("ops-dashboard")).not.toBeNull();
    expect(byTestId("ops-last-ok")?.textContent).toBe("갱신 01:00:00Z");

    // 15 s 뒤 새로고침: providers 만 500, 나머지는 성공
    failing.add("/api/v1/ops/providers");
    await React.act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    // 수정 전: 다른 엔드포인트의 성공으로 "갱신 01:00:15Z" — providers 탭은 옛 값인데 새 시각 아래
    expect(byTestId("ops-last-ok")?.textContent).toBe("갱신 01:00:00Z");
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-providers")!)).not.toBeNull();
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-runs")!)).toBeNull();
    // 오류 문구가 어느 탭(엔드포인트)인지 말한다
    expect(alertText()).toContain("providers");
    expect(alertText()).toContain("provider status unavailable");

    // 다시 성공하면 표시가 사라지고 시각이 새로워진다
    failing.clear();
    await React.act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    expect(byTestId("ops-last-ok")?.textContent).toBe("갱신 01:00:30Z");
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-providers")!)).toBeNull();
    expect(alertText()).toBe("");
  });

  it("a tab that has never loaded shows no time ('—'), not another endpoint's", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-09-28T02:00:00Z") });
    stubFetch(new Set(["/api/v1/ops/providers"]));
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(OpsPage)); });
    await settle();
    await settle();
    expect(byTestId("ops-last-ok")?.textContent).toBe("갱신 —");
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-providers")!)).not.toBeNull();
  });
});
