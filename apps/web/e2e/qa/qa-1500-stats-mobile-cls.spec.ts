import { expect, test, type Page } from "@playwright/test";
import { assertIsolated, saveJson, shot } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA-1500 재현(QA 2026-10-aws · 성능 — findings/performance.md §9): 실제 규모 자료(AWS 규모 seed_perf_aws.sql — FIR 40곳 · 위험 유형 7 · 알림 9행 ·
 * 교통량 09–17시)에서 /stats 모바일 CLS 가 0.113–0.159(Lighthouse 12.8.2 · 6번 모두 0.1 초과). Lighthouse 가 고른 밀린 요소는 'SIGMET BY HAZARD (7D)' ·
 * 'DISTINCT AIRCRAFT BY HOUR (KST)' 패널이다.
 * 의심 원인: 받는 중 자리(PanelLoading — 글자 한 줄 + 막대 + 자리 표시 세 줄, 약 100 px)가 받은 뒤의 막대 그림(BarChart — 최대 238 px, 막대 수에 따라
 * 줄어든다)보다 낮아, 한 단 배치에서 위 패널이 커지며 아래 패널을 민다. 빈 상태 · 오류 상태도 높이가 다르다.
 * 이 시험은 네 요청을 대신 답한다(route — 스택의 집계 상태와 무관하게 결정적). 응답 모양 · 크기는 A1 + AWS 규모 시드에서 받은 것과 같다.
 * 1) 모바일(Lighthouse 모바일 화면 412×823 · DPR 1.75): 받는 중으로 그린 뒤 응답이 오면 CLS(layout-shift 의 가장 큰 세션 창) ≤ 0.1.
 * 2) 받는 중 · 빈 상태 · 오류 상태에서 패널의 자리(뒤 패널의 위치)가 받은 뒤와 같다 — 모바일 412 · 데스크톱 1350. 마지막 패널(알림 표)은 뒤에 미는 것이
 *    없어 높이를 재지 않는다(행 수에 따라 늘어나는 표).
 * 실행: cd apps/web && QA_BASE_URL=http://localhost:8701 QA_EVIDENCE_DIR=… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1500
 */

const MOBILE = { viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true };
const Z = { day_zone: "Asia/Seoul" };
const kstDay = (offset: number) => new Date(Date.now() + 9 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);
const PAST = [-7, -6, -5, -4, -3, -2, -1];
const week = (agg: boolean) => PAST.map((o) => ({ day: kstDay(o), aggregated: agg })).concat([{ day: kstDay(0), aggregated: false }]);
/** 결정적인 값(시드와 같은 크기 범위) */
const val = (i: number, lo: number, hi: number) => lo + ((i * 2654435761) >>> 0) % (hi - lo + 1);
const FIRS = ["BGGL", "CZEG", "EGPX", "EISN", "FACA", "FAJO", "FCCC", "FQBE", "GCCC", "GOOO", "HLLL", "KZAK", "LGGG", "LIRR", "LPPC", "LPPO", "MHTG", "MMID", "NZZC", "OIIX",
  "RKRR", "SACF", "SAVF", "SBAO", "SBAZ", "SBRE", "SCIZ", "SKED", "SVZM", "TTZP", "VABF", "VDPF", "VOMF", "WIIF", "WSJC", "YBBB", "YMMM", "ZJSA", "ZSHA", "ZYSH"];
const HAZARDS = ["CONVECTIVE", "ICE", "MTW", "TC", "TS", "TURB", "VA"];

type Kind = "ready" | "empty" | "error" | "loading";
const PROBLEM = { status: 503, contentType: "application/problem+json", headers: { "X-Request-Id": "qa1500aaaabbbbccccddddeeeeffff00" },
  body: JSON.stringify({ type: "about:blank", title: "Service Unavailable", status: 503, detail: "data store temporarily unavailable; retry later", code: "UNAVAILABLE", request_id: "qa1500aaaabbbbccccddddeeeeffff00" }) };

function body(path: string, day: string | null, kind: "ready" | "empty"): unknown {
  if (path.includes("group=fir")) return { group: "fir", items: kind === "empty" ? [] : PAST.flatMap((o, d) => FIRS.map((f, i) => ({ day: kstDay(o), dim: f, value: val(d * 40 + i, 8, 40) }))), days: week(true), ...Z };
  if (path.includes("group=hazard")) return { group: "hazard", items: kind === "empty" ? [] : PAST.flatMap((o, d) => HAZARDS.map((h, i) => ({ day: kstDay(o), dim: h, value: val(d * 7 + i, 20, 400) }))), days: week(true), ...Z };
  if (path.includes("/stats/alerts")) return { items: kind === "empty" ? [] : PAST.slice(2).flatMap((o) => [
    { day: kstDay(o), metric: "alerts_by_kind", dim: "OBSERVED", value: 350 }, { day: kstDay(o), metric: "alert_dwell_avg_s", dim: "OBSERVED", value: 1798.56 },
  ]).slice(0, 9), days: week(true), ...Z };
  return { day, items: kind === "empty" ? [] : Array.from({ length: 9 }, (_, i) => ({ day, dim: String(9 + i).padStart(2, "0"), value: 130 })), aggregated: true,
    scope: "region", region: { center: [36.5, 127.8], radius_nm: 250, bbox: [122.61665596102841, 32.333333333333336, 132.98334403897158, 40.666666666666664] }, ...Z };
}

