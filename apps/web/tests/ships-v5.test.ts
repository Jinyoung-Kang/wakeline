/**
 * 계약 v5 §B 웹 — B2 격자 칸의 선종별 수(다섯째 원소) · B3 선종 필터 · 선택 선박 표시 · 항적 기간·점 툴팁 · 카드 행 · 선박 표 · 통합 검색.
 * MMSI·선명은 합성(SYNTHETIC) 값이다.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filterGridCells, gridFeatures, parseGridCells, SHIP_CATEGORIES, type ShipCategory } from "@/lib/ships";
import { shipGridTip } from "@/lib/tooltip";

/** 계약 v5 §B2 의 순서(웹 SHIP_CATEGORIES = Java ShipCategory 선언 순서) */
const CONTRACT_ORDER = ["cargo", "tanker", "passenger", "fishing", "tug", "pleasure", "hsc", "special", "military", "other", "unknown"];
const all = (): Set<ShipCategory> => new Set(SHIP_CATEGORIES);
const without = (...c: ShipCategory[]) => { const s = all(); for (const x of c) s.delete(x); return s; };
/** 선종별 수 배열(순서 = SHIP_CATEGORIES) */
const counts = (o: Partial<Record<ShipCategory, number>>) => SHIP_CATEGORIES.map((c) => o[c] ?? 0);

describe("ship category order (contract v5 §B2)", () => {
  it("SHIP_CATEGORIES is the contract order", () => {
    expect([...SHIP_CATEGORIES]).toEqual(CONTRACT_ORDER);
  });
  it("SHIP_CATEGORIES equals the shared vector schemas/vectors/ship-categories.v1.json (api ShipCategory asserts the same file)", () => {
    // 저장소 밖(웹 이미지 빌드 등)에서는 공유 파일이 없다 — 그때는 위의 계약 순서 시험만
    const shared = new URL("../../../schemas/vectors/ship-categories.v1.json", import.meta.url);
    if (!existsSync(shared)) return;
    const v = JSON.parse(readFileSync(shared, "utf8")) as { version: number; order: string[] };
    expect(v.version).toBe(1);
    expect([...SHIP_CATEGORIES]).toEqual(v.order);
  });
});

describe("ships_grid cells with per-category counts (contract v5 §B2)", () => {
  it("reads the 5th element as counts in SHIP_CATEGORIES order; 4-element cells (older servers) have counts null", () => {
    const cells = parseGridCells([
      [35.25, 129.25, 5, "cargo", counts({ cargo: 3, tanker: 1, fishing: 1 })],
      [34.75, 128.75, 2, "tanker"],
    ]);
    expect(cells).toHaveLength(2);
    expect(cells[0]).toEqual({ lat: 35.25, lon: 129.25, count: 5, category: "cargo", counts: counts({ cargo: 3, tanker: 1, fishing: 1 }) });
    expect(cells[1]).toEqual({ lat: 34.75, lon: 128.75, count: 2, category: "tanker", counts: null });
  });
  it("counts that do not fit (wrong length, negative, fractional, non-number, sum ≠ count) are not trusted → null", () => {
    const bad = [
      counts({ cargo: 5 }).slice(0, 10), // 원소 10개
      [...counts({ cargo: 5 }), 0], // 12개
      counts({ cargo: 6, tanker: -1 }),
      counts({ cargo: 4.5, tanker: 0.5 }),
      counts({ cargo: 5 }).map((n, i) => (i === 3 ? "0" : n)),
      counts({ cargo: 4 }), // 합 4 ≠ 5
      "cargo:5",
    ];
    for (const b of bad) expect(parseGridCells([[1, 2, 5, "cargo", b]])[0].counts).toBeNull();
  });
});

describe("category filter on the grid (contract v5 §B3)", () => {
  const cells = parseGridCells([
    [35.25, 129.25, 5, "cargo", counts({ cargo: 3, tanker: 1, fishing: 1 })],
    [34.75, 128.75, 2, "fishing", counts({ fishing: 2 })],
    [33.25, 126.25, 4, "tanker", counts({ tanker: 2, passenger: 2 })],
    [30.25, 122.25, 7, "cargo"], // 구 서버(선종별 수 없음)
  ]);
  it("all categories on: the server's cells as they are", () => {
    const r = filterGridCells(cells, all());
    expect(r.cells.map((c) => [c.count, c.category, c.unfiltered])).toEqual([[5, "cargo", false], [2, "fishing", false], [4, "tanker", false], [7, "cargo", false]]);
    expect(r).toMatchObject({ total: 18, allTotal: 18, unfilteredCells: 0, active: false });
  });
  it("hiding categories recounts each cell from its counts, drops cells that reach 0 and re-picks the most common shown category", () => {
    const r = filterGridCells(cells, without("cargo", "fishing"));
    // 칸 1: 유조선 1 · 칸 2: 0척 → 그리지 않음 · 칸 3: 유조선 2 = 여객 2 → 순서가 앞인 tanker · 칸 4: 선종별 수 없음 → 그대로(필터 미적용 표시)
    expect(r.cells.map((c) => [c.lat, c.count, c.category, c.all, c.unfiltered])).toEqual([
      [35.25, 1, "tanker", 5, false], [33.25, 4, "tanker", 4, false], [30.25, 7, "cargo", 7, true],
    ]);
    expect(r).toMatchObject({ total: 12, allTotal: 18, unfilteredCells: 1, active: true });
    const none = filterGridCells(cells, new Set());
    expect(none.cells.map((c) => c.lat)).toEqual([30.25]); // 선종별 수가 없는 칸만 남는다(지어내지 않는다 — 표시로 밝힌다)
  });
  it("grid features carry the shown count, the total before filtering and a per-category breakdown for the tooltip", () => {
    const f = gridFeatures(filterGridCells(cells, without("cargo")).cells).features;
    expect(f[0].properties).toMatchObject({ count: 2, label: "2", cat: "tanker", all: 5, unfiltered: false, breakdown: "화물선 3(숨김) · 유조선·탱커 1 · 어선 1" });
    expect(f[3].properties).toMatchObject({ count: 7, all: 7, unfiltered: true, breakdown: "" });
    const tip = shipGridTip(f[0].properties!, 0.5);
    expect(tip.title).toBe("선박 2척 · 선종 필터 적용(칸 전체 5척)");
    expect(Object.fromEntries(tip.rows)).toMatchObject({ MOST: "유조선·탱커", "BY TYPE": "화물선 3(숨김) · 유조선·탱커 1 · 어선 1" });
    const old = shipGridTip(f[3].properties!, 0.5);
    expect(old.title).toBe("선박 7척");
    expect(Object.fromEntries(old.rows)["BY TYPE"]).toBe("— (서버가 선종별 수를 보내지 않음)");
    expect(old.flags.map((x) => x.text)).toContain("선종별 수 없음(구 서버) — 선종 필터를 적용하지 못한 전체 수");
  });
});
