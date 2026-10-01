/**
 * 캡처 계획(lib/guide-shots.json)의 번호가 가리키는 요소가 화면 코드에 실제로 있는지 — 브라우저 없이 소스로 확인한다.
 * 화면이 data-testid · aria-label 을 바꾸면 여기서 먼저 깨진다(캡처 때 번호가 조용히 "보이지 않음"이 되기 전에).
 * 목차의 현재 절 계산(activeSection)도 여기서.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN } from "@/lib/guide";
import { currentSection } from "@/components/guide/GuideToc";
import { ERROR_MARKS } from "../scripts/guide-capture-lib.mjs";

const WEB = new URL("..", import.meta.url).pathname;
const walk = (d: string): string[] => readdirSync(join(WEB, d)).flatMap((n) => {
  const rel = join(d, n);
  return statSync(join(WEB, rel)).isDirectory() ? (n === "guide" ? [] : walk(rel)) : /\.tsx?$/.test(n) ? [rel] : [];
});
const SRC = ["app", "components"].flatMap(walk).map((f) => readFileSync(join(WEB, f), "utf8")).join("\n");
/** 상태 바 칩의 testid 는 lib/statusbar 가 정하고(testId: "…") StatusBar 의 ChipView 가 data-testid={chip.testId} 로 그린다 */
const STATUS_CHIPS = readFileSync(join(WEB, "lib", "statusbar.ts"), "utf8");

/** 소스에 그 data-testid 가 있는가 — 글자 그대로, 컴포넌트 prop(testId="…"), 조건부 값, 상태 바 칩(lib/statusbar testId: "…"), 또는 `${앞}-${…}` 로 만들고 뒷부분이 소스의 글자로 있을 때 */
function hasTestId(id: string): boolean {
  if (SRC.includes(`data-testid="${id}"`) || SRC.includes(`testId="${id}"`)) return true;
  if (SRC.includes("data-testid={chip.testId}") && STATUS_CHIPS.includes(`testId: "${id}"`)) return true;
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
  it("every masked column header and table the capture script hides is rendered by the screen (a renamed header would otherwise leave nothing hidden — the script then skips the shot)", () => {
    const masks = PLAN.shots.flatMap((s) => (s.masks ?? []).filter((m) => m.table).map((m) => ({ where: `${s.id}: ${m.label}`, table: m.table!, header: m.header! })));
    expect(masks.length).toBeGreaterThan(0);
    const missing = masks.flatMap(({ where, table, header }) => [
      ...[...table.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]).filter((id) => !hasTestId(id)).map((id) => `${where}: table ${id}`),
      ...(new RegExp(`<th\\b[^>]*>${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</th>`).test(SRC) ? [] : [`${where}: header ${header}`]),
    ]);
    expect(missing).toEqual([]);
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
  // tops = 각 절 위쪽 가장자리(스크롤 영역 위 기준 px, 문서 순서 — 부모 절은 자식보다 먼저 시작), band = 관찰 띠 아래 끝(px)
  const order = ["overview", "dashboard", "dashboard-layout", "dashboard-map", "replay"];
  const at = (tops: (number | null)[], scrollTop = 500, pinned: string | null = null) => currentSection(order, tops, { scrollTop, band: 180, pinned });
  it("the last section in document order that starts above the band's lower edge — the innermost one", () => {
    expect(at([-2000, -300, -250, 40, 900])).toBe("dashboard-map");
    expect(at([-2000, -300, -250, 181, 900])).toBe("dashboard-layout");
    expect(at([-2000, -1500, -1200, -900, 100])).toBe("replay");
  });
  it("between sections (nothing inside the band) it is the section above, not a stale earlier value", () => {
    // 2.2 가 끝난 뒤 3 이 아직 띠 아래 — 바로 앞 절(2.2)
    expect(at([-3000, -2400, -2300, -900, 400])).toBe("dashboard-map");
  });
  it("at the top of the page it is the first section, whatever was current before", () => {
    expect(at([231, 900, 950, 1400, 2400], 0)).toBe("overview");
    expect(at([228, 897, 947, 1397, 2397], 3)).toBe("overview");
  });
  it("a section picked in the contents stays current until the reader scrolls (a short section does not hand over to the next one)", () => {
    expect(at([-2000, -300, 16, 60, 900], 700, "dashboard-layout")).toBe("dashboard-layout");
    expect(at([-2000, -300, 16, 60, 900], 700, null)).toBe("dashboard-map");
    expect(at([-2000, -300, 16, 60, 900], 700, "nowhere")).toBe("dashboard-map"); // 모르는 id 는 무시
  });
  it("missing sections are skipped; nothing measurable is null", () => {
    expect(at([-2000, null, null, 40, 900])).toBe("dashboard-map");
    expect(currentSection([], [], { scrollTop: 0, band: 180, pinned: null })).toBeNull();
  });
});
