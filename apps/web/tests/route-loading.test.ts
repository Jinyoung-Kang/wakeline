/**
 * 노선 "조회 중" 표시의 모양(사용자 요청 2026-09-30 "노선 조회 중 UI 가 부자연스러워, 짧은 직선이 도는 것처럼 보여 — 자연스러운 로딩 UI 로").
 * 원인: 9×9 사각형(모서리 없음 규칙)의 윗변만 파랗게 칠해 돌렸다(.busy-spinner) — 작게 보면 짧은 선 하나가 도는 모양이다.
 * 바꾼 모양:
 * - 노선 상태 줄 아래 가는 진행 막대(.busy-bar — 값이 없는 indeterminate: 짧은 조각이 흐를 뿐 몇 % 인지 말하지 않는다)
 * - 찾은 뒤의 모양을 닮은 자리 표시(출발 · 도착마다 코드 줄 + 이름 줄 — AirportLine)
 * - 글자 "노선 조회 중" · 경과 초 · 느림 알림(ROUTE_SLOW_AFTER_S)은 그대로
 * - 나타남 지연(.busy-appear, BUSY_APPEAR_DELAY_MS = 선택값): 그보다 빨리 끝나는 조회는 진행 표시가 번쩍이지 않는다. 글자는 처음부터 DOM 에 있어
 *   화면 읽기 프로그램에는 바로 읽힌다(live 영역을 다시 만들지 않는다 — route-pending.test.ts).
 * - 움직임 줄이기 설정: 막대 조각 · 자리 표시 밝기 변화를 멈춘다. 나타남 지연은 움직임이 아니라 그대로.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RouteSection } from "@/components/AircraftCard";
import { BUSY_APPEAR_DELAY_MS } from "@/lib/busy";
import { parseRoute, ROUTE_SLOW_AFTER_S, ROUTE_SLOW_TEXT, ROUTE_STATUS_TEXT, type RouteInfo } from "@/lib/route";
import { ancestors, byTestId, classes, findAll, parseHtml, textOf } from "./helpers/html-tree";

const PENDING = parseRoute({ status: "pending", callsign: "KAL081", source: "adsbdb" })!;
const render = (route: RouteInfo | null, pendingForS: number | null = null) =>
  parseHtml(renderToStaticMarkup(createElement(RouteSection, { route, pos: null, callsign: "KAL081", pendingForS })));
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
/** 선택자 하나의 선언 블록(첫 번째) */
const rule = (sel: string) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
const reducedBlocks = () => [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{((?:[^{}]*\{[^}]*\})*)[^}]*\}/g)].map((m) => m[1]);

