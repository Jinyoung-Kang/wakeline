/**
 * 계약 v5 §B3 통합 검색 · 선박 카드의 배선(실제 react-dom 마운트 — 최소 DOM + apiGet 대역).
 * 서버 렌더 시험이 닿지 못하는 부분: 두 검색 요청(limit=10) · 새 검색어에서 이전 요청 취소 · 묶음마다 실패 문구 · 키보드 이동(항공기 → 선박) ·
 * 선박 선택의 효과(선박 레이어 켜기 · selectShip · 줌 9 이동 / 실시간 아님 → 이동 없음) · 카드가 WS "목록에 없음" 뒤 상세를 다시 받는 것.
 * MMSI·선명·호출부호는 합성(SYNTHETIC) 값이다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";

type Call = { path: string; signal: AbortSignal | undefined };
const never = (): Promise<unknown> => new Promise(() => {});
const rec = vi.hoisted(() => ({ calls: [] as Call[], reply: null as ((p: string) => Promise<unknown>) | null }));

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiGet: (p: string, init?: { signal?: AbortSignal }) => { rec.calls.push({ path: p, signal: init?.signal }); return rec.reply ? rec.reply(p) : new Promise(() => {}); },
}));

const dom = installMiniDom();
// react-dom 은 불러올 때 'oninput' in document 로 input 이벤트 지원을 본다 — 없으면 옛 IE 대체 경로(활성 요소 추적)를 써서 최소 DOM 에서 깨진다
(dom.document as unknown as Record<string, unknown>).oninput = null;
const g = globalThis as Record<string, unknown>;
const winListeners = new Map<string, Set<(e: unknown) => void>>();
g.addEventListener = (t: string, l: (e: unknown) => void) => { if (!winListeners.has(t)) winListeners.set(t, new Set()); winListeners.get(t)!.add(l); };
g.removeEventListener = (t: string, l: (e: unknown) => void) => { winListeners.get(t)?.delete(l); };
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let ShipCard: typeof import("@/components/ShipCard").ShipCard;
let AircraftSearch: typeof import("@/components/AircraftSearch").AircraftSearch;
let ApiError: typeof import("@/lib/api").ApiError;
const initialUi = useUi.getState();

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ ShipCard } = await import("@/components/ShipCard"));
  ({ AircraftSearch } = await import("@/components/AircraftSearch"));
  ({ ApiError } = await import("@/lib/api"));
});
afterAll(() => { dom.restore(); delete g.addEventListener; delete g.removeEventListener; });

let root: Root | null = null;
async function mount(el: React.ReactElement) {
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(el); });
}
const settle = (ms = 30) => React.act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const find = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => {
  if (pred(from)) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
  return null;
};
const byTestId = (id: string) => find((e) => e.getAttribute("data-testid") === id);
const findAll = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container, out: MiniElement[] = []): MiniElement[] => {
  if (pred(from)) out.push(from);
  for (const c of from.childNodes) if (c instanceof MiniElement) findAll(pred, c, out);
  return out;
};
/** React 는 루트 컨테이너에서 이벤트를 받는다 — 대상 요소를 target 으로 한 원시 이벤트를 컨테이너에 보낸다 */
const fire = (type: string, target: MiniElement, extra: Record<string, unknown> = {}) =>
  React.act(async () => { dom.container.dispatch(type, { type, target, bubbles: true, preventDefault() {}, stopPropagation() {}, ...extra }); });

beforeEach(() => {
  rec.calls.length = 0;
  rec.reply = never;
  resetData();
  useUi.setState(initialUi, true);
});
afterEach(async () => { if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); } });

describe("ship card re-reads the detail when the WS says the ship left the live list (contract v5 §B3)", () => {
  const MMSI = "431011305";
  const detail = (over: Record<string, unknown>) => ({ state: null, static: { name: "SYN BRAVO", ship_type: 70 }, first_recorded_at: "2026-09-20T01:02:03Z", last_position_at: "2026-09-28T01:00:00Z", last_seen_at: "2026-09-28T01:05:00Z", meta: {}, ...over });

  it("picked while not live: one detail request; the server's ship_selected{state:null} does not re-read it, and the card says not live with the stored time", async () => {
    rec.reply = () => Promise.resolve(detail({}));
    await mount(React.createElement(ShipCard, { mmsi: MMSI }));
    await settle();
    await React.act(async () => setData({ shipSelected: { mmsi: MMSI, received_at: 0, static: null, state: null } }));
    await settle();
    expect(rec.calls.map((c) => c.path)).toEqual([`/api/v1/ships/${MMSI}`]);
    expect(byTestId("ship-not-live")?.textContent).toMatch(/^실시간 아님 · 마지막 수신 (09-28 )?10:05 KST · 마지막 저장 (09-28 )?10:00 KST$/); // 01:05Z · 01:00Z 를 한국 표준시로
    expect(byTestId("ship-gone")).toBeNull();
  });

  it("live when the card opened, then gone: the detail is read again and the card shows the newer stored time", async () => {
    rec.reply = () => Promise.resolve(detail({ state: { lat: 35, lon: 129, sog_kn: 1, seen_at: "2026-09-28T01:00:00Z" } }));
    await mount(React.createElement(ShipCard, { mmsi: MMSI }));
    await settle();
    expect(byTestId("ship-not-live")).toBeNull();
    rec.reply = () => Promise.resolve(detail({ last_position_at: "2026-09-28T02:40:00Z", last_seen_at: "2026-09-28T02:41:00Z" }));
    await React.act(async () => setData({ shipSelected: { mmsi: MMSI, received_at: 0, static: null, state: null } }));
    await settle();
    expect(rec.calls.map((c) => c.path)).toEqual([`/api/v1/ships/${MMSI}`, `/api/v1/ships/${MMSI}`]);
    expect(byTestId("ship-not-live")?.textContent).toMatch(/마지막 수신 (09-28 )?11:41 KST · 마지막 저장 (09-28 )?11:40 KST$/);
    expect(byTestId("ship-gone")).toBeNull();
  });
});

