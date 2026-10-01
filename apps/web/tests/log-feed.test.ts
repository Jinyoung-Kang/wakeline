/**
 * /logs 목록 · 묶음의 불러오기 규칙(characterization — LogsDashboard 의 쪽 · 묶음 · 대기열 · 더 보기 · 자동 확인 논리를 useLogFeed 로 옮기기 전에
 * 지금 동작을 고정한다, web-review §3.2). 이미 다른 시험이 고정한 것(새 항목 N건 · 더 보기 한 번 · 15 s 주기 · 숨긴 탭)은 여기서 다시 보지 않는다.
 * - 묶음 보기의 자동 확인은 바뀌었을 때만 '묶음에 새 항목 — 반영' 을 보이고, 누르면 그 묶음으로 바꾼다
 * - 새 항목이 한 쪽을 넘으면 '… 이상 — 다시 불러오기' 는 처음부터 다시 받는다 · 보이는 줄이 없으면 자동 확인이 바로 보인다
 * - 앞 필터의 늦은 답(목록 · 자동 확인 · 더 보기)은 버린다 · 실패는 다음 성공이 지운다 · 고른 줄은 다시 받은 목록에 있을 때만 남는다
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const NOW = Date.parse("2026-09-29T02:00:00Z");
const T = (min: number) => `${NOW - min * 60_000}-0`;
const entry = (id: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, v: 1, ts: new Date(Number(id.split("-")[0])).toISOString(), service: "api", instance: "api-1", level: "ERROR", logger: "x.Y", thread: "t",
  message: `failure ${id}`, exception: null, fp: "0123456789abcdef", request_id: null, context: {}, suppressed: 0, ...o,
});
const page = (ids: string[], o: Record<string, unknown> = {}) => ({ items: ids.map((id) => entry(id)), next_cursor: null, scanned: ids.length, scan_truncated: false, ...o });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const group = (count: number) => ({ fp: "0123456789abcdef", service: "api", level: "ERROR", logger: "x.Y", exception_type: null, sample_message: "failure", count, suppressed: 0, first_at: "2026-09-29T01:00:00Z", last_at: "2026-09-29T01:59:00Z", last_id: T(1) });

/** 목록 · 묶음 요청의 답을 정한다: 함수가 Response 대신 null 을 돌려주면 그 요청을 붙잡는다(held 로 나중에 답한다) */
type Route = (url: string) => Response | null;
function stub(route: Route) {
  const asked: string[] = [];
  const held: { url: string; answer: (r: Response) => void }[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    if (url === "/api/v1/ops/session") return json(200, { username: "op" });
    const r = route(url);
    return r ?? new Promise<Response>((res) => held.push({ url, answer: res }));
  });
  return { asked, held, lists: () => asked.filter((u) => u.startsWith("/api/v1/ops/logs?")) };
}
async function open() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("location", { hash: "", pathname: "/logs", origin: "http://localhost:8700" });
  await m.render(m.React.createElement((await import("@/app/logs/page")).default));
  await m.settle();
  await m.settle();
}
const tick = async () => { await m.act(() => { vi.advanceTimersByTime(15_000); }); await m.settle(); };
const rows = () => m.allByTestId("log-row").map((r) => r.getAttribute("data-id"));
const isList = (u: string) => u.startsWith("/api/v1/ops/logs?");
const isGroups = (u: string) => u.startsWith("/api/v1/ops/logs/groups?");

describe("/logs groups view: the auto-check offers changed groups and applies them on request", () => {
  it("no offer while the groups are the same; a changed count is offered without changing the table; the button applies it", async () => {
    let groups = { groups: [group(17)], scanned: 10, scan_truncated: false };
    stub((u) => (isGroups(u) ? json(200, groups) : isList(u) ? json(200, page([T(1)])) : json(404, {})));
    await open();
    await m.click(m.button("묶음(fp)"));
    expect(m.allByTestId("log-group")[0].textContent).toContain("17");
    await tick();
    expect(m.byTestId("logs-new")).toBeNull();
    groups = { ...groups, groups: [group(18)] };
    await tick();
    expect(m.byTestId("logs-new")!.textContent).toBe("묶음에 새 항목 — 반영");
    expect(m.allByTestId("log-group")[0].textContent).toContain("17"); // 표는 그대로
    await m.click(m.byTestId("logs-new"));
    expect(m.allByTestId("log-group")[0].textContent).toContain("18");
    expect(m.byTestId("logs-new")).toBeNull();
  });
});

