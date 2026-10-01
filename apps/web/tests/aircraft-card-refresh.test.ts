/**
 * 항공기 카드의 30 s 상세 다시 받기(web-review B9 카드 부분): 요청이 떠 있으면 다음 주기는 겹쳐 보내지 않고, 30 s 보다 느린 답도 버리지 않는다 —
 * 전에는 주기마다 앞 요청의 답을 버리고(live=false) 새 요청을 보냈으므로, 상세 엔드포인트가 30 s 보다 느리면 카드가 상세를 끝내 받지 못했다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { resetData } from "@/lib/store";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); resetData(); });

const NOW = Date.parse("2026-09-29T02:00:00Z");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const advance = (ms: number) => m.act(() => { vi.advanceTimersByTime(ms); });
const DETAIL = (registration: string) => ({ hex: "abc123", state: null, static: { registration } });
const registration = () => m.find((e) => e.textContent === "등록번호")!.parentNode!.childNodes[1].textContent;

describe("aircraft card: the 30 s detail refresh never stacks and keeps a slow answer (web-review B9)", () => {
  it("a detail request slower than 30 s: no second request while it is in flight, and its answer is shown when it comes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
    vi.stubGlobal("self", globalThis);
    const pending: ((r: Response) => void)[] = [];
    let asked = 0;
    vi.stubGlobal("fetch", (url: string) => { if (url === "/api/v1/aircraft/abc123") asked++; return new Promise<Response>((r) => { pending.push(r); }); });
    const { AircraftCard } = await import("@/components/AircraftCard");
    await m.render(m.React.createElement(AircraftCard, { hex: "abc123" }));
    await m.settle();
    expect(asked).toBe(1);
    await advance(30_000);
    await advance(30_000);
    expect(asked).toBe(1); // 떠 있는 동안 겹쳐 보내지 않는다(전에는 2 · 3)
    pending[0](json(200, DETAIL("HL7777"))); // 65 s 쯤 도착한 첫 답
    await m.settle();
    expect(registration()).toBe("HL7777"); // 전에는 버려져 "—"
    await advance(30_000);
    expect(asked).toBe(2); // 끝난 뒤 다음 주기에는 다시 받는다
  });

  it("a failed refresh keeps the last detail and says it failed; the next answer clears it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
    vi.stubGlobal("self", globalThis);
    let n = 0;
    vi.stubGlobal("fetch", async () => (++n === 2 ? json(503, { detail: "db down", request_id: "abababababababab" }) : json(200, DETAIL(`HL${n}`))));
    const { AircraftCard } = await import("@/components/AircraftCard");
    await m.render(m.React.createElement(AircraftCard, { hex: "abc123" }));
    await m.settle();
    expect(registration()).toBe("HL1");
    await advance(30_000);
    await m.settle();
    expect(registration()).toBe("HL1");
    expect(m.byTestId("aircraft-detail-error")?.textContent).toContain("abababababababab");
    await advance(30_000);
    await m.settle();
    expect([registration(), m.byTestId("aircraft-detail-error")]).toEqual(["HL3", null]);
  });
});