describe("pending route: a thin indeterminate bar and placeholders shaped like the result — no rotating square", () => {
  it("no rotating square anywhere (the old .busy-spinner is gone from the card and from the stylesheet)", () => {
    const root = render(PENDING, 3);
    expect(findAll(root, (n) => classes(n).has("busy-spinner"))).toEqual([]);
    expect(css).not.toMatch(/\.busy-spinner/);
    expect(css).not.toMatch(/rotate\(/);
  });
  it("a thin progress bar sits under the status line, hidden from screen readers, and does not claim a percentage", () => {
    const root = render(PENDING, 3);
    const loading = byTestId(root, "route-loading")!;
    const bar = byTestId(loading, "route-progress")!;
    expect(classes(bar).has("busy-bar")).toBe(true);
    expect(bar.attrs["aria-hidden"]).toBe("true");
    expect(bar.attrs.role).toBeUndefined(); // progressbar 역할 · aria-valuenow 없음 — 글자(role=status)가 상태를 말한다
    expect(bar.attrs["aria-valuenow"]).toBeUndefined();
    // 줄 모양: 2 px 높이 · 조각은 흐른다(translateX) — 회전이 아니다
    expect(rule(".busy-bar")).toMatch(/height:\s*2px/);
    expect(rule(".busy-bar::after")).toMatch(/animation:\s*busy-slide/);
    expect(css).toMatch(/@keyframes busy-slide\s*\{[^}]*translateX/);
    // 상태 줄(role=status) 뒤, 자리 표시 앞
    const section = byTestId(root, "route-section")!;
    const order = findAll(section, (n) => ["route-status", "route-progress", "route-skeleton"].includes(n.attrs["data-testid"])).map((n) => n.attrs["data-testid"]);
    expect(order).toEqual(["route-status", "route-progress", "route-skeleton"]);
  });
  it("placeholders mirror the found rows: 출발 · 도착 each with a short code line and a longer place line, right-aligned like AirportLine", () => {
    const sk = byTestId(render(PENDING, 3), "route-skeleton")!;
    const rows = findAll(sk, (n) => n.attrs["data-field"] != null);
    expect(rows.map((r) => r.attrs["data-field"])).toEqual(["출발", "도착"]);
    for (const r of rows) {
      const blocks = findAll(r, (n) => classes(n).has("skeleton"));
      expect(blocks).toHaveLength(2);
      const col = blocks[0].parent!;
      expect(classes(col).has("items-end")).toBe(true); // AirportLine 과 같은 오른쪽 정렬 두 줄
      const w = (n: (typeof blocks)[number]) => [...classes(n)].find((c) => /^w-/.test(c));
      expect(w(blocks[0])).not.toBe(w(blocks[1])); // 코드 줄(짧게) · 이름 줄(길게)
    }
  });
  it(`the whole pending presentation (text, bar, placeholders) appears only after ${BUSY_APPEAR_DELAY_MS} ms — a chosen value, the same in CSS and code`, () => {
    const root = render(PENDING, 3);
    const st = byTestId(root, "route-status")!;
    // 상태 줄의 보이는 줄(글자 · 경과)과 진행 표시 묶음이 나타남 지연을 갖는다 — live 영역 자체는 DOM 에 그대로(글자는 바로 읽힌다)
    expect(ancestors(st).some((a) => classes(a).has("busy-appear"))).toBe(true);
    expect(classes(byTestId(root, "route-loading")!).has("busy-appear")).toBe(true);
    expect(textOf(st)).toContain(ROUTE_STATUS_TEXT.pending);
    expect(rule(":root")).toMatch(new RegExp(`--busy-appear-delay:\\s*${BUSY_APPEAR_DELAY_MS}ms`));
    expect(rule(".busy-appear")).toMatch(/animation:\s*busy-appear\b[^;]*var\(--busy-appear-delay\)[^;]*\bboth\b/);
    expect(BUSY_APPEAR_DELAY_MS).toBeGreaterThanOrEqual(150);
    expect(BUSY_APPEAR_DELAY_MS).toBeLessThanOrEqual(200);
    // 다른 상태(찾음 · 없음 · 실패 …)는 지연 없이 바로
    for (const status of ["not_found", "unavailable", "disabled"] as const) {
      const r = render(parseRoute({ status, callsign: "KAL081", source: "adsbdb" }), 1);
      expect(findAll(r, (n) => classes(n).has("busy-appear")), status).toEqual([]);
    }
  });
  it("the elapsed seconds and the slow notice are kept", () => {
    const root = render(PENDING, ROUTE_SLOW_AFTER_S + 2);
    expect(textOf(byTestId(root, "route-elapsed")!)).toBe(`${ROUTE_SLOW_AFTER_S + 2} s`);
    expect(textOf(byTestId(root, "route-status")!)).toContain(ROUTE_SLOW_TEXT);
  });
  it("prefers-reduced-motion: the bar segment and the placeholder pulse stop; the appear delay stays (it is not motion)", () => {
    const blocks = reducedBlocks();
    const b = blocks.find((x) => /\.busy-bar/.test(x)) ?? "";
    expect(b).toMatch(/\.busy-bar::after[^{]*\{[^}]*animation:\s*none/);
    expect(b).toMatch(/\.skeleton[^{]*\{[^}]*animation:\s*none/);
    expect(blocks.join("\n")).not.toMatch(/\.busy-appear/);
  });
});
