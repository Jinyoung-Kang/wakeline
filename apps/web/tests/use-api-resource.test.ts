// lib/use-api-resource(web-review §3.2 · PLAN 3C-3): 열쇠별 결과(지금 열쇠의 결과만) · 열쇠가 바뀌거나 떠나면 요청을 끊는다 · retry() ·
// refreshMs 의 다시 받기는 값을 둔 채로, 진행 중이면 겹쳐 보내지 않고, 숨긴 탭에서는 보내지 않는다(다시 보이면 곧바로).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import type { ApiResource } from "@/lib/use-api-resource";

const dom = installMiniDom();
const m = mounter(dom);
let useApiResource: typeof import("@/lib/use-api-resource").useApiResource;
beforeAll(async () => { await m.load(); ({ useApiResource } = await import("@/lib/use-api-resource")); });
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); dom.document.hidden = false; });

type Req = { key: string; signal: AbortSignal; resolve: (v: string) => void; reject: (e: unknown) => void };
let reqs: Req[] = [];
/** 열쇠마다 끝나지 않는 요청 — 시험이 resolve · reject 로 끝낸다 */
const loader = (key: string) => (signal: AbortSignal) => new Promise<string>((resolve, reject) => { reqs.push({ key, signal, resolve, reject }); });
let seen: ApiResource<string> | null = null;
function Probe({ k, refreshMs }: { k: string | null; refreshMs?: number }) {
  const r = useApiResource(k, loader(k ?? "-"), { refreshMs });
  m.React.useEffect(() => { seen = r; });
  return null;
}
const render = (k: string | null, refreshMs?: number) => m.render(m.React.createElement(Probe, { k, refreshMs }));
const flush = () => m.act(async () => {});
const state = () => [seen!.status, seen!.data, seen!.error instanceof Error ? seen!.error.message : seen!.error];
const advance = (ms: number) => m.act(() => { vi.advanceTimersByTime(ms); });
const setHidden = async (hidden: boolean) => { dom.document.hidden = hidden; await m.act(() => dom.document.dispatch("visibilitychange")); };
const begin = () => { reqs = []; seen = null; vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); };

describe("useApiResource: keyed result", () => {
  it("no key: idle, nothing asked", async () => {
    begin();
    await render(null);
    expect(state()).toEqual(["idle", null, null]);
    expect(reqs).toHaveLength(0);
  });

  it("loading → loaded; another key is loading at once (the previous key's data is not shown) and the previous request is aborted", async () => {
    begin();
    await render("a");
    expect(state()).toEqual(["loading", null, null]);
    reqs[0].resolve("A");
    await flush();
    expect(state()).toEqual(["loaded", "A", null]);
    await render("b");
    expect(state()).toEqual(["loading", null, null]);
    expect(reqs.map((r) => r.key)).toEqual(["a", "b"]);
    await render("c");
    expect(reqs[1].signal.aborted).toBe(true);
    reqs[1].resolve("B late"); // 끊긴 요청의 늦은 답
    await flush();
    expect(state()).toEqual(["loading", null, null]);
    reqs[2].resolve("C");
    await flush();
    expect(state()).toEqual(["loaded", "C", null]);
  });

  it("an error belongs to its key: the next key's loading does not show it", async () => {
    begin();
    await render("a");
    reqs[0].reject(new Error("a failed"));
    await flush();
    expect(state()).toEqual(["failed", null, "a failed"]);
    await render("b");
    expect(state()).toEqual(["loading", null, null]);
  });

  it("a new load function on each render with the same key does not ask again", async () => {
    begin();
    await render("a");
    await render("a");
    await render("a");
    expect(reqs).toHaveLength(1);
  });

  it("unmount aborts the request in flight and its answer is not applied", async () => {
    begin();
    await render("a");
    await m.unmount();
    expect(reqs[0].signal.aborted).toBe(true);
    reqs[0].resolve("A");
    await flush();
  });

  it("retry: asks again for the same key, loading in between; the previous request is aborted", async () => {
    begin();
    await render("a");
    reqs[0].reject(new Error("down"));
    await flush();
    expect(state()).toEqual(["failed", null, "down"]);
    await m.act(() => seen!.retry());
    expect(state()).toEqual(["loading", null, null]);
    expect(reqs).toHaveLength(2);
    await m.act(() => seen!.retry());
    expect(reqs[1].signal.aborted).toBe(true);
    reqs[2].resolve("A");
    await flush();
    expect(state()).toEqual(["loaded", "A", null]);
  });
});

describe("useApiResource: refreshMs", () => {
  it("refresh keeps the data while it asks; a failed refresh keeps the data and reports the error; the next success clears it", async () => {
    begin();
    await render("a", 30_000);
    reqs[0].resolve("A1");
    await flush();
    await advance(30_000);
    expect(reqs).toHaveLength(2);
    expect(state()).toEqual(["loaded", "A1", null]);
    reqs[1].reject(new Error("refresh failed"));
    await flush();
    expect(state()).toEqual(["failed", "A1", "refresh failed"]);
    await advance(30_000);
    reqs[2].resolve("A2");
    await flush();
    expect(state()).toEqual(["loaded", "A2", null]);
  });

  it("never stacks: while a request is in flight the period is skipped, and a slow answer is applied (not dropped by the next refresh)", async () => {
    begin();
    await render("a", 30_000);
    await advance(90_000); // 첫 요청이 아직 떠 있다
    expect(reqs).toHaveLength(1);
    reqs[0].resolve("slow");
    await flush();
    expect(state()).toEqual(["loaded", "slow", null]);
    await advance(30_000);
    expect(reqs).toHaveLength(2);
    expect(reqs[1].signal.aborted).toBe(false);
  });

  it("skips while the tab is hidden; shown again after a skipped period, one refresh at once", async () => {
    begin();
    await render("a", 30_000);
    reqs[0].resolve("A1");
    await flush();
    await setHidden(true);
    await advance(120_000);
    expect(reqs).toHaveLength(1);
    await setHidden(false);
    expect(reqs).toHaveLength(2);
  });

  it("a key change aborts a refresh in flight; the refresh answer is not applied to the new key", async () => {
    begin();
    await render("a", 30_000);
    reqs[0].resolve("A1");
    await flush();
    await advance(30_000);
    await render("b", 30_000);
    expect(reqs.map((r) => [r.key, r.signal.aborted])).toEqual([["a", false], ["a", true], ["b", false]]);
    reqs[1].resolve("A2");
    await flush();
    expect(state()).toEqual(["loading", null, null]);
  });
});
