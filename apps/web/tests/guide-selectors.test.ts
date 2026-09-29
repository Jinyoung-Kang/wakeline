/**
 * 캡처 계획(lib/guide-shots.json)의 번호가 가리키는 요소가 화면 코드에 실제로 있는지 — 브라우저 없이 소스로 확인한다.
 * 화면이 data-testid · aria-label 을 바꾸면 여기서 먼저 깨진다(캡처 때 번호가 조용히 "보이지 않음"이 되기 전에).
 * 목차의 현재 절 계산(activeSection)도 여기서.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN } from "@/lib/guide";
import { activeSection } from "@/components/guide/GuideToc";
import { ERROR_MARKS } from "../scripts/guide-capture-lib.mjs";

const WEB = new URL("..", import.meta.url).pathname;
const walk = (d: string): string[] => readdirSync(join(WEB, d)).flatMap((n) => {
  const rel = join(d, n);
  return statSync(join(WEB, rel)).isDirectory() ? (n === "guide" ? [] : walk(rel)) : /\.tsx?$/.test(n) ? [rel] : [];
});
const SRC = ["app", "components"].flatMap(walk).map((f) => readFileSync(join(WEB, f), "utf8")).join("\n");

/** 소스에 그 data-testid 가 있는가 — 글자 그대로, 컴포넌트 prop(testId="…"), 조건부 값, 또는 `${앞}-${…}` 로 만들고 뒷부분이 소스의 글자로 있을 때 */
function hasTestId(id: string): boolean {
  if (SRC.includes(`data-testid="${id}"`) || SRC.includes(`testId="${id}"`)) return true;
  if (new RegExp(`data-testid=\\{[^}\\n]*\\? "${id}"`).test(SRC)) return true; // 조건부: data-testid={조건 ? "id" : undefined}
  const cut = id.lastIndexOf("-");
  if (cut > 0) {
    const pre = id.slice(0, cut), suf = id.slice(cut + 1);
    if (SRC.includes(`data-testid={\`${pre}-\${`) && SRC.includes(`"${suf}"`)) return true; // 예: tab-${p} · p ∈ ["alerts", …]
    if (SRC.includes(`testId="${pre}"`) && SRC.includes(`\${testId}-${suf}`)) return true; // 예: ShipTable testId="ship-list" → ship-list-item
  }
  return false;
}

describe("capture plan selectors exist in the screens", () => {
  const targets = PLAN.shots.flatMap((s) => s.callouts.map((c) => ({ where: `${s.id}#${c.n}`, target: c.target })));
  it("every data-testid a callout points at is rendered by some screen", () => {
    const missing = targets.flatMap(({ where, target }) => [...target.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]).filter((id) => !hasTestId(id)).map((id) => `${where}: ${id}`));
    expect(missing).toEqual([]);
  });
  it("every aria-label a callout points at is rendered by some screen", () => {
    const missing = targets.flatMap(({ where, target }) => [...target.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]).filter((l) => !SRC.includes(`aria-label="${l}"`)).map((l) => `${where}: ${l}`));
    expect(missing).toEqual([]);
  });
  it("the error marks the capture script refuses to publish are rendered by some screen", () => {
    expect(ERROR_MARKS.filter((id) => !hasTestId(id))).toEqual([]);
  });
  it("MapLibre class targets exist in the bundled MapLibre", () => {
    const ml = readFileSync(join(WEB, "node_modules/maplibre-gl/dist/maplibre-gl.css"), "utf8");
    for (const { target } of targets) for (const m of target.matchAll(/\.(maplibregl-[a-z-]+)/g)) expect(ml).toContain(`.${m[1]}`);
  });
  it("every target is a selector the capture script can pass to querySelector (no empty parts)", () => {
    for (const { target } of targets) expect(target).toMatch(/^[a-z.[][^\n]*[\]a-z0-9)-]$/i);
  });
});

describe("table of contents: current section", () => {
  const order = ["overview", "dashboard", "dashboard-layout", "dashboard-map", "replay"];
  it("the last visible section in document order wins (the innermost), and nothing visible keeps the previous", () => {
    expect(activeSection(order, new Set(["dashboard", "dashboard-map"]), null)).toBe("dashboard-map");
    expect(activeSection(order, new Set(["dashboard"]), "overview")).toBe("dashboard");
    expect(activeSection(order, new Set(), "replay")).toBe("replay");
    expect(activeSection(order, new Set(["overview", "replay"]), null)).toBe("replay");
  });
});
