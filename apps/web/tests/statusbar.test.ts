/**
 * 상단 상태 바(사용자 요청 2026-09-30): "[WS open] 줄에 정보가 너무 많아 한 화면에서 잘리고 옆으로 끌어야 보인다" — 1,427 px 창에서 줄의 내용이
 * 2,063 px(가로 스크롤)였다. 바꾼 모양:
 * - 줄: 연결 · 경고 · 피드마다 칩 하나(이름 + 상태 — 색과 모양(■ ▲ ✕ □) · 정상이 아니면 낱말 + 핵심 수 하나). 가로로 스크롤되지 않는다.
 * - 상세(단추 — aria-expanded, 키보드 · Esc · 바깥 누르기로 닫힘): 출처 · 속도 · 수집 시각 · 기상청 프레임 · 합성 지점 · 엔진 · 판 · AIS 공백 기록을 표로.
 * - 폭이 모자라면 정상 · 모름 칩만 뒤에서부터 상세로 옮기고 '+N' 으로 센다 — 잘리지 않는다. 주의 · 경고 칩은 빼지 않는다.
 * - 기준은 이미 있는 값만(지역 60 s · 전세계 300 s · AIS 120 s · 기상청 900 s · SIGMET 900 s · 레이더 600 s — 서버 코드와 견준다).
 * - AIS 공백은 길이(1분 미만은 초)로 — 전에는 "02:22–02:22 KST · 17:22–17:22Z" 처럼 같은 두 시각이었다.
 * - "WS paused" 는 탭이 숨겨져 서버에 일시정지를 보낸 상태 — 그렇게 적는다.
 * - 시각은 KST 만(사용자 결정 2026-09-30).
 * - 성능: 줄 폭은 ResizeObserver(크기가 바뀔 때)로만 잰다 — 1 s 시계 틱마다 재지 않는다. 스토어 전체가 아니라 필요한 값만 구독한다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { StatusBarView } from "@/components/StatusBar";
import { WS_INVALID_NONE } from "@/lib/store";
import {
  chipState, connChip, detailRows, fitChips, HEALTH_MARK, pinnedOverflow, openGapWarning, RADAR_STALE_S, SIGMET_STALE_S, statusChips, type StatusInput,
} from "@/lib/statusbar";
import { AIS_GAP_SHOW_MS, AIS_LAG_WARN_S, parseAisStatus } from "@/lib/ships";
import { KR_RADAR_STALE_S } from "@/lib/format";
import { GLOBAL_STALE_S, REGION_STALE_S } from "@/lib/ws-protocol";
import type { KrRadar } from "@/lib/types";
import { byTestId, findAll, parseHtml, textOf } from "./helpers/html-tree";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";

const dom = installMiniDom();
afterAll(() => dom.restore());

/** 사용자 화면(2026-09-30 02:43 KST)과 같은 모양의 값 */
const NOW = Date.parse("2026-09-29T17:43:32Z");
const iso = (dtMs: number) => new Date(NOW + dtMs).toISOString();
function kr(over: Partial<KrRadar> = {}, frame: Record<string, unknown> = {}): KrRadar {
  const f = { tm: "202609300235", obs_tm: "202609300235", fetched_at: iso(-8 * 60_000), echo_cells: 10, url: "/x", stations: 17, stations_ref: 17, partial: false, ...frame };
  return {
    available: true, latest_tm: "202609300235", georeferenced: true, coordinates: null, legend: null, frames: Array.from({ length: 12 }, () => f) as never,
    attribution: "기상청", meta: { fetched_at: iso(-8 * 60_000), stale: false }, ...over,
  };
}
function input(over: Partial<StatusInput> = {}): StatusInput {
  return {
    conn: "open", reconnectAttempt: 0, lastRxAt: NOW - 2000, nowMs: NOW, srvNowMs: NOW,
    feeds: {
      region: { provider: "adsb_fi", fetched_at: iso(-9000), lag_s: 9, stale: false, received_at: NOW - 1000 },
      global: { provider: "opensky", fetched_at: iso(-31_000), lag_s: 31, stale: false, received_at: NOW - 1000 },
    },
    aircraftCount: 26,
    status: { fixture_mode: false, sigmet: { provider: "awc", active: 153, fetched_at: iso(-42_000), stale: false }, radar: { provider: "rainviewer", frames: 13, stale: false }, engine: { index_polygons: 157, last_cycle_ms: 106 } },
    sigmetsProvider: "awc", sigmetsFetchedAt: iso(-42_000),
    radar: { host: "h", generated: 0, past: Array.from({ length: 13 }, (_, i) => ({ time: i, path: "/p" })), fetched_at: iso(-39_000), provider: "rainviewer" },
    radarKr: kr(),
    ais: parseAisStatus({ sources: { ais: { connected: true, state: "receiving", lag_s: 3, msgs_per_s: 65.9, last_gap: { started_at: iso(-21 * 60_000 - 42_000), ended_at: iso(-21 * 60_000), reason: "restart" } } } }, NOW - 1000),
    snapshotVersion: 284,
    ...over,
  };
}
const bar = (i: StatusInput = input()) => parseHtml(renderToStaticMarkup(createElement(StatusBarView, { input: i, inv: WS_INVALID_NONE })));

