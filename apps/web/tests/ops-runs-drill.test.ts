/**
 * 운영 RUNS 가 오래된 오류 실행의 까닭을 보인다(errors F1 — 운영 2026-09-30: region adsb_fi error 13 중 공급자 해시에 남은 마지막 하나의 글자만 보였다.
 * 'Recent runs' 는 모든 작업의 최근 50건이라 약 6분 뒤면 밀려났고, 화면은 필터 · 다음 쪽을 쓰지 않았다).
 * - 24 h 요약: ok 가 아닌 행마다 가장 최근 실행의 오류 글자(원문 그대로 — data-raw) · http(api 의 last_error_text · last_http_status).
 * - 행을 열면 그 job · provider · status 의 실행을 연 때의 요약 창(since = 응답의 summary_since)으로 50건씩 — next_cursor 로 '더 보기'. 해결 처리와 상관없이 모두.
 * - 연 행이 새로 받은 요약에서 빠지면 목록을 닫고 까닭을 적는다 — 행이 돌아와도 저절로 다시 열리지 않는다(리뷰 2026-10-01).
 * - 화면 시각은 KST 만(원문 글자 안의 'Z' 는 그대로).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { domUtcLeaks } from "./helpers/kst-only";
import { appendRunsPage, drillGoneText, runKeyOf, runsDrillPath, summaryHasKey, summaryLastError, summarySince } from "@/lib/ops-runs";

describe("lib/ops-runs: the drill-down request and the summary's last error", () => {
  const k = { job: "region", provider: "adsb_fi", status: "error" };
  it("asks for that job · provider · status in the summary's window, 50 at a time, with the cursor when paging", () => {
    expect(runsDrillPath(k, "2026-09-30T18:00:00.123456Z", null))
      .toBe("/api/v1/ops/runs?job=region&provider=adsb_fi&status=error&since=2026-09-30T18%3A00%3A00.123456Z&limit=50");
    expect(runsDrillPath(k, "2026-09-30T18:00:00.123456Z", 12345))
      .toBe("/api/v1/ops/runs?job=region&provider=adsb_fi&status=error&since=2026-09-30T18%3A00%3A00.123456Z&limit=50&cursor=12345");
    // 창을 모르면(옛 api) since 없이 — 기간을 짓지 않는다
    expect(runsDrillPath(k, null, null)).toBe("/api/v1/ops/runs?job=region&provider=adsb_fi&status=error&limit=50");
    expect(runsDrillPath({ job: "a&b", provider: "p q", status: "x" }, null, null)).toBe("/api/v1/ops/runs?job=a%26b&provider=p+q&status=x&limit=50");
  });
  it("reads a row's key only from strings", () => {
    expect(runKeyOf({ job: "region", provider: "adsb_fi", status: "error", n: 3 })).toEqual(k);
    expect(runKeyOf({ job: "region", provider: null, status: "error" })).toBeNull();
  });
  it("summary_since only as an ISO instant with a zone", () => {
    expect(summarySince({ summary_since: "2026-09-30T18:00:00.123456Z" })).toBe("2026-09-30T18:00:00.123456Z");
    expect(summarySince({ summary_since: "2026-09-30T18:00:00" })).toBeNull();
    expect(summarySince({})).toBeNull();
  });
  it("last error: text · http as the api sent them; a missing key (older api) is 'unknown', not 'none'", () => {
    expect(summaryLastError({ last_error_text: "HTTP 502 — Bad Gateway", last_http_status: 502 })).toEqual({ known: true, text: "HTTP 502 — Bad Gateway", http: 502 });
    expect(summaryLastError({ last_error_text: null, last_http_status: 200 })).toEqual({ known: true, text: null, http: 200 });
    expect(summaryLastError({})).toEqual({ known: false, text: null, http: null });
    expect(summaryLastError({ last_error_text: 7, last_http_status: "x" })).toEqual({ known: true, text: null, http: null });
  });
  it("an opened row that left the summary: found by its three strings; the note says why without guessing", () => {
    expect(summaryHasKey([{ job: "region", provider: "adsb_fi", status: "error", n: 1 }], k)).toBe(true);
    expect(summaryHasKey([{ job: "region", provider: "adsb_fi", status: "ok", n: 1 }], k)).toBe(false);
    expect(summaryHasKey(undefined, k)).toBe(false);
    // 요약에서 행이 빠지는 길은 둘뿐(IngestRunRepository.summary — n 이 0): 창 안에 실행이 없거나, hide 에서 error 실행이 모두 해결로 가려졌거나
    const hide = drillGoneText(k, "hide");
    expect(hide).toContain("region · adsb_fi · error");
    expect(hide).toContain("24 h 창 안에 그 실행이 더 없거나");
    expect(hide).toContain("해결 처리");
    expect(drillGoneText(k, "show")).not.toContain("해결 처리"); // show 는 가리지 않는다
    expect(drillGoneText({ ...k, status: "budget_exhausted" }, "hide")).not.toContain("해결 처리"); // 해결은 error 만 가린다
    expect(drillGoneText({ ...k, status: "budget_exhausted" }, "hide")).toContain("24 h 창 안에 그 실행이 더 없다");
  });
  it("pages append in order and an id already shown is not repeated", () => {
    expect(appendRunsPage([{ id: 9 }, { id: 8 }], [{ id: 8 }, { id: 7 }])).toEqual([{ id: 9 }, { id: 8 }, { id: 7 }]);
  });
});

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

const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const all = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container, out: MiniElement[] = []): MiniElement[] => {
  if (pred(from)) out.push(from);
  for (const c of from.childNodes) if (c instanceof MiniElement) all(pred, c, out);
  return out;
};
const byTestId = (id: string, from: MiniElement = dom.container) => all((e) => e.getAttribute?.("data-testid") === id, from)[0] ?? null;
const click = async (el: MiniElement) => {
  const k = Object.keys(el).find((x) => x.startsWith("__reactProps$"))!;
  await React.act(async () => { (el as unknown as Record<string, { onClick: () => void }>)[k].onClick(); });
  await settle();
};
const cells = (tr: MiniElement) => all((e) => e.tagName === "TD", tr);

describe("ops RUNS: the 24 h summary shows each non-ok row's last error; a row opens its own runs, paged by the cursor (KST only)", () => {
  const NOW = "2026-09-30T18:05:00Z"; // 10-01 03:05 KST
  const SINCE = "2026-09-29T18:05:00.123456Z";
  const TIMEOUT = "ReadTimeout — read 제한 8 s 초과 (opendata.adsb.fi)";
  const GRID = "MOF hourly window: grid share used (290 of 390 in UTC hour 2026093017, 100 left for port calls) — geometry fill resumes at 2026-09-30T18:00:00Z";
  const drill = `/api/v1/ops/runs?job=region&provider=adsb_fi&status=error&since=${encodeURIComponent(SINCE)}&limit=50`;
  const run = (id: number, at: string, text: string | null, http: number | null = null) => ({
    id, job: "region", provider: "adsb_fi", started_at: at, finished_at: at, status: "error", http_status: http, latency_ms: 8000,
    records_in: 0, records_quarantined: 0, raw_ref: null, error_text: text,
  });
  const DATA: Record<string, unknown> = {
    "/api/v1/ops/session": { username: "op" },
    "/api/v1/ops/providers": { providers: [], active: {}, collector: {}, switches: [], budget_days: [], budget_day_zone: "UTC" },
    "/api/v1/ops/runs?limit=50&resolved=hide": {
      items: [],
      summary_24h: [
        { job: "region", provider: "adsb_fi", status: "error", n: 13, avg_latency_ms: 8012, last_at: "2026-09-30T17:58:01Z", last_error_text: TIMEOUT, last_http_status: null },
        // ok 행: api 는 고르지 않는다(둘 다 null — 계약 v5 §G14 개정)
        { job: "region", provider: "adsb_fi", status: "ok", n: 8000, avg_latency_ms: 250, last_at: "2026-09-30T18:04:50Z", last_error_text: null, last_http_status: null },
        { job: "traffic_grid_geom", provider: "mof_grid4", status: "budget_exhausted", n: 24, last_at: "2026-09-30T17:18:11Z", last_error_text: GRID, last_http_status: null },
        // 옛 api(키 없음): 모름 — '글자 없음' 이라고 하지 않는다
        { job: "radar", provider: "rainviewer", status: "error", n: 4, last_at: "2026-09-30T15:25:27Z" },
      ],
      summary_since: SINCE,
      hidden_resolved_errors: 0,
    },
    [drill]: { items: [run(912, "2026-09-30T17:58:01Z", TIMEOUT), run(905, "2026-09-30T17:57:43Z", TIMEOUT)], next_cursor: 905 },
    [`${drill}&cursor=905`]: { items: [run(501, "2026-09-30T02:58:01Z", "HTTP 503 — Service Unavailable (opendata.adsb.fi)", 503)] },
  };
  const asked: string[] = [];

  it("shows last errors, opens a row, pages to the end, closes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse(NOW) });
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(url in DATA ? DATA[url] : { detail: "no such resource" }), { status: url in DATA ? 200 : 404, headers: { "Content-Type": "application/json" } });
    });
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(OpsPage)); });
    await settle();
    await settle();
    await click(byTestId("ops-tab-runs")!);

    const rows = all((e) => e.getAttribute?.("data-testid") === "runs-summary-row");
    expect(rows).toHaveLength(4);
    // 오류 행: 가장 최근 실행의 글자(원문 그대로 · data-raw)
    const err = byTestId("runs-last-error", rows[0])!;
    expect(err.textContent).toBe(TIMEOUT);
    expect(err.getAttribute("data-raw")).toBe("record");
    expect(byTestId("runs-last-http", rows[0])).toBeNull(); // http 를 모르면 적지 않는다
    // ok 행은 비운다(http 200 도 적지 않는다)
    expect(byTestId("runs-last-error", rows[1])).toBeNull();
    // 예산 거절: 원문의 UTC 'Z' 는 그대로(data-raw 안) — 상태는 주황 · 제 뜻(title)
    expect(byTestId("runs-last-error", rows[2])!.textContent).toBe(GRID);
    expect(cells(rows[2])[2].getAttribute("class")).toBe("text-warn");
    expect(cells(rows[2])[2].getAttribute("title")).toContain("예산 거절");
    // 옛 api: 모름
    expect(byTestId("runs-last-error-unknown", rows[3])!.textContent).toBe("—");
    expect(byTestId("runs-last-error-unknown", rows[3])!.getAttribute("title")).toContain("api 가 이 화면보다 옛 판");
    expect(domUtcLeaks(byTestId("ops-dashboard")!)).toEqual([]);

    // 행 열기 → 그 행의 실행(연 때의 요약 창)
    const open = byTestId("runs-drill-open", rows[0])!;
    expect(open.getAttribute("aria-expanded")).toBe("false");
    await click(open);
    expect(asked).toContain(drill);
    const panel = byTestId("runs-drill")!;
    expect(panel).not.toBeNull();
    expect(byTestId("runs-drill-open", all((e) => e.getAttribute?.("data-testid") === "runs-summary-row")[0])!.getAttribute("aria-expanded")).toBe("true");
    expect(byTestId("runs-drill-window", panel)!.textContent).toContain("09-30 03:05:00 KST 뒤에 시작한 실행"); // 18:05:00Z 전날 = 09-30 03:05 KST
    // 리뷰 2026-10-01: 요약은 15 s 마다 창이 앞으로 가고 이 목록은 연 때의 창 그대로 — '요약과 같은 창' 이라고 하면 곧 틀린다
    expect(byTestId("runs-drill-window", panel)!.textContent).toContain("연 때의 요약 창");
    expect(byTestId("runs-drill-window", panel)!.textContent).not.toContain("요약과 같은");
    expect(byTestId("runs-drill-window", panel)!.textContent).toContain("해결 처리와 상관없이 모두");
    const texts = () => all((e) => e.getAttribute?.("data-testid") === "runs-drill-error", panel).map((e) => e.textContent);
    expect(texts()).toEqual([TIMEOUT, TIMEOUT]);
    const drillRows = () => all((e) => e.tagName === "TR" && e.getAttribute?.("data-testid") === "runs-drill-row", panel);
    expect(cells(drillRows()[0]).map((c) => c.textContent).slice(0, 3)).toEqual(["912", "10-01 02:58:01 KST", "10-01 02:58:01 KST"]);
    expect(byTestId("runs-drill-count", panel)!.textContent).toBe("2건 · 더 있음");

    // 더 보기 → next_cursor
    await click(byTestId("runs-drill-more", panel)!);
    expect(asked).toContain(`${drill}&cursor=905`);
    expect(texts()).toEqual([TIMEOUT, TIMEOUT, "HTTP 503 — Service Unavailable (opendata.adsb.fi)"]);
    expect(cells(drillRows()[2])[3].textContent).toBe("503");
    expect(byTestId("runs-drill-more", panel)).toBeNull();
    expect(byTestId("runs-drill-count", panel)!.textContent).toBe("3건 · 끝");
    expect(domUtcLeaks(byTestId("ops-dashboard")!)).toEqual([]);

    // 15 s 새로고침이 요약을 다시 받아도 열린 목록은 그대로(다시 부르지 않는다)
    const before = asked.filter((u) => u.startsWith(drill)).length;
    await React.act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    expect(asked.filter((u) => u.startsWith(drill)).length).toBe(before);
    expect(byTestId("runs-drill")).not.toBeNull();
    expect(texts()).toHaveLength(3);

    // 닫기
    await click(byTestId("runs-drill-close", byTestId("runs-drill")!)!);
    expect(byTestId("runs-drill")).toBeNull();
  });

  it("when the opened row leaves the refreshed summary the panel closes with a note, and it does not reopen or refetch when the row comes back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse(NOW) });
    const summaryUrl = "/api/v1/ops/runs?limit=50&resolved=hide";
    const full = DATA[summaryUrl] as { summary_24h: Record<string, unknown>[] };
    let summary: unknown = full;
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      const body = url === summaryUrl ? summary : DATA[url];
      return new Response(JSON.stringify(body ?? { detail: "no such resource" }), { status: body ? 200 : 404, headers: { "Content-Type": "application/json" } });
    });
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(OpsPage)); });
    await settle();
    await settle();
    await click(byTestId("ops-tab-runs")!);
    await click(byTestId("runs-drill-open", all((e) => e.getAttribute?.("data-testid") === "runs-summary-row")[0])!);
    expect(byTestId("runs-drill")).not.toBeNull();
    const drillAsks = () => seen.filter((u) => u.startsWith(drill)).length;
    const asked0 = drillAsks();

    // 15 s 뒤의 요약에 그 행이 없다(창 밖으로 나갔거나 해결로 모두 가려짐) — 패널을 닫고 까닭을 적는다(말없이 사라지지 않는다)
    summary = { ...full, summary_24h: full.summary_24h.filter((r) => r.status !== "error" || r.job !== "region") };
    await React.act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    expect(byTestId("runs-drill")).toBeNull();
    const note = byTestId("runs-drill-gone")!;
    expect(note).not.toBeNull();
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toContain("region · adsb_fi · error");
    expect(note.textContent).toContain("해결 처리");

    // 행이 돌아와도 저절로 다시 열리지 않고 다시 부르지 않는다(사용자가 열 때만)
    summary = full;
    await React.act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    expect(byTestId("runs-drill")).toBeNull();
    expect(drillAsks()).toBe(asked0);
    const row0 = all((e) => e.getAttribute?.("data-testid") === "runs-summary-row")[0];
    expect(byTestId("runs-drill-open", row0)!.getAttribute("aria-expanded")).toBe("false");
    // 사용자가 다시 열면 알림은 지우고 새로 부른다
    await click(byTestId("runs-drill-open", row0)!);
    expect(byTestId("runs-drill")).not.toBeNull();
    expect(byTestId("runs-drill-gone")).toBeNull();
    expect(drillAsks()).toBe(asked0 + 1);
    expect(domUtcLeaks(byTestId("ops-dashboard")!)).toEqual([]);
  });

  it("a failed drill-down request is named on the panel with its request id; nothing is invented", async () => {
    vi.stubGlobal("self", globalThis); // 요청 id 의 "로그 보기" 는 Next 링크(브라우저 전역 self 를 읽는다)
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse(NOW) });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === drill) return new Response(JSON.stringify({ status: 503, detail: "data store temporarily unavailable; retry later", code: "UNAVAILABLE", request_id: "abcd1234abcd1234" }),
        { status: 503, headers: { "Content-Type": "application/problem+json", "Retry-After": "10" } });
      return new Response(JSON.stringify(url in DATA ? DATA[url] : { detail: "no such resource" }), { status: url in DATA ? 200 : 404, headers: { "Content-Type": "application/json" } });
    });
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(OpsPage)); });
    await settle();
    await settle();
    await click(byTestId("ops-tab-runs")!);
    await click(byTestId("runs-drill-open", all((e) => e.getAttribute?.("data-testid") === "runs-summary-row")[0])!);
    const panel = byTestId("runs-drill")!;
    const note = byTestId("runs-drill-failed", panel)!;
    expect(note.textContent).toContain("실행 목록을 불러오지 못함");
    expect(note.textContent).toContain("HTTP 503");
    expect(note.textContent).toContain("abcd1234abcd1234");
    expect(all((e) => e.getAttribute?.("data-testid") === "runs-drill-row", panel)).toHaveLength(0);
    expect(byTestId("runs-drill-count", panel)).toBeNull(); // 몇 건인지 모른다 — '0건' 이라고 하지 않는다
  });
});
