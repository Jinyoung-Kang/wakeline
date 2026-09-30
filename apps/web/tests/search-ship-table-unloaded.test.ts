/**
 * 통합 검색의 선박 줄은 선박 표 조각(ShipTablePart — ADR-026, 첫 화면 JS 밖)이 그린다. 그 조각을 받지 못한 동안(받는 중 · 실패) 선박 listbox · option 은
 * DOM 에 없다 — 리뷰 2026-09-30: 전에는 콤보박스의 aria-controls · aria-activedescendant 가 없는 선박 listbox · option id 를 가리키고, ↓ · Enter 가
 * 보이지 않는 선박 줄로 가서 사용자가 보지 못한 선박을 열었다. 여기서는 조각의 모듈이 받아지지 않게 두고(새 배포 뒤 옛 청크 · 오프라인과 같다) 본다.
 * MMSI · 선명 · 호출부호는 합성(SYNTHETIC) 값이다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { resetData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";

const rec = vi.hoisted(() => ({ calls: [] as string[], reply: null as ((p: string) => Promise<unknown>) | null }));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiGet: (p: string) => { rec.calls.push(p); return rec.reply ? rec.reply(p) : new Promise(() => {}); },
}));
vi.mock("@/lib/errorReport", async (orig) => ({ ...(await orig<typeof import("@/lib/errorReport")>()), reportClientError: () => "sent" }));
// 선박 표 청크를 받지 못한다(ChunkLoadError 와 같은 자리)
vi.mock("@/components/ShipTable", () => { throw new Error("Failed to load chunk (test — ShipTable)"); });

const dom = installMiniDom();
(dom.document as unknown as Record<string, unknown>).oninput = null;
const g = globalThis as Record<string, unknown>;
g.addEventListener = () => {};
g.removeEventListener = () => {};
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let AircraftSearch: typeof import("@/components/AircraftSearch").AircraftSearch;
const initialUi = useUi.getState();

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ AircraftSearch } = await import("@/components/AircraftSearch"));
});
afterAll(() => { dom.restore(); delete g.addEventListener; delete g.removeEventListener; });

let root: Root | null = null;
beforeEach(() => { rec.calls.length = 0; resetData(); useUi.setState(initialUi, true); });
afterEach(async () => { if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); } });

const find = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => {
  if (pred(from)) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
  return null;
};
const byTestId = (id: string) => find((e) => e.getAttribute("data-testid") === id);
const fire = (type: string, target: MiniElement, extra: Record<string, unknown> = {}) =>
  React.act(async () => { dom.container.dispatch(type, { type, target, bubbles: true, preventDefault() {}, stopPropagation() {}, ...extra }); });
const settle = (ms = 30) => React.act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe("search: ship rows join the combobox only once the ship table part is on the page (review 2026-09-30)", () => {
  const SHIPS = { items: [
    { mmsi: "440123456", name: "SYN ALPHA", call_sign: "D7AA", imo: null, ship_type: 70, category: "cargo", live: true, lat: 35.1, lon: 129.1, sog_kn: 12.3, seen_at: "2026-09-28T02:59:00Z", last_position_at: "2026-09-28T02:58:00Z", last_seen_at: null },
  ], meta: { q: "SYN ALPHA", count: 1 } };

  it("the part failed to load: its error shows, the combobox controls only the aircraft list, ↓ and Enter do not reach the unseen ship", async () => {
    rec.reply = (p) => Promise.resolve(p.startsWith("/api/v1/ships/") ? SHIPS : { items: [] });
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(AircraftSearch)); });
    const input = () => byTestId("aircraft-search-input")!;
    await fire("focusin", input());
    (input() as unknown as { value: string }).value = "SYN ALPHA";
    await fire("input", input());
    await settle(300);
    expect(rec.calls).toEqual(["/api/v1/aircraft/search?q=SYNALPHA", "/api/v1/ships/search?q=SYN%20ALPHA&limit=10"]); // 항공기 0건 · 선박 1건
    expect(byTestId("lazy-error")?.getAttribute("data-part")).toBe("선박 표"); // 조각은 까닭과 다시 시도를 보인다(LazyPart)
    const controls = input().getAttribute("aria-controls")!.split(" ");
    expect(controls).toHaveLength(1); // 항공기 listbox 만 — 없는 선박 listbox id 를 가리키지 않는다
    expect(find((e) => e.getAttribute("id") === controls[0])?.getAttribute("role")).toBe("listbox");
    await fire("keydown", input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    await fire("keydown", input(), { key: "Enter" });
    expect(useUi.getState().selectedShip ?? null).toBeNull(); // 보지 못한 선박을 열지 않는다
    expect(byTestId("aircraft-search-results")).not.toBeNull();
  });
});
