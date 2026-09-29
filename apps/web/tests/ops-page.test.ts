/**
 * 운영 화면 새로고침(실제 react-dom 으로 마운트 — 최소 DOM + fetch 대역). R-12: 탭마다 마지막 성공 시각·실패를 따로 보인다.
 * 한 엔드포인트만 계속 실패하면(예: /ops/providers 500, /ops/runs 성공) 그 탭이 옛 값을 새 '갱신' 시각 아래 보이지 않는다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";

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

const BODY: Record<string, unknown> = {
  "/api/v1/ops/session": { username: "op" },
  "/api/v1/ops/providers": { providers: [], active: {}, collector: {}, switches: [], budget_days: [] },
  "/api/v1/ops/runs?limit=50": { items: [], summary_24h: [] },
  "/api/v1/ops/quality": { rule_counts: [], recent: [] },
  "/api/v1/ops/settings": { items: [] },
  "/api/v1/ops/audit": { items: [] },
  "/api/v1/ops/dlq": { items: [] },
  "/api/v1/ops/pipeline": { collector: {}, api: {} },
};
/** 경로 → 응답. failing 에 든 경로는 500(인증 문제 아님) */
function stubFetch(failing: Set<string>) {
  vi.stubGlobal("fetch", async (url: string) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (failing.has(url)) return json(500, { detail: "provider status unavailable" });
    return url in BODY ? json(200, BODY[url]) : json(404, { detail: "no such resource" });
  });
}
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const byTestId = (id: string, from: MiniElement = dom.container): MiniElement | null => {
  if (from.getAttribute?.("data-testid") === id) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? byTestId(id, c) : null; if (f) return f; }
  return null;
};
const alertText = (): string => {
  const walk = (n: MiniElement): string | null => {
    if (n.getAttribute?.("role") === "alert") return n.textContent;
    for (const c of n.childNodes) { const f = c instanceof MiniElement ? walk(c) : null; if (f != null) return f; }
    return null;
  };
  return walk(dom.container) ?? "";
};

describe("R-12 ops: last success per tab, the failing endpoint is named", () => {
  it("a tab whose endpoint keeps failing keeps its old time and is marked, while other endpoints succeed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-09-28T01:00:00Z") });
    const failing = new Set<string>();
    stubFetch(failing);
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(OpsPage)); });
    await settle(); // 세션 확인 → 대시보드 → 첫 새로고침(setTimeout 0)
    await settle();
    expect(byTestId("ops-dashboard")).not.toBeNull();
    expect(byTestId("ops-last-ok")?.textContent).toBe("갱신 10:00:00 KST"); // 01:00:00Z = 한국 표준시 10:00:00

    // 15 s 뒤 새로고침: providers 만 500, 나머지는 성공
    failing.add("/api/v1/ops/providers");
    await React.act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    // 수정 전: 다른 엔드포인트의 성공으로 "갱신 10:00:15 KST" — providers 탭은 옛 값인데 새 시각 아래
    expect(byTestId("ops-last-ok")?.textContent).toBe("갱신 10:00:00 KST");
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-providers")!)?.getAttribute("title")).toBe("마지막 요청 실패 — 표시 값은 10:00:00 KST 기준");
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-providers")!)).not.toBeNull();
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-runs")!)).toBeNull();
    // 오류 문구가 어느 탭(엔드포인트)인지 말한다
    expect(alertText()).toContain("providers");
    expect(alertText()).toContain("provider status unavailable");

    // 다시 성공하면 표시가 사라지고 시각이 새로워진다
    failing.clear();
    await React.act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    expect(byTestId("ops-last-ok")?.textContent).toBe("갱신 10:00:30 KST");
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-providers")!)).toBeNull();
    expect(alertText()).toBe("");
  });

  it("a tab that has never loaded shows no time ('—'), not another endpoint's", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-09-28T02:00:00Z") });
    stubFetch(new Set(["/api/v1/ops/providers"]));
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(OpsPage)); });
    await settle();
    await settle();
    expect(byTestId("ops-last-ok")?.textContent).toBe("갱신 —");
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-providers")!)).not.toBeNull();
  });
});

/**
 * R-94(계약 v5 §D1 · ADR-019): 공급자 스위치의 원본은 DB 이고 수집기는 Redis 미러를 따른다. 토글이 DB 에는 커밋됐지만 Redis 미러에 실패하면
 * (mirrored=false — 예: Redis 장애) 운영자에게 알린다: 수집기는 아직 이전 값을 따른다. 표는 원본(DB)과 미러(Redis)를 나란히 보인다.
 */
