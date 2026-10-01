/**
 * QA-306 — 글자 대비 4.5:1 미만 두 곳(WCAG 1.4.3, axe color-contrast):
 * 1) 지도 범례의 고도 m 보조 표기(9 px): fg-3 의 80 % 불투명(#727982 상당) / 범례 바탕 #111418 = 4.19:1 → m 은 fg-3 그대로(5.87:1), 위계는 ft 를 fg-2 로 밝혀 둔다.
 * 2) 로그 목록에서 고른 줄(#1c2a3f)의 ERROR 배지(--color-bad #ef5d62) = 4.41:1 → 고른 줄 안의 bad 배지만 같은 빨강을 조금 밝게(#f06a6e).
 * 팔레트(globals.css @theme)는 그대로다.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/basemap";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const token = (name: string) => new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`).exec(css)![1];

describe("QA-306 contrast", () => {
  it("legend: metre labels use fg-3 at full strength on the legend panel (bg-1) — no faded text classes left", () => {
    const legend = readFileSync(new URL("../components/MapLegend.tsx", import.meta.url), "utf8");
    expect(legend).not.toMatch(/text-fg-[23]\/\d+/);
    expect(legend).toMatch(/<span className="text-fg-2">\{t\.ft\}<\/span><span>\{t\.m\}<\/span>/);
    expect(contrastRatio(token("fg-3"), token("bg-1"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token("fg-2"), token("bg-1"))).toBeGreaterThanOrEqual(4.5);
  });
  it("a bad badge inside a selected row (#1c2a3f) is ≥ 4.5:1; elsewhere --color-bad stays", () => {
    const sel = /\[aria-selected="true"\] \.badge\.bad \{ color: (#[0-9a-f]{6}); \}/.exec(css);
    expect(sel).not.toBeNull();
    expect(contrastRatio(token("bad"), "#1c2a3f")).toBeLessThan(4.5); // 그대로 두면 미달(4.41)
    expect(contrastRatio(sel![1], "#1c2a3f")).toBeGreaterThanOrEqual(4.5);
    expect(token("bad")).toBe("#ef5d62");
    // 로그 목록의 고른 줄이 그 배경과 aria-selected 를 함께 쓴다(규칙이 닿는다)
    const logs = readFileSync(new URL("../components/logs/LogsDashboard.tsx", import.meta.url), "utf8");
    expect(logs).toMatch(/aria-selected=\{k === selId\}/);
    expect(logs).toMatch(/k === selId \? "bg-\[#1c2a3f\]"/);
  });
});