describe("the row: one chip per feed — name, state (colour and shape, a word when not ok) and one key number", () => {
  it("the user's feeds become short chips in a fixed order; the details are not in the row", () => {
    const chips = statusChips(input());
    expect(chips.map((c) => c.key)).toEqual(["aircraft", "region", "world", "ais", "ais-gap", "sigmet", "radar", "kma"]);
    const v = Object.fromEntries(chips.map((c) => [c.key, c.value]));
    expect(v).toEqual({ aircraft: "26", region: "lag 9s", world: "lag 31s", ais: "lag 3s", "ais-gap": "42s", sigmet: "age 42s", radar: "age 39s", kma: "age 8m" });
    const t = textOf(byTestId(bar(), "statusbar-row")!);
    for (const gone of ["adsb_fi", "opensky", "msg/s", "153 active", "13 frames", "polys", "v284", "합성 17/17곳"]) expect(t, gone).not.toContain(gone);
  });
  it("every chip that has a state carries a shape as well as a colour; ok has no word, other states say it", () => {
    const root = bar(input({ feeds: { region: { provider: "adsb_fi", fetched_at: iso(-90_000), lag_s: 90, stale: true, received_at: NOW - 1000 }, global: null } }));
    const region = byTestId(root, "lag-badge")!;
    expect(region.attrs["data-health"]).toBe("bad");
    expect(textOf(region)).toContain(HEALTH_MARK.bad);
    expect(textOf(region)).toContain("STALE");
    const sigmet = byTestId(root, "sigmet-chip")!;
    expect(sigmet.attrs["data-health"]).toBe("ok");
    expect(textOf(sigmet)).toContain(HEALTH_MARK.ok);
    // 모양은 화면 읽기 프로그램에서 숨기고, 상태 낱말(정상)을 대신 읽힌다
    const mark = findAll(sigmet, (n) => textOf(n) === HEALTH_MARK.ok && n.tag === "span")[0];
    expect(mark.attrs["aria-hidden"]).toBe("true");
    expect(findAll(sigmet, (n) => (n.attrs.class ?? "").includes("sr-only")).map(textOf)).toEqual(["정상"]);
    // 전세계 피드를 모르면 모름(□) · "—" — 0 이나 정상으로 채우지 않는다
    const world = byTestId(root, "global-lag-badge")!;
    expect(world.attrs["data-health"]).toBe("unknown");
    expect(textOf(world)).toContain("—");
    // 항공기 수는 상태가 아니다 — 모양을 붙이지 않는다
    expect(textOf(byTestId(root, "aircraft-count")!)).toMatch(/^aircraft\s*26$/);
  });
  it("times are KST only — no UTC or …Z clock anywhere in the row or the details", () => {
    const i = input({ ais: parseAisStatus({ sources: { ais: { connected: true, lag_s: 3, msgs_per_s: 1, gap_open_since: iso(-252_000) } } }, NOW) });
    const all = [textOf(bar(i)), ...detailRows(i).flatMap((r) => [r.state, r.value, r.source, r.rule, r.valueTitle ?? ""]), ...statusChips(i).map((c) => c.title)].join("\n");
    expect(all).not.toMatch(/UTC|\d\d:\d\dZ\b|\d\dZ\b/);
    expect(detailRows(i).find((r) => r.key === "region")!.source).toBe("adsb_fi · 수집 02:43:23 KST");
  });
  it("상세 times carry the full KST instant on hover (year and ms) — the source column's title", () => {
    const rows = Object.fromEntries(detailRows(input()).map((r) => [r.key, r]));
    expect(rows.region.sourceTitle).toBe("수집 2026-09-30 02:43:23.000 KST");
    expect(rows.world.sourceTitle).toBe("수집 2026-09-30 02:43:01.000 KST");
    expect(rows.sigmet.sourceTitle).toBe("수집 2026-09-30 02:42:50.000 KST");
    expect(rows.radar.sourceTitle).toBe("수집 2026-09-30 02:42:53.000 KST");
    expect(rows.kma.sourceTitle).toBe("최신 tm 첫 수집 2026-09-30 02:35:32.000 KST");
    expect(rows["ais-gap"].sourceTitle).toBe("2026-09-30 02:21:50.000 KST – 2026-09-30 02:22:32.000 KST");
    // 모르면 title 없음(지어내지 않는다)
    expect(detailRows(input({ sigmetsFetchedAt: null })).find((r) => r.key === "sigmet")!.sourceTitle).toBeUndefined();
  });
});