describe("R-94 ops: provider switch source (DB) vs mirror (Redis)", () => {
  // 변경 요청은 CSRF 쿠키 값을 헤더로 되돌려 보낸다(lib/api csrfToken) — 미니 DOM 에는 쿠키가 없어서 둔다
  beforeAll(() => { (dom.document as unknown as { cookie: string }).cookie = "WAKELINE_CSRF=t"; });
  type Reply = { status: number; body: unknown };
  /** "METHOD path" → 응답(함수면 부를 때마다 다시 계산). 없는 GET 은 BODY 로 */
  function stubRoutes(routes: Record<string, Reply | (() => Reply)>) {
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      const r = routes[`${init?.method ?? "GET"} ${url}`];
      if (r) { const v = typeof r === "function" ? r() : r; return json(v.status, v.body); }
      return url in BODY ? json(200, BODY[url]) : json(404, { detail: "no such resource" });
    });
  }
  const find = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => {
    if (pred(from)) return from;
    for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
    return null;
  };
  /** React 가 요소에 붙인 props 의 onClick 을 부른다(미니 DOM 에는 이벤트 전파가 없다) */
  const click = async (e: MiniElement) => {
    const key = Object.keys(e).find((k) => k.startsWith("__reactProps$"));
    const props = key ? (e as unknown as Record<string, { onClick?: () => unknown }>)[key] : undefined;
    expect(props?.onClick).toBeTypeOf("function");
    await React.act(async () => { await props!.onClick!(); });
    await settle();
  };
  const providers = (sw: Record<string, unknown>) => ({
    status: 200,
    body: { ...(BODY["/api/v1/ops/providers"] as object), providers: [{ name: "adsbdb", disabled: sw.redis_disabled ?? undefined }], provider_switch: [sw] },
  });
  const mount = async () => {
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(OpsPage)); });
    await settle();
    await settle();
  };

  it("a toggle committed in the database but not mirrored to Redis warns that the collector still follows the old value", async () => {
    let sw: Record<string, unknown> = { provider: "adsbdb", disabled: false, version: 1, updated_at: "2026-09-28T00:59:00Z", updated_by: "op", redis_disabled: "0", mirror_differs: false };
    stubRoutes({
      "GET /api/v1/ops/providers": () => providers(sw),
      "POST /api/v1/ops/providers/adsbdb/disable": () => {
        // Redis 장애: 원본(DB)은 바뀌었고 미러는 그대로(Redis 를 읽지 못해 미러 상태는 모름 → mirror_differs 없음)
        sw = { provider: "adsbdb", disabled: true, version: 2, updated_at: "2026-09-28T01:00:05Z", updated_by: "op", redis_error: "redis unavailable" };
        return { status: 200, body: { provider: "adsbdb", disabled: true, version: 2, updated_at: "2026-09-28T01:00:05Z", mirrored: false } };
      },
    });
    await mount();
    const cell = byTestId("provider-switch")!;
    expect(cell.textContent).toContain("on v1");
    expect(cell.textContent).toContain("미러 같음");

    await click(find((e) => e.tagName === "BUTTON" && e.textContent === "disable")!);
    const warn = byTestId("switch-unmirrored");
    expect(warn?.getAttribute("role")).toBe("alert");
    expect(warn?.textContent).toContain("adsbdb 끔");
    expect(warn?.textContent).toContain("DB 원본 반영(v2 · 09-28 10:00:05 KST)");
    expect(warn?.textContent).toContain("Redis 미러 실패");
    expect(warn?.textContent).toContain("수집기는 아직 이전 값을 따른다");
    expect(byTestId("switch-ok")).toBeNull();
    // 새로고침 뒤 표: 원본은 꺼짐(v2), 미러는 모름 — 버튼은 원본을 기준으로 'enable'
    expect(byTestId("provider-switch")!.textContent).toContain("off v2");
    expect(byTestId("provider-switch")!.textContent).toContain("미러 ?");
    expect(find((e) => e.tagName === "BUTTON" && e.textContent === "enable")).not.toBeNull();

    // Redis 가 돌아왔지만 아직 미러 전: 수집기가 따르는 값(Redis "0" = 켜짐)이 원본(꺼짐)과 다르다고 알린다
    sw = { ...sw, redis_error: undefined, redis_disabled: "0", mirror_differs: true };
    await click(find((e) => e.tagName === "BUTTON" && e.textContent === "refresh")!);
    const differs = byTestId("switch-mirror-differs");
    expect(differs?.getAttribute("role")).toBe("alert");
    expect(differs?.textContent).toContain("adsbdb(원본 꺼짐 · 수집기 켜짐)");
    expect(byTestId("provider-switch")!.textContent).toContain("미러 다름");
    expect(byTestId("switch-unmirrored")).not.toBeNull();

    // 주기 미러가 맞췄다: 경고는 '지금' 사실이 아니므로 내린다 — 미러됐다고 상태 줄로 바꾼다
    sw = { ...sw, redis_disabled: "1", mirror_differs: false };
    await click(find((e) => e.tagName === "BUTTON" && e.textContent === "refresh")!);
    expect(byTestId("switch-unmirrored")).toBeNull();
    expect(byTestId("switch-mirror-differs")).toBeNull();
    expect(byTestId("switch-ok")?.textContent).toContain("adsbdb v2 — 이제 Redis 미러 반영(api 주기 미러) · 수집기가 원본(꺼짐)을 따른다");
    expect(byTestId("provider-switch")!.textContent).toContain("미러 같음");
  });

  it("a mirrored toggle is a status line, not an alert", async () => {
    let sw: Record<string, unknown> = { provider: "adsbdb", disabled: true, version: 4, updated_at: "2026-09-28T00:59:00Z", redis_disabled: "1", mirror_differs: false };
    stubRoutes({
      "GET /api/v1/ops/providers": () => providers(sw),
      "POST /api/v1/ops/providers/adsbdb/enable": () => {
        sw = { provider: "adsbdb", disabled: false, version: 5, updated_at: "2026-09-28T01:00:05Z", updated_by: "op", redis_disabled: "0", mirror_differs: false };
        return { status: 200, body: { provider: "adsbdb", disabled: false, version: 5, updated_at: "2026-09-28T01:00:05Z", mirrored: true } };
      },
    });
    await mount();
    // 이관된 행(운영자 없음)은 '시스템(이관)'으로 적는다
    expect(byTestId("provider-switch")!.getAttribute("title")).toContain("시스템(이관)");
    await click(find((e) => e.tagName === "BUTTON" && e.textContent === "enable")!);
    expect(byTestId("switch-ok")?.textContent).toContain("adsbdb 켬 — DB 원본 반영(v5 · 09-28 10:00:05 KST) · Redis 미러 반영");
    expect(byTestId("switch-unmirrored")).toBeNull();
    expect(byTestId("switch-mirror-differs")).toBeNull();
    expect(byTestId("provider-switch")!.getAttribute("title")).toContain("op");
    expect(byTestId("provider-switch")!.getAttribute("title")).toContain("v5 · 09-28 10:00:05 KST · op");
  });
});

