/**
 * 재생 시각 슬라이더(사용자 영상 2026-09-29 14:22): 끄는 동안 슬라이더의 폭·위치가 바뀌어 손잡이가 커서에서 떨어졌다.
 * 원인 — 슬라이더(flex-1 · min-w 200px)가 길이가 바뀌는 상태 글자("1분 요약 구간(72 h 밖) … 불러오는 중" ↔ "원해상도 구간(72 h 안) … 308 aircraft …")와
 * 한 flex-wrap 줄을 나눠 써서, 글자 길이에 따라 줄바꿈 위치와 남는 폭이 달라졌다(영상에서 약 160 ↔ 380 px).
 * - 레이아웃: 슬라이더는 자기 줄에 혼자 있다(폭 = 줄 폭). 상태 글자는 높이가 고정된 한 줄(넘치면 잘림)에 따로.
 * - 동작: 시각 라벨은 입력마다 바로 바뀌고, 기록 요청은 debounce 뒤 마지막 값 하나만 — 사용자가 옮기면 보내는 중인 이전 요청은 취소(AbortController).
 *   재생(▶) 중에는 취소하지 않고 끝나면 최신 값을 보낸다(R-47 — 응답이 느려도 프레임이 계속 온다).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReplayPage from "@/app/replay/page";
import * as R from "@/lib/replay";
import { ancestors, byTestId, classes, elements, findAll, parseHtml, type HNode } from "./helpers/html-tree";

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

describe("dragging: debounced requests, stale ones cancelled, at most one in flight, the last value wins", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function harness() {
    let active = 0, maxActive = 0;
    const calls: R.ReplayReq[] = [];
    const aborted: R.ReplayReq[] = [];
    const pending: { r: R.ReplayReq; resolve: (f: R.ReplayFrame) => void; signal: AbortSignal }[] = [];
    const events: { type: string; at?: string }[] = [];
    const loader = new R.ReplayLoader(
      (r, signal) => {
        calls.push(r);
        active++; maxActive = Math.max(maxActive, active);
        return new Promise<R.ReplayFrame>((resolve, reject) => {
          let done = false;
          signal?.addEventListener("abort", () => { if (done) return; done = true; active--; aborted.push(r); reject(new DOMException("aborted", "AbortError")); });
          pending.push({ r, signal: signal!, resolve: (f) => { if (done) return; done = true; active--; resolve(f); } });
        });
      },
      (e) => events.push(e.type === "loaded" ? { type: e.type, at: e.frame.at } : { type: e.type }),
    );
    const frame = (r: R.ReplayReq): R.ReplayFrame => ({ at: new Date(r.at).toISOString(), aircraft: [], sigmets: [], source: "track_point" });
    return { calls, aborted, pending, events, loader, frame, get active() { return active; }, get maxActive() { return maxActive; } };
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

  it("moving again while a request is in flight aborts it; never more than one in flight; the last value is drawn", async () => {
    const h = harness();
    // 끌다 멈추고(요청 1 보냄) · 다시 끌다 멈추고(요청 1 취소, 요청 2) · 다시(요청 2 취소, 요청 3)
    for (const burst of [[1, 2, 3], [4, 5, 6, 7], [8, 9]]) {
      for (const v of burst) { h.loader.schedule({ at: v * 60_000, bbox: "b" }, { supersede: true }); await vi.advanceTimersByTimeAsync(16); }
      await vi.advanceTimersByTimeAsync(R.REPLAY_DEBOUNCE_MS);
    }
    expect(h.calls.map((r) => r.at / 60_000)).toEqual([3, 7, 9]);
    expect(h.aborted.map((r) => r.at / 60_000)).toEqual([3, 7]);
    expect(h.maxActive).toBe(1);
    expect(h.active).toBe(1);
    // 취소된 요청은 실패로 알리지 않는다(지도를 비우지 않는다)
    await flush();
    expect(h.events).toEqual([]);
    h.pending[2].resolve(h.frame(h.pending[2].r));
    await flush();
    expect(h.events).toEqual([{ type: "loaded", at: new Date(9 * 60_000).toISOString() }]);
  });

  it("a response that arrives after its request was superseded is never drawn", async () => {
    const h = harness();
    h.loader.request({ at: 1_000, bbox: "b" }, { supersede: true });
    h.loader.request({ at: 2_000, bbox: "b" }, { supersede: true });
    h.pending[0].resolve(h.frame(h.pending[0].r)); // 이미 취소됨 — 무시
    h.pending[1].resolve(h.frame(h.pending[1].r));
    await flush();
    expect(h.events).toEqual([{ type: "loaded", at: new Date(2_000).toISOString() }]);
  });

  it("the same (at, bbox) as the one in flight is not cancelled or re-sent", async () => {
    const h = harness();
    h.loader.request({ at: 1_000, bbox: "b" }, { supersede: true });
    h.loader.schedule({ at: 1_000, bbox: "b" }, { supersede: true });
    await vi.advanceTimersByTimeAsync(R.REPLAY_DEBOUNCE_MS);
    expect(h.calls).toHaveLength(1);
    expect(h.aborted).toEqual([]);
  });

  it("while playing (no supersede) a slow request is not cancelled: the latest tick is sent when it finishes (R-47)", async () => {
    const h = harness();
    for (let i = 1; i <= 5; i++) { h.loader.schedule({ at: i * 10_000, bbox: "b" }, { supersede: false }); await vi.advanceTimersByTimeAsync(1_000); }
    expect(h.calls.map((r) => r.at)).toEqual([10_000]); // 첫 요청이 아직 끝나지 않았다
    expect(h.aborted).toEqual([]);
    h.pending[0].resolve(h.frame(h.pending[0].r));
    await flush();
    expect(h.calls.map((r) => r.at)).toEqual([10_000, 50_000]);
    expect(h.maxActive).toBe(1);
  });

  it("dispose cancels the pending debounce and aborts the request in flight", async () => {
    const h = harness();
    h.loader.request({ at: 1_000, bbox: "b" });
    h.loader.schedule({ at: 2_000, bbox: "b" }, { supersede: true });
    h.loader.dispose();
    await vi.advanceTimersByTimeAsync(R.REPLAY_DEBOUNCE_MS * 2);
    expect(h.calls).toHaveLength(1);
    expect(h.aborted).toHaveLength(1);
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
