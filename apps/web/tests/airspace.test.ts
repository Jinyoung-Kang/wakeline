/**
 * 공역 레이어(계약 v5 §G47 · ADR-034 · SPEC F1) — api /airspace(켜진 차수 하나 — 국토교통부 공역정보 지도자료)를 그린다.
 * 응답 검증(틀린 도형은 버리고 센다 · 봉투가 틀리면 null · 자료 없음) · 고도 글(기준을 숨기지 않음 — 지면 기준 · 모름은 고도로 판정하지 않는다고 적음) ·
 * MapLibre 스타일 규격 · 종류 거르기 · 툴팁(출처 · 기준 차수 · 최신 여부 확인 안 함) · 상태 줄 · 종류 선택 저장(이 브라우저 — 깨진 값 · 저장소 실패) · 조회기(Accept).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import {
  addAirspaceLayers, AIRSPACE_LABEL_LAYER, AIRSPACE_LAYERS, AIRSPACE_PREFS_KEY, AIRSPACE_SOURCE, AIRSPACE_URL, airspacePoller, airspaceStatusLine, airspaceTip,
  bandText, categoriesPresent, categoryFilter, CATEGORY_STYLES, DEFAULT_CATEGORIES, limitText, loadCategories, parseAirspace, saveCategories, styleOf, type Airspace,
} from "@/lib/airspace";
import { AIRSPACE_FILL_LAYER, AIRSPACE_LINE_LAYER } from "@/lib/airspace-meta";
import { PICK_LAYERS } from "@/lib/map-pointer";
import { AirspaceStatusView } from "@/components/AirspaceLayer";
import type { PollState } from "@/lib/etag-poller";

const SQ = { type: "Polygon", coordinates: [[[132, 36], [132.2, 36], [132.2, 36.2], [132, 36.2], [132, 36]]] };
function feat(id: number, category: string, over: Record<string, unknown> = {}) {
  return {
    type: "Feature", id: String(id), geometry: SQ,
    properties: {
      id, category, type_ko: `종류 ${category}`, ident: `RK X${id}`, name: `시험 ${id}`, label: `RK X${id}`, kind: "polygon",
      lower: { ft: 0, basis: "SFC", raw: "Ground" }, upper: { ft: 18_000, basis: "FL", raw: "180 Flight Level Altitude" }, ...over,
    },
  };
}
function body(over: Record<string, unknown> = {}) {
  return {
    type: "FeatureCollection", source: "국토교통부 공역정보 지도자료(AIP 차수 기준)",
    edition: { id: 3, label: "AIP 25년 5차", document_name: "AIP 25년 5차 기준", imported_at: "2026-10-09T05:00:00Z", currency_checked: false },
    features: [feat(1, "prohibited", { upper: { ft: null, basis: "UNL", raw: "Unlimited" } }), feat(2, "restricted"), feat(3, "danger", { upper: { ft: 2000, basis: "AGL", raw: "2000 Feet Height" } }),
      { ...feat(4, "route", { kind: "line" }), geometry: { type: "LineString", coordinates: [[131, 37], [132, 37.5]] } }, feat(5, "mystery")],
    meta: { stale: false }, ...over,
  };
}
const air = (over: Record<string, unknown> = {}) => parseAirspace(body(over)) as Airspace;

describe("parseAirspace: the api answer, checked again", () => {
  it("reads the edition, source and every feature property", () => {
    const a = air();
    expect(a.edition).toEqual({ id: 3, label: "AIP 25년 5차", documentName: "AIP 25년 5차 기준", importedAt: "2026-10-09T05:00:00Z" });
    expect(a.features).toHaveLength(5);
    expect(a.features[0].properties.upper).toEqual({ ft: null, basis: "UNL", raw: "Unlimited" });
    expect(a.features[3].geometry.type).toBe("LineString");
    expect(a.dropped).toBe(0);
  });
  it("no data is an empty collection with a null edition (not an error)", () => {
    const a = air({ edition: null, features: [] });
    expect(a.edition).toBeNull();
    expect(a.features).toEqual([]);
  });
  it("drops and counts bad features, and refuses a bad envelope", () => {
    const a = air({ features: [feat(1, "prohibited"), feat(2, "x", { lower: { ft: "0", basis: "SFC", raw: "" } }), feat(3, "x", { kind: "area" }),
      { ...feat(4, "x"), geometry: { type: "Point", coordinates: [1, 2] } }, feat(5, "x", { upper: { ft: 1, basis: "WAT", raw: "" } }), null] });
    expect(a.features.map((f) => f.properties.id)).toEqual([1]);
    expect(a.dropped).toBe(5);
    expect(parseAirspace({ ...body(), type: "Feature" })).toBeNull();
    expect(parseAirspace({ ...body(), edition: { id: "3" } })).toBeNull();
    expect(parseAirspace(null)).toBeNull();
  });
});

describe("vertical limits never hide their reference", () => {
  it("writes each basis", () => {
    expect(limitText({ ft: 0, basis: "SFC", raw: "Ground" })).toBe("지면");
    expect(limitText({ ft: null, basis: "UNL", raw: "Unlimited" })).toBe("무제한");
    expect(limitText({ ft: 18_000, basis: "FL", raw: "" })).toBe("FL180");
    expect(limitText({ ft: 9_500, basis: "FL", raw: "" })).toBe("FL095");
    expect(limitText({ ft: 5_000, basis: "MSL", raw: "" })).toBe("5,000 ft(해면)");
    expect(limitText({ ft: 2_000, basis: "AGL", raw: "" })).toBe("지면 기준 2,000 ft");
    expect(limitText({ ft: null, basis: "UNKNOWN", raw: "Feet" })).toBe("모름(Feet)");
    expect(limitText({ ft: null, basis: "UNKNOWN", raw: "" })).toBe("모름");
  });
  it("says when the altitude is not used for judging", () => {
    expect(bandText({ ft: 0, basis: "SFC", raw: "" }, { ft: 18_000, basis: "FL", raw: "" })).toEqual({ text: "지면 – FL180", note: null });
    expect(bandText({ ft: 0, basis: "SFC", raw: "" }, { ft: 2_000, basis: "AGL", raw: "" }).note).toMatch(/^지면 기준 한계 — 지형 높이를 더해야/);
    expect(bandText({ ft: null, basis: "UNKNOWN", raw: "" }, { ft: 1, basis: "MSL", raw: "" }).note).toBe("고도 기준을 알 수 없음 — 고도로 판정하지 않음");
  });
});

describe("map layers, filter and hover order", () => {
  it("adds one source and three layers under the given slot, passing the MapLibre style spec", () => {
    const added: { id: string; spec: unknown; before?: string }[] = [];
    const sources: Record<string, unknown> = {};
    const host = {
      addSource: (id: string, spec: unknown) => { sources[id] = spec; },
      addLayer: (spec: unknown, before?: string) => { added.push({ id: (spec as { id: string }).id, spec, before }); },
      getSource: (id: string) => sources[id],
      getLayer: (id: string) => added.find((a) => a.id === id),
    };
    addAirspaceLayers(host, "radar-slot");
    addAirspaceLayers(host, "radar-slot");
    expect(Object.keys(sources)).toEqual([AIRSPACE_SOURCE]);
    expect(added.map((a) => a.id)).toEqual([...AIRSPACE_LAYERS]);
    expect(AIRSPACE_LAYERS).toEqual([AIRSPACE_FILL_LAYER, AIRSPACE_LINE_LAYER, AIRSPACE_LABEL_LAYER]);
    expect(added.every((a) => a.before === "radar-slot")).toBe(true);
    const f = categoryFilter(["prohibited", "danger"]);
    const style = {
      version: 8, glyphs: "https://example.test/{fontstack}/{range}.pbf",
      sources: { [AIRSPACE_SOURCE]: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
      layers: [...added.map((a) => a.spec), { ...(added[0].spec as object), id: "x-filtered", filter: f.polygons }, { ...(added[1].spec as object), id: "y-filtered", filter: f.all }],
    };
    expect(validateStyleMin(style as never)).toEqual([]);
    for (const c of Object.values(CATEGORY_STYLES)) expect(JSON.stringify(added[1].spec)).toContain(c.color);
  });
  it("airspace is the lowest hover priority (wide areas never hide aircraft, ships or SIGMET)", () => {
    expect(PICK_LAYERS.slice(-2)).toEqual([AIRSPACE_LINE_LAYER, AIRSPACE_FILL_LAYER]);
  });
  it("defaults show the judged controlled areas and danger areas; unknown categories get the other style", () => {
    expect([...DEFAULT_CATEGORIES].sort()).toEqual(["danger", "nuclear", "prohibited", "restricted", "security"]);
    expect(styleOf("mystery").label).toBe("기타");
    expect(categoriesPresent(air())).toEqual([
      { code: "prohibited", label: "비행금지" }, { code: "restricted", label: "비행제한" }, { code: "danger", label: "위험구역" }, { code: "route", label: "항공로" },
      { code: "mystery", label: "종류 mystery" }]);
    const two = air({ features: [feat(1, "other", { type_ko: "새폴더B" }), feat(2, "other", { type_ko: "새폴더A" })] });
    expect(categoriesPresent(two)).toEqual([{ code: "other", label: "새폴더A·새폴더B" }]);
    expect(categoriesPresent(null)).toEqual([]);
  });
});

describe("tooltip and status line", () => {
  it("tooltip names the area, its band and reference, the edition and the source", () => {
    const a = air();
    const t = airspaceTip({ id: 3 }, a)!;
    expect(t.title).toBe("RK X3 시험 3");
    expect(t.rows).toEqual([["종류", "종류 danger"], ["고도", "지면 – 지면 기준 2,000 ft"], ["원문", "Ground / 2000 Feet Height"], ["기준", "AIP 25년 5차 · 국토교통부"]]);
    expect(t.flags.map((f) => f.text)).toEqual(["AIRAC 최신 여부 확인 안 함", expect.stringMatching(/^지면 기준 한계/)]);
    expect(airspaceTip({ id: "4" }, a)!.subtitle).toBe("항로 선");
    expect(airspaceTip({ id: 99 }, a)).toBeNull();
    expect(airspaceTip({}, a)).toBeNull();
    expect(airspaceTip({ id: 1 }, null)).toBeNull();
  });
  it("status line: edition and source, no data, errors (KST)", () => {
    expect(airspaceStatusLine(air(), null, 3)).toEqual({
      text: "AIP 25년 5차 기준 · 국토교통부 · 최신 여부 확인 안 함 · 가져옴 10-09 14:00 KST · 그린 도형 3/5", tone: "ok" });
    expect(airspaceStatusLine(air({ edition: null, features: [] }), null, 0)).toEqual({ text: "공역 자료 없음 — 운영자가 가져오기 필요(make airspace-import)", tone: "warn" });
    expect(airspaceStatusLine(null, null, null)).toEqual({ text: "받는 중…", tone: "muted" });
    expect(airspaceStatusLine(null, "HTTP 503", null)).toEqual({ text: "조회 실패(HTTP 503)", tone: "bad" });
    expect(airspaceStatusLine(air(), "HTTP 503", 1).text).toMatch(/ · 조회 실패\(HTTP 503\) — 마지막 값$/);
  });
  it("the view lists the categories present with pressed state, colour and dash", () => {
    const html = renderToStaticMarkup(createElement(AirspaceStatusView, {
      line: { text: "x", tone: "ok" }, present: [{ code: "prohibited", label: "비행금지" }, { code: "danger", label: "위험구역" }, { code: "mystery", label: "새폴더" }],
      cats: ["prohibited"], onToggle: () => {} }));
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="airspace-cat-prohibited"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="airspace-cat-danger"/);
    expect(html).toContain("새폴더</button>");
    expect(html).toContain("dashed");
  });
});

describe("category choice is kept in this browser only", () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
  it("round-trips, drops bad entries and duplicates, and survives a broken or failing storage", () => {
    const s = mem();
    saveCategories(["danger", "moa"], s);
    expect(s.m.get(AIRSPACE_PREFS_KEY)).toBe('["danger","moa"]');
    expect(loadCategories(s)).toEqual(["danger", "moa"]);
    s.setItem(AIRSPACE_PREFS_KEY, '["danger","danger","BAD",3,"route"]');
    expect(loadCategories(s)).toEqual(["danger", "route"]);
    s.setItem(AIRSPACE_PREFS_KEY, "{not json");
    expect(loadCategories(s)).toBeNull();
    s.setItem(AIRSPACE_PREFS_KEY, '{"a":1}');
    expect(loadCategories(s)).toBeNull();
    expect(loadCategories({ getItem: () => { throw new Error("denied"); } })).toBeNull();
    expect(() => saveCategories(["x"], { setItem: () => { throw new Error("quota"); } })).not.toThrow();
    expect(loadCategories(null)).toBeNull();
  });
});

describe("poller", () => {
  it("asks for GeoJSON with ETag and publishes a new version only when the body changes", async () => {
    const calls: { url: string; accept: string; inm?: string }[] = [];
    const states: PollState<Airspace>[] = [];
    const answers = [
      () => new Response(JSON.stringify(body()), { status: 200, headers: { ETag: '"as3"' } }),
      () => new Response(null, { status: 304 }),
    ];
    const p = airspacePoller((s) => states.push(s), undefined, async (url, init) => {
      const h = init.headers as Record<string, string>;
      calls.push({ url, accept: h.Accept, inm: h["If-None-Match"] });
      return answers.shift()!();
    }, () => false, () => 5);
    await p.poll();
    await p.poll();
    expect(calls).toEqual([{ url: AIRSPACE_URL, accept: "application/geo+json", inm: undefined }, { url: AIRSPACE_URL, accept: "application/geo+json", inm: '"as3"' }]);
    expect(states.at(-1)!.version).toBe(1);
    expect(states.at(-1)!.data!.features).toHaveLength(5);
  });
});
