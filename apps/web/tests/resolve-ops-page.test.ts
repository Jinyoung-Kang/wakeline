/**
 * 해결 처리(ADR-022) — /ops 화면(실제 react-dom 마운트 — 최소 DOM + fetch 대역).
 * PROVIDERS: LAST ERROR 칸의 "해결 처리"(kind provider_error, key = 공급자, upto = 그 오류의 시각 last_error_at 그대로) · last_error_resolved 면 흐리게 "해결됨"
 * + "되돌리기" · 해결 뒤 재발은 그렇다고. RUNS: 요약 요청의 resolved=hide|show · hidden_resolved_errors 안내 · "해결된 오류 포함" 토글.
 * 쓰기는 CSRF 헤더 · 세션 만료 처리 · 요청 id 를 붙인 오류, 화면은 201/204 뒤에만 바뀌고 영향받는 목록(providers · runs · audit)을 다시 불러온다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { unpairedKst } from "./helpers/dual-time";

const dom = installMiniDom();
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let OpsPage: typeof import("@/app/ops/page").default;

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  OpsPage = (await import("@/app/ops/page")).default;
  (dom.document as unknown as { cookie: string }).cookie = "WAKELINE_CSRF=t";
});
afterAll(() => dom.restore());
let root: Root | null = null;
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NOW = "2026-09-28T23:41:14Z";
const ERR_AT = "2026-09-28T23:40:21.631Z";
const RUNS_HIDE = "/api/v1/ops/runs?limit=50&resolved=hide";
const RUNS_SHOW = "/api/v1/ops/runs?limit=50&resolved=show";
const lol = (o: Record<string, unknown> = {}) => ({
  name: "adsb_lol", last_success_at: "2026-09-28T23:40:00Z", last_records: "12", consecutive_failures: "1",
  last_error: "rate limited (429)", last_error_at: ERR_AT, last_error_resolution: null, last_error_resolved: false, ...o,
});
const fi = { name: "adsb_fi", last_success_at: "2026-09-28T23:41:00Z", last_latency_ms: "420", last_records: "80", consecutive_failures: "0", last_error_resolution: null, last_error_resolved: false };
const PROV = (providers: unknown[], o: Record<string, unknown> = {}) => ({ providers, active: {}, collector: {}, switches: [], budget_days: [], resolution_state: "ok", ...o });
const ERROR_ROW = { job: "region", provider: "adsb_lol", status: "error", n: 3, avg_latency_ms: null, last_at: "2026-09-28T23:40:21Z" };
const OK_ROW = { job: "region", provider: "adsb_fi", status: "ok", n: 40, avg_latency_ms: 250, last_at: "2026-09-28T23:41:00Z" };
const BASE: Record<string, unknown> = {
  "/api/v1/ops/session": { username: "op" },
  [RUNS_HIDE]: { items: [], summary_24h: [OK_ROW], hidden_resolved_errors: 3 },
  [RUNS_SHOW]: { items: [], summary_24h: [ERROR_ROW, OK_ROW], hidden_resolved_errors: 0 },
  "/api/v1/ops/quality": { rule_counts: [], recent: [] },
  "/api/v1/ops/settings": { items: [] },
  "/api/v1/ops/audit": { items: [] },
  "/api/v1/ops/dlq": { items: [] },
  "/api/v1/ops/pipeline": { collector: {}, api: {} },
};

type Reply = { status: number; body?: unknown };
type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };
const calls: Call[] = [];
/** "METHOD path" → 응답(함수 · 비동기 가능). 없는 GET 은 BASE */
function stub(routes: Record<string, Reply | (() => Reply | Promise<Reply>)>, session: () => boolean = () => true) {
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const res = (r: Reply) => (r.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } }));
    if (url === "/api/v1/ops/session") return session() ? res({ status: 200, body: { username: "op" } }) : res({ status: 404, body: { detail: "not found" } });
    const r = routes[`${method} ${url}`];
    if (r) return res(typeof r === "function" ? await r() : r);
    return url in BASE && method === "GET" ? res({ status: 200, body: BASE[url] }) : res({ status: 404, body: { detail: "no such resource" } });
  });
}
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const find = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => {
  if (pred(from)) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
  return null;
};
const byTestId = (id: string, from?: MiniElement) => find((e) => e.getAttribute?.("data-testid") === id, from);
const button = (text: string, from?: MiniElement) => find((e) => e.tagName === "BUTTON" && e.textContent.trim() === text, from);
const propsOf = (e: MiniElement): Record<string, (...a: unknown[]) => unknown> => {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  return (e as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[k!];
};
const click = async (e: MiniElement | null) => {
  expect(e).not.toBeNull();
  await React.act(async () => { await propsOf(e!).onClick?.({ preventDefault() {}, stopPropagation() {} }); });
  await settle();
  await settle();
};
async function mount() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse(NOW) });
  vi.stubGlobal("self", globalThis); // 요청 id 의 "로그 보기" 는 Next 링크(브라우저 전역 self 를 읽는다)
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(React.createElement(OpsPage)); });
  await settle();
  await settle();
}
const cell = () => byTestId("provider-last-error")!;
const statusText = () => find((e) => e.getAttribute?.("data-testid") === "resolve-ok")?.textContent ?? "";

