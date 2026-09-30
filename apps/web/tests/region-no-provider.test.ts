/**
 * 관심 지역 '공급자 없음'(운영 로그 2026-09-30 KST 12:16:32 · 12:22:28 — adsb_fi 3회 연속 실패로 쉬는 동안 adsb_lol 도 429 로 쉼). 전에는 화면 어디에도
 * 그렇게 적히지 않았다: 운영 공급자 탭 위쪽은 초록 배지 "region: adsb_lol"(마지막으로 쓴 공급자), 상태 바 region 칩은 나이로 STALE 만.
 * 이제 수집기가 wakeline:active 에 쓰는 {job}_none_since · {job}_none_reason · {job}_none_next(계약 v5 §G24)를 그대로 보인다 — 시각은 KST 만,
 * 모르는 값(풀리는 때를 모름 · 시작 시각 형식이 틀림)은 짓지 않는다. 실행 상태 'throttled'(기상청 429 — 2026-09-30)에 뜻(title)을 붙인다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activeJobs, jobBadgeText, jobProvider, noProviderLine } from "@/lib/active-provider";
import { RUN_STATUS_TITLE, runStatusClass } from "@/lib/ops";
import { detailRows, statusChips, type StatusInput } from "@/lib/statusbar";
import { domUtcLeaks, utcLeaks } from "./helpers/kst-only";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";

/** 12:16:40 KST — 공급자 없음 8 s 뒤 */
const NOW = Date.parse("2026-09-30T03:16:40Z");
const NONE = {
  region: "adsb_lol", region_since: "2026-09-30T03:15:00Z", region_reason: "fallback — adsb_fi 3회 연속 실패(10분 쉼) · adsb_lol 429 미룸 중이나 다른 공급자 없음",
  region_none_since: "2026-09-30T03:16:32Z", region_none_reason: "adsb_lol 429 반복 → 240분 뒤로 미룸 · adsb_fi 운영자 끔",
  region_none_next: "2026-09-30T03:21:22Z", global: "opensky", global_since: "2026-09-30T00:00:00Z", global_reason: "initial",
  global_none_since: "", global_none_reason: "", global_none_next: "",
};
const LINE = "공급자 없음 · 12:16:32 KST 부터 — 건너뜀: adsb_lol 429 반복 → 240분 뒤로 미룸 · adsb_fi 운영자 끔 · 가장 먼저 풀리는 때 12:21:22 KST(수집기 체인 상태) · 마지막으로 쓴 공급자 adsb_lol";
/** 쉬는 공급자를 다시 시도하는 공급자 없음(수집기 region_none_retry) */
const RETRY = {
  ...NONE, region_none_reason: "adsb_fi 3회 연속 실패(10분 쉼) · adsb_lol 429 쉼(300 s)", region_none_retry: "adsb_fi",
};
const RETRY_LINE = "공급자 없음 · 12:16:32 KST 부터 · adsb_fi 다시 시도 중(쉬는 공급자 — 다른 공급자가 없어 주기마다) — 건너뜀: adsb_fi 3회 연속 실패(10분 쉼) · adsb_lol 429 쉼(300 s) · 가장 먼저 풀리는 때 12:21:22 KST(수집기 체인 상태) · 마지막으로 쓴 공급자 adsb_lol";

describe("the collector's wakeline:active fields, as they are", () => {
  it("a job without any provider is a named state with its reason and the earliest known release (KST)", () => {
    const r = jobProvider(NONE, "region")!;
    expect(r.name).toBe("adsb_lol");
    expect(r.none).toEqual({ since: "2026-09-30T03:16:32Z", reason: "adsb_lol 429 반복 → 240분 뒤로 미룸 · adsb_fi 운영자 끔", next: "2026-09-30T03:21:22Z", retry: null });
    expect(noProviderLine(r, NOW)).toBe(LINE);
    expect(utcLeaks(noProviderLine(r, NOW))).toEqual([]);
    expect(jobProvider(NONE, "global")!.none).toBeNull(); // 빈 값 = 공급자가 있다
  });
  it("no release time known (switched off · not configured) is said, not invented; a malformed start time is unknown", () => {
    const r = jobProvider({ region: "adsb_lol", region_none_since: "yesterday", region_none_reason: "adsb_lol 운영자 끔 · adsb_fi 운영자 끔", region_none_next: "" }, "region")!;
    expect(r.none).toEqual({ since: null, reason: "adsb_lol 운영자 끔 · adsb_fi 운영자 끔", next: null, retry: null });
    expect(noProviderLine(r, NOW)).toBe("공급자 없음 · 시작 시각 모름 — 건너뜀: adsb_lol 운영자 끔 · adsb_fi 운영자 끔 · 풀리는 때 모름(운영자가 켜거나 설정해야 한다) · 마지막으로 쓴 공급자 adsb_lol");
  });
  it("a cooling provider retried because nothing else is usable is still 공급자 없음, and the line names it (review 2026-09-30)", () => {
    // 운영 로그의 모양: adsb_fi 연결 실패 3회로 쉬는 중 · adsb_lol 429 쉼 — 수집기가 adsb_fi 를 주기마다 다시 시도한다. 고치기 전 첫 판은 이 동안
    // wakeline:active 에 공급자 없음을 적지 않아 운영 배지가 초록 'region: adsb_fi' 였다
    const r = jobProvider(RETRY, "region")!;
    expect(r.none).toEqual({ since: "2026-09-30T03:16:32Z", reason: "adsb_fi 3회 연속 실패(10분 쉼) · adsb_lol 429 쉼(300 s)", next: "2026-09-30T03:21:22Z", retry: "adsb_fi" });
    expect(noProviderLine(r, NOW)).toBe(RETRY_LINE);
    expect(utcLeaks(RETRY_LINE)).toEqual([]);
    expect(jobBadgeText(r, NOW)).toBe("region: 공급자 없음 · 12:16:32 KST 부터 · adsb_fi 다시 시도 중");
  });
  it("jobs are the keys without an underscore, in the collector's order; an absent map is empty", () => {
    expect(activeJobs(NONE).map((j) => [j.job, j.name, j.none != null])).toEqual([["region", "adsb_lol", true], ["global", "opensky", false]]);
    expect(activeJobs(undefined)).toEqual([]);
    expect(jobProvider(undefined, "region")).toBeNull();
  });
});

