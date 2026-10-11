/**
 * 모바일 알림 화면 `/m`(SPEC F8 · 계약 v5 §G52): 경로의 정적 그래프에 지도 · MapLibre · WS 가 없다(따로 받는 조각도 없다) · 열린 알림을 REST 로 그리고 줄은
 * 근거 화면(/alerts/{id})으로 간다 · 보이는 동안 15 s 마다 · 관심 대상 목록 · 화면 글은 KST 만.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { domUtcLeaks } from "./helpers/kst-only";
import { resetData } from "@/lib/store";
import { useWatch } from "@/lib/watch-store";

const ROOT = resolve(__dirname, "..");

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? resolve(ROOT, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) if (existsSync(base + ext) && (ext || /\.(ts|tsx)$/.test(base))) return base + ext;
  return null;
}
/** 정적 import 그래프(파일 · 패키지 이름) — import type 은 빼고, import() 는 따로 센다 */
function graphOf(entry: string): { files: string[]; packages: Set<string>; dynamic: string[] } {
  const seen = new Set<string>(), packages = new Set<string>(), dynamic: string[] = [];
  const stack = [resolve(ROOT, entry)];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^"';]*?from\s*["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
      const spec = m[1] ?? m[2];
      const r = resolveImport(f, spec);
      if (r) { if (!r.endsWith(".css")) stack.push(r); } else if (!spec.startsWith(".") && !spec.startsWith("@/")) packages.add(spec);
    }
    for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) dynamic.push(`${f.slice(ROOT.length + 1)} → ${m[1]}`);
  }
  return { files: [...seen].map((f) => f.slice(ROOT.length + 1)), packages, dynamic };
}

describe("/m carries no map, MapLibre or WS", () => {
  it("static graph", () => {
    const g = graphOf("app/m/page.tsx");
    expect(g.files).toContain("components/MobileAlerts.tsx");
    for (const banned of ["components/MapView.tsx", "lib/maplibre.ts", "lib/ws.ts", "components/map/useLiveFeed.ts", "components/DashboardParts.tsx"])
      expect(g.files, banned).not.toContain(banned);
    expect([...g.packages].filter((p) => p.startsWith("maplibre"))).toEqual([]);
    expect(g.dynamic).toEqual([]); // 따로 받는 조각도 없다(지도 조각이 끼어들 길이 없다)
  });
});

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); resetData(); dom.document.hidden = false; useWatch.setState({ targets: [], state: null, banner: [] }); });

const NOW = Date.parse("2026-10-09T10:00:00Z");
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const ALERTS = { items: [
  { id: 101, kind: "OBSERVED", hex: "71be01", callsign: "KAL081 ", sigmet_id: "RKRR:S1", fir_id: "RKRR", hazard: "TS", entered_at: "2026-10-09T09:50:00Z", evidence: {}, estimated: false },
  { id: 102, kind: "PREDICTED", hex: "71be02", sigmet_id: "RKRR:S1", fir_id: "RKRR", hazard: "TS", entered_at: "2026-10-09T09:55:00Z", eta_at: "2026-10-09T10:04:00Z", evidence: {}, estimated: true },
], meta: {} };

describe("/m renders the open alerts and the watchlist", () => {
  it("rows link to the evidence page, refresh every 15 s while visible, KST only", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
    vi.stubGlobal("self", globalThis);
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { asked.push(url.split("?")[0]); return url.startsWith("/api/v1/alerts") ? json(ALERTS) : json({ aircraft: [], ships: [], airports: [] }); });
    useWatch.setState({ targets: [{ kind: "aircraft", id: "71be01", label: "KAL081" }], permission: "unsupported" });
    vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
    const { MobileAlerts } = await import("@/components/MobileAlerts");
    await m.render(m.React.createElement(MobileAlerts));
    await m.settle();
    await m.settle();
    const rows = m.allByTestId("mobile-alert");
    expect(rows.map((r) => r.getAttribute("href"))).toEqual(["/alerts/101", "/alerts/102"]);
    expect(m.byTestId("mobile-status")?.textContent).toBe("열린 알림 2건 · 15초마다(보이는 동안) · 지도 · 실시간 연결 없음");
    expect(rows[1].textContent).toContain("예측 진입");
    expect(rows[1].textContent).toContain("예상 19:04:00 KST(추정)");
    expect(m.allByTestId("mobile-watch-item")).toHaveLength(1);
    expect(domUtcLeaks(m.byTestId("mobile")!)).toEqual([]);
    const n = asked.filter((u) => u === "/api/v1/alerts").length;
    await m.act(() => { vi.advanceTimersByTime(15_000); });
    expect(asked.filter((u) => u === "/api/v1/alerts").length).toBe(n + 1);
    dom.document.hidden = true;
    await m.act(() => { vi.advanceTimersByTime(60_000); });
    expect(asked.filter((u) => u === "/api/v1/alerts").length).toBe(n + 1); // 숨은 동안 쉰다
    expect(asked.some((u) => u.includes("/ws"))).toBe(false);
  });
  it("an answer of the wrong shape says so instead of loading forever", async () => {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("fetch", async () => json({ items: "not a list" }));
    useWatch.setState({ targets: [], permission: "unsupported" });
    vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
    const { MobileAlerts } = await import("@/components/MobileAlerts");
    await m.render(m.React.createElement(MobileAlerts));
    await m.settle();
    await m.settle();
    expect(m.byTestId("mobile-status")?.textContent).toBe("응답의 모양이 틀려 그리지 않음");
  });
  it("says so when the browser blocks page notifications (no enable button, banner only)", async () => {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("fetch", async () => json(ALERTS));
    useWatch.setState({ targets: [], permission: "blocked" });
    vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
    const { MobileAlerts } = await import("@/components/MobileAlerts");
    await m.render(m.React.createElement(MobileAlerts));
    await m.settle();
    expect(m.byTestId("mobile-notify")?.textContent).toBe("이 브라우저는 페이지 알림을 막음(안드로이드 크롬 등) — 이 화면의 배너만");
    expect(m.byTestId("mobile-watch")?.textContent).not.toContain("브라우저 알림 켜기");
  });
});