describe("/logs list: what the auto-check does with new entries", () => {
  it("more new entries than one page: the button says so and reloads the list from the top", async () => {
    const fresh = Array.from({ length: 100 }, (_, i) => `${NOW + (100 - i) * 1000}-0`);
    let body: unknown = page([T(1), T(2)]);
    const s = stub((u) => (isList(u) ? json(200, body) : json(404, {})));
    await open();
    body = page(fresh);
    await tick();
    expect(m.byTestId("logs-new")!.textContent).toBe("새 항목 100건 이상 — 다시 불러오기");
    expect(rows()).toEqual([T(1), T(2)]);
    const before = s.lists().length;
    await m.click(m.byTestId("logs-new"));
    expect(s.lists().length).toBe(before + 1);
    expect(rows()).toEqual(fresh);
    expect(m.byTestId("logs-new")).toBeNull();
  });

  it("with no row on screen the auto-check's entries are shown at once (no button)", async () => {
    let body: unknown = page([]);
    stub((u) => (isList(u) ? json(200, body) : json(404, {})));
    await open();
    expect(m.byTestId("logs-empty")).not.toBeNull();
    body = page([T(1), T(2)]);
    await tick();
    expect(rows()).toEqual([T(1), T(2)]);
    expect(m.byTestId("logs-new")).toBeNull();
  });
});

describe("/logs list: answers for conditions no longer on screen are dropped", () => {
  it("the previous filter's list answer that lands after the new filter's is not shown", async () => {
    const s = stub((u) => (!isList(u) ? json(404, {}) : u.includes("level=WARN") ? null : u.includes("level=ERROR") ? json(200, page([T(5)])) : json(200, page([T(1)]))));
    await open();
    await m.click(m.button("WARN"));
    await m.click(m.button("ERROR"));
    expect(rows()).toEqual([T(5)]);
    s.held[0].answer(json(200, page([T(3)])));
    await m.settle();
    expect(rows()).toEqual([T(5)]);
  });

  it("an auto-check that lands after a filter change offers nothing", async () => {
    let hold = false;
    const s = stub((u) => (!isList(u) ? json(404, {}) : u.includes("level=ERROR") ? json(200, page([T(5)])) : hold ? null : json(200, page([T(1)]))));
    await open();
    hold = true;
    await tick();
    expect(s.held).toHaveLength(1);
    await m.click(m.button("ERROR"));
    s.held[0].answer(json(200, page([`${NOW + 1000}-0`, T(1)])));
    await m.settle();
    expect(rows()).toEqual([T(5)]);
    expect(m.byTestId("logs-new")).toBeNull();
  });

  it("an older page that lands after a filter change is not appended", async () => {
    const s = stub((u) => (!isList(u) ? json(404, {}) : u.includes("cursor=") ? null : u.includes("level=ERROR") ? json(200, page([T(5)])) : json(200, page([T(1)], { next_cursor: T(1) }))));
    await open();
    await m.click(m.button("이전 항목 더 보기"));
    expect(s.held).toHaveLength(1);
    await m.click(m.button("ERROR"));
    s.held[0].answer(json(200, page([T(9)])));
    await m.settle();
    expect(rows()).toEqual([T(5)]);
  });
});

/**
 * 자동 확인은 떠날 때 그려져 있던 쪽 · 묶음과 견주었다(리뷰 cto-2026-10 최종): 불러오는 동안(필터 · 새로고침 · '다시 불러오기') 떠난 확인은 앞 조건의 것과 —
 * 새로 불러온 목록의 줄을 '새 항목'으로, 같은 묶음을 '묶음에 새 항목'으로 보였다(5f4996c7 뒤로 주기가 다시 걸리지 않아 불러오는 중에도 떠난다) —, 떠 있는 동안
 * '새 항목'을 반영했으면 반영 전의 것과 견주어 이미 보이는 줄을 다시 내놓았다
 */
