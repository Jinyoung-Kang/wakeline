/**
 * QA-302 — 375 px 이하에서 운영 탭 줄(role=group "운영 탭")이 한 줄로 화면 밖에 넘쳐 audit · dlq · pipeline(320 px 에서는 settings 도)을 누를 수 없었다
 * (본문은 overflow hidden 이라 페이지도 밀리지 않는다 — WCAG 1.4.10). 탭 줄은 줄바꿈한다. 실제 폭에서의 확인은 e2e/qa/qa-302-ops-tabs-mobile.spec.ts —
 * 이 시험은 CI(vitest)에서 그 규칙이 빠지지 않게 그려진 탭 줄의 클래스를 본다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.unstubAllGlobals(); });

describe("/ops tab row on a narrow screen", () => {
  it("wraps (flex-wrap, may shrink below its one-line width) so every tab stays on screen", async () => {
    const body: Record<string, unknown> = {
      "/api/v1/ops/session": { username: "op" },
      "/api/v1/ops/providers": { providers: [], active: {}, collector: {}, switches: [], budget_days: [] },
      "/api/v1/ops/runs?limit=50&resolved=hide": { items: [], summary_24h: [] },
      "/api/v1/ops/quality": { rule_counts: [], recent: [] },
      "/api/v1/ops/pipeline": { collector: {}, api: {} },
    };
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(body[url] ?? { items: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("self", globalThis);
    await m.render(m.React.createElement((await import("@/app/ops/page")).default));
    await m.settle();
    await m.settle();
    const group = m.find((e) => e.getAttribute("role") === "group" && e.getAttribute("aria-label") === "운영 탭")!;
    const cls = (group.getAttribute("class") ?? "").split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["flex", "flex-wrap", "min-w-0"]));
    expect(m.findAll((e) => e.tagName === "BUTTON", group).map((b) => b.getAttribute("data-testid")))
      .toEqual(["providers", "runs", "quality", "settings", "audit", "dlq", "pipeline"].map((t) => `ops-tab-${t}`));
  });
});