describe("/ops PROVIDERS: the LAST ERROR cell", () => {
  it("'해결 처리' confirms (provider · upto = that error's time · effect), POSTs exactly {kind: provider_error, key, upto} with CSRF; after 201 providers · runs · audit are re-read and the cell shows 해결됨", async () => {
    let resolved = false;
    stub({
      "GET /api/v1/ops/providers": () => ({ status: 200, body: PROV([resolved ? lol({ last_error_resolution: { id: 5, upto: ERR_AT, resolved_by: "op" }, last_error_resolved: true }) : lol(), fi]) }),
      "POST /api/v1/ops/resolutions": () => { resolved = true; return { status: 201, body: { id: 5, kind: "provider_error", key: "adsb_lol", upto: ERR_AT, resolved_at: NOW, resolved_by: "op", note: null } }; },
    });
    await mount();
    expect(byTestId("provider-last-error-text")!.textContent).toBe("rate limited (429) 09-29 08:40:21 KST · 09-28 23:40:21 UTC");
    await click(button("해결 처리", cell()));
    const panel = byTestId("resolve-confirm")!;
    expect(panel.textContent).toContain("공급자 adsb_lol 의 마지막 오류");
    expect(panel.textContent).toContain("upto 09-29 08:40:21 KST · 09-28 23:40:21 UTC");
    expect(panel.textContent).toContain("실행 기록 · 공급자 상태는 그대로");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const before = calls.length;
    await click(button("해결 처리 확인", panel));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/v1/ops/resolutions");
    expect(post.body).toEqual({ kind: "provider_error", key: "adsb_lol", upto: ERR_AT });
    expect(post.headers["X-CSRF-Token"]).toBe("t");
    const after = calls.slice(before).filter((c) => c.method === "GET").map((c) => c.url);
    expect(after).toEqual(expect.arrayContaining(["/api/v1/ops/providers", RUNS_HIDE, "/api/v1/ops/audit"]));
    expect(byTestId("resolve-confirm")).toBeNull();
    expect(byTestId("provider-error-resolved")!.textContent).toBe("해결됨 · op · 09-29 08:40:21 KST · 09-28 23:40:21 UTC");
    expect(cell().getAttribute("class")).toContain("text-fg-3");
    expect(button("해결 처리", cell())).toBeNull();
    expect(button("되돌리기", cell())).not.toBeNull();
    expect(statusText()).toContain("해결 처리됨: 공급자 adsb_lol");
    expect(unpairedKst(byTestId("ops-dashboard")!.textContent)).toEqual([]);
  });
  it("a providers response that left before the write and lands after the post-write reload is dropped (the older answer never wins)", async () => {
    let resolved = false;
    let hold = false;
    let release: (() => void) | null = null;
    stub({
      "GET /api/v1/ops/providers": async () => {
        const body = PROV([resolved ? lol({ last_error_resolution: { id: 5, upto: ERR_AT, resolved_by: "op" }, last_error_resolved: true }) : lol(), fi]);
        if (hold) { hold = false; await new Promise<void>((r) => { release = r; }); }
        return { status: 200, body };
      },
      "POST /api/v1/ops/resolutions": () => { resolved = true; return { status: 201, body: { id: 5, kind: "provider_error", key: "adsb_lol", upto: ERR_AT, resolved_at: NOW, resolved_by: "op", note: null } }; },
    });
    await mount();
    hold = true;
    await click(button("refresh")); // 해결 전 값을 싣고 기다리는 요청
    await click(button("해결 처리", cell()));
    await click(button("해결 처리 확인", byTestId("resolve-confirm")!));
    expect(byTestId("provider-error-resolved")).not.toBeNull();
    await React.act(async () => { release!(); });
    await settle();
    expect(byTestId("provider-error-resolved")).not.toBeNull();
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-providers")!)).toBeNull();
  });
  it("a resolved last error is muted with 해결됨; '되돌리기' confirms and sends DELETE /api/v1/ops/resolutions/{id} (no body, CSRF); after 204 the lists are re-read", async () => {
    let revoked = false;
    stub({
      "GET /api/v1/ops/providers": () => ({ status: 200, body: PROV([revoked ? lol() : lol({ last_error_resolution: { id: 5, upto: ERR_AT, resolved_by: "kim" }, last_error_resolved: true }), fi]) }),
      "DELETE /api/v1/ops/resolutions/5": () => { revoked = true; return { status: 204 }; },
    });
    await mount();
    expect(byTestId("provider-error-resolved")!.textContent).toBe("해결됨 · kim · 09-29 08:40:21 KST · 09-28 23:40:21 UTC");
    await click(button("되돌리기", cell()));
    expect(byTestId("resolve-confirm")!.textContent).toContain("해결 #5");
    const before = calls.length;
    await click(button("되돌리기 확인", byTestId("resolve-confirm")!));
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toBe("/api/v1/ops/resolutions/5");
    expect(del.body).toBeUndefined();
    expect(del.headers["X-CSRF-Token"]).toBe("t");
    expect(calls.slice(before).filter((c) => c.method === "GET").map((c) => c.url)).toEqual(expect.arrayContaining(["/api/v1/ops/providers", RUNS_HIDE]));
    expect(byTestId("provider-error-resolved")).toBeNull();
    expect(button("해결 처리", cell())).not.toBeNull();
    expect(statusText()).toContain("되돌림: 해결 #5");
  });
  it("a new error after the resolution is shown as a recurrence and can be resolved again", async () => {
    stub({ "GET /api/v1/ops/providers": { status: 200, body: PROV([lol({ last_error_resolution: { id: 5, upto: "2026-09-28T23:00:00Z", resolved_by: "op" }, last_error_resolved: false }), fi]) } });
    await mount();
    expect(byTestId("provider-error-recurred")!.textContent).toBe("이전 해결 #5(upto 09-29 08:00:00 KST · 09-28 23:00:00 UTC) 뒤 다시 남");
    expect(byTestId("provider-error-resolved")).toBeNull();
    expect(button("해결 처리", cell())).not.toBeNull();
  });
  it("a resolution the api could not match to this error (its time is unreadable) is not called a recurrence — it says the coverage is unknown", async () => {
    stub({ "GET /api/v1/ops/providers": { status: 200, body: PROV([lol({ last_error_at: "yesterday", last_error_resolution: { id: 5, upto: "2026-09-28T23:00:00Z", resolved_by: "op" }, last_error_resolved: false }), fi]) } });
    await mount();
    expect(byTestId("provider-error-recurred")).toBeNull();
    expect(byTestId("provider-error-resolved")).toBeNull();
    expect(byTestId("provider-error-undecided")!.textContent).toBe("해결 #5(upto 09-29 08:00:00 KST · 09-28 23:00:00 UTC) 있음 — 이 오류의 시각을 몰라 그 해결이 덮는지 알 수 없음");
    expect(button("해결 처리", cell())!.getAttribute("disabled")).not.toBeNull();
  });
  it("no last error → no action; a last_error_at the web cannot read as an instant → the action is disabled and says why", async () => {
    stub({ "GET /api/v1/ops/providers": { status: 200, body: PROV([lol({ last_error_at: "yesterday" }), fi]) } });
    await mount();
    const b = button("해결 처리", cell())!;
    expect(b.getAttribute("disabled")).not.toBeNull();
    expect(b.getAttribute("title")).toContain("오류 시각을 모름");
    const rows = [...dom.container.textContent.matchAll(/해결 처리/g)];
    expect(rows).toHaveLength(1); // adsb_fi(오류 없음)에는 없다
  });
  it("a refused resolve shows the reason with HTTP · code · request id and changes nothing", async () => {
    stub({
      "GET /api/v1/ops/providers": { status: 200, body: PROV([lol(), fi]) },
      "POST /api/v1/ops/resolutions": { status: 400, body: { detail: "key must be an operated provider", code: "BAD_RESOLUTION", request_id: "c0ffee00c0ffee00" } },
    });
    await mount();
    await click(button("해결 처리", cell()));
    await click(button("해결 처리 확인", byTestId("resolve-confirm")!));
    const err = byTestId("resolve-error")!;
    expect(err.textContent).toContain("해결 처리 실패 — 서버가 요청을 거절함: key must be an operated provider");
    expect(err.textContent).toContain("HTTP 400 · BAD_RESOLUTION");
    expect(err.textContent).toContain("c0ffee00c0ffee00");
    expect(byTestId("provider-error-resolved")).toBeNull();
    const post = calls.findIndex((c) => c.method === "POST");
    expect(calls.slice(post + 1).filter((c) => c.url === "/api/v1/ops/providers")).toEqual([]);
  });
  it("a session that expired before the write goes back to the login form", async () => {
    let alive = true;
    stub({
      "GET /api/v1/ops/providers": { status: 200, body: PROV([lol(), fi]) },
      "POST /api/v1/ops/resolutions": () => { alive = false; return { status: 404, body: { detail: "not found" } }; },
    }, () => alive);
    await mount();
    await click(button("해결 처리", cell()));
    await click(button("해결 처리 확인", byTestId("resolve-confirm")!));
    await settle();
    expect(byTestId("ops-login")).not.toBeNull();
    expect(byTestId("ops-login-notice")!.textContent).toContain("세션이 만료");
  });
  it("a resolution record the api could not re-read (stale) is announced", async () => {
    stub({ "GET /api/v1/ops/providers": { status: 200, body: PROV([lol(), fi], { resolution_state: "stale" }) } });
    await mount();
    expect(byTestId("ops-resolution-state")!.textContent).toContain("stale");
  });
});

