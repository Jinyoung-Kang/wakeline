/**
 * 재생 시각 슬라이더(사용자 영상 2026-09-29 14:22): 끄는 동안 슬라이더의 폭·위치가 바뀌어 손잡이가 커서에서 떨어졌다.
 * 원인 — 슬라이더(flex-1 · min-w 200px)가 길이가 바뀌는 상태 글자("1분 요약 구간(72 h 밖) … 불러오는 중" ↔ "원해상도 구간(72 h 안) … 308 aircraft …")와
 * 한 flex-wrap 줄을 나눠 써서, 글자 길이에 따라 줄바꿈 위치와 남는 폭이 달라졌다(영상에서 약 160 ↔ 380 px).
 * - 레이아웃: 슬라이더는 자기 줄에 혼자 있다(폭 = 줄 폭). 상태 글자는 높이가 고정된 한 줄(넘치면 잘림)에 따로.
 * - 동작: 시각 라벨은 입력마다 바로 바뀌고, 기록 요청은 debounce 뒤 마지막 값 하나만 — 사용자가 옮기면 보내는 중인 이전 요청은 "낡음"으로 표시해
 *   그 응답·실패를 반영하지 않는다. 새 요청은 그 요청이 끝난 뒤에 보낸다: 브라우저가 fetch 를 끊어도(AbortController) 서버는 그 요청의 조회
 *   (HistoryController.replay — publicRead 최대 4문장, 각 3 s 상한)를 끝까지 돌므로, 끊고 바로 보내면 탭 하나가 서버에 요청을 여러 개 겹쳐 둔다
 *   (리뷰 2026-09-29). 서버 쪽 동시 요청은 탭당 1개(R-47 과 같은 불변식). 재생(▶) 중에는 응답을 그대로 그리고 끝나면 최신 값을 보낸다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReplayPage from "@/app/replay/page";
import * as R from "@/lib/replay";
import { ancestors, byTestId, classes, elements, findAll, parseHtml, textOf, type HNode } from "./helpers/html-tree";

const page = () => parseHtml(renderToStaticMarkup(createElement(ReplayPage)));
const isFlex = (n: HNode) => classes(n).has("flex") || classes(n).has("inline-flex") || classes(n).has("grid");

describe("replay slider geometry does not depend on any text", () => {
  it("the range input sits alone in its own row (only its tick datalist beside it)", () => {
    const root = page();
    const ranges = findAll(root, (n) => n.tag === "input" && n.attrs.type === "range");
    expect(ranges).toHaveLength(1);
    const slider = ranges[0];
    const row = slider.parent!;
    expect(row.attrs["data-testid"]).toBe("replay-slider-row");
    expect(elements(row).map((n) => n.tag)).toEqual(["input", "datalist"]);
    expect(row.children.filter((c) => c.tag === "#text" && c.text.trim())).toEqual([]);
    // 폭은 줄 폭 그대로 — 형제 글자에 따라 늘고 주는 flex 항목이 아니다
    expect(classes(slider).has("w-full")).toBe(true);
    for (const c of ["flex-1", "grow", "shrink", "min-w-[200px]"]) expect(classes(slider).has(c)).toBe(false);
  });
  it("no flex container lays the slider out together with a variable-length status text; status texts come after (below) the slider", () => {
    const root = page();
    const slider = findAll(root, (n) => n.tag === "input" && n.attrs.type === "range")[0];
    const all = findAll(root, () => true);
    // 페이지 전체(flex-col: 도구 묶음 · 지도)는 flex 지만 슬라이더와 상태 글자는 그 안의 한 블록(도구 묶음) 안에 있다 — 둘을 함께 담은
    // 가장 가까운 조상이 flex/grid 가 아니면 상태 글자의 길이가 슬라이더의 폭 · 줄바꿈을 바꿀 수 없다.
    const status = ["replay-at", "replay-frame-at", "replay-summary", "replay-radar"].map((id) => byTestId(root, id)!);
    const up = new Set(ancestors(slider));
    for (const t of status) {
      expect(t, "status text rendered").not.toBeNull();
      const common = ancestors(t).find((a) => up.has(a))!;
      expect(isFlex(common), `${t.attrs["data-testid"]} and the slider share flex container "${common.attrs.class}"`).toBe(false);
      expect(all.indexOf(t)).toBeGreaterThan(all.indexOf(slider)); // 위에서 줄이 늘어 슬라이더를 밀어 내리지 않는다
    }
  });
  it("status texts live in one fixed-height, single-line row that clips instead of wrapping; numbers are tabular", () => {
    const root = page();
    const row = byTestId(root, "replay-status")!;
    expect(row).not.toBeNull();
    const c = classes(row);
    expect(c.has("h-5")).toBe(true);
    expect(c.has("overflow-hidden")).toBe(true);
    expect(c.has("whitespace-nowrap")).toBe(true);
    for (const id of ["replay-at", "replay-frame-at", "replay-summary", "replay-radar"]) expect(byTestId(row, id), id).not.toBeNull(); // replay-zone 은 시각을 안 뒤에만
    // 시각 라벨은 잘리지 않고(shrink-0) 고정폭 숫자, 긴 글자는 잘리고 전체는 title 에
    expect(classes(byTestId(row, "replay-at")!).has("shrink-0")).toBe(true);
    expect(classes(byTestId(row, "replay-at")!).has("mono")).toBe(true);
    for (const id of ["replay-frame-at", "replay-summary", "replay-radar"]) expect(classes(byTestId(row, id)!).has("truncate"), id).toBe(true);
  });
  it("the slider row comes before the status row and after the controls (the controls row holds only fixed-width buttons and the time input)", () => {
    const root = page();
    const controls = byTestId(root, "replay-controls")!;
    expect(controls).not.toBeNull();
    const all = findAll(root, () => true);
    const idx = (id: string) => all.indexOf(byTestId(root, id)!);
    expect(idx("replay-controls")).toBeLessThan(idx("replay-slider-row"));
    expect(idx("replay-slider-row")).toBeLessThan(idx("replay-status"));
    for (const id of ["replay-at", "replay-zone", "replay-frame-at", "replay-summary", "replay-radar"]) expect(byTestId(controls, id), id).toBeNull();
  });
});

describe("the loading signal is never the first thing clipped on a narrow row", () => {
  // 재생 시각(KST, 약 23자)과 구간 라벨은 shrink-0 이라 휴대폰 폭에서는 줄을 거의 채운다 — "불러오는 중" 이 잘리는 글자의 꼬리에 있으면 먼저 사라졌다(리뷰 2026-09-29)
  const range = { min: Date.parse("2026-08-30T00:00:00Z"), max: Date.parse("2026-09-29T05:00:00Z"), fullResFrom: Date.parse("2026-09-26T05:00:00Z") };
  const at = Date.parse("2026-09-29T04:50:00Z");
  const frame = (iso: string): R.ReplayFrame => ({ at: iso, aircraft: [], sigmets: [], source: "track_point" });
  const row = async (f: R.ReplayFrame | null) => {
    const { ReplayStatusRow } = await import("@/components/ReplayStatus");
    return parseHtml(renderToStaticMarkup(createElement(ReplayStatusRow, { at, range, frame: f, latencyMs: 42 })));
  };
  it("behind (the map still shows another time): a short shrink-0 badge right after the replay time, before every clipping text", async () => {
    const root = await row(frame("2026-09-29T04:40:00Z"));
    const badge = byTestId(root, "replay-loading")!;
    expect(badge).not.toBeNull();
    expect(badge.children.map((c) => (c.tag === "#text" ? c.text : "")).join("")).toBe("불러오는 중");
    expect(classes(badge).has("shrink-0")).toBe(true);
    expect(classes(badge).has("text-warn")).toBe(true);
    const all = findAll(root, () => true);
    const idx = (id: string) => all.indexOf(byTestId(root, id)!);
    expect(idx("replay-loading")).toBeGreaterThan(idx("replay-at"));
    for (const id of ["replay-zone", "replay-frame-at", "replay-summary", "replay-radar"]) expect(idx("replay-loading"), id).toBeLessThan(idx(id));
    // 잘리는 글자에는 더 이상 싣지 않는다(두 번 말하지 않는다)
    const frameAt = byTestId(root, "replay-frame-at")!;
    expect(textOf(frameAt)).not.toContain("불러오는 중");
    expect(textOf(frameAt)).toContain("지도 2026-09-29 13:40:00 KST"); // 지도가 아직 그린 시각
  });
  it("caught up (the map shows the replay time): no badge", async () => {
    expect(byTestId(await row(frame(new Date(at).toISOString())), "replay-loading")).toBeNull();
  });
  it("the page uses the status row component", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("../app/replay/page.tsx", import.meta.url), "utf8")).toMatch(/<ReplayStatusRow at=\{at\} range=\{range\} frame=\{frame\} latencyMs=\{latency\} \/>/);
  });
});

describe("dragging: debounced requests, stale responses dropped, at most one request per tab at the server, the last value wins", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /**
   * fetch 모형 — 브라우저 쪽(clientActive: 기다리는 promise)과 서버 쪽(serverActive: 서버가 아직 처리 중인 요청)을 따로 센다.
   * abort 는 브라우저만 멈춘다(promise 가 곧바로 AbortError 로 끝남). 서버는 pending[i].resolve/reject(= 서버가 응답을 끝냄) 때까지 그 요청을 계속 처리한다.
   */
  function harness() {
    let clientActive = 0, maxClientActive = 0, serverActive = 0, maxServerActive = 0, startedWhileServerBusy = 0;
    const calls: R.ReplayReq[] = [];
    const aborted: R.ReplayReq[] = [];
    const pending: { r: R.ReplayReq; resolve: (f: R.ReplayFrame) => void; reject: (e: unknown) => void; signal: AbortSignal }[] = [];
    const events: { type: string; at?: string }[] = [];
    const loader = new R.ReplayLoader(
      (r, signal) => {
        calls.push(r);
        if (serverActive > 0) startedWhileServerBusy++;
        serverActive++; maxServerActive = Math.max(maxServerActive, serverActive);
        clientActive++; maxClientActive = Math.max(maxClientActive, clientActive);
        return new Promise<R.ReplayFrame>((resolve, reject) => {
          let clientDone = false, serverDone = false;
          const serverFinish = () => { if (!serverDone) { serverDone = true; serverActive--; } };
          const clientFinish = () => { if (clientDone) return false; clientDone = true; clientActive--; return true; };
          signal?.addEventListener("abort", () => { if (clientFinish()) { aborted.push(r); reject(new DOMException("aborted", "AbortError")); } });
          pending.push({
            r, signal: signal!,
            resolve: (f) => { serverFinish(); if (clientFinish()) resolve(f); },
            reject: (e) => { serverFinish(); if (clientFinish()) reject(e); },
          });
        });
      },
      (e) => events.push(e.type === "loaded" ? { type: e.type, at: e.frame.at } : { type: e.type }),
    );
    const frame = (r: R.ReplayReq): R.ReplayFrame => ({ at: new Date(r.at).toISOString(), aircraft: [], sigmets: [], source: "track_point" });
    return {
      calls, aborted, pending, events, loader, frame,
      get clientActive() { return clientActive; }, get maxClientActive() { return maxClientActive; },
      get serverActive() { return serverActive; }, get maxServerActive() { return maxServerActive; }, get startedWhileServerBusy() { return startedWhileServerBusy; },
    };
  }
  const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

  it("a burst of input events sends one request after the pause, for the last value", async () => {
    const h = harness();
    for (let i = 1; i <= 40; i++) { h.loader.schedule({ at: i * 10_000, bbox: "b" }, { supersede: true }); await vi.advanceTimersByTimeAsync(16); }
    expect(h.calls).toEqual([]); // 끄는 동안(16 ms 간격)은 보내지 않는다
    await vi.advanceTimersByTimeAsync(R.REPLAY_DEBOUNCE_MS);
    expect(h.calls).toEqual([{ at: 400_000, bbox: "b" }]);
    h.pending[0].resolve(h.frame(h.pending[0].r));
    await flush();
    expect(h.events).toEqual([{ type: "loaded", at: new Date(400_000).toISOString() }]);
  });

  it("stop-and-go drag: no request starts while an earlier one is still running at the server; stale responses are not drawn; the last value is drawn", async () => {
    const h = harness();
    // 끌다 멈추고(요청 1 보냄 — 서버가 느림) · 다시 끌다 멈추고 · 다시 — 요청 1 이 서버에서 끝나기 전
    for (const burst of [[1, 2, 3], [4, 5, 6, 7], [8, 9]]) {
      for (const v of burst) { h.loader.schedule({ at: v * 60_000, bbox: "b" }, { supersede: true }); await vi.advanceTimersByTimeAsync(16); }
      await vi.advanceTimersByTimeAsync(R.REPLAY_DEBOUNCE_MS);
    }
    // 수정 전: 요청 1·2 를 끊고 곧바로 2·3 을 보냈다 — calls [3, 7, 9], 서버에는 셋이 겹쳐 있었다(serverActive 3)
    expect(h.calls.map((r) => r.at / 60_000)).toEqual([3]);
    expect(h.startedWhileServerBusy).toBe(0);
    expect(h.serverActive).toBe(1);
    h.pending[0].resolve(h.frame(h.pending[0].r)); // 서버가 요청 1 을 끝냄 — 이미 낡았다(그리지 않는다)
    await flush();
    expect(h.events).toEqual([]);
    expect(h.calls.map((r) => r.at / 60_000)).toEqual([3, 9]); // 중간 값(7)은 건너뛰고 마지막 값만
    h.pending[1].resolve(h.frame(h.pending[1].r));
    await flush();
    expect(h.events).toEqual([{ type: "loaded", at: new Date(9 * 60_000).toISOString() }]);
    expect(h.maxServerActive).toBe(1);
    expect(h.startedWhileServerBusy).toBe(0);
    expect(h.maxClientActive).toBe(1);
  });

  it("a response that arrives after its request was superseded is never drawn; the newer request is sent once it settles", async () => {
    const h = harness();
    h.loader.request({ at: 1_000, bbox: "b" }, { supersede: true });
    h.loader.request({ at: 2_000, bbox: "b" }, { supersede: true });
    expect(h.calls.map((r) => r.at)).toEqual([1_000]);
    h.pending[0].resolve(h.frame(h.pending[0].r)); // 낡음 — 무시
    await flush();
    expect(h.events).toEqual([]);
    expect(h.calls.map((r) => r.at)).toEqual([1_000, 2_000]);
    h.pending[1].resolve(h.frame(h.pending[1].r));
    await flush();
    expect(h.events).toEqual([{ type: "loaded", at: new Date(2_000).toISOString() }]);
    expect(h.maxServerActive).toBe(1);
  });

  it("a superseded request that fails is not reported (the map is not cleared) and the newer request is still sent", async () => {
    const h = harness();
    h.loader.request({ at: 1_000, bbox: "b" }, { supersede: true });
    h.loader.request({ at: 2_000, bbox: "b" }, { supersede: true });
    h.pending[0].reject(new Error("boom"));
    await flush();
    expect(h.events).toEqual([]);
    expect(h.calls.map((r) => r.at)).toEqual([1_000, 2_000]);
  });

  it("moving back to the time already in flight keeps it: no re-send, and its response is drawn", async () => {
    const h = harness();
    h.loader.request({ at: 1_000, bbox: "b" }, { supersede: true });
    h.loader.request({ at: 2_000, bbox: "b" }, { supersede: true }); // 1 000 은 낡음
    h.loader.request({ at: 1_000, bbox: "b" }, { supersede: true }); // 다시 1 000 — 보내는 중인 그것이 다시 최신
    h.pending[0].resolve(h.frame(h.pending[0].r));
    await flush();
    expect(h.calls.map((r) => r.at)).toEqual([1_000]);
    expect(h.events).toEqual([{ type: "loaded", at: new Date(1_000).toISOString() }]);
  });

  it("the same (at, bbox) as the one in flight is not cancelled or re-sent", async () => {
    const h = harness();
    h.loader.request({ at: 1_000, bbox: "b" }, { supersede: true });
    h.loader.schedule({ at: 1_000, bbox: "b" }, { supersede: true });
    await vi.advanceTimersByTimeAsync(R.REPLAY_DEBOUNCE_MS);
    expect(h.calls).toHaveLength(1);
    expect(h.aborted).toEqual([]);
  });

  it("while playing (no supersede) a slow request is not cancelled: its frame is drawn and the latest tick is sent when it finishes (R-47)", async () => {
    const h = harness();
    for (let i = 1; i <= 5; i++) { h.loader.schedule({ at: i * 10_000, bbox: "b" }, { supersede: false }); await vi.advanceTimersByTimeAsync(1_000); }
    expect(h.calls.map((r) => r.at)).toEqual([10_000]); // 첫 요청이 아직 끝나지 않았다
    expect(h.aborted).toEqual([]);
    h.pending[0].resolve(h.frame(h.pending[0].r));
    await flush();
    expect(h.events).toEqual([{ type: "loaded", at: new Date(10_000).toISOString() }]);
    expect(h.calls.map((r) => r.at)).toEqual([10_000, 50_000]);
    expect(h.maxServerActive).toBe(1);
  });

  it("dispose cancels the pending debounce and aborts the request in flight (nothing new is started)", async () => {
    const h = harness();
    h.loader.request({ at: 1_000, bbox: "b" });
    h.loader.schedule({ at: 2_000, bbox: "b" }, { supersede: true });
    h.loader.dispose();
    await vi.advanceTimersByTimeAsync(R.REPLAY_DEBOUNCE_MS * 2);
    expect(h.calls).toHaveLength(1);
    expect(h.aborted).toHaveLength(1);
    h.pending[0].resolve(h.frame(h.pending[0].r));
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.events).toEqual([]);
  });
});

describe("the page wires the loader: fetch gets the abort signal; user moves supersede, playback ticks do not", () => {
  it("source check", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../app/replay/page.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/apiGet<ReplayFrame>\(replayApiPath\(r\), \{ signal \}\)/);
    expect(src).toMatch(/\.schedule\(\{ at, bbox \}, \{ supersede: !playingRef\.current \}\)/);
    expect(src).not.toMatch(/setTimeout\(\(\) => loader\.current\?\.request/); // 페이지의 따로 된 debounce 는 없앴다(로더 하나가 맡는다)
  });
});
