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
    expect(byTestId("ops-last-ok")?.textContent).toBe("갱신 01:00:00Z");

    // 15 s 뒤 새로고침: providers 만 500, 나머지는 성공
    failing.add("/api/v1/ops/providers");
    await React.act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    // 수정 전: 다른 엔드포인트의 성공으로 "갱신 01:00:15Z" — providers 탭은 옛 값인데 새 시각 아래
    expect(byTestId("ops-last-ok")?.textContent).toBe("갱신 01:00:00Z");
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-providers")!)).not.toBeNull();
    expect(byTestId("ops-tab-stale", byTestId("ops-tab-runs")!)).toBeNull();
    // 오류 문구가 어느 탭(엔드포인트)인지 말한다
    expect(alertText()).toContain("providers");
    expect(alertText()).toContain("provider status unavailable");

    // 다시 성공하면 표시가 사라지고 시각이 새로워진다
    failing.clear();
    await React.act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    expect(byTestId("ops-last-ok")?.textContent).toBe("갱신 01:00:30Z");
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
    expect(warn?.textContent).toContain("DB 원본 반영(v2 · 09-28 01:00:05Z)");
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
    expect(byTestId("switch-ok")?.textContent).toContain("adsbdb 켬 — DB 원본 반영(v5 · 09-28 01:00:05Z) · Redis 미러 반영");
    expect(byTestId("switch-unmirrored")).toBeNull();
    expect(byTestId("switch-mirror-differs")).toBeNull();
    expect(byTestId("provider-switch")!.getAttribute("title")).toContain("op");
  });
});