describe("/ops RUNS: resolved errors are left out of the summary unless asked", () => {
  const tab = async (t: string) => click(byTestId(`ops-tab-${t}`));
  const summary = () => {
    const all: MiniElement[] = [];
    const walk = (n: MiniElement) => { if (n.getAttribute?.("data-testid") === "runs-summary-row") all.push(n); for (const c of n.childNodes) if (c instanceof MiniElement) walk(c); };
    walk(dom.container);
    return all.map((r) => r.textContent);
  };
  it("the request says resolved=hide; hidden_resolved_errors is a note; '해결된 오류 포함' asks for resolved=show", async () => {
    stub({ "GET /api/v1/ops/providers": { status: 200, body: PROV([fi]) } });
    await mount();
    expect(calls.some((c) => c.url === RUNS_HIDE)).toBe(true);
    await tab("runs");
    const note = byTestId("runs-hidden-resolved")!;
    expect(note.textContent).toContain("해결 처리로 요약에서 뺀 오류 실행 3건");
    expect(note.textContent).toContain("실행 기록(Recent runs)은 가리지 않음");
    expect(summary()).toHaveLength(1);
    const toggle = button("해결된 오류 포함")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await click(toggle);
    expect(calls.at(-1)!.url).toBe(RUNS_SHOW);
    expect(button("해결된 오류 포함")!.getAttribute("aria-pressed")).toBe("true");
    expect(byTestId("runs-hidden-resolved")!.textContent).toBe("해결된 오류 포함(요약에서 빼지 않음)");
    expect(summary()).toHaveLength(2);
    expect(byTestId("ops-last-ok")!.getAttribute("title")).toContain(RUNS_SHOW); // 탭의 경로가 지금 요청을 말한다
    // 15 s 새로고침도 고른 쪽으로
    await React.act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    expect(calls.filter((c) => c.url.startsWith("/api/v1/ops/runs")).at(-1)!.url).toBe(RUNS_SHOW);
  });
  it("an api that does not report the count shows '—' alone", async () => {
    stub({ "GET /api/v1/ops/providers": { status: 200, body: PROV([fi]) }, [`GET ${RUNS_HIDE}`]: { status: 200, body: { items: [], summary_24h: [OK_ROW] } } });
    await mount();
    await tab("runs");
    expect(byTestId("runs-hidden-resolved")!.textContent).toContain("해결 처리로 요약에서 뺀 오류 실행 —");
    expect(byTestId("runs-hidden-resolved")!.textContent).not.toContain("—건");
  });
  it("a summary that was asked for before the toggle and arrives after it is dropped (the table never shows the other mode)", async () => {
    let gate = false;
    let release: (() => void) | null = null;
    stub({
      "GET /api/v1/ops/providers": { status: 200, body: PROV([fi]) },
      [`GET ${RUNS_HIDE}`]: async () => {
        if (gate) await new Promise<void>((r) => { release = r; });
        return { status: 200, body: BASE[RUNS_HIDE] };
      },
    });
    await mount();
    await tab("runs");
    gate = true;
    await click(button("refresh")); // hide 요청이 떠나 기다린다
    await click(button("해결된 오류 포함")); // show 요청은 바로 온다
    expect(summary()).toHaveLength(2);
    await React.act(async () => { release!(); });
    await settle();
    expect(summary()).toHaveLength(2); // 늦게 온 hide 응답은 버렸다
    expect(byTestId("runs-hidden-resolved")!.textContent).toBe("해결된 오류 포함(요약에서 빼지 않음)");
  });
});