/**
 * 운영 화면의 시각은 한국 표준시(사용자 요청 2026-09-29): 모든 탭의 표 칸은 "MM-DD HH:MM:SS" + 머리글 "(KST)", 머리글이 없는 자리는 " KST",
 * title 에 원본 UTC. 일 단위 집계(예산 · 격리 수)의 day 는 수집기가 UTC 날짜로 세므로 "day (UTC)" 그대로 — 날짜를 KST 로 옮기지 않는다.
 * 지연을 모르면 "—" 만(단위가 붙은 "— ms" 가 아니다). 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
describe("ops: every tab shows Korean time; unknown latency is — (not '— ms')", () => {
  /** 사용자가 붙여 넣은 로그와 같은 무렵 — UTC 23 시대라 KST 로는 다음 날 */
  const NOW = "2026-09-28T23:41:14Z";
  const DATA: Record<string, unknown> = {
    "/api/v1/ops/session": { username: "op" },
    "/api/v1/ops/providers": {
      providers: [
        // 첫 공급자: 지연 필드 없음(모름) · 마지막 오류가 있음
        { name: "adsb_lol", last_success_at: "2026-09-28T23:40:21.631Z", last_records: "12", consecutive_failures: "1", last_error: "rate limited (429)", last_error_at: "2026-09-28T23:40:21.631Z" },
        { name: "adsb_fi", last_success_at: "2026-09-28T23:41:00Z", last_latency_ms: "420", last_records: "80", consecutive_failures: "0" },
      ],
      active: { region: "adsb_fi" }, collector: { region_at: "2026-09-28T23:41:00Z", fixture: "0" },
      switches: [{ at: "2026-09-28T23:25:26.025Z", job: "region", from: "adsb_lol", to: "adsb_fi", reason: "429" }],
      budget_days: [{ day: "2026-09-28", provider: "adsb_fi", calls: 10, limit_value: 0 }],
    },
    "/api/v1/ops/runs?limit=50": {
      items: [
        { id: 7, job: "region", provider: "adsb_lol", started_at: "2026-09-28T23:40:21Z", status: "error", http_status: 429, latency_ms: null, records_in: 0, records_quarantined: 0, raw_ref: null, error_text: "429" },
        { id: 6, job: "region", provider: "adsb_fi", started_at: "2026-09-28T23:39:00Z", status: "ok", http_status: 200, latency_ms: 250, records_in: 80, records_quarantined: 0, raw_ref: "r/6", error_text: null },
      ],
      summary_24h: [
        { job: "region", provider: "adsb_lol", status: "error", n: 3, avg_latency_ms: null, last_at: "2026-09-28T23:40:21Z" },
        { job: "region", provider: "adsb_fi", status: "ok", n: 40, avg_latency_ms: 250, last_at: "2026-09-28T23:41:00Z" },
      ],
    },
    "/api/v1/ops/quality": { rule_counts: [{ day: "2026-09-28", rule: "seen_in_future", count: 2 }], recent: [{ id: 1, run_id: 6, rule: "seen_in_future", hex: "abc123", detail: "{}", created_at: "2026-09-28T23:30:00Z" }] },
    "/api/v1/ops/settings": { items: [{ key: "region_poll_s", value: 10, version: 3, updated_by: "op", updated_at: "2026-09-28T15:00:00Z" }] },
    "/api/v1/ops/audit": { items: [{ id: 1, username: "op", action: "SETTING_UPDATE", target: "region_poll_s", before: "5", after: "10", ip: "127.0.0.1", request_id: "abcd1234abcd1234", at: "2026-09-28T15:00:00Z" }] },
    "/api/v1/ops/dlq": { items: [{ stream_id: "1-0", at: "2026-09-28T14:59:59Z", source_stream: "wakeline:aircraft", kind: "schema", reason: "bad", payload_head: "{" }] },
    "/api/v1/ops/pipeline": { collector: {}, api: { last_stream_trim_loss: { stream: "wakeline:aircraft", from: "2026-09-28T23:00:00Z", to: "2026-09-28T23:02:00Z" } }, generated_at: "2026-09-28T23:41:14Z" },
  };
  const all = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container, out: MiniElement[] = []): MiniElement[] => {
    if (pred(from)) out.push(from);
    for (const c of from.childNodes) if (c instanceof MiniElement) all(pred, c, out);
    return out;
  };
  const heads = () => all((e) => e.tagName === "TH").map((h) => h.textContent);
  /** 첫 칸이 key 인 표 행의 칸들 */
  const row = (key: string) => {
    const tr = all((e) => e.tagName === "TR").find((r) => all((e) => e.tagName === "TD", r)[0]?.textContent.startsWith(key));
    expect(tr, `row ${key}`).toBeDefined();
    return all((e) => e.tagName === "TD", tr!);
  };
  const tab = async (t: string) => {
    const b = byTestId(`ops-tab-${t}`)!;
    const k = Object.keys(b).find((x) => x.startsWith("__reactProps$"))!;
    await React.act(async () => { (b as unknown as Record<string, { onClick: () => void }>)[k].onClick(); });
    await settle();
  };
  /** 운영 화면 어디에도 UTC "…Z" 시각이나 "— ms" 가 남지 않는다 */
  const noUtcNoDashUnit = () => {
    const text = byTestId("ops-dashboard")!.textContent;
    expect(text).not.toMatch(/\d\d:\d\d:\d\dZ/);
    expect(text).not.toContain("— ms");
  };
  it("providers · runs · quality · settings · audit · dlq · pipeline", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse(NOW) });
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(url in DATA ? DATA[url] : { detail: "no such resource" }), { status: url in DATA ? 200 : 404, headers: { "Content-Type": "application/json" } }));
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(OpsPage)); });
    await settle();
    await settle();
    expect(byTestId("ops-last-ok")!.textContent).toBe("갱신 08:41:14 KST");
    expect(byTestId("ops-last-ok")!.getAttribute("title")).toContain("원본 UTC 2026-09-28T23:41:14.000Z");

    // providers(기본 탭)
    expect(heads()).toEqual(expect.arrayContaining(["last success (KST)", "at (KST)", "day (UTC)"]));
    const lol = row("adsb_lol");
    expect(lol[1].textContent).toBe("09-29 08:40:21");
    expect(all((e) => e.getAttribute?.("title") === "원본 UTC 2026-09-28T23:40:21.631Z", lol[1]).length).toBeGreaterThan(0);
    expect(lol[2].textContent).toBe("—"); // 지연 모름 — "— ms" 가 아니다
    expect(lol[7].textContent).toBe("rate limited (429) 09-29 08:40:21 KST");
    expect(row("adsb_fi")[2].textContent).toBe("420 ms");
    expect(byTestId("ops-dashboard")!.textContent).toContain("region 09-29 08:41:00 KST"); // 위쪽 작업별 칩(머리글 없음)
    expect(row("09-29 08:25:26")[1].textContent).toBe("region"); // Provider switches — at (KST)
    expect(row("2026-09-28")[1].textContent).toBe("adsb_fi"); // Daily budget — UTC 날짜 그대로
    noUtcNoDashUnit();

    await tab("runs");
    expect(heads()).toEqual(expect.arrayContaining(["last (KST)", "started (KST)", "avg latency", "ms"]));
    const sum = all((e) => e.tagName === "TR").map((r) => all((e) => e.tagName === "TD", r).map((c) => c.textContent)).filter((c) => c.length === 6);
    expect(sum).toEqual([
      ["region", "adsb_lol", "error", "3", "—", "09-29 08:40:21"],
      ["region", "adsb_fi", "ok", "40", "250 ms", "09-29 08:41:00"],
    ]);
    expect(row("7")[3].textContent).toBe("09-29 08:40:21");
    expect(row("7")[6].textContent).toBe("—"); // 머리글이 ms — 모르면 빈칸이 아니라 —
    expect(row("6")[6].textContent).toBe("250");
    noUtcNoDashUnit();

    await tab("quality");
    expect(heads()).toEqual(["day (UTC)", "rule", "count", "at (KST)", "run", "rule", "hex", "detail"]);
    expect(row("09-29 08:30:00")[2].textContent).toBe("seen_in_future");
    noUtcNoDashUnit();

    await tab("settings");
    expect(heads()).toContain("updated (KST)");
    expect(row("region_poll_s")[3].textContent).toBe("op 09-29 00:00:00"); // 15:00Z = KST 자정
    noUtcNoDashUnit();

    await tab("audit");
    expect(heads()[0]).toBe("at (KST)");
    expect(row("09-29 00:00:00")[2].textContent).toBe("SETTING_UPDATE");
    noUtcNoDashUnit();

    await tab("dlq");
    expect(heads()[0]).toBe("at (KST)");
    expect(row("09-28 23:59:59")[1].textContent).toBe("wakeline:aircraft"); // 14:59:59Z = KST 자정 1초 전
    noUtcNoDashUnit();

    await tab("pipeline");
    const pipe = byTestId("ops-pipeline")!.textContent;
    expect(pipe).toContain("생성 09-29 08:41:14 KST");
    expect(byTestId("ops-pipeline-trim")!.textContent).toContain("wakeline:aircraft · 09-29 08:00:00 KST – 09-29 08:02:00 KST");
    noUtcNoDashUnit();
  });
});

describe("fmtLatencyMs: a latency cell never shows the unit without a value", () => {
  it("a number or numeric string → \"N ms\"; unknown or malformed → \"—\"", async () => {
    const { fmtLatencyMs } = await import("@/lib/format");
    expect(fmtLatencyMs(250)).toBe("250 ms");
    expect(fmtLatencyMs("420")).toBe("420 ms"); // Redis 해시 값은 문자열
    expect(fmtLatencyMs(0)).toBe("0 ms");
    expect(fmtLatencyMs(1234)).toBe("1,234 ms");
    for (const v of [null, undefined, "", " ", "abc", -1, Number.NaN, Number.POSITIVE_INFINITY, {}]) expect(fmtLatencyMs(v)).toBe("—");
  });
});