describe("health thresholds are the existing ones (code and server), not new numbers", () => {
  const ages = (ageS: number): Partial<StatusInput> => ({ sigmetsFetchedAt: iso(-ageS * 1000), radar: { host: "h", generated: 0, past: [], fetched_at: iso(-ageS * 1000) }, status: {} });
  it("SIGMET > 900 s and radar > 600 s are copied from api StatusService (read here), region 60 s · world 300 s are the api's too", () => {
    const java = readFileSync(new URL("../../api/src/main/java/dev/wakeline/rest/StatusService.java", import.meta.url), "utf8");
    expect(java).toMatch(new RegExp(`lag\\(ss\\.fetchedAt\\(\\), now\\) > ${SIGMET_STALE_S}\\b`));
    expect(java).toMatch(new RegExp(`lag\\(rf\\.fetchedAt\\(\\), now\\) > ${RADAR_STALE_S}\\b`));
    expect(java).toMatch(new RegExp(`r\\.stale\\(now, ${REGION_STALE_S}\\)`));
    expect(java).toMatch(new RegExp(`g\\.stale\\(now, ${GLOBAL_STALE_S}\\)`));
  });
  it("SIGMET / radar chips turn bad just past their limits (browser-seen age or the server's stale flag), unknown without a time", () => {
    const at = (ageS: number) => Object.fromEntries(statusChips(input(ages(ageS))).map((c) => [c.key, c.health]));
    expect(at(RADAR_STALE_S)).toMatchObject({ sigmet: "ok", radar: "ok" });
    expect(at(RADAR_STALE_S + 1)).toMatchObject({ sigmet: "ok", radar: "bad" });
    expect(at(SIGMET_STALE_S + 1)).toMatchObject({ sigmet: "bad", radar: "bad" });
    const flagged = statusChips(input({ status: { sigmet: { stale: true }, radar: { stale: true } } }));
    expect(flagged.filter((c) => c.key === "sigmet" || c.key === "radar").map((c) => c.health)).toEqual(["bad", "bad"]);
    const none = statusChips(input({ sigmetsFetchedAt: null, radar: null, status: {} }));
    expect(none.filter((c) => c.key === "sigmet" || c.key === "radar").map((c) => [c.health, c.value])).toEqual([["unknown", "age —"], ["unknown", "age —"]]);
  });
  it("AIS warns past 120 s; KMA is STALE past 900 s; a partial KMA composite warns with the sentence", () => {
    const lagAis = statusChips(input({ ais: parseAisStatus({ sources: { ais: { connected: true, lag_s: AIS_LAG_WARN_S + 1, msgs_per_s: 1 } } }, NOW) })).find((c) => c.key === "ais")!;
    expect([lagAis.health, chipState(lagAis)]).toEqual(["warn", "지연"]);
    const stale = statusChips(input({ radarKr: kr({ meta: { fetched_at: iso(-(KR_RADAR_STALE_S + 1) * 1000), stale: false } }) })).find((c) => c.key === "kma")!;
    expect(stale.health).toBe("bad");
    expect(stale.words.map((w) => w.testId)).toEqual(["kr-radar-stale"]);
    const partial = statusChips(input({ radarKr: kr({}, { stations: 12, partial: true }) })).find((c) => c.key === "kma")!;
    expect(partial.health).toBe("warn");
    expect(partial.words[0]).toMatchObject({ text: "일부 합성", testId: "kr-status-partial" });
    expect(partial.words[0].title).toContain("일부 지점만 합성(12/17곳)");
  });
  it("a chip that is not ok is pinned (never moved out of the row); ok and unknown chips are not", () => {
    const chips = statusChips(input({ feeds: { region: { provider: "p", fetched_at: null, lag_s: 99, stale: true, received_at: NOW }, global: null } }));
    for (const c of chips) expect(c.pinned, c.key).toBe(c.health === "warn" || c.health === "bad");
  });
});

describe("AIS gap: a duration, not an identical start–end", () => {
  it("a 42 s gap that ended 21 minutes ago reads '42s · 02:22 KST 끝남' in the row (within the 30-minute window of contract v2 §B4)", () => {
    const chip = statusChips(input()).find((c) => c.key === "ais-gap")!;
    expect(chip.value).toBe("42s");
    expect(chipState(chip)).toBe("02:22 KST 끝남");
    expect(textOf(byTestId(bar(), "ais-gap-badge")!)).not.toMatch(/02:22\s*[–-]\s*02:22/);
    expect(AIS_GAP_SHOW_MS).toBe(30 * 60_000);
  });
  it("older than 30 minutes: no chip, but the details keep the last gap with its duration and KST span (seconds)", () => {
    const old = input({ ais: parseAisStatus({ sources: { ais: { connected: true, lag_s: 3, msgs_per_s: 1, last_gap: { started_at: iso(-40 * 60_000 - 42_000), ended_at: iso(-40 * 60_000), reason: "restart" } } } }, NOW) });
    expect(statusChips(old).some((c) => c.key === "ais-gap")).toBe(false);
    const row = detailRows(old).find((r) => r.key === "ais-gap")!;
    expect([row.state, row.value]).toEqual(["끝남", "42s"]);
    expect(row.source).toBe("09-30 02:02:50 – 09-30 02:03:32 KST · restart");
  });
  it("an open gap is a warning at the front of the row with its running duration; a partial gap names the zones", () => {
    const open = input({ ais: parseAisStatus({ sources: { ais: { connected: false, state: "backoff", lag_s: null, gap_open_since: iso(-252_000) } } }, NOW) });
    expect(openGapWarning(open)!.text).toBe("AIS 공백 진행 중 4m 12s");
    const root = bar(open);
    const row = byTestId(root, "statusbar-row")!;
    const ids = findAll(row, (n) => n.attrs["data-testid"] != null).map((n) => n.attrs["data-testid"]);
    expect(ids.indexOf("ais-gap-badge")).toBeLessThan(ids.indexOf("aircraft-count"));
    expect(ids.indexOf("conn")).toBe(0);
    const shards = input({ ais: parseAisStatus({ sources: { ais: { connected: true, lag_s: 3, msgs_per_s: 1, shards: [
      { coverage: [[18, 105, 46, 150]], state: "receiving", connected: true, gap_open_since: null },
      { coverage: [[-90, 45, 90, 180]], state: "backoff", connected: false, gap_open_since: iso(-60_000) },
    ] } } }, NOW) });
    expect(openGapWarning(shards)).toMatchObject({ text: "AIS 공백 1/2 구역 진행 중 1m 00s", partial: true });
    // 상세: 상태에 구역 수, 값에 길이(줄과 같은 길이 — 따로 짓지 않는다)
    const zoneRow = detailRows(shards).find((r) => r.key === "ais-gap")!;
    expect([zoneRow.health, zoneRow.state, zoneRow.value]).toEqual(["warn", "진행 중 · 1/2 구역", "1m 00s"]);
    const openRow = detailRows(open).find((r) => r.key === "ais-gap")!;
    expect([openRow.health, openRow.state, openRow.value]).toEqual(["bad", "진행 중", "4m 12s"]);
  });
  it("상세 marks an ended gap as 주의 only while it is still in the row's 30-minute window; an older one is neutral (review finding)", () => {
    const at = (endedAgoMs: number) => input({ ais: parseAisStatus({ sources: { ais: { connected: true, lag_s: 3, msgs_per_s: 1, last_gap: { started_at: iso(-endedAgoMs - 42_000), ended_at: iso(-endedAgoMs), reason: "restart" } } } }, NOW) });
    const recent = detailRows(at(AIS_GAP_SHOW_MS)).find((r) => r.key === "ais-gap")!;
    expect([recent.health, recent.state, recent.value]).toEqual(["warn", "끝남", "42s"]);
    const old = detailRows(at(AIS_GAP_SHOW_MS + 1000)).find((r) => r.key === "ais-gap")!;
    expect([old.health, old.state, old.value]).toEqual([null, "끝남", "42s"]);
  });
});

