/**
 * QA-304 — 패널 내용이 바뀌어 누른 단추가 사라지거나 숨겨지거나 비활성이 되면 초점이 <body> 로 떨어졌다(WCAG 2.4.3): 목록에서 카드 열기 · 카드 '닫기' ·
 * 알림 근거의 '항공기 카드' · '선박 켜기' · 설정 save · 로그인 · 로그아웃 등. 이제 그때만(lib/focus-rescue — 초점을 잃었을 때만) 새 내용이나 연 자리로 옮긴다.
 * 초점을 잃지 않았으면(검색 입력 · 지도에서 고름) 건드리지 않고, 처음 그릴 때도 옮기지 않는다(첫 Tab = 건너뛰기 링크).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom, type MiniElement } from "./helpers/mini-dom";
import { mounter, propsOf } from "./helpers/mount";
import { focusLost, isShown, rescueFocus } from "@/lib/focus-rescue";
import { useUi } from "@/lib/ui-store";

// 패널 조각 · 알림 패널은 단추 하나씩으로 대신한다(조각을 받는 일 · 실시간 자료와 상관없이 초점 규칙만 본다)
vi.mock("@/components/DashboardParts", async () => {
  const { createElement: h } = await import("react");
  const { useUi: ui } = await import("@/lib/ui-store");
  return {
    SigmetListPart: () => h("ul", null, ["S1", "S2"].map((id) => h("li", { key: id }, h("button", { "data-testid": "sigmet-list-item", "data-id": id, onClick: () => ui.getState().selectSigmet(id) }, id)))),
    SigmetCardPart: ({ id }: { id: string }) => h("div", { "data-testid": "sigmet-card" }, h("button", { onClick: () => ui.getState().selectSigmet(null) }, `닫기 ${id}`)),
    AircraftCardPart: ({ hex }: { hex: string }) => h("div", { "data-testid": "aircraft-card" }, h("button", { onClick: () => ui.getState().select(null) }, `닫기 ${hex}`)),
    AirportCardPart: () => null, AirportListPart: () => null,
    ShipPanelPart: () => (ui((s) => s.layers.ships) ? h("div", { "data-testid": "ship-list" }) : h("button", { onClick: () => ui.getState().toggleLayer("ships") }, "선박 켜기")),
  };
});
vi.mock("@/components/AlertPanel", async () => {
  const { createElement: h } = await import("react");
  const { useUi: ui } = await import("@/lib/ui-store");
  return { AlertPanel: () => h("button", { "data-testid": "alert-open-aircraft", onClick: () => ui.getState().select("abc123") }, "항공기 카드") };
});

const dom = installMiniDom();
(dom.document as unknown as { cookie: string }).cookie = "WAKELINE_CSRF=t";
const m = mounter(dom);
const doc = dom.document as unknown as Document;
const initialUi = useUi.getState();
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); useUi.setState(initialUi, true); vi.useRealTimers(); vi.unstubAllGlobals(); dom.document.activeElement = null; });

const active = () => dom.document.activeElement as MiniElement | null;
const testid = (e: MiniElement | null) => e?.getAttribute("data-testid") ?? e?.textContent ?? null;
const press = async (el: MiniElement | null) => { el!.focus(); await m.act(() => propsOf(el!).onClick?.({ preventDefault() {}, currentTarget: el })); await m.settle(); };

describe("lib/focus-rescue: moves focus only when it was lost", () => {
  it("lost = none · body · detached · inside a hidden ancestor · disabled; rescue picks the first shown candidate", () => {
    const body = dom.document.body;
    const wrap = dom.document.createElement("div");
    const a = dom.document.createElement("button");
    const b = dom.document.createElement("button");
    wrap.appendChild(a); wrap.appendChild(b); body.appendChild(wrap);
    dom.document.activeElement = null;
    expect(focusLost(doc)).toBe(true);
    a.focus();
    expect(focusLost(doc)).toBe(false);
    wrap.setAttribute("hidden", "");
    expect(isShown(a as unknown as Element)).toBe(false);
    expect(focusLost(doc)).toBe(true); // 숨긴 패널 안
    wrap.removeAttribute("hidden");
    a.setAttribute("disabled", "");
    expect(focusLost(doc)).toBe(true); // 비활성이 된 단추
    expect(rescueFocus(null, a as unknown as Element, b as unknown as Element)).toBe(b);
    expect(active()).toBe(b);
    expect(rescueFocus(a as unknown as Element)).toBeNull(); // 잃지 않았으면 옮기지 않는다
    wrap.removeChild(b);
    expect(focusLost(doc)).toBe(true); // 떼어 낸 요소
    body.removeChild(wrap);
  });
});

describe("dashboard side panel: focus follows the content it swaps", () => {
  const mount = async () => {
    const { SidePanel } = await import("@/components/SidePanel");
    await m.render(m.React.createElement(SidePanel));
    await m.settle();
  };
  const content = () => m.byTestId("side-panel-content");

  it("first render moves nothing; SIGMET list Enter → the panel content; '닫기' → the same list item", async () => {
    await m.act(() => { useUi.getState().setPanel("sigmet"); });
    await mount();
    expect(active()).toBeNull();
    const item = m.allByTestId("sigmet-list-item")[1];
    await press(item);
    expect(m.byTestId("sigmet-card")).not.toBeNull();
    expect(active()).toBe(content());
    expect(content()!.getAttribute("aria-label")).toBe("SIGMET 상세");
    await press(m.button("닫기 S2"));
    const back = m.allByTestId("sigmet-list-item")[1];
    expect(back.getAttribute("data-id")).toBe("S2");
    expect(active()).toBe(back);
  });

  it("alert '항공기 카드' (the alert list is hidden, not removed) → the card; '닫기' → back to that alert button", async () => {
    await mount();
    const open = m.byTestId("alert-open-aircraft")!;
    await press(open);
    expect(m.byTestId("aircraft-card")).not.toBeNull();
    expect(active()).toBe(content());
    await press(m.button("닫기 abc123"));
    expect(active()).toBe(open);
  });

  it("chosen from outside the panel (search input keeps focus): nothing moves on open; '닫기' returns to the search input", async () => {
    await mount();
    const search = dom.document.createElement("input");
    dom.document.body.appendChild(search);
    search.focus();
    await m.act(() => { useUi.getState().select("abc123"); });
    await m.settle();
    expect(active()).toBe(search);
    await press(m.button("닫기 abc123"));
    expect(active()).toBe(search);
    dom.document.body.removeChild(search);
  });

  it("'선박 켜기' (the button is replaced by the list) → the panel content", async () => {
    await m.act(() => { useUi.getState().setPanel("ship"); });
    await mount();
    await press(m.button("선박 켜기"));
    expect(m.byTestId("ship-list")).not.toBeNull();
    expect(testid(active())).toBe("side-panel-content");
  });
});

describe("/ops: sign-in, settings save and sign-out keep the focus on the screen", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const BODY: Record<string, unknown> = {
    "/api/v1/ops/providers": { providers: [], active: {}, collector: {}, switches: [], budget_days: [] },
    "/api/v1/ops/runs?limit=50&resolved=hide": { items: [], summary_24h: [] },
    "/api/v1/ops/quality": { rule_counts: [], recent: [] },
    "/api/v1/ops/settings": { items: [{ key: "region_poll_s", value: 10, version: 3, updated_by: "op", updated_at: "2026-09-28T15:00:00Z" }] },
    "/api/v1/ops/audit": { items: [] },
    "/api/v1/ops/dlq": { items: [] },
    "/api/v1/ops/pipeline": { collector: {}, api: {} },
  };
  it("sign in → the current tab button; save → that setting's input; sign out → the username field", async () => {
    let signedIn = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/v1/ops/session") {
        if (method === "POST") { signedIn = true; return json(200, { username: "op" }); }
        if (method === "DELETE") { signedIn = false; return new Response(null, { status: 204 }); }
        return signedIn ? json(200, { username: "op" }) : json(404, { detail: "not found" });
      }
      if (method === "PUT") return json(200, {});
      return url in BODY ? json(200, BODY[url]) : json(404, { detail: "no such resource" });
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal("self", globalThis);
    await m.render(m.React.createElement((await import("@/app/ops/page")).default));
    await m.settle();
    expect(active()).toBeNull(); // 처음 확인 뒤에는 옮기지 않는다
    const field = (id: string) => m.find((e) => e.getAttribute("id") === id)!;
    await m.act(() => propsOf(field("ops-user")).onChange({ target: { value: "op" } }));
    await m.act(() => propsOf(field("ops-pass")).onChange({ target: { value: "correct horse" } }));
    const submit = m.find((e) => e.tagName === "BUTTON" && e.getAttribute("type") === "submit")!;
    submit.focus();
    await m.act(() => propsOf(m.byTestId("ops-login")!).onSubmit({ preventDefault() {} }));
    await m.settle();
    await m.settle();
    expect(m.byTestId("ops-dashboard")).not.toBeNull();
    expect(testid(active())).toBe("ops-tab-providers");

    await m.click(m.byTestId("ops-tab-settings"));
    const input = m.find((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "region_poll_s 값")!;
    await m.act(() => propsOf(input).onChange({ target: { value: "15" } }));
    await press(m.button("save"));
    await m.settle();
    expect(m.byTestId("settings-ok")).not.toBeNull();
    expect(m.button("save")!.getAttribute("disabled")).not.toBeNull(); // 저장 뒤 바뀐 값 없음 — 단추는 비활성
    expect(active()).toBe(m.find((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "region_poll_s 값"));

    await press(m.button("sign out"));
    await m.settle();
    expect(m.byTestId("ops-login")).not.toBeNull();
    expect(active()?.getAttribute("id")).toBe("ops-user");
  });
});

describe("/ops lists and /logs detail: a button that goes away hands the focus on", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, s)).toISOString();
  const audit = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from - i, username: "op", action: "LOGIN", target: "op", before: null, after: null, ip: "1", request_id: `r${from - i}`, at: at(from - i) }));
  const run = (id: number) => ({ id, job: "region", provider: "adsb_fi", started_at: at(id), finished_at: at(id), status: "error", http_status: 502, latency_ms: 9, records_in: 0, records_quarantined: 0, raw_ref: null, error_text: "x" });
  const BODY: Record<string, unknown> = {
    "/api/v1/ops/session": { username: "op" },
    "/api/v1/ops/providers": { providers: [], active: {}, collector: {}, switches: [], budget_days: [] },
    "/api/v1/ops/runs?limit=50&resolved=hide": { items: [], summary_24h: [{ job: "region", provider: "adsb_fi", status: "error", n: 3, last_at: at(1), last_error_text: "x", last_http_status: 502 }], summary_since: "2026-09-30T00:00:00Z" },
    "/api/v1/ops/runs?job=region&provider=adsb_fi&status=error&since=2026-09-30T00%3A00%3A00Z&limit=50": { items: [run(9), run(8)], next_cursor: 8 },
    "/api/v1/ops/runs?job=region&provider=adsb_fi&status=error&since=2026-09-30T00%3A00%3A00Z&limit=50&cursor=8": { items: [run(7)], next_cursor: null },
    "/api/v1/ops/quality": { rule_counts: [], recent: [] },
    "/api/v1/ops/settings": { items: [] },
    "/api/v1/ops/audit": { items: audit(60, 50), next_cursor: 11 },
    "/api/v1/ops/audit?cursor=11&limit=50": { items: audit(10, 10), next_cursor: null },
    "/api/v1/ops/dlq": { items: [] },
    "/api/v1/ops/pipeline": { collector: {}, api: {} },
  };
  /** 붙잡아 둔 응답(받는 동안을 보려고) — 경로 → 풀기 */
  const held = new Map<string, () => void>();
  const openOps = async (hold: string[] = []) => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (hold.includes(url)) await new Promise<void>((r) => held.set(url, r));
      return url in BODY ? json(200, BODY[url]) : json(404, { detail: "no such resource" });
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal("self", globalThis);
    await m.render(m.React.createElement((await import("@/app/ops/page")).default));
    await m.settle();
    await m.settle();
  };

  it("audit '더 보기' keeps its focus while loading (aria-disabled, not disabled); at the last page the tab body takes it", async () => {
    await openOps(["/api/v1/ops/audit?cursor=11&limit=50"]);
    await m.click(m.byTestId("ops-tab-audit"));
    const more = m.byTestId("audit-more")!;
    more.focus();
    await m.act(() => { void propsOf(more).onClick(); });
    await m.settle();
    expect(more.getAttribute("disabled")).toBeNull();
    expect(more.getAttribute("aria-disabled")).toBe("true");
    expect(active()).toBe(more);
    await m.act(() => { held.get("/api/v1/ops/audit?cursor=11&limit=50")!(); });
    await m.settle();
    expect(m.byTestId("audit-more")).toBeNull();
    expect(testid(active())).toBe("ops-tab-body");
    expect(active()!.getAttribute("aria-label")).toBe("audit 탭");
  });

  it("runs drill '더 보기' to the end → the drill region; '닫기' → back to the row's '실행' button", async () => {
    await openOps();
    await m.click(m.byTestId("ops-tab-runs"));
    const opener = m.byTestId("runs-drill-open")!;
    await press(opener);
    await m.settle();
    await press(m.byTestId("runs-drill-more"));
    await m.settle();
    expect(m.byTestId("runs-drill-more")).toBeNull();
    expect(testid(active())).toBe("runs-drill");
    await press(m.byTestId("runs-drill-close"));
    expect(m.byTestId("runs-drill")).toBeNull();
    expect(active()).toBe(m.byTestId("runs-drill-open"));
  });

  it("/logs: closing the detail puts the focus on the log grid", async () => {
    const NOW = Date.parse("2026-09-29T02:00:00Z");
    const e = { id: `${NOW}-0`, v: 1, ts: new Date(NOW).toISOString(), service: "api", instance: "api:1", level: "ERROR", logger: "x", thread: "t", message: "boom", exception: null, fp: "0123456789abcdef", request_id: null, context: {}, suppressed: 0 };
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/v1/ops/session") return json(200, { username: "op" });
      if (url.startsWith("/api/v1/ops/logs?")) return json(200, { items: [e], next_cursor: null, scanned: 1, scan_truncated: false });
      return json(404, { detail: "no such resource" });
    });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("location", { hash: "", pathname: "/logs", origin: "http://localhost:8700" });
    await m.render(m.React.createElement((await import("@/app/logs/page")).default));
    await m.settle();
    await m.settle();
    await m.click(m.byTestId("log-row"));
    expect(m.byTestId("log-detail")).not.toBeNull();
    await press(m.button("닫기", m.byTestId("log-detail")!));
    expect(m.byTestId("log-detail")).toBeNull();
    expect(testid(active())).toBe("log-grid");
  });
});