function input(active: Record<string, string> | undefined): StatusInput {
  return {
    conn: "open", reconnectAttempt: 0, lastRxAt: NOW - 1000, nowMs: NOW, srvNowMs: NOW,
    feeds: { region: { provider: "adsb_lol", fetched_at: new Date(NOW - 28_000).toISOString(), lag_s: 28, stale: false, received_at: NOW - 1000 }, global: null },
    aircraftCount: 20, status: { fixture_mode: false, active_providers: active } as never, sigmetsProvider: "awc", sigmetsFetchedAt: null,
    radar: null, radarKr: null, ais: null, snapshotVersion: 1,
  };
}

describe("status bar: the region chip says 공급자 없음 (not only STALE by age)", () => {
  it("a word, a bad state that stays in the row, and the collector's reason in the title", () => {
    const c = statusChips(input(NONE)).find((x) => x.key === "region")!;
    expect(c.words.map((w) => w.text)).toEqual(["공급자 없음"]);
    expect(c.words[0].testId).toBe("region-no-provider");
    expect(c.words[0].title).toBe(LINE);
    expect(c.health).toBe("bad");
    expect(c.pinned).toBe(true);
    expect(c.title).toContain(LINE);
    expect(utcLeaks(c.title)).toEqual([]);
    const row = detailRows(input(NONE)).find((r) => r.key === "region")!;
    expect(row.state).toBe("공급자 없음");
    expect(row.valueTitle).toBe(LINE);
  });
  it("while the collector retries a cooling provider the chip still says 공급자 없음 and the title names the retried provider", () => {
    const c = statusChips(input(RETRY)).find((x) => x.key === "region")!;
    expect(c.words.map((w) => w.text)).toEqual(["공급자 없음"]);
    expect(c.words[0].title).toBe(RETRY_LINE);
    expect(c.health).toBe("bad");
  });
  it("with a provider the chip is as before", () => {
    const c = statusChips(input({ region: "adsb_fi", region_none_since: "" })).find((x) => x.key === "region")!;
    expect(c.words).toEqual([]);
    expect(c.health).toBe("ok");
    expect(statusChips(input(undefined)).find((x) => x.key === "region")!.words).toEqual([]);
  });
});

describe("runs: 'throttled' has its meaning (KMA 429 · rate limiter) and is not painted as a provider failure", () => {
  it("title and colour", () => {
    expect(RUN_STATUS_TITLE.throttled).toContain("429");
    expect(RUN_STATUS_TITLE.throttled).toContain("공급자 오류가 아니다");
    expect(runStatusClass("throttled", "item")).toBe("text-warn");
    expect(runStatusClass("error", "item")).toBe("text-bad");
  });
});

// ---- 운영 공급자 탭 위쪽의 작업별 배지 ----
const dom = installMiniDom();
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let OpsPage: typeof import("@/app/ops/page").default;
beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  OpsPage = (await import("@/app/ops/page")).default;
});
afterAll(() => dom.restore());
let root: Root | null = null;
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const byTestId = (id: string, from: MiniElement = dom.container): MiniElement | null => {
  if (from.getAttribute?.("data-testid") === id) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? byTestId(id, c) : null; if (f) return f; }
  return null;
};
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });

describe("ops providers tab: the job badge is red and says 공급자 없음 (it was green 'region: adsb_lol')", () => {
  it("region without a provider · global with one", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
    const DATA: Record<string, unknown> = {
      "/api/v1/ops/session": { username: "op" },
      "/api/v1/ops/providers": { providers: [], active: NONE, collector: {}, switches: [], budget_days: [], budget_day_zone: "UTC", generated_at: new Date(NOW).toISOString() },
    };
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(url in DATA ? DATA[url] : { detail: "no such resource" }), { status: url in DATA ? 200 : 404, headers: { "Content-Type": "application/json" } }));
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(OpsPage)); });
    await settle();
    await settle();
    const region = byTestId("ops-active-region")!;
    expect(region.textContent).toBe("region: 공급자 없음 · 12:16:32 KST 부터");
    expect(region.getAttribute("class")).toContain("badge bad");
    expect(region.getAttribute("title")).toBe(LINE);
    const global = byTestId("ops-active-global")!;
    expect(global.textContent).toBe("global: opensky");
    expect(global.getAttribute("class")).toContain("badge ok");
    expect(domUtcLeaks(byTestId("ops-dashboard")!)).toEqual([]);
  });
});
