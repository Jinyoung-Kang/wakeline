/**
 * 관심 대상 저장소 · 관심 탭(ADR-037) — 출시 QA 2차 수정의 나머지 경로(독립 검토가 짚은 시험 공백):
 * - 다른 탭이 저장소를 바꾸면(storage 이벤트) 이 탭의 목록도 따라간다(QA-712 — 바꾸기 직전 다시 읽는 것은 tests/qa/qa-712-801-803 이 본다).
 * - 관심 탭 '지우기'는 누른 줄을 없앤다 — 초점이 다음 줄의 '지우기'로 옮겨 간다(QA-801 — 배너 '닫기'는 tests/qa 가 본다).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { WATCH_KEY } from "@/lib/watch";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("storage event from another tab", () => {
  it("replaces this tab's list with the stored one; other keys are ignored", async () => {
    const store = new Map<string, string>([[WATCH_KEY, JSON.stringify([{ kind: "aircraft", id: "71be01" }])]]);
    const listeners: ((e: { key: string | null }) => void)[] = [];
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal("addEventListener", (t: string, l: (e: { key: string | null }) => void) => { if (t === "storage") listeners.push(l); });
    vi.resetModules();
    const { useWatch } = await import("@/lib/watch-store");
    expect(useWatch.getState().targets.map((t) => t.id)).toEqual(["71be01"]);
    expect(listeners).toHaveLength(1);
    store.set(WATCH_KEY, JSON.stringify([{ kind: "aircraft", id: "71be01" }, { kind: "ship", id: "440123456" }]));
    for (const l of listeners) l({ key: "other.key" });
    expect(useWatch.getState().targets.map((t) => t.id)).toEqual(["71be01"]);
    for (const l of listeners) l({ key: WATCH_KEY });
    expect(useWatch.getState().targets.map((t) => t.id)).toEqual(["71be01", "440123456"]);
  });
});

describe("watch tab remove keeps focus", () => {
  it("after '지우기' the focus moves to the next row's remove button", async () => {
    vi.stubGlobal("self", globalThis);
    const { useWatch } = await import("@/lib/watch-store");
    useWatch.setState({ targets: [{ kind: "aircraft", id: "71be01" }, { kind: "airport", id: "RKSI" }], storage: "unavailable", state: null, banner: [] });
    const { WatchPanel } = await import("@/components/WatchPanel");
    await m.render(m.React.createElement(WatchPanel));
    const removes = () => m.findAll((e) => e.tagName === "BUTTON" && e.hasAttribute?.("data-watch-remove"));
    const first = removes()[0];
    first.focus();
    await m.click(first);
    await m.settle();
    expect(useWatch.getState().targets.map((t) => t.id)).toEqual(["RKSI"]);
    expect(dom.document.activeElement).toBe(removes()[0]);
  });
});