describe("/logs: an auto-check compares its answer with the list on screen, not with the one it started from", () => {
  it("list: the check that fires while the new filter's list is loading does not offer that list's own rows", async () => {
    const s = stub((u) => (!isList(u) ? json(404, {}) : u.includes("level=ERROR") ? null : json(200, page([T(5)]))));
    await open();
    expect(rows()).toEqual([T(5)]);
    await m.act(() => { vi.advanceTimersByTime(14_000); });
    await m.click(m.button("ERROR")); // ERROR 목록을 받는 중
    expect(s.held).toHaveLength(1);
    await m.act(() => { vi.advanceTimersByTime(1_000); }); // 그 사이 15 s 확인
    await m.settle();
    s.held[0].answer(json(200, page([T(1), T(2)])));
    await m.settle();
    expect(rows()).toEqual([T(1), T(2)]);
    s.held[1]?.answer(json(200, page([T(1), T(2)]))); // 확인이 떠났다면 같은 답 — 새 것 없음
    await m.settle();
    expect(m.byTestId("logs-new")?.textContent ?? null).toBeNull();
    expect(rows()).toEqual([T(1), T(2)]);
  });

  it("list: while the new filter's list is loading the check offers nothing, even when it answers before the list", async () => {
    const s = stub((u) => (!isList(u) ? json(404, {}) : u.includes("level=ERROR") ? null : json(200, page([T(5)]))));
    await open();
    await m.act(() => { vi.advanceTimersByTime(14_000); });
    await m.click(m.button("ERROR"));
    await m.act(() => { vi.advanceTimersByTime(1_000); });
    await m.settle();
    s.held[1]?.answer(json(200, page([T(1), T(2)])));
    await m.settle();
    expect(m.byTestId("logs-new")?.textContent ?? null).toBeNull(); // 보이는 것은 아직 앞 필터의 [T(5)]
    s.held[0].answer(json(200, page([T(1), T(2)])));
    await m.settle();
    expect(rows()).toEqual([T(1), T(2)]);
    expect(m.byTestId("logs-new")?.textContent ?? null).toBeNull();
  });

  it("groups: the check that fires while the new filter's groups are loading does not offer those groups as changed", async () => {
    const s = stub((u) => (!isGroups(u) ? (isList(u) ? json(200, page([T(1)])) : json(404, {})) : u.includes("level=ERROR") ? null : json(200, { groups: [group(17)], scanned: 10, scan_truncated: false })));
    await open();
    await m.click(m.button("묶음(fp)"));
    expect(m.allByTestId("log-group")[0].textContent).toContain("17");
    await m.act(() => { vi.advanceTimersByTime(14_000); });
    await m.click(m.button("ERROR"));
    expect(s.held).toHaveLength(1);
    await m.act(() => { vi.advanceTimersByTime(1_000); });
    await m.settle();
    const errorGroups = { groups: [group(42)], scanned: 42, scan_truncated: false };
    s.held[0].answer(json(200, errorGroups));
    await m.settle();
    expect(m.allByTestId("log-group")[0].textContent).toContain("42");
    s.held[1]?.answer(json(200, errorGroups));
    await m.settle();
    expect(m.byTestId("logs-new")?.textContent ?? null).toBeNull();
  });

  it("list: a check that was out when '새 항목' was applied does not offer the applied rows again", async () => {
    let body: unknown = page([T(1)]);
    let hold = false;
    const s = stub((u) => (!isList(u) ? json(404, {}) : hold ? null : json(200, body)));
    await open();
    body = page([T(0), T(1)]);
    await tick();
    expect(m.byTestId("logs-new")!.textContent).toBe("새 항목 1건");
    hold = true;
    await tick(); // 다음 확인은 떠 있다
    expect(s.held).toHaveLength(1);
    await m.click(m.byTestId("logs-new")); // 그동안 반영
    expect(rows()).toEqual([T(0), T(1)]);
    s.held[0].answer(json(200, page([T(0), T(1)])));
    await m.settle();
    expect(m.byTestId("logs-new")?.textContent ?? null).toBeNull();
  });

  it("groups: a check that was out when the changed groups were applied does not offer them again", async () => {
    let groups = { groups: [group(17)], scanned: 10, scan_truncated: false };
    let hold = false;
    const s = stub((u) => (isGroups(u) ? (hold ? null : json(200, groups)) : isList(u) ? json(200, page([T(1)])) : json(404, {})));
    await open();
    await m.click(m.button("묶음(fp)"));
    groups = { ...groups, groups: [group(18)] };
    await tick();
    expect(m.byTestId("logs-new")!.textContent).toBe("묶음에 새 항목 — 반영");
    hold = true;
    await tick();
    expect(s.held).toHaveLength(1);
    await m.click(m.byTestId("logs-new"));
    expect(m.allByTestId("log-group")[0].textContent).toContain("18");
    s.held[0].answer(json(200, groups));
    await m.settle();
    expect(m.byTestId("logs-new")?.textContent ?? null).toBeNull();
  });
});

/**
 * 자동 확인은 앞 확인이 떠 있으면 그 주기를 건너뛴다(ADR-029 §5 — 쌓지 않는다). 막는 것이 없어 api 가 멈추면 15 s 마다 요청이 쌓였고,
 * 늦게 온 앞 확인이 더 새 확인의 대기열을 덮었다(리뷰 cto-2026-10 최종)
 */
