/**
 * 통계 · 공항 목록 · 시스템 로그 화면의 규칙(characterization — 컴포넌트 안의 함수를 lib 로 옮기기 전에 지금 동작을 고정한다, web-review §3.3):
 * - 통계 막대(SIGMET FIR · 위험 유형): 차원마다 날짜를 더하고 큰 값부터 24개
 * - 공항 탭 목록의 줄: ICAO 순서, METAR 없음 · 오래됨(경과) · 카테고리 글자, 점 색(모름 · 오래됨은 회색)
 * - 로그 묶음 보기의 자동 확인: 묶음의 (지문 · 수 · 마지막 id · 해결) 이 바뀔 때만 '묶음에 새 항목 — 반영'
 * - /logs#fp=… 로 열면 그 지문으로 거른 목록, #rid=… 는 7일
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { CAT_COLORS, CAT_UNKNOWN_COLOR } from "@/lib/format";
import { topDims } from "@/lib/chart";
import { flagOf, zoneBad } from "@/lib/stats";
import { airportListRows } from "@/lib/airport-list";
import { DEFAULT_LOG_FILTER, initialLogsState, logGroupsSig } from "@/lib/logs";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("stats bars: summed per dimension, largest first, top 24 (characterization)", () => {
  it("FIR rows over several days add up per FIR; 30 FIRs → the 24 largest", async () => {
    const Z = { day_zone: "Asia/Seoul" }; // 7일 응답에는 최상위 aggregated 가 없다(날짜별 days[] — QA-308)
    const firs = Array.from({ length: 30 }, (_, i) => ({ day: "2026-09-27", dim: `F${String(i).padStart(2, "0")}`, value: i + 1 }));
    const items = [...firs, { day: "2026-09-26", dim: "F00", value: 100 }, { day: "2026-09-25", dim: "F01", value: 50 }];
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-28T16:00:00Z") });
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("fetch", async (url: string) => (url === "/api/v1/stats/sigmet?group=fir" ? json(200, { items, ...Z }) : new Promise<Response>(() => {})));
    await m.render(m.React.createElement((await import("@/app/stats/page")).default));
    await m.settle();
    const panel = m.find((e) => e.getAttribute("data-stats-panel") === "fir")!;
    const rows = m.findAll((e) => e.tagName === "TR", panel).slice(1).map((r) => r.textContent);
    expect(rows).toHaveLength(24);
    expect(rows.slice(0, 4)).toEqual(["F00101", "F0152", "F2930", "F2829"]);
    expect(rows[23]).toBe("F089"); // 24번째 = F08(9) — F02–F07 은 빠진다
  });
});

describe("airport tab rows (characterization)", () => {
  it("sorted by ICAO; METAR 없음 / 오래됨(경과) / category text; dot colour grey unless a fresh known category", async () => {
    const { AirportListView } = await import("@/components/AirportList");
    const now = Date.parse("2026-09-28T03:00:00Z");
    const f = (icao: string, p: Record<string, unknown>) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [127, 37] }, properties: { icao, name: icao, ...p } });
    const html = renderToStaticMarkup(createElement(AirportListView, {
      state: "done", now,
      features: [
        f("RKSS", { flight_cat: "VFR", obs_time: "2026-09-28T00:30:00Z" }), // 2h 30m — 오래됨
        f("RKPC", {}), // METAR 없음
        f("RKSI", { flight_cat: "IFR", obs_time: "2026-09-28T02:30:00Z" }),
        f("RKPK", { obs_time: "2026-09-28T02:50:00Z" }), // 카테고리 모름
        f("RKTU", { flight_cat: "XYZ", obs_time: "2026-09-28T02:50:00Z" }), // 표에 없는 카테고리
        f("RKJB", { flight_cat: "MVFR", obs_age_s: 600 }), // 시각 대신 경과(초)
      ],
    }));
    const items = [...html.matchAll(/data-icao="([A-Z]+)"><span[^>]*style="background:([^"]+)"[^>]*><\/span>.*?<span class="mono shrink-0 text-\[11px\] ?([^"]*)">([^<]*)<\/span>/g)]
      .map((x) => [x[1], x[2], x[3], x[4]]);
    expect(items).toEqual([
      ["RKJB", CAT_COLORS.MVFR, "", "MVFR"],
      ["RKPC", CAT_UNKNOWN_COLOR, "", "METAR 없음"],
      ["RKPK", CAT_UNKNOWN_COLOR, "", "—"],
      ["RKSI", CAT_COLORS.IFR, "", "IFR"],
      ["RKSS", CAT_UNKNOWN_COLOR, "text-warn", "METAR 오래됨(2h 30m 전)"],
      ["RKTU", CAT_UNKNOWN_COLOR, "", "XYZ"],
    ]);
  });
});

describe("logs: groups auto-check and the #fp= start (characterization)", () => {
  const NOW = Date.parse("2026-09-29T02:00:00Z");
  const T = (min: number) => `${NOW - min * 60_000}-0`;
  const group = (fp: string, o: Record<string, unknown> = {}) => ({
    fp, service: "api", level: "ERROR", logger: "x.Y", exception_type: null, sample_message: `boom ${fp}`, count: 3, suppressed: 0,
    first_at: "2026-09-29T01:00:00Z", last_at: "2026-09-29T01:59:00Z", last_id: T(1), resolved: null, ...o,
  });
  const FP = "0123456789abcdef", FP2 = "fedcba9876543210";
  let groups: unknown = null;
  const calls: string[] = [];
  async function open(hash = "") {
    calls.length = 0;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("location", { hash, pathname: "/logs", origin: "http://localhost:8700" });
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url === "/api/v1/ops/session") return json(200, { username: "op" });
      if (url.startsWith("/api/v1/ops/logs/groups?")) return json(200, groups);
      if (url.startsWith("/api/v1/ops/logs?")) return json(200, { items: [], next_cursor: null, scanned: 0, scan_truncated: false });
      return json(404, {});
    });
    await m.render(m.React.createElement((await import("@/app/logs/page")).default));
    await m.settle();
    await m.settle();
  }
  const tick = async () => { await m.act(() => { vi.advanceTimersByTime(15_000); }); await m.settle(); };
  const fresh = () => m.byTestId("logs-new");
  it("a fresh button only when a group's fingerprint, count, last id or resolution changes (not the scan size)", async () => {
    groups = { groups: [group(FP), group(FP2)], scanned: 40, scan_truncated: false };
    await open();
    await m.click(m.button("묶음(fp)"));
    expect(m.allByTestId("log-group")).toHaveLength(2);
    groups = { groups: [group(FP), group(FP2)], scanned: 99, scan_truncated: true };
    await tick();
    expect(fresh()).toBeNull();
    const changes: Record<string, unknown>[] = [{ count: 4 }, { last_id: T(0) }, { resolved: { id: 9, upto: "2026-09-29T01:59:00Z", resolved_by: "op" } }];
    for (const c of changes) {
      groups = { groups: [group(FP), group(FP2, c)], scanned: 40, scan_truncated: false };
      await tick();
      expect(fresh()?.textContent, JSON.stringify(c)).toBe("묶음에 새 항목 — 반영");
      await m.click(fresh());
      expect(fresh()).toBeNull();
    }
    groups = { groups: [group(FP2, { resolved: { id: 9, upto: "2026-09-29T01:59:00Z", resolved_by: "op" } }), group(FP)], scanned: 40, scan_truncated: false };
    await tick();
    expect(fresh()?.textContent).toBe("묶음에 새 항목 — 반영"); // 순서가 바뀌어도 바뀐 것
  });
  it("#fp= opens the list filtered by that fingerprint (period kept); #rid= filters by the request id over 7 d", async () => {
    groups = { groups: [] };
    await open(`#fp=${FP}`);
    const first = calls.find((u) => u.startsWith("/api/v1/ops/logs?"))!;
    const q = new URLSearchParams(first.split("?")[1]);
    expect([q.get("fp"), q.get("rid"), q.get("since")]).toEqual([FP, null, new Date(NOW - 3_600_000).toISOString()]);
    await m.unmount();
    await open("#rid=5f2c9a0e1b7d4c3a");
    const r = new URLSearchParams(calls.find((u) => u.startsWith("/api/v1/ops/logs?"))!.split("?")[1]);
    expect([r.get("rid"), r.get("fp"), r.get("since")]).toEqual(["5f2c9a0e1b7d4c3a", null, new Date(NOW - 7 * 86_400_000).toISOString()]);
  });
});

describe("the moved helpers, directly (web-review §3.3)", () => {
  it("lib/chart topDims", () => {
    expect(topDims([{ dim: "A", value: 1 }, { dim: "B", value: 5 }, { dim: "A", value: "7" }], 2)).toEqual([{ label: "A", value: 8 }, { label: "B", value: 5 }]);
    expect(topDims([{ dim: "A", value: 1 }, { dim: "B", value: 2 }], 1)).toEqual([{ label: "B", value: 2 }]);
    expect(topDims([])).toEqual([]);
  });
  it("lib/stats flagOf · zoneBad: only a KST-day response is read; loading and failed are unknown", () => {
    const kst = { day_zone: "Asia/Seoul", aggregated: true };
    expect(flagOf({ status: "loaded", resp: kst })).toBe(true);
    expect(flagOf({ status: "loaded", resp: { aggregated: true } })).toBeUndefined();
    expect(flagOf({ status: "loading" })).toBeUndefined();
    expect(flagOf({ status: "failed", error: new Error("x") })).toBeUndefined();
    expect([zoneBad({ status: "loaded", resp: kst }), zoneBad({ status: "loaded", resp: {} }), zoneBad({ status: "loading" })]).toEqual([false, true, false]);
  });
  it("lib/airport-list airportListRows: without a known 'now' nothing is judged stale; coordinates that are not numbers are null", () => {
    const f = (icao: string, p: Record<string, unknown>, coordinates: unknown[] = [127, 37]) =>
      ({ type: "Feature", geometry: { type: "Point", coordinates }, properties: { icao, ...p } }) as never;
    const rows = airportListRows([f("RKSS", { flight_cat: "VFR", obs_time: "2020-01-01T00:00:00Z" }), f("RKSI", { name: "Incheon" }, [null, 37])], 0);
    expect(rows).toEqual([
      { icao: "RKSI", name: "Incheon", cat: "METAR 없음", color: CAT_UNKNOWN_COLOR, stale: false, lonLat: null },
      { icao: "RKSS", name: "", cat: "VFR", color: CAT_COLORS.VFR, stale: false, lonLat: [127, 37] },
    ]);
  });
  it("lib/logs initialLogsState · logGroupsSig", () => {
    expect(initialLogsState("")).toEqual({ filter: DEFAULT_LOG_FILTER, openId: null, openStream: null });
    expect(initialLogsState("#rid=5f2c9a0e1b7d4c3a").filter).toEqual({ ...DEFAULT_LOG_FILTER, rid: "5f2c9a0e1b7d4c3a", period: "7d" });
    expect(initialLogsState("#fp=0123456789abcdef").filter).toEqual({ ...DEFAULT_LOG_FILTER, fp: "0123456789abcdef" });
    expect(initialLogsState("#id=1727480000000-0&stream=client")).toMatchObject({ openId: "1727480000000-0", openStream: "client" });
    expect(initialLogsState("#rid=bad id")).toEqual({ filter: DEFAULT_LOG_FILTER, openId: null, openStream: null });
    const g = (count: number, resolved: { id: number } | null = null) => ({ fp: "0123456789abcdef", count, last_id: "1-0", resolved: resolved as never });
    expect(logGroupsSig(null)).toBe("");
    expect(logGroupsSig({ groups: [g(3)] })).toBe("0123456789abcdef:3:1-0:");
    expect(logGroupsSig({ groups: [g(3, { id: 9 })] })).toBe("0123456789abcdef:3:1-0:9");
  });
});