/** 네 통계 요청을 kind 대로 답한다 — delayMs 뒤(받는 중을 먼저 그리게). loading 은 답하지 않는다 */
async function routeStats(page: Page, kind: Kind, delayMs = 0) {
  await page.route(/\/api\/v1\/stats\/(sigmet|alerts|traffic)/, async (route) => {
    if (kind === "loading") return; // 답하지 않음 — 받는 중에 머문다
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (kind === "error") return route.fulfill(PROBLEM);
    const u = new URL(route.request().url());
    return route.fulfill({ json: body(u.pathname + u.search, u.searchParams.get("day"), kind) });
  });
}

const PANELS = ["fir", "hazard", "traffic", "alerts"] as const;
async function layout(page: Page) {
  return page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
    const el = document.querySelector<HTMLElement>(`[data-stats-panel="${id}"]`);
    const r = el?.getBoundingClientRect();
    return [id, { state: el?.dataset.state ?? null, top: r ? Math.round(r.top * 10) / 10 : null, height: r ? Math.round(r.height * 10) / 10 : null }];
  })), [...PANELS]);
}

test("QA-1500 /stats mobile CLS stays ≤ 0.1 when AWS-scale stats arrive after the loading panels", async ({ browser, baseURL }) => {
  assertIsolated(baseURL);
  const ctx = await browser.newContext({ ...MOBILE, baseURL, locale: "ko-KR", timezoneId: "UTC" });
  const page = await ctx.newPage();
  await emptyExternal(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __qaShifts: { t: number; v: number; input: boolean; src: string[] }[] };
    w.__qaShifts = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as { startTime: number; value: number; hadRecentInput: boolean; sources?: { node?: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[] }[]) {
        w.__qaShifts.push({ t: Math.round(e.startTime), v: e.value, input: e.hadRecentInput,
          src: (e.sources ?? []).map((s) => {
            const n = s.node instanceof Element ? s.node : s.node?.parentElement ?? null;
            const p = n?.closest("[data-stats-panel]")?.getAttribute("data-stats-panel");
            return `${p ?? n?.tagName ?? "?"} ${Math.round(s.previousRect.top)}→${Math.round(s.currentRect.top)} h${Math.round(s.previousRect.height)}→${Math.round(s.currentRect.height)}`;
          }) });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await routeStats(page, "ready", 700);
  await page.goto("/stats", { waitUntil: "domcontentloaded" });
  for (const id of PANELS) await expect(page.locator(`[data-stats-panel="${id}"]`)).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const shifts = await page.evaluate(() => (window as unknown as { __qaShifts: { t: number; v: number; input: boolean; src: string[] }[] }).__qaShifts);
  // CLS = 가장 큰 세션 창(앞 이동과 1 s 안 · 창 5 s 안 — web-vitals 와 같은 정의). hadRecentInput 은 보지 않는다: 이 시험은 입력을 하지 않는데
  // Chromium 의 모바일(터치) 흉내에서는 이동이 hadRecentInput=true 로 온다(이 시험에서 관찰) — Lighthouse 도 이 이동을 CLS 에 센다(0.156).
  let cls = 0, cur = 0, start = -1, last = -1;
  for (const s of shifts) {
    if (start < 0 || s.t - last > 1000 || s.t - start > 5000) { cur = 0; start = s.t; }
    cur += s.v; last = s.t; cls = Math.max(cls, cur);
  }
  const after = await layout(page);
  await shot(page, "qa-1500-stats-mobile.png");
  saveJson("qa-1500-stats-mobile-cls.json", { cls, shifts, after });
  console.log(`QA-1500 mobile cls=${cls.toFixed(3)} shifts=${JSON.stringify(shifts.map((s) => [s.t, Number(s.v.toFixed(3)), s.src]))}`);
  await ctx.close();
  expect(cls, "mobile CLS of /stats with AWS-scale stats").toBeLessThanOrEqual(0.1);
});

for (const [name, opts] of [["mobile 412", MOBILE], ["desktop 1350", { viewport: { width: 1350, height: 940 } }]] as const) {
  test(`QA-1500 /stats panels keep their place in loading · empty · error (${name})`, async ({ browser, baseURL }) => {
    assertIsolated(baseURL);
    const out: Record<string, Awaited<ReturnType<typeof layout>>> = {};
    for (const kind of ["ready", "loading", "empty", "error"] as const) {
      const ctx = await browser.newContext({ ...opts, baseURL, locale: "ko-KR", timezoneId: "UTC" });
      const page = await ctx.newPage();
      await emptyExternal(page);
      await routeStats(page, kind);
      await page.goto("/stats", { waitUntil: "domcontentloaded" });
      const want = kind === "loading" ? "loading" : kind;
      for (const id of PANELS) await expect(page.locator(`[data-stats-panel="${id}"]`)).toHaveAttribute("data-state", want, { timeout: 20_000 });
      await page.waitForTimeout(700); // 받는 중의 진행 표시가 나타난 뒤(lib/busy 지연 180 ms)
      out[kind] = await layout(page);
      await shot(page, `qa-1500-stats-${name.replace(" ", "-")}-${kind}.png`);
      await ctx.close();
    }
    saveJson(`qa-1500-stats-places-${name.replace(" ", "-")}.json`, out);
    // 뒤 패널의 위치(= 앞 패널들의 높이)가 상태와 상관없이 같아야 한다 — 받은 뒤가 기준
    const moved: string[] = [];
    for (const kind of ["loading", "empty", "error"] as const) {
      for (const id of ["hazard", "traffic", "alerts"] as const) {
        const a = out.ready[id].top ?? NaN, b = out[kind][id].top ?? NaN;
        if (!(Math.abs(a - b) <= 1)) moved.push(`${kind}: ${id} top ${b} (ready ${a})`);
      }
    }
    console.log(`QA-1500 ${name} places=${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([p, x]) => [p, [x.top, x.height]]))])))}`);
    expect(moved, `${name}: panels below move when the stats arrive`).toEqual([]);
  });
}
