/**
 * 첫 화면 크롬(상단 검색 · 알림 패널 · 레이어 단추)의 규칙(characterization — 컴포넌트 안의 함수를 lib 로 옮기기 전에 지금 동작을 고정한다, web-review §3.3):
 * - 검색 묶음의 실패 문구: 429 · 404 · 400 · 그 밖(서버 문구 또는 망 오류 문구)
 * - 알림 목록의 범위(관심 지역 = 중심 · 반경 안, 위치 없는 알림은 전세계에서만)와 순서(관측 먼저, 같은 종류는 진입 시각 최신 먼저)
 * - 범례 열림: 이 브라우저에 저장한 "1" · "0" 이 먼저, 없거나 다른 값이면 화면 폭(1600 px 이상만 펼침), 저장소가 없어도 동작
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, type MiniElement } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import type { Alert, PublicStatus } from "@/lib/types";

const dom = installMiniDom();
// react-dom 은 불러올 때 'oninput' in document 로 input 이벤트 지원을 본다(search-ships-mount 와 같은 준비)
(dom.document as unknown as Record<string, unknown>).oninput = null;
const g = globalThis as Record<string, unknown>;
g.addEventListener = () => {};
g.removeEventListener = () => {};
const m = mounter(dom);
const initialUi = useUi.getState();
beforeAll(() => m.load());
afterAll(() => { dom.restore(); delete g.addEventListener; delete g.removeEventListener; });
beforeEach(() => { resetData(); useUi.setState(initialUi, true); });
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); resetData(); });

const fire = (type: string, target: MiniElement) =>
  m.act(() => { dom.container.dispatch(type, { type, target, bubbles: true, preventDefault() {}, stopPropagation() {} }); });

describe("search groups: failure texts (characterization)", () => {
  const problem = (status: number, detail: string) => new Response(JSON.stringify({ detail }), { status, headers: { "Content-Type": "application/problem+json" } });
  async function searchFailing(reply: () => Promise<Response>) {
    vi.stubGlobal("fetch", (url: string) => (url.startsWith("/api/v1/aircraft/search") ? reply() : new Promise<Response>(() => {})));
    vi.stubGlobal("self", globalThis);
    const { AircraftSearch } = await import("@/components/AircraftSearch");
    await m.render(m.React.createElement(AircraftSearch));
    const input = m.byTestId("aircraft-search-input")!;
    (input as unknown as { value: string }).value = "KAL1";
    await fire("input", input);
    await m.settle(300); // 디바운스 250 ms
    return m.byTestId("search-error-aircraft")?.textContent ?? null;
  }
  it("429 → rate-limited; 404 → the server has no such search; 400 → query format; anything else → 검색 실패 (message)", async () => {
    expect(await searchFailing(async () => problem(429, "slow down"))).toBe("요청이 많아 잠시 제한됨 — 잠시 후 다시");
    await m.unmount();
    expect(await searchFailing(async () => problem(404, "Not Found"))).toBe("항공기 검색을 쓸 수 없음(HTTP 404 — 서버가 지원하지 않음)");
    await m.unmount();
    expect(await searchFailing(async () => problem(400, "bad q"))).toBe("항공기 검색어 형식이 맞지 않음(HTTP 400)");
    await m.unmount();
    expect(await searchFailing(async () => problem(503, "db down"))).toBe("항공기 검색 실패 (db down)");
    await m.unmount();
    expect(await searchFailing(() => Promise.reject(new TypeError("Failed to fetch")))).toBe("항공기 검색 실패 (Failed to fetch)");
  });
});

describe("alert list scope and order (characterization)", () => {
  const STATUS = { server_time: "2026-09-28T01:00:00Z", region: { center: [36.5, 127.8], radius_nm: 300 } } as unknown as PublicStatus;
  const alert = (id: number, kind: Alert["kind"], entered: string, pos: [number, number] | null): Alert => ({
    id, kind, hex: `a${id}`, callsign: `CS${id}`, sigmet_id: `S${id}`, fir_id: "RKRR", hazard: "TS", entered_at: entered, eta_s: kind === "PREDICTED" ? 120 : null,
    alt_ft: 35000, evidence: pos ? { position: pos, judged_at: entered } : { judged_at: entered }, estimated: kind === "PREDICTED",
  } as Alert);
  const ALERTS = [
    alert(1, "PREDICTED", "2026-09-28T00:50:00Z", [36.5, 127.8]),
    alert(2, "OBSERVED", "2026-09-28T00:40:00Z", [40.5, 127.8]), // 240 NM 북쪽 — 안
    alert(3, "OBSERVED", "2026-09-28T00:55:00Z", [42.0, 127.8]), // 330 NM — 밖
    alert(4, "OBSERVED", "2026-09-28T00:45:00Z", null), // 위치 없음 — 관심 지역에서 빠진다
    alert(5, "PREDICTED", "2026-09-28T00:58:00Z", [36.5, 133.0]), // 경도 5.2° ≈ 250 NM(위도 36.5°) — 안
    alert(6, "OBSERVED", "2026-09-28T00:30:00Z", [36.5, 127.0]),
  ];
  const shown = () => m.allByTestId("alert-item").map((e) => `${e.getAttribute("data-kind")![0]}${e.textContent.match(/CS(\d+)/)![1]}`);
  it("region: inside the radius only (no position → out); observed first, newest entry first within a kind", async () => {
    setData({ status: STATUS, alerts: new Map(ALERTS.map((a) => [a.id, a])), alertsVersion: 1 });
    const { AlertPanel } = await import("@/components/AlertPanel");
    await m.render(m.React.createElement(AlertPanel));
    expect(shown()).toEqual(["O2", "O6", "P5", "P1"]);
    await m.click(m.byTestId("alerts-scope-world"));
    expect(shown()).toEqual(["O3", "O4", "O2", "O6", "P5", "P1"]);
  });
  it("a region setting without a centre or radius keeps every alert", async () => {
    setData({ status: { ...STATUS, region: { ...STATUS.region!, radius_nm: null } } as unknown as PublicStatus, alerts: new Map(ALERTS.map((a) => [a.id, a])), alertsVersion: 1 });
    const { AlertPanel } = await import("@/components/AlertPanel");
    await m.render(m.React.createElement(AlertPanel));
    expect(shown()).toEqual(["O3", "O4", "O2", "O6", "P5", "P1"]);
  });
});

describe("legend open state is remembered in this browser (characterization)", () => {
  function storage(initial: Record<string, string>, opts: { failRead?: boolean; failWrite?: boolean } = {}) {
    const data = { ...initial };
    const writes: [string, string][] = [];
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => { if (opts.failRead) throw new Error("denied"); return data[k] ?? null; },
      setItem: (k: string, v: string) => { if (opts.failWrite) throw new Error("denied"); writes.push([k, v]); data[k] = v; },
    });
    return writes;
  }
  async function mountPanel(width: number) {
    vi.stubGlobal("innerWidth", width);
    const { LayerPanel } = await import("@/components/LayerPanel");
    await m.render(m.React.createElement(LayerPanel));
    return useUi.getState().legendOpen;
  }
  it("a stored '1' or '0' wins over the screen width; otherwise wide screens (≥ 1600 px) open it", async () => {
    storage({ "wakeline.legend": "0" });
    expect(await mountPanel(1920)).toBe(false);
    await m.unmount();
    storage({ "wakeline.legend": "1" });
    expect(await mountPanel(1024)).toBe(true);
    await m.unmount();
    storage({ "wakeline.legend": "yes" });
    expect(await mountPanel(1599)).toBe(false);
    await m.unmount();
    storage({});
    expect(await mountPanel(1600)).toBe(true);
    await m.unmount();
    storage({}, { failRead: true });
    expect(await mountPanel(1700)).toBe(true);
  });
  it("the 범례 button stores '1' / '0'; a storage that refuses writes still toggles", async () => {
    const writes = storage({ "wakeline.legend": "0" });
    await mountPanel(1920);
    await m.click(m.byTestId("legend-toggle"));
    await m.click(m.byTestId("legend-toggle"));
    expect(writes).toEqual([["wakeline.legend", "1"], ["wakeline.legend", "0"]]);
    await m.unmount();
    storage({ "wakeline.legend": "0" }, { failWrite: true });
    await mountPanel(1920);
    await m.click(m.byTestId("legend-toggle"));
    expect(useUi.getState().legendOpen).toBe(true);
  });
});