describe("connection chip", () => {
  it("'paused' is a hidden tab: the chip says so and the title explains that the server stops sending until the tab is visible again", () => {
    const c = connChip({ conn: "paused", reconnectAttempt: 0, lastRxAt: NOW, nowMs: NOW });
    expect(c.text).toBe("WS paused · 탭 숨김");
    expect(c.tone).toBe("warn");
    expect(c.title).toContain("탭이 숨겨져");
    expect(c.title).toContain("resume");
    // lib/ws 의 pause 는 visibilitychange(document.hidden)에서만 불린다 — 이 설명이 맞는지 코드로 확인
    const map = readFileSync(new URL("../components/MapView.tsx", import.meta.url), "utf8");
    expect(map).toMatch(/if \(document\.hidden\) \{ client\.pause\(\);/);
  });
  it("open but silent past 45 s says '수신 없음'; retries are counted", () => {
    expect(connChip({ conn: "open", reconnectAttempt: 0, lastRxAt: NOW - 46_000, nowMs: NOW }).text).toBe("WS open · 수신 없음");
    expect(connChip({ conn: "closed", reconnectAttempt: 3, lastRxAt: null, nowMs: NOW })).toMatchObject({ text: "WS closed · retry 3", tone: "bad" });
  });
});

describe("fitting the row: hide ok/unknown chips from the end, never a pinned one, never skip ahead", () => {
  const boxes = [
    { key: "aircraft", width: 80, pinned: false }, { key: "region", width: 90, pinned: true }, { key: "world", width: 90, pinned: false },
    { key: "ais", width: 80, pinned: false }, { key: "sigmet", width: 100, pinned: false }, { key: "radar", width: 20, pinned: false },
  ];
  it("everything fits → nothing hidden", () => expect([...fitChips(boxes, 1000, 200, 8)]).toEqual([]));
  it("too narrow → the first chip that does not fit and every later non-pinned chip move out (a small later chip is not squeezed in)", () => {
    // 폭 600 − 고정 200 − 늘 보일 region(98) = 302: aircraft 88 · world 98 · ais 88 = 274 → sigmet(108) 이 넘친다 → sigmet · radar
    expect([...fitChips(boxes, 600, 200, 8)]).toEqual(["sigmet", "radar"]);
  });
  it("no room at all → only pinned chips stay", () => expect([...fitChips(boxes, 250, 200, 8)]).toEqual(["aircraft", "world", "ais", "sigmet", "radar"]));
  it("the row wraps only when even the fixed items and the pinned chips do not fit (then nothing more can move out)", () => {
    expect(pinnedOverflow(boxes, 1000, 200, 8)).toBe(false);
    expect(pinnedOverflow(boxes, 298, 200, 8)).toBe(false); // 고정 200 + region 98 = 298 — 딱 맞다
    expect(pinnedOverflow(boxes, 297, 200, 8)).toBe(true);
  });
});

describe("details disclosure: a button with aria-expanded; opens and closes by mouse and keyboard (Escape, click outside)", () => {
  let root: Root | null = null;
  afterEach(async () => { if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); } vi.unstubAllGlobals(); });
  const find = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => {
    if (pred(from)) return from;
    for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
    return null;
  };
  const byId = (id: string) => find((e) => e.getAttribute?.("data-testid") === id);
  const propsOf = (e: MiniElement): Record<string, (...a: unknown[]) => unknown> => {
    const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
    return (e as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[k!];
  };
  async function mount(i: StatusInput = input()) {
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(createElement(StatusBarView, { input: i, inv: WS_INVALID_NONE })); });
    return (next: StatusInput) => React.act(async () => { root!.render(createElement(StatusBarView, { input: next, inv: WS_INVALID_NONE })); });
  }
  it("closed by default: the toggle names what it controls only when open; the table appears on click with every feed, KST times and the rules", async () => {
    await mount();
    const btn = byId("statusbar-details-toggle")!;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(byId("statusbar-details")).toBeNull();
    await React.act(async () => { propsOf(btn).onClick({}); });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const panel = byId("statusbar-details")!;
    expect(btn.getAttribute("aria-controls")).toBe(panel.getAttribute("id"));
    const rows: string[] = [];
    const walk = (e: MiniElement) => { const k = e.getAttribute?.("data-row"); if (k) rows.push(k); for (const c of e.childNodes) if (c instanceof MiniElement) walk(c); };
    walk(panel);
    expect(rows).toEqual(["conn", "aircraft", "region", "world", "ais", "ais-gap", "sigmet", "radar", "kma", "engine", "version", "fixture"]);
    const t = panel.textContent;
    for (const s of ["adsb_fi · 수집 02:43:23 KST", "opensky", "65.9 msg/s", "153 active", "13 frames", "157 polys · cycle 106 ms", "v284", "합성 17/17곳", "최신 tm 02:35 KST", "경고 > 60 s"]) expect(t, s).toContain(s);
    // 다시 누르면 닫힌다
    await React.act(async () => { propsOf(btn).onClick({}); });
    expect(byId("statusbar-details")).toBeNull();
  });
  it("Escape closes and returns focus to the toggle; a press outside closes; a press inside does not", async () => {
    await mount();
    const btn = byId("statusbar-details-toggle")!;
    await React.act(async () => { propsOf(btn).onClick({}); });
    const panel = byId("statusbar-details")!;
    await React.act(async () => { dom.document.dispatch("pointerdown", { type: "pointerdown", target: panel.childNodes[0] }); });
    expect(byId("statusbar-details")).not.toBeNull();
    await React.act(async () => { dom.document.dispatch("pointerdown", { type: "pointerdown", target: btn }); }); // 단추는 onClick 이 맡는다
    expect(byId("statusbar-details")).not.toBeNull();
    // 키보드: 초점이 상세 단추에 있을 때 Esc → 닫고 초점은 단추에
    btn.focus();
    await React.act(async () => { dom.document.dispatch("keydown", { type: "keydown", key: "Escape", target: btn }); });
    expect(byId("statusbar-details")).toBeNull();
    expect(dom.document.activeElement).toBe(btn);
    await React.act(async () => { propsOf(btn).onClick({}); });
    await React.act(async () => { dom.document.dispatch("pointerdown", { type: "pointerdown", target: dom.document.body }); });
    expect(byId("statusbar-details")).toBeNull();
    // 닫힌 뒤에는 문서에 남은 처리기가 없다
    expect(dom.document.listenerCount("keydown")).toBe(0);
    expect(dom.document.listenerCount("pointerdown")).toBe(0);
    expect(dom.document.listenerCount("focusin")).toBe(0);
  });
  it("Escape belongs to the focused control: 상세 closes on Escape only from inside it (or with no focus); focus moving elsewhere closes it without taking focus back (review finding)", async () => {
    await mount();
    const isOpen = () => byId("statusbar-details") != null;
    const btn = byId("statusbar-details-toggle")!;
    const search = dom.document.createElement("input");
    dom.document.body.appendChild(search);
    try {
      // 하네스 재현: 키보드로 연 뒤 '/' 로 검색에 초점 → 상세는 닫히고 초점은 검색에 남는다(전에는 열린 채였다가 검색의 Esc 가 상세도 닫고 초점을 빼앗았다)
      btn.focus();
      await React.act(async () => { propsOf(btn).onClick({}); });
      expect(isOpen(), "상세 열림").toBe(true);
      search.focus();
      await React.act(async () => { dom.document.dispatch("focusin", { type: "focusin", target: search }); });
      expect(isOpen(), "상세 열림").toBe(false);
      expect(dom.document.activeElement === search, "초점 = 검색").toBe(true);
      // 초점이 이미 다른 입력에 있을 때 연 경우: 그 입력의 Esc 는 그 입력의 것 — 상세는 열린 채, 초점은 그대로
      await React.act(async () => { propsOf(btn).onClick({}); });
      await React.act(async () => { dom.document.dispatch("keydown", { type: "keydown", key: "Escape", target: search }); });
      expect(isOpen(), "상세 열림").toBe(true);
      expect(dom.document.activeElement === search, "초점 = 검색").toBe(true);
      // 다른 처리기가 이미 쓴 Esc(defaultPrevented)도 건드리지 않는다
      await React.act(async () => { dom.document.dispatch("keydown", { type: "keydown", key: "Escape", target: dom.document.body, defaultPrevented: true }); });
      expect(isOpen(), "상세 열림").toBe(true);
      // 상세 안(닫기 단추)에서의 Esc → 닫고 초점은 상세 단추로
      const panel = byId("statusbar-details")!;
      const close = (function first(e: MiniElement): MiniElement | null {
        if (e.tagName === "BUTTON") return e;
        for (const c of e.childNodes) { const f = c instanceof MiniElement ? first(c) : null; if (f) return f; }
        return null;
      })(panel)!;
      close.focus();
      await React.act(async () => { dom.document.dispatch("focusin", { type: "focusin", target: close }); });
      expect(isOpen(), "상세 열림").toBe(true); // 안으로 옮긴 초점은 닫지 않는다
      await React.act(async () => { dom.document.dispatch("keydown", { type: "keydown", key: "Escape", target: close }); });
      expect(isOpen(), "상세 열림").toBe(false);
      expect(dom.document.activeElement === btn, "초점 = 상세 단추").toBe(true);
      // 상세 안의 글자(초점을 받지 않는 칸)를 누르면 브라우저는 초점을 초점 받을 수 있는 조상(<main tabindex=-1> 등)으로 옮긴다 — 밖으로 나간 것이 아니다
      // (하네스 e2e 에서 발견: th 를 누르자 focusin 대상이 MAIN 이라 상세가 닫혔다). 그 상태의 Esc 는 '초점 없음'처럼 닫는다
      await React.act(async () => { propsOf(btn).onClick({}); });
      const ancestor = dom.container; // 상세를 품은 요소
      ancestor.focus();
      await React.act(async () => { dom.document.dispatch("focusin", { type: "focusin", target: ancestor }); });
      expect(isOpen(), "조상으로 옮긴 초점").toBe(true);
      await React.act(async () => { dom.document.dispatch("keydown", { type: "keydown", key: "Escape", target: ancestor }); });
      expect(isOpen(), "조상에서의 Esc").toBe(false);
      expect(dom.document.activeElement === btn, "초점 = 상세 단추").toBe(true);
      // 초점이 아무 데도 없을 때(마우스로 연 뒤 — 문서 본문)의 Esc 도 닫는다
      await React.act(async () => { propsOf(btn).onClick({}); });
      await React.act(async () => { dom.document.dispatch("keydown", { type: "keydown", key: "Escape", target: dom.document.body }); });
      expect(isOpen(), "상세 열림").toBe(false);
      expect(dom.document.listenerCount("focusin")).toBe(0);
    } finally {
      dom.document.body.removeChild(search);
    }
  });
  it("overflow: measured by a ResizeObserver (not per clock tick) — hidden chips stay measurable, are aria-hidden and counted as '+N'", async () => {
    const observers: { cb: () => void; targets: unknown[] }[] = [];
    vi.stubGlobal("ResizeObserver", class { targets: unknown[] = []; constructor(public cb: () => void) { observers.push(this); } observe(t: unknown) { this.targets.push(t); } unobserve() {} disconnect() { this.targets = []; } });
    let reads = 0;
    const W: Record<string, number> = { conn: 70, "statusbar-details-toggle": 80, aircraft: 80, region: 90, world: 90, ais: 80, "ais-gap": 120, sigmet: 100, radar: 100, kma: 100 };
    const size = (e: MiniElement) => W[e.getAttribute("data-chip") ?? e.getAttribute("data-testid") ?? ""] ?? 0;
    const proto = MiniElement.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, "offsetWidth", { configurable: true, get(this: MiniElement) { reads++; return size(this); } });
    Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: MiniElement) { reads++; return this.getAttribute("data-testid") === "statusbar-row" ? 700 : 0; } });
    vi.stubGlobal("getComputedStyle", () => ({ columnGap: "8px", paddingLeft: "12px", paddingRight: "12px" }));
    try {
      const rerender = await mount();
      expect(observers).toHaveLength(1);
      const row = byId("statusbar-row")!;
      const probe = byId("statusbar-width")!;
      // 줄 자체는 보지 않는다(브라우저 오류 'ResizeObserver loop completed with undelivered notifications.' — 사용자 로그 2026-09-30): 줄의 높이는
      // 칩을 옮기면 바뀐다(두 줄 → 한 줄) — 콜백 안에서 관찰 중인 상자의 크기를 바꾸면 브라우저가 그 알림을 그 프레임에 전하지 못한다.
      // 폭은 줄 폭 그대로이고 높이가 0 인 탐침(absolute · inset-x-0 · h-0)을 본다 — 내용이 바꿀 수 없는 상자
      expect(observers[0].targets.includes(row)).toBe(false);
      expect(observers[0].targets.includes(probe)).toBe(true);
      expect(probe.getAttribute("aria-hidden")).toBe("true");
      for (const c of ["absolute", "inset-x-0", "top-0", "h-0"]) expect(probe.getAttribute("class")!.split(/\s+/)).toContain(c);
      expect(observers[0].targets.length).toBeGreaterThan(8); // 폭 탐침 + 칩 + 고정 항목
      await React.act(async () => { observers[0].cb(); });
      // 700 − 24 − 고정(연결 78 + 상세 88) − 늘 보일 칩(끝난 AIS 공백 128) = 382: aircraft 88 · region 98 · world 98 · ais 88 = 372 → sigmet · radar · kma 를 뺀다
      const over = ["sigmet-chip", "radar-chip", "kr-status"].map(byId);
      for (const e of over) {
        expect(e!.getAttribute("data-overflow")).toBe("true");
        expect(e!.getAttribute("aria-hidden")).toBe("true");
      }
      expect(byId("lag-badge")!.getAttribute("data-overflow")).toBeNull();
      expect(byId("statusbar-details-toggle")!.textContent).toContain("+3");
      expect(byId("statusbar-details-toggle")!.getAttribute("title")).toContain("sigmet · radar · KMA");
      // 1 s 시계 틱(새 입력)으로 다시 그려도 폭을 다시 재지 않는다 — ResizeObserver 가 알릴 때만
      const before = reads;
      await rerender(input({ nowMs: NOW + 1000, srvNowMs: NOW + 1000 }));
      await rerender(input({ nowMs: NOW + 2000, srvNowMs: NOW + 2000 }));
      expect(reads).toBe(before);
    } finally {
      delete proto.offsetWidth;
      delete proto.clientWidth;
    }
  });
  it("the 상세 button keeps one box whatever '+N' says — the count cannot grow its line box (it is observed; the count comes from the measurement)", () => {
    // 하네스(Playwright, 수정 전): '상세 ▾' 84 × 21.75 → '상세 +1 ▾' 84 × 22.75 — 고정폭 글꼴의 줄 상자가 단추를 1 px 키웠고 줄도 1 px 커졌다
    const btn = byTestId(bar(), "statusbar-details-toggle")!;
    expect(btn.attrs.class).toMatch(/(^|\s)h-\[22px\](\s|$)/);
    expect(btn.attrs.class).toMatch(/(^|\s)min-w-\[84px\](\s|$)/);
    const src = readFileSync(new URL("../components/StatusBar.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/<span className="mono leading-none text-warn"> \+\{hidden\.length\}<\/span>/);
  });
  it("a second change inside one frame waits for the next frame — the bar never flips between two layouts within a frame", async () => {
    const observers: { cb: () => void; targets: unknown[] }[] = [];
    vi.stubGlobal("ResizeObserver", class { targets: unknown[] = []; constructor(public cb: () => void) { observers.push(this); } observe(t: unknown) { this.targets.push(t); } unobserve() {} disconnect() { this.targets = []; } });
    let rowW = 2000;
    const W: Record<string, number> = { conn: 70, "statusbar-details-toggle": 80, aircraft: 80, region: 90, world: 90, ais: 80, "ais-gap": 120, sigmet: 100, radar: 100, kma: 100 };
    const size = (e: MiniElement) => W[e.getAttribute("data-chip") ?? e.getAttribute("data-testid") ?? ""] ?? 0;
    const proto = MiniElement.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, "offsetWidth", { configurable: true, get(this: MiniElement) { return size(this); } });
    Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: MiniElement) { return this.getAttribute("data-testid") === "statusbar-row" ? rowW : 0; } });
    vi.stubGlobal("getComputedStyle", () => ({ columnGap: "8px", paddingLeft: "12px", paddingRight: "12px" }));
    const moved = () => ["lag-badge", "global-lag-badge", "ais-badge", "sigmet-chip", "radar-chip", "kr-status"].filter((id) => byId(id)?.getAttribute("data-overflow") === "true");
    const g = globalThis as Record<string, unknown>;
    const outsideAct = (fn: () => void) => { const prev = g.IS_REACT_ACT_ENVIRONMENT; g.IS_REACT_ACT_ENVIRONMENT = false; try { fn(); } finally { g.IS_REACT_ACT_ENVIRONMENT = prev; } };
    try {
      await mount();
      expect(moved()).toEqual([]);
      const ro = observers[observers.length - 1];
      rowW = 700;
      outsideAct(() => ro.cb()); // 이 프레임의 첫 변화 — 그 자리에서(그리기 전)
      expect(moved()).toEqual(["sigmet-chip", "radar-chip", "kr-status"]);
      rowW = 2000;
      outsideAct(() => ro.cb()); // 같은 프레임의 두 번째 변화 — 다음 프레임에(그 사이 되돌아가도 한 프레임 안에서 오가지 않는다)
      expect(moved()).toEqual(["sigmet-chip", "radar-chip", "kr-status"]);
      await React.act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(moved()).toEqual([]);
      rowW = 700;
      outsideAct(() => ro.cb()); // 다음 프레임 — 다시 그 자리에서
      expect(moved()).toEqual(["sigmet-chip", "radar-chip", "kr-status"]);
    } finally {
      delete proto.offsetWidth;
      delete proto.clientWidth;
    }
  });
  it("before the first measurement (server HTML, before hydration) the row is one clipped line — it never paints two or three lines and then shrinks (harness at 390 px: 75 → 30 px)", async () => {
    const row = byTestId(bar(), "statusbar-row")!;
    const cls = row.attrs.class ?? "";
    expect(cls).toContain("flex-nowrap");
    expect(cls).toContain("overflow-hidden");
    expect(cls).not.toMatch(/(^|\s)flex-wrap(\s|$)/);
    expect(row.attrs["data-measured"]).toBeUndefined();
    // 고정 항목(연결)도 줄어들거나 안에서 줄바꿈하지 않는다(재는 동안 폭이 달라지지 않게)
    expect(byTestId(bar(), "conn")!.attrs.class).toMatch(/shrink-0/);
    // 레이아웃이 없으면(폭 0 — 숨김 · 배치 전) 재지 않고 아무것도 옮기지 않는다(한 줄로 둔 채 ResizeObserver 를 기다린다)
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    await mount();
    expect(byId("statusbar-row")!.getAttribute("data-measured")).toBeNull();
    expect(byId("statusbar-details-toggle")!.textContent).not.toContain("+");
  });
  it("no two-line flash: a new chip set is measured before paint (layout effect), and a size change is applied synchronously from the ResizeObserver callback (review finding)", async () => {
    // 하네스(검토): 자료가 칩을 더할 때마다 줄이 먼저 두 줄(52 px)로 그려지고 약 260 ms 뒤에 칩이 상세로 옮겨졌다 — 측정이 그린 뒤의 useEffect ·
    // ResizeObserver 콜백의 setState(다음 작업)에서만 돌았다. 여기서는 ResizeObserver 가 알리기 전에도 이미 옮겨져 있어야 한다.
    const observers: { cb: () => void; targets: unknown[] }[] = [];
    vi.stubGlobal("ResizeObserver", class { targets: unknown[] = []; constructor(public cb: () => void) { observers.push(this); } observe(t: unknown) { this.targets.push(t); } unobserve() {} disconnect() { this.targets = []; } });
    let rowW = 700;
    const W: Record<string, number> = { conn: 70, "statusbar-details-toggle": 80, aircraft: 80, region: 90, world: 90, ais: 80, "ais-gap": 120, sigmet: 100, radar: 100, kma: 100 };
    const size = (e: MiniElement) => W[e.getAttribute("data-chip") ?? e.getAttribute("data-testid") ?? ""] ?? 0;
    const proto = MiniElement.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, "offsetWidth", { configurable: true, get(this: MiniElement) { return size(this); } });
    Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: MiniElement) { return this.getAttribute("data-testid") === "statusbar-row" ? rowW : 0; } });
    vi.stubGlobal("getComputedStyle", () => ({ columnGap: "8px", paddingLeft: "12px", paddingRight: "12px" }));
    const moved = () => ["lag-badge", "global-lag-badge", "ais-badge", "sigmet-chip", "radar-chip", "kr-status"].filter((id) => byId(id)?.getAttribute("data-overflow") === "true");
    try {
      // 기상청 칩이 없는 자료로 시작 → 첫 커밋에서 이미 잰다(ResizeObserver 콜백 없이). 옮길 칩을 옮기면 한 줄에 들어가므로 한 줄로 둔다(nowrap) —
      // 창이 좁아지는 순간(옮기기 전) 줄이 두 줄로 넘어가 상태 바 높이가 바뀌면 아래 지도의 ResizeObserver(MapLibre)가 그 프레임에 크기 변화를 받고, 곧이어
      // 옮기기가 한 줄로 되돌려 지도 크기가 또 바뀐다 — 그 알림을 브라우저가 전하지 못한다('ResizeObserver loop' — 사용자 로그 2026-09-30, 하네스 632 px)
      const rerender = await mount(input({ radarKr: null }));
      expect(moved()).toEqual(["sigmet-chip", "radar-chip"]);
      const rowEl = byId("statusbar-row")!;
      expect(rowEl.getAttribute("data-measured")).toBe("true");
      expect(rowEl.getAttribute("class")).toContain("flex-nowrap");
      expect(rowEl.getAttribute("class")).toContain("overflow-hidden");
      // 새 칩(기상청)이 생기는 자료 — 같은 커밋 안에서 다시 잰다
      await rerender(input());
      expect(moved()).toEqual(["sigmet-chip", "radar-chip", "kr-status"]);
      expect(byId("statusbar-details-toggle")!.textContent).toContain("+3");
      // 창이 넓어짐(크기 변화) → ResizeObserver 콜백 안에서 바로 반영(act 밖 — 다음 작업을 기다리지 않는다)
      rowW = 2000;
      const g = globalThis as Record<string, unknown>;
      const prevAct = g.IS_REACT_ACT_ENVIRONMENT;
      g.IS_REACT_ACT_ENVIRONMENT = false;
      try { observers[observers.length - 1].cb(); } finally { g.IS_REACT_ACT_ENVIRONMENT = prevAct; }
      expect(moved()).toEqual([]);
      // 고정 항목 · 경고 칩만으로도 넘치면(좁은 화면의 경고들) 그때만 줄바꿈 — 잘리지 않는다. 줄 높이가 바뀌는 일이라 다음 프레임에(그 자리가 아니라)
      await React.act(async () => { await new Promise((r) => setTimeout(r, 50)); }); // 다음 프레임(그 자리 반영은 한 프레임에 한 번)
      rowW = 150;
      g.IS_REACT_ACT_ENVIRONMENT = false;
      try { observers[observers.length - 1].cb(); } finally { g.IS_REACT_ACT_ENVIRONMENT = prevAct; }
      expect(moved().length).toBeGreaterThan(0); // 칩 옮기기는 그 자리에서
      await React.act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(rowEl.getAttribute("class")).toContain("flex-wrap");
      expect(rowEl.getAttribute("class")).not.toContain("overflow-hidden");
      rowW = 2000;
      g.IS_REACT_ACT_ENVIRONMENT = false;
      try { observers[observers.length - 1].cb(); } finally { g.IS_REACT_ACT_ENVIRONMENT = prevAct; }
      await React.act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(rowEl.getAttribute("class")).toContain("flex-nowrap");
    } finally {
      delete proto.offsetWidth;
      delete proto.clientWidth;
    }
  });
});

describe("performance: the bar subscribes to the fields it shows, not the whole store", () => {
  it("no whole-store selector", () => {
    const src = readFileSync(new URL("../components/StatusBar.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/useServerData\(\(x\) => x\)/);
    expect(src).toMatch(/new ResizeObserver\(/);
  });
});
