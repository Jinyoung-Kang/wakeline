/**
 * 항공기 카드 노선의 "노선 조회 중"이 진행 중으로 읽히게(사용자 요청 2026-09-29).
 * - 조회 중: role=status(한 번만 읽힘 — aria-busy 조상 밖에 두어 알림이 미뤄지지 않게) · 값이 채워질 자리(출발/도착 skeleton)만 aria-busy ·
 *   가는 진행 막대(움직임 줄이기 설정이면 멈춤 — 모양은 tests/route-loading.test.ts) · 경과 초(시각만, 읽지 않음).
 * - 보통 경로 계산값(api 노선 메모리 캐시 5 s + 선택 항공기 갱신(selected) 주기 약 5 s = 10 s)보다 오래 걸리면 한 번 더 알린다.
 *   이 수들은 서버 코드의 값을 읽어 확인한다(짐작한 값이 아니다) — 측정값이 아니라 계산값이라고 적는다(리뷰 2026-09-29: 수집기는 콜사인을 5 s 주기가 아니라
 *   다음 1 s 틱에 조회에 넘긴다 — 5 s 는 selected 가 오는 주기다). 상한은 말하지 않는다 — 수집기의 조회 대기열(동시 2개)은 기다림에 상한이 없다.
 * - 실패 · 없음 · 꺼짐 문구는 그대로(계약 v4 §A).
 * - 계약 v5 §G21(2026-09-30): api 가 수집기의 결과(Redis)를 읽는 동안도 "조회 중"이다(읽기는 세션 우편함 밖) — 설명이 그 읽기와 상한(Redis 명령 상한,
 *   서버 설정 application.yml 에서 읽어 확인)을 적는다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { RouteSection } from "@/components/AircraftCard";
import { parseRoute, ROUTE_API_READ_BOUND_S, ROUTE_NORMAL_PATH_S, ROUTE_PENDING_TITLE, ROUTE_SLOW_AFTER_S, ROUTE_SLOW_TEXT, ROUTE_STATUS_TEXT, routePendingPhase, type RouteInfo } from "@/lib/route";
import { ancestors, byTestId, classes, findAll, parseHtml, textOf } from "./helpers/html-tree";
import { installMiniDom } from "./helpers/mini-dom";

// 최소 DOM 은 파일에 하나(describe 마다 설치하면 앞 describe 의 restore 가 뒤 describe 의 전역을 되돌린다)
const dom = installMiniDom();
afterAll(() => dom.restore());
const PENDING = parseRoute({ status: "pending", callsign: "KAL081", source: "adsbdb" })!;
const render = (route: RouteInfo | null, pendingForS: number | null = null) =>
  parseHtml(renderToStaticMarkup(createElement(RouteSection, { route, pos: null, callsign: "KAL081", pendingForS })));

describe("pending route lookup reads as in progress", () => {
  it("status line: role=status with the contract text, a motion indicator hidden from screen readers; no aria-busy ancestor delays it", () => {
    const root = render(PENDING, 3);
    const st = byTestId(root, "route-status")!;
    expect(st.attrs.role).toBe("status");
    expect(ancestors(st).filter((a) => a.attrs["aria-busy"] === "true")).toEqual([]);
    expect(textOf(st)).toContain(ROUTE_STATUS_TEXT.pending);
    // 움직이는 표시(진행 막대)는 화면 읽기 프로그램에서 숨긴다 — 상태는 글자가 말한다
    const bar = byTestId(root, "route-progress")!;
    expect(bar.attrs["aria-hidden"]).toBe("true");
  });
  it("placeholder rows for 출발 / 도착: the region to be filled is aria-busy, the bars are hidden from screen readers — no airport values are shown", () => {
    const root = render(PENDING, 3);
    const sk = byTestId(root, "route-skeleton")!;
    expect(sk.attrs["aria-busy"]).toBe("true");
    expect(textOf(sk)).toContain("출발");
    expect(textOf(sk)).toContain("도착");
    const bars = findAll(sk, (n) => classes(n).has("skeleton"));
    expect(bars.length).toBe(4); // 출발 · 도착마다 코드 줄 + 이름 줄(찾은 뒤의 AirportLine 모양)
    for (const b of bars) expect([b, ...ancestors(b)].some((a) => a.attrs["aria-hidden"] === "true")).toBe(true);
    expect(textOf(root)).not.toContain("계산값");
  });
  it("elapsed seconds are shown but not announced (outside the live region); unknown elapsed shows nothing, not 0", () => {
    const el = byTestId(render(PENDING, 4.4), "route-elapsed")!;
    expect(textOf(el)).toBe("4 s");
    expect(el.attrs["aria-hidden"]).toBe("true");
    expect(byTestId(render(PENDING, 4.4), "route-status")!.children.some((c) => c === el)).toBe(false);
    expect(byTestId(render(PENDING, null), "route-elapsed")).toBeNull();
  });
  it(`after ${ROUTE_SLOW_AFTER_S} s the live text says it is taking longer than usual (once), with the reason in the title`, () => {
    expect(routePendingPhase(null)).toBe("normal");
    expect(routePendingPhase(ROUTE_SLOW_AFTER_S - 0.1)).toBe("normal");
    expect(routePendingPhase(ROUTE_SLOW_AFTER_S)).toBe("slow");
    const early = byTestId(render(PENDING, ROUTE_SLOW_AFTER_S - 1), "route-status")!;
    expect(textOf(early)).not.toContain(ROUTE_SLOW_TEXT);
    const slow = byTestId(render(PENDING, ROUTE_SLOW_AFTER_S + 2), "route-status")!;
    expect(textOf(slow)).toContain(ROUTE_SLOW_TEXT);
    expect(slow.attrs["data-phase"]).toBe("slow");
    expect(slow.attrs.title).toContain("노선 조회 실패");
    expect(ROUTE_SLOW_TEXT).toContain(`${ROUTE_NORMAL_PATH_S} s`);
  });
  it("the wording says what 10 s really is: a value computed from the api cache and the selected push cadence, not a measured usual time", () => {
    expect(ROUTE_SLOW_TEXT).not.toContain("평소"); // 잰 적 없는 "평소" 가 아니다
    expect(ROUTE_SLOW_TEXT).toContain("계산값");
    expect(ROUTE_PENDING_TITLE).toContain("api 가 “조회 중”을 5 s 동안 캐시");
    expect(ROUTE_PENDING_TITLE).toContain("selected");
    expect(ROUTE_PENDING_TITLE).toContain("약 5 s");
    expect(ROUTE_PENDING_TITLE).toContain("계산값");
    expect(ROUTE_PENDING_TITLE).not.toContain("수집기 조회 주기"); // 수집기는 콜사인을 다음 1 s 틱에 넘긴다
  });
  it("other statuses keep their wording, with no progress bar, no skeleton and no aria-busy", () => {
    for (const status of ["not_found", "no_callsign", "unavailable", "disabled"] as const) {
      const root = render(parseRoute({ status, callsign: status === "no_callsign" ? null : "KAL081", source: "adsbdb" }), 30);
      expect(textOf(byTestId(root, "route-status")!), status).toContain(ROUTE_STATUS_TEXT[status]);
      expect(findAll(root, (n) => n.attrs["aria-busy"] === "true"), status).toEqual([]);
      expect(byTestId(root, "route-skeleton"), status).toBeNull();
      expect(byTestId(root, "route-progress"), status).toBeNull();
      expect(byTestId(root, "route-loading"), status).toBeNull();
    }
  });
});

describe("the 10 s threshold comes from the server's route path (read from the code, not guessed)", () => {
  const repo = new URL("../../../", import.meta.url);
  const src = (p: string) => readFileSync(new URL(p, repo), "utf8");
  it("api route memory cache 5 s (a 'pending' read is served for that long) + the next selected push (focus observations every FOCUS_INTERVAL_S)", () => {
    const demand = src("apps/collector/wakeline_collector/jobs/demand.py");
    const focus = Number(/^FOCUS_INTERVAL_S = (\d+(?:\.\d+)?)/m.exec(demand)![1]);
    const tick = Number(/^TICK_S = (\d+(?:\.\d+)?)/m.exec(demand)![1]);
    const apiCacheMs = Number(/TTL_MS = ([\d_]+);/.exec(src("apps/api/src/main/java/dev/wakeline/route/RouteReader.java"))![1].replace(/_/g, ""));
    // 5 s 는 selected 가 오는 주기: 수집기의 집중 추적 관측이 FOCUS_INTERVAL_S 마다(_focus_due) → WsHub 가 그 관측마다 selected 를 보낸다(≈ 5 s)
    expect(demand).toMatch(/self\._focus_due = now \+ FOCUS_INTERVAL_S/);
    expect(src("apps/api/src/main/java/dev/wakeline/ws/WsHub.java")).toMatch(/focus 관측이 오면 그 hex 를 선택한 세션에 selected 를 보낸다\(≈ 5 s/);
    // 노선 조회에 넘기는 것은 틱마다(TICK_S) — 처음 보는 콜사인은 곧바로(FOCUS_INTERVAL_S 는 같은 콜사인을 다시 넘기기까지의 간격일 뿐)
    expect(tick).toBeLessThan(focus);
    expect(demand).toMatch(/self\._request_routes\(demand, now\)/);
    expect(demand).toMatch(/now - self\._route_asked\.get\(cs, -math\.inf\) >= FOCUS_INTERVAL_S/);
    expect(ROUTE_NORMAL_PATH_S).toBe(apiCacheMs / 1000 + focus);
    expect(ROUTE_SLOW_AFTER_S).toBe(ROUTE_NORMAL_PATH_S);
  });
});

describe("'조회 중' also covers the api's own read of the collector's result (contract v5 §G21 — off the session mailbox)", () => {
  const repo = new URL("../../../", import.meta.url);
  const src = (p: string) => readFileSync(new URL(p, repo), "utf8");
  it("the bound is the api's Redis command timeout, read from the server config (a configured value, not a measurement)", () => {
    const yml = src("apps/api/src/main/resources/application.yml");
    const m = /^ {4}redis:\n(?: {6}.*\n)*? {6}timeout: (\d+)s$/m.exec(yml);
    expect(m).not.toBeNull();
    expect(ROUTE_API_READ_BOUND_S).toBe(Number(m![1]));
    // api 가 그 값을 selected.route 답의 마감으로 쓴다(WsHub → RouteLookups.deadlineMs)
    expect(src("apps/api/src/main/java/dev/wakeline/ws/WsHub.java")).toContain('@Value("${spring.data.redis.timeout}") String redisCommandTimeout');
    expect(src("apps/api/src/main/java/dev/wakeline/ws/RouteLookups.java")).toMatch(/static long deadlineMs\(Duration redisCommandTimeout\)/);
  });
  it("the title says so: reading the result, answered within that bound, otherwise the failure text", () => {
    expect(ROUTE_PENDING_TITLE).toContain("api 가 그 결과(Redis)를 읽는 중");
    expect(ROUTE_PENDING_TITLE).toContain(`늦어도 ${ROUTE_API_READ_BOUND_S} s`);
    expect(ROUTE_PENDING_TITLE).toContain("설정값");
    expect(ROUTE_PENDING_TITLE).toContain(`“${ROUTE_STATUS_TEXT.unavailable}”`);
  });
});

describe("one live region stays mounted while the route status changes (so the first \"노선 조회 중\" is announced)", () => {
  it("null → pending → found → pending → unavailable: the same role=status node, only its text changes", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { MiniElement } = await import("./helpers/mini-dom");
    const find = (from: InstanceType<typeof MiniElement>, pred: (e: InstanceType<typeof MiniElement>) => boolean): InstanceType<typeof MiniElement> | null => {
      if (pred(from)) return from;
      for (const c of from.childNodes) if (c instanceof MiniElement) { const x = find(c, pred); if (x) return x; }
      return null;
    };
    const region = () => find(dom.container as never, (e) => e.getAttribute?.("role") === "status");
    const root = createRoot(dom.container as never);
    const show = async (route: RouteInfo | null) => { await React.act(async () => { root.render(createElement(RouteSection, { route, pos: null, callsign: "KAL081", pendingForS: 1 })); }); return region(); };
    const FOUND = parseRoute({ status: "found", callsign: "KAL081", source: "adsbdb", fetched_at: "2026-09-29T05:00:00Z",
      origin: { icao: "ZZAA", iata: null, name: "Synthetic Alpha", city: null, country: null, country_iso: null, lat: 1, lon: 2 },
      destination: { icao: "ZZBB", iata: null, name: "Synthetic Beta", city: null, country: null, country_iso: null, lat: 3, lon: 4 } })!;
    const first = await show(null);
    expect(first).not.toBeNull(); // 경로를 모를 때("—")부터 live 영역이 있다
    expect(first!.textContent).toBe("—");
    const seq: [RouteInfo | null, string][] = [
      [PENDING, ROUTE_STATUS_TEXT.pending], [FOUND, "노선 찾음"], [parseRoute({ status: "pending", callsign: "KAL082", source: "adsbdb" }), ROUTE_STATUS_TEXT.pending],
      [parseRoute({ status: "unavailable", callsign: "KAL082", source: "adsbdb" }), ROUTE_STATUS_TEXT.unavailable],
    ];
    for (const [route, text] of seq) {
      const r = await show(route);
      expect(r, route?.status).toBe(first); // 새로 만들지 않는다 — 화면 읽기 프로그램은 이미 있던 영역의 바뀐 글자를 읽는다
      expect(r!.textContent, route?.status).toContain(text);
    }
    await React.act(async () => { root.unmount(); });
  });
});

describe("the card tracks how long it has seen 'pending' for this aircraft and callsign", () => {
  it("starts at the first pending render, resets when the callsign changes or the lookup ends", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useElapsedSince } = await import("@/lib/clock");
    const seen: (number | null)[] = [];
    function Probe({ k, now }: { k: string | null; now: number }) { seen.push(useElapsedSince(k, now)); return null; }
    const root = createRoot(dom.container as never);
    const at = async (k: string | null, now: number) => { await React.act(async () => { root.render(React.createElement(Probe, { k, now })); }); return seen.at(-1); };
    expect(await at("a|KAL081", 0)).toBeNull(); // 시계를 아직 모름
    expect(await at("a|KAL081", 10_000)).toBe(0);
    expect(await at("a|KAL081", 14_500)).toBe(4.5);
    expect(await at("a|KAL082", 15_000)).toBe(0); // 콜사인이 바뀌면 새로
    expect(await at(null, 16_000)).toBeNull(); // 끝남
    expect(await at("a|KAL082", 20_000)).toBe(0); // 다시 조회 중이면 그때부터
    await React.act(async () => { root.unmount(); });
  });
  it("the aircraft card passes it to the route section", () => {
    const card = readFileSync(new URL("../components/AircraftCard.tsx", import.meta.url), "utf8");
    expect(card).toMatch(/useElapsedSince\(/);
    expect(card).toMatch(/<RouteSection [^>]*pendingForS=\{/);
  });
});
