/**
 * /ops 탭 불러오기의 세션 · 오류 규칙(characterization — 운영 화면의 탭 불러오기 · RequestOrder · 주기 논리를 useOpsTabs 로 옮기기 전에 지금 동작을
 * 고정한다, web-review §3.2). 요청 순서(RequestOrder) · 느린 답 · 갱신 시각 · 숨긴 탭은 ops-request-order · resolve-ops-page · ops-page · hidden-tab-polls 가 본다.
 * - 한 번의 새로고침에서 탭 여러 개가 401/404 여도 세션 확인은 한 번 — 세션도 없으면 만료 문구와 함께 로그인으로
 * - 세션이 살아 있으면 그 탭만 '갱신 실패'(로그인으로 가지 않는다)
 * - 설정 저장의 401/404(세션은 살아 있음)는 위 줄의 오류로도 보이고, 다음 전체 새로고침이 그 줄을 지운다(설정 칸의 실패 문구는 남는다 — 결정 4)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter, propsOf } from "./helpers/mount";

const dom = installMiniDom();
(dom.document as unknown as { cookie: string }).cookie = "WAKELINE_CSRF=t";
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const BODY: Record<string, unknown> = {
  "/api/v1/ops/providers": { providers: [], active: {}, collector: {}, switches: [], budget_days: [] },
  "/api/v1/ops/runs?limit=50&resolved=hide": { items: [], summary_24h: [] },
  "/api/v1/ops/quality": { rule_counts: [], recent: [] },
  "/api/v1/ops/settings": { items: [{ key: "region_poll_s", value: 10, version: 3, updated_by: "op", updated_at: "2026-09-28T15:00:00Z" }] },
  "/api/v1/ops/audit": { items: [] },
  "/api/v1/ops/dlq": { items: [] },
  "/api/v1/ops/pipeline": { collector: {}, api: {} },
};
/** answer(url, method) 가 undefined 면 BODY(세션은 200) */
function stub(answer: (url: string, method: string) => Response | undefined = () => undefined) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    asked.push(`${method} ${url}`);
    const r = answer(url, method);
    if (r) return r;
    if (url === "/api/v1/ops/session") return json(200, { username: "op" });
    return url in BODY ? json(200, BODY[url]) : json(404, { detail: "no such resource" });
  });
  return { sessionChecks: () => asked.filter((a) => a === "GET /api/v1/ops/session").length };
}
async function open() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-09-28T23:41:14Z") });
  vi.stubGlobal("self", globalThis);
  await m.render(m.React.createElement((await import("@/app/ops/page")).default));
  await m.settle();
  await m.settle();
}
const tick = async () => { await m.act(() => { vi.advanceTimersByTime(15_000); }); await m.settle(); await m.settle(); };
const topLine = () => m.find((e) => e.getAttribute("role") === "alert" && e.tagName === "SPAN")?.textContent ?? "";

describe("/ops tab loads: a session that is gone and a 401 on one tab", () => {
  it("every tab answering 404 with the session gone: one session check for the whole refresh, then the login form with the expiry notice", async () => {
    let gone = false;
    const s = stub((url) => (gone ? json(404, { detail: "not found" }) : undefined));
    await open();
    expect(m.byTestId("ops-dashboard")).not.toBeNull();
    const before = s.sessionChecks();
    gone = true;
    await tick();
    expect(s.sessionChecks()).toBe(before + 1);
    expect(m.byTestId("ops-dashboard")).toBeNull();
    expect(m.byTestId("ops-login-notice")!.textContent).toContain("세션이 만료");
  });

  it("one tab answering 401 while the session is alive is marked 갱신 실패 on that tab only and the dashboard stays", async () => {
    const s = stub((url) => (url === "/api/v1/ops/audit" ? json(401, { detail: "unauthorized", request_id: "feedface0000beef" }) : undefined));
    await open();
    expect(m.byTestId("ops-dashboard")).not.toBeNull();
    const stale = m.allByTestId("ops-tab-stale").map((e) => (e.parentNode as unknown as { getAttribute(n: string): string | null }).getAttribute("data-testid"));
    expect(stale).toEqual(["ops-tab-audit"]);
    expect(topLine()).toContain("audit: ");
    expect(topLine()).toContain("feedface0000beef");
    expect(s.sessionChecks()).toBe(2); // 화면을 열 때 한 번 + 이 401 을 가리려고 한 번
  });
});

describe("/ops: a settings save refused with 404 while the session is alive", () => {
  it("shows in the top line as well as under the form; the next full refresh clears the top line, the form's failure stays", async () => {
    stub((url, method) => (method === "PUT" ? json(404, { detail: "no such setting", request_id: "beefbeef0000feed" }) : undefined));
    await open();
    await m.click(m.byTestId("ops-tab-settings"));
    await m.act(() => propsOf(m.find((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "region_poll_s 값")!).onChange({ target: { value: "15" } }));
    await m.click(m.button("save"));
    await m.settle();
    expect(m.byTestId("settings-error")!.textContent).toContain("region_poll_s: 저장 실패(HTTP 404)");
    expect(topLine()).toContain("no such setting");
    expect(topLine()).toContain("beefbeef0000feed");
    await tick();
    expect(topLine()).toBe("");
    expect(m.byTestId("settings-error")!.textContent).toContain("region_poll_s: 저장 실패(HTTP 404)");
  });
});
