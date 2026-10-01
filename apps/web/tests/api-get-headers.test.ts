// apiGet 의 요청 머리(web-review B16 · PLAN W16): 부른 쪽이 준 머리는 형식(객체 · Headers · 배열)과 상관없이 보낸다 —
// 전에는 객체 펼치기({ ...init.headers })라 Headers 인스턴스의 값이 말없이 빠졌다. 기본 Accept 는 부른 쪽이 정하지 않았을 때만.
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

function capture() {
  const sent: RequestInit[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { sent.push(init); return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }); });
  return sent;
}
const header = (init: RequestInit, k: string) => new Headers(init.headers).get(k);
const DEFAULT_ACCEPT = "application/json, application/geo+json, application/problem+json";

describe("apiGet request headers", () => {
  it("keeps the caller's headers given as a Headers instance, an object or pairs, with the default Accept", async () => {
    const sent = capture();
    await apiGet("/x", { headers: new Headers({ "X-Probe": "h" }) });
    await apiGet("/x", { headers: { "X-Probe": "o" } });
    await apiGet("/x", { headers: [["X-Probe", "p"]] });
    expect(sent.map((i) => header(i, "X-Probe"))).toEqual(["h", "o", "p"]);
    expect(sent.map((i) => header(i, "Accept"))).toEqual([DEFAULT_ACCEPT, DEFAULT_ACCEPT, DEFAULT_ACCEPT]);
  });

  it("a caller's Accept replaces the default; other init fields (signal) pass through; credentials stay same-origin", async () => {
    const sent = capture();
    const ctl = new AbortController();
    await apiGet("/x", { headers: new Headers({ Accept: "text/plain" }), signal: ctl.signal });
    await apiGet("/x");
    expect(header(sent[0], "Accept")).toBe("text/plain");
    expect(sent[0].signal).toBe(ctl.signal);
    expect(header(sent[1], "Accept")).toBe(DEFAULT_ACCEPT);
    expect(sent.every((i) => i.credentials === "same-origin")).toBe(true);
  });
});