describe("/logs: the auto-check is not sent while the previous check is still out", () => {
  it("list: four ticks with the api hanging send one check; an answer (or a failure) frees the next tick", async () => {
    let hold = false;
    let fail = false;
    const s = stub((u) => (!isList(u) ? json(404, {}) : hold ? null : fail ? json(503, { detail: "log store unavailable" }) : json(200, page([T(1)]))));
    await open();
    const first = s.lists().length;
    hold = true;
    for (let i = 0; i < 4; i++) await tick();
    expect(s.lists().length - first).toBe(1);
    hold = false;
    s.held[0].answer(json(503, { detail: "log store unavailable" }));
    await m.settle();
    fail = true;
    await tick(); // 실패한 확인도 다음 주기를 막지 않는다
    expect(s.lists().length - first).toBe(2);
    fail = false;
    await tick();
    expect(s.lists().length - first).toBe(3);
    expect(rows()).toEqual([T(1)]);
  });

  it("groups: four ticks with the api hanging send one check", async () => {
    let hold = false;
    const s = stub((u) => (isGroups(u) ? (hold ? null : json(200, { groups: [group(17)], scanned: 10, scan_truncated: false })) : isList(u) ? json(200, page([T(1)])) : json(404, {})));
    await open();
    await m.click(m.button("묶음(fp)"));
    const groupsAsked = () => s.asked.filter(isGroups).length;
    const first = groupsAsked();
    hold = true;
    for (let i = 0; i < 4; i++) await tick();
    expect(groupsAsked() - first).toBe(1);
  });

  it("a check left hanging under the previous filter does not hold back the checks for the new one", async () => {
    let hold = false;
    const s = stub((u) => (!isList(u) ? json(404, {}) : u.includes("level=ERROR") ? json(200, page([T(5)])) : hold ? null : json(200, page([T(1)]))));
    await open();
    hold = true;
    await tick();
    expect(s.held).toHaveLength(1); // 앞 필터의 확인이 떠 있다
    await m.click(m.button("ERROR"));
    expect(rows()).toEqual([T(5)]);
    const errorAsked = () => s.lists().filter((u) => u.includes("level=ERROR")).length;
    const before = errorAsked();
    await tick();
    expect(errorAsked() - before).toBe(1);
  });
});

describe("/logs list: errors, the last-success time and the selection across reloads", () => {
  it("a failed load shows its error with the request id; the next successful check clears it and sets 갱신", async () => {
    let fail = true;
    stub((u) => (!isList(u) ? json(404, {}) : fail ? json(503, { detail: "log store unavailable", request_id: "feedface0000beef" }) : json(200, page([T(1)]))));
    await open();
    const alert = () => m.find((e) => e.getAttribute("role") === "alert")?.textContent ?? "";
    expect(alert()).toContain("log store unavailable");
    expect(alert()).toContain("feedface0000beef");
    expect(m.byTestId("logs-last-ok")!.textContent).toBe("갱신 — · 15 s 확인");
    fail = false;
    await tick();
    expect(alert()).toBe("");
    expect(rows()).toEqual([T(1)]);
    expect(m.byTestId("logs-last-ok")!.textContent).toBe("갱신 11:00:15 KST · 15 s 확인");
  });

  it("'새로고침' is disabled while the list loads; the selected row stays selected only while it is still listed", async () => {
    let body: unknown = page([T(1), T(2)]);
    let hold = false;
    const s = stub((u) => (!isList(u) ? json(404, {}) : hold ? null : json(200, body)));
    await open();
    await m.click(m.allByTestId("log-row")[1]);
    const selected = () => m.allByTestId("log-row").filter((r) => r.getAttribute("aria-selected") === "true").map((r) => r.getAttribute("data-id"));
    expect(selected()).toEqual([T(2)]);
    hold = true;
    await m.click(m.button("새로고침"));
    expect(m.button("새로고침")!.getAttribute("disabled")).not.toBeNull();
    s.held[0].answer(json(200, page([T(0), T(1), T(2)])));
    await m.settle();
    expect(m.button("새로고침")!.getAttribute("disabled")).toBeNull();
    expect(selected()).toEqual([T(2)]);
    hold = false;
    body = page([T(0), T(1)]);
    await m.click(m.button("새로고침"));
    expect(rows()).toEqual([T(0), T(1)]);
    expect(selected()).toEqual([]);
    body = page([T(0), T(1), T(2)]); // 다시 나타나도 고른 줄로 돌아오지 않는다(선택은 그 목록에서 지웠다)
    await m.click(m.button("새로고침"));
    expect(rows()).toEqual([T(0), T(1), T(2)]);
    expect(selected()).toEqual([]);
  });
});
