// EtagPoller 의 수명(web-review B6 · PLAN W6) — stop() 뒤에 도착한 응답은 발행하지 않고, 진행 중인 요청은 끊는다.
// 레이어를 껐다 켜면 새 폴러가 store 를 쓰는데, 옛 폴러의 늦은 답이 새 상태를 덮으면 안 된다(연안 교통량 · 관측 수신 범위).
import { describe, expect, it } from "vitest";
import { EtagPoller, type EtagPollerSpec, type PollState } from "@/lib/etag-poller";

const spec: EtagPollerSpec<unknown> = { url: "/api/v1/traffic/grid", parse: (x) => x as object, intervalMs: 60_000, visibleMinGapMs: 0 };
const ok = (etag: string) => new Response(JSON.stringify({ cells: [] }), { status: 200, headers: { ETag: etag } });
const tick = () => new Promise((r) => setTimeout(r, 20));
const noWatch = () => () => {};

describe("EtagPoller after stop()", () => {
  it("does not publish a response that arrives after stop()", async () => {
    let resolveFetch!: (r: Response) => void;
    const published: PollState<unknown>[] = [];
    const p = new EtagPoller<unknown>(spec, (s) => published.push(s), undefined, () => new Promise<Response>((r) => { resolveFetch = r; }), () => false, () => 1000, noWatch);
    p.start();
    p.stop();
    resolveFetch(ok('"v1"'));
    await tick();
    expect(published).toEqual([]);
  });

  it("a stopped poller's late answer does not overwrite its replacement's state", async () => {
    const resolvers: ((r: Response) => void)[] = [];
    const fetcher = () => new Promise<Response>((r) => { resolvers.push(r); });
    let store: PollState<unknown> | null = null;
    const a = new EtagPoller<unknown>(spec, (s) => { store = s; }, undefined, fetcher, () => false, () => 1000, noWatch);
    a.start();
    a.stop();
    const b = new EtagPoller<unknown>(spec, (s) => { store = s; }, undefined, fetcher, () => false, () => 2000, noWatch);
    b.start();
    resolvers[1](ok('"v2"'));
    await tick();
    resolvers[0](ok('"v1"'));
    await tick();
    b.stop();
    expect(store!.etag).toBe('"v2"');
  });

  it("stop() aborts the request in flight, and its failure is not published as an error", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const published: PollState<unknown>[] = [];
    const fetcher = (_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => {
      signals.push(init.signal);
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const p = new EtagPoller<unknown>(spec, (s) => published.push(s), undefined, fetcher, () => false, () => 1000, noWatch);
    p.start();
    expect(signals[0]?.aborted).toBe(false);
    p.stop();
    expect(signals[0]?.aborted).toBe(true);
    await tick();
    expect(published).toEqual([]);
  });

  it("a restarted poller asks again at once, and the old request's end does not unlock a second concurrent call", async () => {
    const resolvers: ((r: Response) => void)[] = [];
    const fetcher = () => new Promise<Response>((r) => { resolvers.push(r); });
    const published: PollState<unknown>[] = [];
    const p = new EtagPoller<unknown>(spec, (s) => published.push(s), undefined, fetcher, () => false, () => 1000, noWatch);
    p.start();
    p.stop();
    p.start(); // 껐다 곧 켬 — 앞 요청이 끝나기를 기다리지 않고 새로 묻는다
    expect(resolvers).toHaveLength(2);
    resolvers[0](ok('"v1"')); // 옛 요청이 끝나도
    await tick();
    await p.poll(); // 새 요청은 아직 진행 중 — 겹쳐 부르지 않는다
    expect(resolvers).toHaveLength(2);
    resolvers[1](ok('"v2"'));
    await tick();
    p.stop();
    expect(published.map((s) => s.etag)).toEqual(['"v2"']);
  });
});
