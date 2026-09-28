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
const g = globalThis as Record<string, unknown>;
const winListeners = new Map<string, Set<(e: unknown) => void>>();
g.addEventListener = (t: string, l: (e: unknown) => void) => { if (!winListeners.has(t)) winListeners.set(t, new Set()); winListeners.get(t)!.add(l); };
g.removeEventListener = (t: string, l: (e: unknown) => void) => { winListeners.get(t)?.delete(l); };
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let ShipCard: typeof import("@/components/ShipCard").ShipCard;
const initialUi = useUi.getState();

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ ShipCard } = await import("@/components/ShipCard"));
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

beforeEach(() => {
  rec.calls.length = 0;
  rec.reply = never;
  resetData();
  useUi.setState(initialUi, true);
});
afterEach(async () => { if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); } });

describe("ship card re-reads the detail when the WS says the ship left the live list (contract v5 §B3)", () => {
  const MMSI = "431011305";
  const detail = (over: Record<string, unknown>) => ({ state: null, static: { name: "SYN BRAVO", ship_type: 70 }, first_recorded_at: "2026-09-20T01:02:03Z", last_position_at: "2026-09-28T01:00:00Z", meta: {}, ...over });

  it("picked while not live: one detail request; the server's ship_selected{state:null} does not re-read it, and the card says not live with the stored time", async () => {
    rec.reply = () => Promise.resolve(detail({}));
    await mount(React.createElement(ShipCard, { mmsi: MMSI }));
    await settle();
    await React.act(async () => setData({ shipSelected: { mmsi: MMSI, received_at: 0, static: null, state: null } }));
    await settle();
    expect(rec.calls.map((c) => c.path)).toEqual([`/api/v1/ships/${MMSI}`]);
    expect(byTestId("ship-not-live")?.textContent).toMatch(/^실시간 아님 · 마지막 저장 (09-28 )?01:00 UTC$/);
    expect(byTestId("ship-gone")).toBeNull();
  });

  it("live when the card opened, then gone: the detail is read again and the card shows the newer stored time", async () => {
    rec.reply = () => Promise.resolve(detail({ state: { lat: 35, lon: 129, sog_kn: 1, seen_at: "2026-09-28T01:00:00Z" } }));
    await mount(React.createElement(ShipCard, { mmsi: MMSI }));
    await settle();
    expect(byTestId("ship-not-live")).toBeNull();
    rec.reply = () => Promise.resolve(detail({ last_position_at: "2026-09-28T02:40:00Z" }));
    await React.act(async () => setData({ shipSelected: { mmsi: MMSI, received_at: 0, static: null, state: null } }));
    await settle();
    expect(rec.calls.map((c) => c.path)).toEqual([`/api/v1/ships/${MMSI}`, `/api/v1/ships/${MMSI}`]);
    expect(byTestId("ship-not-live")?.textContent).toMatch(/마지막 저장 (09-28 )?02:40 UTC$/);
    expect(byTestId("ship-gone")).toBeNull();
  });
});
