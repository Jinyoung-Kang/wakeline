/**
 * 관심 대상 규칙(SPEC F4 · ADR-037 · 계약 v5 §G50) — 저장소 읽기 검증(깨진 값 · 못 씀) · 50개 상한 · 조회 쿼리 · 답 해석 · 사건(첫 답은 기준) · 사건 열쇠 ·
 * 같은 사건 한 번 · 10분 반복 억제 · 숨은 탭 예외의 조건과 그것을 쓰는 곳이 하나뿐임 · 브라우저 알림 감싸기(허락은 단추에서만).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffWatch, loadTargets, normalizeTargets, parseWatch, pollWhileHidden, saveTargets, suppress, toggleTarget, watchQuery, WATCH_KEY, WATCH_MAX, WATCH_REPEAT_MS,
  type WatchState, type WatchTarget,
} from "@/lib/watch";
import { enableNotify, initialPermission, keepBlocked, NOTIFY_BLOCKED_KEY, notifyPermission, NOTIFY_ENABLED_TAG, rememberPermission, requestNotify, showNotification, type NotificationApi } from "@/lib/notify";

const AC: WatchTarget = { kind: "aircraft", id: "71be01", label: "KAL081" };
const SHIP: WatchTarget = { kind: "ship", id: "440123456" };
const APT: WatchTarget = { kind: "airport", id: "RKSI" };
const T = [AC, SHIP, APT];

function mem(init: Record<string, string> = {}, fail = false) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { if (fail) throw new Error("QuotaExceeded"); m.set(k, v); }, m };
}

function state(p: Partial<WatchState> = {}): WatchState {
  return {
    aircraft: [{ hex: "71be01", found: true, seen_at: "2026-10-09T10:00:00Z", open_alerts: [], closed_alerts: [] }],
    ships: [{ mmsi: "440123456", found: true, seen_at: "2026-10-09T10:00:00Z", age_s: 60 }],
    airports: [{ icao: "RKSI", found: true, flight_cat: "VFR", obs_time: "2026-10-09T09:30:00Z" }],
    aisLastGap: null, ...p,
  };
}
const alert = (id: number, kind: "OBSERVED" | "PREDICTED" = "OBSERVED", extra = {}) =>
  ({ id, kind, zone_type: "sigmet", sigmet_id: "RKRR S1", hazard: "TS", entered_at: "2026-10-09T10:00:00Z", ...extra });

describe("watch list in this browser only", () => {
  it("keeps only well-formed, distinct targets, normalises ids and caps at 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ kind: "ship", id: String(440000000 + i) }));
    const r = normalizeTargets([{ kind: "aircraft", id: " 71BE01 " }, { kind: "aircraft", id: "71be01" }, { kind: "airport", id: "rksi" }, { kind: "ship", id: "12" },
      { kind: "boat", id: "440123456" }, null, ...many]);
    expect(r.targets.slice(0, 2)).toEqual([{ kind: "aircraft", id: "71be01" }, { kind: "airport", id: "RKSI" }]);
    expect(r.targets).toHaveLength(WATCH_MAX);
    expect(r.dropped).toBe(4 + 12);
  });
  it("load: missing → empty ok · broken JSON or bad items → corrupt (the rest kept) · no storage or a throwing getItem → unavailable", () => {
    expect(loadTargets(mem())).toEqual({ targets: [], state: "ok" });
    expect(loadTargets(mem({ [WATCH_KEY]: "{oops" }))).toEqual({ targets: [], state: "corrupt" });
    expect(loadTargets(mem({ [WATCH_KEY]: JSON.stringify([AC, { kind: "x" }]) }))).toEqual({ targets: [AC], state: "corrupt" });
    expect(loadTargets(null).state).toBe("unavailable");
    expect(loadTargets({ getItem: () => { throw new Error("SecurityError"); }, setItem: () => {} }).state).toBe("unavailable");
  });
  it("save reports failure (private mode · quota) so the screen can say 'this visit only'", () => {
    const ok = mem();
    expect(saveTargets(ok, [AC])).toBe(true);
    expect(JSON.parse(ok.m.get(WATCH_KEY)!)).toEqual([AC]);
    expect(saveTargets(mem({}, true), [AC])).toBe(false);
    expect(saveTargets(null, [AC])).toBe(false);
  });
  it("toggle adds, removes the same target, and refuses the 51st", () => {
    expect(toggleTarget([], AC)).toEqual({ list: [AC], full: false });
    expect(toggleTarget([AC, SHIP], { kind: "aircraft", id: "71be01" })).toEqual({ list: [SHIP], full: false });
    const full = Array.from({ length: WATCH_MAX }, (_, i) => ({ kind: "ship" as const, id: String(440000000 + i) }));
    expect(toggleTarget(full, AC)).toEqual({ list: full, full: true });
  });
  it("query carries the three lists only (no labels)", () => {
    expect(watchQuery(T)).toBe("aircraft=71be01&ships=440123456&airports=RKSI");
    expect(watchQuery([SHIP])).toBe("ships=440123456");
  });
});

describe("answer and events", () => {
  it("parses the §G50 answer, dropping malformed rows; a wrong body is null", () => {
    expect(parseWatch({ aircraft: [{ hex: "71be01", found: true, open_alerts: [alert(1), { id: "x" }] }, { hex: 1 }], ships: [], airports: [], ais_last_gap: { started_at: "a", reason: "ws_closed" } }))
      .toEqual({ aircraft: [{ hex: "71be01", found: true, open_alerts: [alert(1)], closed_alerts: [] }], ships: [], airports: [], aisLastGap: { started_at: "a", reason: "ws_closed" } });
    expect(parseWatch({ aircraft: [] })).toBeNull();
    expect(parseWatch(null)).toBeNull();
  });
  it("the first answer is only the baseline — no events on opening the page", () => {
    expect(diffWatch(null, state({ aircraft: [{ hex: "71be01", found: true, open_alerts: [alert(1)], closed_alerts: [] }] }), T)).toEqual([]);
  });
  it("aircraft: a new open alert (entry · predicted entry), a newly closed one, and losing the signal", () => {
    const prev = state();
    const next = state({ aircraft: [{ hex: "71be01", found: true, open_alerts: [alert(7, "PREDICTED", { zone_type: "airspace", zone_name: "R-75", level: "info" })], closed_alerts: [{ ...alert(5), left_at: "x", close_reason: "left" }] }] });
    const evs = diffWatch(prev, next, T);
    expect(evs.map((e) => [e.key, e.title, e.body, e.tone])).toEqual([
      ["ac:71be01:alert:7:open", "항공기 KAL081 (71be01) — 예측 진입", "공역 R-75(정보)", "info"],
      ["ac:71be01:alert:5:closed", "항공기 KAL081 (71be01) — 알림 닫힘", "SIGMET TS RKRR S1 · 이탈 확인(바깥 관측 3회)", "info"],
    ]);
    const lost = diffWatch(prev, state({ aircraft: [{ hex: "71be01", found: false, open_alerts: [], closed_alerts: [] }] }), T);
    expect(lost.map((e) => e.title)).toEqual(["항공기 KAL081 (71be01) — 신호 끊김"]);
    expect(diffWatch(prev, next, [SHIP, APT])).toEqual([]); // 목록에서 뺀 대상은 보지 않는다
  });
  it("ship: lost after 30 min (with an open AIS gap's reason) and received again", () => {
    const lost = diffWatch(state(), state({ ships: [{ mmsi: "440123456", found: false }], aisLastGap: { started_at: "x", reason: "ws_closed" } }), T);
    expect(lost.map((e) => [e.title, e.body])).toEqual([["선박 440123456 — 위치 수신 끊김(30분)", "마지막 위치 뒤 30분 넘게 받지 못함 · AIS 수신 공백 중(ws_closed)"]]);
    const back = diffWatch(state({ ships: [{ mmsi: "440123456", found: false }] }), state(), T);
    expect(back.map((e) => e.title)).toEqual(["선박 440123456 — 위치 다시 받음"]);
  });
  it("airport: a flight-category change between known values only", () => {
    const ifr = state({ airports: [{ icao: "RKSI", found: true, flight_cat: "IFR", obs_time: "2026-10-09T10:00:00Z" }] });
    expect(diffWatch(state(), ifr, T).map((e) => [e.title, e.tone])).toEqual([["공항 RKSI — 비행 등급 VFR → IFR", "alert"]]);
    expect(diffWatch(state({ airports: [{ icao: "RKSI", found: true }] }), ifr, T)).toEqual([]); // 모름 → 앎은 변화가 아니다
  });
  it("suppression: one event per key, and the same family not again within 10 minutes", () => {
    const [e] = diffWatch(state(), state({ ships: [{ mmsi: "440123456", found: false }] }), T);
    const a = suppress([e, e], new Map(), 0);
    expect(a.pass).toHaveLength(1);
    expect(suppress([e], a.fired, 60_000).pass).toHaveLength(0);
    const again = { ...e, key: "ship:440123456:lost:2026-10-09T10:20:00Z" }; // 다시 받았다가 또 끊김 — 열쇠는 다르지만 10분 안
    expect(suppress([again], a.fired, WATCH_REPEAT_MS - 1).pass).toHaveLength(0);
    expect(suppress([again], a.fired, WATCH_REPEAT_MS).pass).toHaveLength(1);
  });
});

describe("hidden-tab exception (ADR-037 — the only one to ADR-029 §5-2)", () => {
  it("polls while hidden only with targets and a granted permission", () => {
    expect(pollWhileHidden(0, "granted")).toBe(false);
    expect(pollWhileHidden(3, "default")).toBe(false);
    expect(pollWhileHidden(3, "denied")).toBe(false);
    expect(pollWhileHidden(3, "granted")).toBe(true);
  });
  it("is used in exactly one place — the watch runner", () => {
    const root = resolve(__dirname, "..");
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n)) files.push(p); } };
    for (const d of ["app", "components", "lib"]) walk(join(root, d));
    const users = files.filter((f) => readFileSync(f, "utf8").includes("pollWhileHidden(")).map((f) => relative(root, f));
    expect(users.sort()).toEqual(["components/watch/useWatchRunner.ts", "lib/watch.ts"]);
  });
});

describe("browser notifications", () => {
  function fake(permission: string) {
    const shown: { title: string; body?: string; tag?: string }[] = [];
    let asked = 0;
    const N = class { onclick: ((ev: Event) => unknown) | null = null; constructor(title: string, o?: { body?: string; tag?: string }) { shown.push({ title, ...o }); } close() {} } as unknown as NotificationApi;
    Object.assign(N, { permission, requestPermission: async () => { asked++; (N as { permission: string }).permission = "granted"; return "granted"; } });
    return { N, shown, asked: () => asked };
  }
  it("unsupported → banner only; shows nothing until granted; asks only when called (the button)", async () => {
    expect(notifyPermission(null)).toBe("unsupported");
    expect(showNotification("t", "b", "k", undefined, null)).toBe("off");
    const f = fake("default");
    expect(notifyPermission(f.N)).toBe("default");
    expect(showNotification("t", "b", "k", undefined, f.N)).toBe("off");
    expect(f.asked()).toBe(0);
    expect(await requestNotify(f.N)).toBe("granted");
    expect(showNotification("제목", "본문", "ac:1", undefined, f.N)).toBe("shown");
    expect(f.shown).toEqual([{ title: "제목", body: "본문", tag: "ac:1" }]);
  });
  it("the enable button confirms with one notification; a browser that grants but blocks page notifications (Android Chrome) is 'blocked'", async () => {
    const f = fake("default");
    expect(await enableNotify(f.N)).toBe("granted");
    expect(f.shown.map((x) => x.tag)).toEqual([NOTIFY_ENABLED_TAG]);
    // 서비스 워커 전용 브라우저: 허락은 granted 인데 생성자가 던진다 — 화면이 '켜짐'이라고 하지 않고, 숨은 탭에서 헛되이 조회하지 않는다
    const Blocked = class { constructor() { throw new TypeError("Illegal constructor"); } } as unknown as NotificationApi;
    Object.assign(Blocked, { permission: "default", requestPermission: async () => { (Blocked as { permission: string }).permission = "granted"; return "granted"; } });
    expect(await enableNotify(Blocked)).toBe("blocked");
    expect(showNotification("t", "b", "k", undefined, Blocked)).toBe("blocked");
    expect(pollWhileHidden(3, "blocked")).toBe(false);
  });
  it("'blocked' survives a reload while the browser still says granted, and is forgotten once it does not (AWS review L1)", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
    expect(initialPermission(store, "granted")).toBe("granted");
    rememberPermission(store, "blocked");
    expect(mem.get(NOTIFY_BLOCKED_KEY)).toBe("1");
    expect(initialPermission(store, "granted")).toBe("blocked"); // 새로고침 — 생성자를 다시 부르지 않아도 '켜짐'이 아니다
    expect(initialPermission(store, "denied")).toBe("denied");   // 브라우저 설정에서 거뒀다 — 기억도 지운다
    expect(mem.has(NOTIFY_BLOCKED_KEY)).toBe(false);
    rememberPermission(store, "blocked");
    rememberPermission(store, "default");
    expect(mem.has(NOTIFY_BLOCKED_KEY)).toBe(false);
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(initialPermission(broken, "granted")).toBe("granted"); // 저장소를 못 쓰면 지금처럼(이번 접속 동안만)
    expect(() => rememberPermission(broken, "blocked")).not.toThrow();
    expect(initialPermission(null, "unsupported")).toBe("unsupported");
  });
  it("re-reading the browser permission keeps 'blocked' while it still says granted, and follows a withdrawal", () => {
    expect(keepBlocked("blocked", "granted")).toBe("blocked");
    expect(keepBlocked("blocked", "denied")).toBe("denied");
    expect(keepBlocked("granted", "denied")).toBe("denied");
    expect(keepBlocked("default", "granted")).toBe("granted");
  });
});
