/**
 * 항공기 카드의 행 규칙(characterization — 카드 안에 있던 함수들을 lib 로 옮기기 전에 지금 동작을 고정한다, web-review §3.3):
 * 품질 칸(quality 0 · 1 · 그 밖 · 없음), 비상 squawk(7500 · 7600 · 7700 — squawk 가 없으면 REST 상세의 emergency), 10분 예측 칸(가능 · 안 함 + 까닭),
 * 그리고 WS selected 가 없을 때 REST 상세와 지도 스냅샷 사본 중 관측(seen_at)이 더 새로운 상태를 쓰는 규칙.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { aircraftStates, resetData, setData } from "@/lib/store";
import type { AircraftState, SelectedInfo } from "@/lib/types";

const dom = installMiniDom();
const m = mounter(dom);
let AircraftCard: typeof import("@/components/AircraftCard").AircraftCard;
beforeAll(async () => { await m.load(); ({ AircraftCard } = await import("@/components/AircraftCard")); });
afterAll(() => dom.restore());
beforeEach(() => resetData());
afterEach(async () => { await m.unmount(); resetData(); vi.unstubAllGlobals(); });

const HEX = "71c081";
const T0 = Date.parse("2026-09-28T03:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ST: AircraftState = { hex: HEX, callsign: "KAL081", lat: 36.5, lon: 127.8, alt_ft: 34000, seen_at: iso(T0 - 5_000), provider: "adsb_fi" };
const text = (h: string) => h.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
/** 카드의 한 행(이름 → 값 글자) */
const row = (html: string, name: string) => new RegExp(`\\|${name}\\|([^|]*)\\|`).exec(text(html))?.[1] ?? null;
const render = (sel: Partial<SelectedInfo> & { state: AircraftState | null }) => {
  setData({ selected: { hex: HEX, prediction: null, received_at: 0, ...sel } });
  return renderToStaticMarkup(createElement(AircraftCard, { hex: HEX }));
};

describe("aircraft card rows (characterization)", () => {
  it("품질: 0 · 통과, 1 · 경고(…), other numbers as is, unknown as —", () => {
    expect(row(render({ state: { ...ST, quality: 0 } }), "품질")).toBe("0 · 통과");
    expect(row(render({ state: { ...ST, quality: 1 } }), "품질")).toBe("1 · 경고(속도/방위 없음 → 보간 안 함)");
    expect(row(render({ state: { ...ST, quality: 2 } }), "품질")).toBe("2");
    expect(row(render({ state: { ...ST, quality: null } }), "품질")).toBe("—");
  });

  it("Squawk: 7500 · 7600 · 7700 are EMERGENCY (red); others are not", () => {
    for (const sq of ["7500", "7600", "7700"]) {
      const h = render({ state: { ...ST, squawk: sq } });
      expect(h).toContain(`<span class="mono text-bad">${sq} EMERGENCY</span>`);
    }
    for (const sq of ["1200", "7777", "0700"]) {
      const h = render({ state: { ...ST, squawk: sq } });
      expect(h).toContain(`<span class="mono ">${sq}</span>`);
    }
    expect(render({ state: { ...ST, squawk: null } })).toContain(`<span class="mono ">—</span>`);
  });

  it("10분 예측: available → 가능 · 지도 점선(추정); not available → 안 함 · the reason's label (— without one); no prediction → —", () => {
    const pred = (prediction: SelectedInfo["prediction"]) => row(render({ state: ST, prediction }), "10분 예측");
    expect(pred({ available: true })).toBe("가능 · 지도 점선(추정)");
    expect(pred({ available: false, reason: "turning" })).toBe("안 함 · 선회 중(최근 트랙 변화 &gt; 15°)");
    expect(pred({ available: false, reason: "slow" })).toBe("안 함 · 저속");
    expect(pred({ available: false, reason: "on_ground" })).toBe("안 함 · 지상");
    expect(pred({ available: false, reason: "no_track" })).toBe("안 함 · 속도/방위 없음");
    expect(pred({ available: false, reason: "stale" })).toBe("안 함 · 수신 지연");
    expect(pred({ available: false, reason: null })).toBe("안 함 · —");
    expect(pred(null)).toBe("—");
  });
});

describe("aircraft card: REST detail vs map snapshot copy (characterization)", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const callsign = () => m.find((e) => e.textContent === "Callsign")!.parentNode!.childNodes[1].textContent;
  const mountWith = async (rest: AircraftState | null, snapshot: AircraftState | null, detail: Record<string, unknown> = {}) => {
    vi.stubGlobal("fetch", async () => json({ hex: HEX, state: rest, static: null, ...detail }));
    aircraftStates.clear();
    if (snapshot) aircraftStates.set(HEX, snapshot);
    await m.render(m.React.createElement(AircraftCard, { hex: HEX }));
    await m.settle();
  };
  it("the newer observation wins; equal or incomparable times keep the REST state", async () => {
    await mountWith({ ...ST, callsign: "REST", seen_at: iso(T0) }, { ...ST, callsign: "SNAP", seen_at: iso(T0 - 1_000) });
    expect(callsign()).toBe("REST");
    await m.unmount();
    await mountWith({ ...ST, callsign: "REST", seen_at: iso(T0 - 1_000) }, { ...ST, callsign: "SNAP", seen_at: iso(T0) });
    expect(callsign()).toBe("SNAP");
    await m.unmount();
    await mountWith({ ...ST, callsign: "REST", seen_at: iso(T0) }, { ...ST, callsign: "SNAP", seen_at: iso(T0) });
    expect(callsign()).toBe("REST");
    await m.unmount();
    await mountWith({ ...ST, callsign: "REST", seen_at: null }, { ...ST, callsign: "SNAP", seen_at: iso(T0) });
    expect(callsign()).toBe("SNAP");
    await m.unmount();
    await mountWith({ ...ST, callsign: "REST", seen_at: iso(T0) }, { ...ST, callsign: "SNAP", seen_at: null });
    expect(callsign()).toBe("REST");
    await m.unmount();
    // 숫자 seen_at 은 epoch 초(호환 — lib/interpolate seenAtMs)
    await mountWith({ ...ST, callsign: "REST", seen_at: (T0 - 1_000) / 1000 }, { ...ST, callsign: "SNAP", seen_at: iso(T0) });
    expect(callsign()).toBe("SNAP");
    await m.unmount();
    await mountWith(null, { ...ST, callsign: "SNAP" });
    expect(callsign()).toBe("SNAP");
  });
  it("without a squawk the REST detail's emergency flag marks EMERGENCY", async () => {
    await mountWith({ ...ST, squawk: null }, null, { emergency: true });
    expect(m.find((e) => e.tagName === "SPAN" && e.getAttribute("class") === "mono text-bad")?.textContent).toBe("— EMERGENCY");
  });
});
