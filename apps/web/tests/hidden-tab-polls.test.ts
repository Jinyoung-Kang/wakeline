/**
 * 주기 새로고침은 탭이 보일 때만(PLAN §5 결정 2 · web-review B12): 운영 화면(15 s × 7 엔드포인트), 시스템 로그 자동 확인(15 s), 항공기 카드(30 s)는
 * 숨긴 탭에서 부르지 않고, 다시 보이면 곧바로 부른다. 로그 자동 확인은 쪽을 넘기거나 새 항목을 반영해도 15 s 주기가 밀리지 않는다(web-review B13).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter, propsOf } from "./helpers/mount";

const dom = installMiniDom();
(dom.document as unknown as { cookie: string }).cookie = "WAKELINE_CSRF=t";
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); dom.document.hidden = false; });

const NOW = Date.parse("2026-09-29T02:00:00Z");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
/** 부른 GET 경로(쿼리 앞) */
function stub(answer: (url: string) => Response | Promise<Response>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => { asked.push(url.split("?")[0]); return answer(url); });
  return { count: (path: string) => asked.filter((u) => u === path).length };
}
const advance = (ms: number) => m.act(() => { vi.advanceTimersByTime(ms); });
const setHidden = async (hidden: boolean) => { dom.document.hidden = hidden; await m.act(() => dom.document.dispatch("visibilitychange")); };
async function start(el: import("react").ReactElement) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("location", { hash: "", pathname: "/", origin: "http://localhost:8700" });
  await m.render(el);
  await m.settle();
  await m.settle();
}

describe("periodic refreshes pause while the tab is hidden and resume at once (web-review B12, decision 2)", () => {
  it("/ops: no reload of the 7 tabs while hidden; shown again, one reload right away", async () => {
    const s = stub((url) => url === "/api/v1/ops/session" ? json(200, { username: "op" }) : json(404, { detail: "no such resource" }));
    await start(m.React.createElement((await import("@/app/ops/page")).default));
    const first = s.count("/api/v1/ops/providers");
    expect(first).toBe(1);
    await setHidden(true);
    await advance(60_000);
    expect(s.count("/api/v1/ops/providers")).toBe(first);
    await setHidden(false);
    await m.settle();
    expect(s.count("/api/v1/ops/providers")).toBe(first + 1);
  });

  it("/logs: no auto-check while hidden; shown again, one check right away", async () => {
    const s = stub((url) => url === "/api/v1/ops/session" ? json(200, { username: "op" })
      : url.startsWith("/api/v1/ops/logs?") ? json(200, { items: [], next_cursor: null, scanned: 0, scan_truncated: false }) : json(404, {}));
    await start(m.React.createElement((await import("@/app/logs/page")).default));
    const first = s.count("/api/v1/ops/logs");
    await setHidden(true);
    await advance(60_000);
    expect(s.count("/api/v1/ops/logs")).toBe(first);
    await setHidden(false);
    await m.settle();
    expect(s.count("/api/v1/ops/logs")).toBe(first + 1);
  });

  it("aircraft card: no detail refresh while hidden; shown again, one refresh right away", async () => {
    const s = stub(() => json(200, { hex: "abc123", state: null }));
    const { AircraftCard } = await import("@/components/AircraftCard");
    await start(m.React.createElement(AircraftCard, { hex: "abc123" }));
    const first = s.count("/api/v1/aircraft/abc123");
    expect(first).toBe(1);
    await setHidden(true);
    await advance(120_000);
    expect(s.count("/api/v1/aircraft/abc123")).toBe(first);
    await setHidden(false);
    await m.settle();
    expect(s.count("/api/v1/aircraft/abc123")).toBe(first + 1);
  });
});

describe("/logs auto-check keeps its 15 s rhythm (web-review B13)", () => {
  it("loading an older page at 10 s does not push the next check to 25 s", async () => {
    const T = (min: number) => `${NOW - min * 60_000}-0`;
    const entry = (id: string) => ({ id, v: 1, ts: new Date(Number(id.split("-")[0])).toISOString(), service: "api", instance: "api-1", level: "ERROR", logger: "x.Y", thread: "t",
      message: `failure ${id}`, exception: null, fp: "0123456789abcdef", request_id: null, context: {}, suppressed: 0 });
    const s = stub((url) => url === "/api/v1/ops/session" ? json(200, { username: "op" })
      : url.startsWith("/api/v1/ops/logs?") && url.includes("cursor=") ? json(200, { items: [entry(T(10))], next_cursor: null, scanned: 5, scan_truncated: false })
      : url.startsWith("/api/v1/ops/logs?") ? json(200, { items: [entry(T(1)), entry(T(2))], next_cursor: T(2), scanned: 10, scan_truncated: false }) : json(404, {}));
    await start(m.React.createElement((await import("@/app/logs/page")).default));
    const loads = s.count("/api/v1/ops/logs"); // 첫 목록
    await advance(10_000);
    await m.act(() => propsOf(m.button("이전 항목 더 보기")!).onClick());
    await m.settle();
    expect(s.count("/api/v1/ops/logs")).toBe(loads + 1); // 더 보기
    await advance(5_000); // t = 15 s
    await m.settle();
    expect(s.count("/api/v1/ops/logs")).toBe(loads + 2); // 자동 확인은 15 s 에 — 더 보기로 다시 걸리지 않는다
  });
});
