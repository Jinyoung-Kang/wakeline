/**
 * 지도 없는 실시간 피드(Q4 — components/map/useMaplessFeed 의 MaplessFeed)를 StrictMode 로 마운트한다(next dev — next.config reactStrictMode: true 처럼
 * 효과가 마운트 → 정리 → 마운트로 두 번 돈다). 살아남는 것은 두 번째 클라이언트 하나와 그 visibilitychange 듣기 하나뿐이어야 한다:
 * - 만든 클라이언트 2 · 닫기 1(첫 클라이언트) · 열린 것 1(지도 없는 구독 · 연결) · 스토어 mapless 켜짐 · 문서의 visibilitychange 듣기 1
 * - 탭이 숨겨지면 살아남은 클라이언트만 멈추고(pause) 다시 보이면 잇는다(resume) — 닫은 첫 클라이언트에는 아무것도 가지 않는다
 * - 떠나면(언마운트) 듣기 0 · 닫기 · mapless 꺼짐 — 그 뒤의 visibilitychange 는 어느 클라이언트에도 닿지 않는다
 * 전에는 숨김 처리 · 듣기 해제가 소스 정규식(statusbar.test.ts)으로만 고정돼, 듣기 등록 줄이나 해제 줄을 지워도 모든 시험이 통과했다(리뷰 F3).
 * 가짜 WS 클라이언트는 map-load-failure 의 틀(connect 로 열고 close 로 닫는다)에 클라이언트마다 부른 횟수를 적는다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { getData, resetData } from "@/lib/store";

type Calls = Record<"connect" | "subscribe" | "subscribeWithoutMap" | "close" | "pause" | "resume" | "select", number>;
interface FakeClient { calls: Calls; on: boolean }
const ctl = vi.hoisted(() => ({ clients: [] as FakeClient[] }));
vi.mock("@/lib/ws", () => ({
  WakelineWsClient: class {
    calls: Calls = { connect: 0, subscribe: 0, subscribeWithoutMap: 0, close: 0, pause: 0, resume: 0, select: 0 };
    on = false;
    constructor() { ctl.clients.push(this); }
    connect() { this.calls.connect++; this.on = true; }
    subscribe() { this.calls.subscribe++; }
    subscribeWithoutMap() { this.calls.subscribeWithoutMap++; }
    close() { this.calls.close++; this.on = false; }
    pause() { this.calls.pause++; }
    resume() { this.calls.resume++; }
    select() { this.calls.select++; }
    selectShip() { this.calls.select++; }
    setLayers() {}
  },
}));

const dom = installMiniDom();
const m = mounter(dom);
let MaplessFeed: typeof import("@/components/map/useMaplessFeed").MaplessFeed;
beforeAll(async () => { await m.load(); ({ MaplessFeed } = await import("@/components/map/useMaplessFeed")); });
afterAll(() => dom.restore());
beforeEach(() => { ctl.clients.length = 0; resetData(); });
afterEach(async () => { await m.unmount(); dom.document.hidden = false; });

const listeners = () => dom.document.listenerCount("visibilitychange");
const openClients = () => ctl.clients.filter((c) => c.on);
const total = (k: keyof Calls) => ctl.clients.reduce((n, c) => n + c.calls[k], 0);
const setHidden = async (hidden: boolean) => { dom.document.hidden = hidden; await m.act(() => dom.document.dispatch("visibilitychange")); };
async function mountStrict() {
  expect(listeners(), "no visibilitychange listener before mounting").toBe(0);
  await m.render(m.React.createElement(MaplessFeed), { strict: true });
  expect(ctl.clients).toHaveLength(2);
  return { first: ctl.clients[0], live: ctl.clients[1] };
}

describe("map-less feed under StrictMode (mount → cleanup → mount, as next dev does)", () => {
  it("of the two clients made, the first is closed and the second stays open — subscribed without a map and connected; mapless is on; one visibilitychange listener", async () => {
    const { first, live } = await mountStrict();
    expect(total("close")).toBe(1);
    expect(first.calls.close).toBe(1);
    expect(openClients()).toHaveLength(1);
    expect(openClients()[0]).toBe(live);
    expect(live.calls).toMatchObject({ subscribeWithoutMap: 1, connect: 1, subscribe: 0, select: 0, close: 0 });
    expect(getData().mapless).toBe(true);
    expect(listeners()).toBe(1);
  });

  it("a hidden tab pauses only the surviving client; showing the tab resumes it (the closed first client gets nothing)", async () => {
    const { first, live } = await mountStrict();
    await setHidden(true);
    expect(live.calls).toMatchObject({ pause: 1, resume: 0 });
    expect(first.calls).toMatchObject({ pause: 0, resume: 0 });
    await setHidden(false);
    expect(live.calls).toMatchObject({ pause: 1, resume: 1 });
    expect(first.calls).toMatchObject({ pause: 0, resume: 0 });
  });

  it("leaving removes the listener, closes the client and clears mapless; visibility events after that reach no client", async () => {
    const { live } = await mountStrict();
    await m.unmount();
    expect(listeners()).toBe(0);
    expect(live.calls.close).toBe(1);
    expect(openClients()).toHaveLength(0);
    expect(getData().mapless).toBe(false);
    await setHidden(true);
    await setHidden(false);
    expect(total("pause")).toBe(0);
    expect(total("resume")).toBe(0);
  });
});