describe("/ops tabs: an answer slower than the 15 s refresh", () => {
  const providersGets = () => calls.filter((c) => c.method === "GET" && c.url === "/api/v1/ops/providers").length;
  const tick = async () => { await React.act(async () => { vi.advanceTimersByTime(15_000); }); await settle(); };
  it("a tab whose request takes longer than the refresh still shows what came back — a late 503 marks the tab 갱신 실패 with the error and request id", async () => {
    const pending: (() => void)[] = [];
    let n = 0;
    stub({
      "GET /api/v1/ops/providers": async () => {
        if (++n === 1) return { status: 200, body: PROV([lol(), fi]) };
        await new Promise<void>((r) => { pending.push(r); }); // 새로고침(15 s)보다 오래 걸린 뒤 503
        return { status: 503, body: { detail: "db slow", code: "UNAVAILABLE", request_id: "5105105105105105" } };
      },
    });
    await mount();
    await tick();
    await tick(); // 앞 요청이 아직 떠 있는 동안의 새로고침
    expect(pending.length).toBeGreaterThanOrEqual(1);
    await React.act(async () => { pending.shift()!(); });
    await settle();
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-providers")!)).not.toBeNull();
    const alert = find((e) => e.getAttribute?.("role") === "alert")!;
    expect(alert.textContent).toContain("providers: db slow");
    expect(alert.textContent).toContain("5105105105105105");
    expect(byTestId("provider-last-error")).not.toBeNull(); // 값은 마지막 성공 기준으로 남는다
  });
  it("the refresh does not stack another request on a tab whose request is still in flight; the other tabs keep refreshing", async () => {
    let release: (() => void) | null = null;
    let n = 0;
    stub({
      "GET /api/v1/ops/providers": async () => {
        if (++n === 2) await new Promise<void>((r) => { release = r; });
        return { status: 200, body: PROV([lol(), fi]) };
      },
    });
    await mount();
    expect(providersGets()).toBe(1);
    const runsGets = () => calls.filter((c) => c.url === RUNS_HIDE).length;
    const runs0 = runsGets();
    await tick(); // 2번째 요청이 떠나 기다린다
    await tick();
    await tick();
    expect(providersGets()).toBe(2); // 떠 있는 동안에는 더 보내지 않는다
    expect(runsGets()).toBe(runs0 + 3);
    await React.act(async () => { release!(); });
    await settle();
    await tick();
    expect(providersGets()).toBe(3);
  });
  it("a providers answer that left before a write and lands before the post-write re-read is dropped (no flash of the unresolved state)", async () => {
    let resolved = false;
    const held: (() => void)[] = [];
    let hold = 0;
    stub({
      "GET /api/v1/ops/providers": async () => {
        const body = PROV([resolved ? lol({ last_error_resolution: { id: 5, upto: ERR_AT, resolved_by: "op" }, last_error_resolved: true }) : lol(), fi]);
        if (hold > 0) { hold--; await new Promise<void>((r) => { held.push(r); }); }
        return { status: 200, body };
      },
      "POST /api/v1/ops/resolutions": () => { resolved = true; return { status: 201, body: { id: 5, kind: "provider_error", key: "adsb_lol", upto: ERR_AT, resolved_at: NOW, resolved_by: "op", note: null } }; },
    });
    await mount();
    hold = 2;
    await click(button("refresh")); // 해결 전 값을 싣고 기다리는 요청
    await click(button("해결 처리", cell()));
    await click(button("해결 처리 확인", byTestId("resolve-confirm")!)); // 쓰기 뒤 다시 읽기도 기다린다
    expect(held).toHaveLength(2);
    expect(byTestId("provider-error-resolved")).not.toBeNull(); // 201 뒤 낙관적 표시
    await React.act(async () => { held.shift()!(); }); // 쓰기 전에 떠난 응답이 먼저 온다
    await settle();
    expect(byTestId("provider-error-resolved")).not.toBeNull();
    await React.act(async () => { held.shift()!(); });
    await settle();
    expect(byTestId("provider-error-resolved")).not.toBeNull();
  });
  it("a summary asked for before the toggle that lands before the new mode's answer is dropped too", async () => {
    const held: (() => void)[] = [];
    let hold = false;
    // 떠나 기다린 hide 응답은 수가 다르다(9) — 처음 받은 hide 응답(3)과 가려 본다
    const gate = async (url: string) => {
      if (!hold) return { status: 200, body: BASE[url] };
      await new Promise<void>((r) => { held.push(r); });
      return { status: 200, body: url === RUNS_HIDE ? { ...(BASE[url] as object), hidden_resolved_errors: 9 } : BASE[url] };
    };
    stub({
      "GET /api/v1/ops/providers": { status: 200, body: PROV([fi]) },
      [`GET ${RUNS_HIDE}`]: () => gate(RUNS_HIDE),
      [`GET ${RUNS_SHOW}`]: () => gate(RUNS_SHOW),
    });
    await mount();
    await click(byTestId("ops-tab-runs"));
    hold = true;
    await click(button("refresh")); // hide 요청이 떠나 기다린다
    await click(button("해결된 오류 포함")); // show 요청도 기다린다
    expect(held).toHaveLength(2);
    await React.act(async () => { held.shift()!(); }); // hide 응답이 먼저 온다 — 버린다
    await settle();
    expect(byTestId("runs-hidden-resolved")!.textContent).not.toContain("9건");
    await React.act(async () => { held.shift()!(); });
    await settle();
    expect(byTestId("runs-hidden-resolved")!.textContent).toBe("해결된 오류 포함(요약에서 빼지 않음)");
  });
});