describe("unified search wiring (contract v5 §B1/§B3)", () => {
  const input = () => byTestId("aircraft-search-input")!;
  async function typeText(v: string) {
    const el = input();
    (el as unknown as { value: string }).value = v;
    await fire("input", el);
  }
  const key = (k: string) => fire("keydown", input(), { key: k });
  const paths = () => rec.calls.map((c) => c.path);
  const AIRCRAFT = { items: [{ hex: "71c081", callsign: "SYN081", alt_ft: 34000, lat: 36, lon: 127 }] };
  const SHIPS = { items: [
    // api-ships 레인의 응답 모양(항목마다 계약의 13 키 — §G4 last_seen_at 포함, 모르는 값은 null)
    { mmsi: "440123456", name: "SYN ALPHA", call_sign: "D7AA", imo: 9811000, ship_type: 70, category: "cargo", live: true, lat: 35.1, lon: 129.1, sog_kn: 12.3, seen_at: "2026-09-28T02:59:00Z", last_position_at: "2026-09-28T02:58:00Z", last_seen_at: null },
    { mmsi: "440999999", name: "SYN BRAVO", call_sign: null, imo: null, ship_type: 80, category: "tanker", live: false, lat: null, lon: null, sog_kn: null, seen_at: null, last_position_at: "2026-09-28T01:00:00Z", last_seen_at: "2026-09-28T01:05:00Z" },
  ], meta: { q: "SYN", count: 2 } };

  beforeEach(() => { useUi.setState({ layers: { ...initialUi.layers, ships: false } }); });

  it("one query → both searches in parallel (ships with limit=10); a new query aborts the pending ones", async () => {
    await mount(React.createElement(AircraftSearch));
    await typeText("sy");
    await settle(300); // 디바운스 250 ms
    expect(paths()).toEqual(["/api/v1/aircraft/search?q=SY", "/api/v1/ships/search?q=SY&limit=10"]);
    const first = rec.calls.map((c) => c.signal);
    await typeText("syn a");
    await settle(300);
    expect(first.every((sig) => sig?.aborted)).toBe(true);
    // 공백이 든 검색어: 항공기 규칙(공백 제거)과 선박 규칙(공백 유지)이 따로
    expect(paths().slice(2)).toEqual(["/api/v1/aircraft/search?q=SYNA", "/api/v1/ships/search?q=SYN%20A&limit=10"]);
    expect(rec.calls.slice(2).every((c) => !c.signal?.aborted)).toBe(true);
  });

  it("a group that fails says why (404 = server without ship search) while the other group keeps its results", async () => {
    rec.reply = (p) => (p.startsWith("/api/v1/ships/") ? Promise.reject(new ApiError(404, "Not Found")) : Promise.resolve(AIRCRAFT));
    await mount(React.createElement(AircraftSearch));
    await typeText("SYN");
    await settle(300);
    const results = byTestId("aircraft-search-results")!;
    expect(results.textContent).toContain("선박 검색을 쓸 수 없음(HTTP 404 — 서버가 지원하지 않음)");
    expect(findAll((e) => e.getAttribute("data-testid") === "aircraft-search-item")).toHaveLength(1);
  });

  it("the ship search answered without the DB (meta.db_unavailable): the group says the results come from the live list only", async () => {
    rec.reply = (p) => Promise.resolve(p.startsWith("/api/v1/ships/") ? { items: [{ ...SHIPS.items[0], last_position_at: null }], meta: { q: "SYN", count: 1, db_unavailable: true } } : AIRCRAFT);
    await mount(React.createElement(AircraftSearch));
    await typeText("SYN");
    await settle(300);
    expect(byTestId("ship-search-db-note")?.textContent).toBe("선박 DB 일시 사용 불가 — 실시간 목록에서만 찾았습니다(실시간이 아닌 선박·마지막 저장 시각은 빠짐)");
    rec.reply = (p) => Promise.resolve(p.startsWith("/api/v1/ships/") ? SHIPS : AIRCRAFT);
    await typeText("SYNA");
    await settle(300);
    expect(byTestId("ship-search-db-note")).toBeNull();
  });

  it("↑/↓ moves across both groups (aircraft → ships); the combobox controls both listboxes and points at the active option", async () => {
    rec.reply = (p) => Promise.resolve(p.startsWith("/api/v1/ships/") ? SHIPS : AIRCRAFT);
    await mount(React.createElement(AircraftSearch));
    await typeText("SYN");
    await settle(300);
    const [aList, sList] = input().getAttribute("aria-controls")!.split(" ");
    expect(find((e) => e.getAttribute("id") === aList)?.getAttribute("role")).toBe("listbox");
    expect(find((e) => e.getAttribute("id") === sList)?.getAttribute("role")).toBe("listbox");
    await key("ArrowDown");
    const a = input().getAttribute("aria-activedescendant")!;
    expect(find((e) => e.getAttribute("id") === a)?.getAttribute("role")).toBe("option");
    expect(find((e) => e.getAttribute("id") === a)?.getAttribute("data-testid")).toBe("aircraft-search-item");
    await key("ArrowDown");
    const s1 = find((e) => e.getAttribute("id") === input().getAttribute("aria-activedescendant"))!;
    expect(s1.getAttribute("role")).toBe("option");
    expect(s1.getAttribute("data-mmsi")).toBe("440123456");
    expect(s1.getAttribute("aria-selected")).toBe("true");
    expect(find((e) => e.getAttribute("id") === sList)!.contains(s1)).toBe(true);
    await key("ArrowDown");
    await key("ArrowDown"); // 끝에서 처음으로
    expect(input().getAttribute("aria-activedescendant")).toBe(a);
  });

  it("keyboard users can reach the ship sort headers: Tab into the results keeps them open, leaving the search closes them, Esc returns to the input", async () => {
    rec.reply = (p) => Promise.resolve(p.startsWith("/api/v1/ships/") ? SHIPS : AIRCRAFT);
    await mount(React.createElement(AircraftSearch));
    await typeText("SYN");
    await settle(300);
    const sortBtn = byTestId("ship-search-sort-sog")!;
    await fire("focusout", input(), { relatedTarget: sortBtn }); // Tab: 입력 → 정렬 단추
    expect(byTestId("aircraft-search-results")).not.toBeNull();
    await fire("click", sortBtn);
    expect(byTestId("ship-search-sort-sog")!.getAttribute("aria-label")).toBe("속력 기준 정렬 — 지금 내림차순");
    let focused = 0;
    (input() as unknown as { focus: () => void }).focus = () => { focused++; };
    await fire("keydown", byTestId("ship-search-sort-sog")!, { key: "Escape" });
    expect(focused).toBe(1);
    expect(byTestId("aircraft-search-results")).toBeNull();
    await fire("focusin", input());
    expect(byTestId("aircraft-search-results")).not.toBeNull();
    await fire("focusout", input(), { relatedTarget: null }); // 검색 밖으로
    expect(byTestId("aircraft-search-results")).toBeNull();
  });

  it("choosing a live ship: turns the ships layer on, selects it and flies to zoom 9", async () => {
    rec.reply = (p) => Promise.resolve(p.startsWith("/api/v1/ships/") ? SHIPS : { items: [] });
    await mount(React.createElement(AircraftSearch));
    await typeText("SYN");
    await settle(300);
    await key("ArrowDown");
    await key("Enter");
    const ui = useUi.getState();
    expect(ui.layers.ships).toBe(true);
    expect(ui.selectedShip).toBe("440123456");
    expect(ui.flyTo).toMatchObject({ lon: 129.1, lat: 35.1, zoom: 9 });
    expect(byTestId("aircraft-search-results")).toBeNull(); // 고르면 닫힌다
  });

  it("choosing a ship that is not live: card only — selected, no map move, the not-live text with the stored time", async () => {
    rec.reply = (p) => Promise.resolve(p.startsWith("/api/v1/ships/") ? SHIPS : { items: [] });
    await mount(React.createElement(AircraftSearch));
    await typeText("SYN");
    await settle(300);
    await key("ArrowDown");
    await key("ArrowDown");
    await key("Enter");
    const ui = useUi.getState();
    expect(ui.selectedShip).toBe("440999999");
    expect(ui.flyTo).toBeNull();
    const status = find((e) => e.getAttribute("aria-live") === "polite")!;
    expect(status.textContent).toMatch(/^SYN BRAVO 선택 — 실시간 아님 · 마지막 수신 (09-28 )?10:05 KST · 마지막 저장 (09-28 )?10:00 KST · 카드만/);
  });
});
