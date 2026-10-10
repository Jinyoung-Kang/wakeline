/**
 * 출시 QA 2차(docs/qa/2026-10-release) — 관심 대상 화면.
 * QA-712: 목록은 이 브라우저의 저장소(wakeline.watch) 하나인데, 상태(lib/watch-store)는 모듈을 불러올 때 한 번 읽고 storage 이벤트를 듣지 않는다 — 상황판을 두 탭에
 *         열어 두면, 탭 A 에서 더한 대상이 먼저 열린 탭 B 에서 무엇이든 바꾸는 순간 저장소에서 사라진다(B 가 자기 옛 목록으로 덮어쓴다).
 * QA-801: 배너의 '닫기'(그리고 관심 탭의 '지우기')는 누른 단추를 없앤다 — 초점이 문서 밖(body)으로 떨어진다. 이 프로젝트의 규칙(QA-304 · lib/focus-rescue —
 *         바뀐 내용이 누른 단추를 없애면 초점을 옮긴다, WCAG 2.4.3)과 다르다.
 * QA-803: 모바일 화면 /m 의 배너 단추 이름은 "<대상> 카드"인데 /m 에는 카드가 없다 — 알림 사건이 아니면 누르면 배너만 닫히고, 알림 사건이면 근거 화면으로 간다
 *         (이름과 동작이 다름 — WCAG 2.4.6 · 2.5.3).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "../helpers/mini-dom";
import { mounter } from "../helpers/mount";
import { resetData } from "@/lib/store";
import { useWatch } from "@/lib/watch-store";
import { WATCH_KEY, type WatchEvent } from "@/lib/watch";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => {
  await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.doUnmock("next/navigation"); resetData();
  useWatch.setState({ targets: [], banner: [], state: null, error: null, checkedAt: null, permission: "unsupported" });
});

const ev = (key: string, title: string, alertId?: number): WatchEvent & { at: number } =>
  ({ key, target: { kind: "airport", id: "RKSI" }, title, body: "METAR 기준", tone: "info", at: Date.parse("2026-10-10T03:00:00Z"), ...(alertId ? { alertId } : {}) });
const attached = (e: unknown): boolean => {
  let n = e as { parentNode?: unknown; nodeType?: number } | null;
  while (n) { if (n.nodeType === 9) return true; n = n.parentNode as typeof n; }
  return false;
};

describe("QA-712 another tab's additions are not overwritten", () => {
  it("a target added in another tab survives a change made in this tab", () => {
    const store = new Map<string, string>([[WATCH_KEY, JSON.stringify([{ kind: "aircraft", id: "71be01" }])]]);
    const listeners: ((e: { key: string | null; newValue: string | null }) => void)[] = [];
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    const add = (globalThis as unknown as { addEventListener?: unknown }).addEventListener;
    if (typeof add !== "function") vi.stubGlobal("addEventListener", (t: string, l: never) => { if (t === "storage") listeners.push(l); });
    useWatch.setState({ targets: [{ kind: "aircraft", id: "71be01" }] });                       // 이 탭(B)이 연 때의 목록
    const other = JSON.stringify([{ kind: "aircraft", id: "71be01" }, { kind: "ship", id: "440123456" }]);
    store.set(WATCH_KEY, other);                                                                 // 다른 탭(A)이 선박을 더했다
    for (const l of listeners) l({ key: WATCH_KEY, newValue: other });
    useWatch.getState().toggle({ kind: "airport", id: "RKSI" });                                 // 이 탭에서 공항을 더함
    const saved = JSON.parse(store.get(WATCH_KEY)!) as { id: string }[];
    expect(saved.map((t) => t.id)).toEqual(expect.arrayContaining(["71be01", "440123456", "RKSI"]));
  });
});

describe("QA-801 dismissing a banner event keeps focus on the page", () => {
  it("after '닫기' the focus is on an element still in the document", async () => {
    useWatch.setState({ banner: [ev("a", "공항 RKSI — 비행 등급 VFR → IFR"), ev("b", "공항 RKSS — 비행 등급 VFR → MVFR")] });
    const { WatchBanner } = await import("@/components/watch/WatchRunner");
    await m.render(m.React.createElement(WatchBanner));
    const close = m.findAll((e) => e.tagName === "BUTTON" && (e.getAttribute?.("aria-label") ?? "").startsWith("공항 RKSI"))[0];
    close.focus();
    await m.click(close);
    expect(attached(dom.document.activeElement)).toBe(true);
  });
});

describe("QA-803 /m banner button name matches what it does", () => {
  it("a non-alert event on /m is not offered as a '카드' to open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-10-10T03:00:00Z") });
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
    useWatch.setState({ banner: [ev("a", "공항 RKSI — 비행 등급 VFR → IFR")] });
    const { MobileAlerts } = await import("@/components/MobileAlerts");
    await m.render(m.React.createElement(MobileAlerts));
    await m.settle();
    const names = m.findAll((e) => e.tagName === "BUTTON", m.byTestId("watch-banner")!).map((b) => (b.textContent ?? "").trim());
    expect(names.filter((n) => n.endsWith("카드"))).toEqual([]);
  });
});