describe("/ops: a write whose confirmation is gone before the answer still counts", () => {
  it("switching tabs while the POST is in flight: the 201 re-reads the lists, says so, and the confirmation does not come back", async () => {
    let resolved = false;
    let release: (() => void) | null = null;
    stub({
      "GET /api/v1/ops/providers": () => ({ status: 200, body: PROV([resolved ? lol({ last_error_resolution: { id: 5, upto: ERR_AT, resolved_by: "op" }, last_error_resolved: true }) : lol(), fi]) }),
      "POST /api/v1/ops/resolutions": async () => {
        await new Promise<void>((r) => { release = r; });
        resolved = true;
        return { status: 201, body: { id: 5, kind: "provider_error", key: "adsb_lol", upto: ERR_AT, resolved_at: NOW, resolved_by: "op", note: null } };
      },
    });
    await mount();
    await click(button("해결 처리", cell()));
    await click(button("해결 처리 확인", byTestId("resolve-confirm")!));
    await click(byTestId("ops-tab-runs"));
    const before = calls.length;
    await React.act(async () => { release!(); });
    await settle(); await settle();
    expect(calls.slice(before).filter((c) => c.method === "GET").map((c) => c.url)).toEqual(expect.arrayContaining(["/api/v1/ops/providers", RUNS_HIDE, "/api/v1/ops/audit"]));
    await click(byTestId("ops-tab-providers"));
    expect(byTestId("resolve-confirm")).toBeNull();
    expect(byTestId("provider-error-resolved")).not.toBeNull();
    expect(statusText()).toContain("해결 처리됨: 공급자 adsb_lol(해결 #5)");
  });
});

describe("/ops LAST ERROR actions for screen-reader users", () => {
  it("the actions name the provider and say whether their confirmation is open", async () => {
    stub({ "GET /api/v1/ops/providers": { status: 200, body: PROV([lol(), { ...fi, name: "adsb_fi", last_error: "timeout", last_error_at: ERR_AT, last_error_resolution: { id: 7, upto: ERR_AT, resolved_by: "kim" }, last_error_resolved: true }]) } });
    await mount();
    const [c1, c2] = (() => { const out: MiniElement[] = []; const walk = (n: MiniElement) => { if (n.getAttribute?.("data-testid") === "provider-last-error") out.push(n); for (const c of n.childNodes) if (c instanceof MiniElement) walk(c); }; walk(dom.container); return out; })();
    const act = button("해결 처리", c1)!;
    expect(act.getAttribute("aria-label")).toBe("해결 처리: 공급자 adsb_lol 오류");
    expect(act.getAttribute("aria-expanded")).toBe("false");
    expect(button("되돌리기", c2)!.getAttribute("aria-label")).toBe("되돌리기: 공급자 adsb_fi 해결 #7");
    await click(act);
    expect(button("해결 처리", cell())!.getAttribute("aria-expanded")).toBe("true");
    expect(button("해결 처리", cell())!.getAttribute("aria-controls")).toBe(byTestId("resolve-confirm")!.getAttribute("id"));
  });
});
