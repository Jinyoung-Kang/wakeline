import { describe, expect, it } from "vitest";
import { band, BASE_ASSUMED_LABEL, fmtBool, fmtEta, TOP_UNKNOWN_LABEL } from "@/lib/format";
import { activeSigmetFeatures, isExpired, sigmetBandSource, topAboveFromRaw } from "@/lib/sigmet";
import { closeReasonLabel, etaRemainingS, evidenceBand, evidenceBandSource } from "@/lib/alerts";
import { appendTrackPoint, mergeTrack, pointFromState, trackFeatureCollection, trackFromRest } from "@/lib/track";
import { predictionFeature, predictionKey, predictionTargets } from "@/lib/maplayers";
import type { AircraftState, Alert, SelectedInfo, SigmetCollection, SigmetProps } from "@/lib/types";

const NOW = Date.parse("2026-09-27T05:10:00Z");

describe("SIGMET band display (contract §1: never show unpublished values as published)", () => {
  it("assumed surface base and unknown top are labelled as assumptions, never 'SFC' / '∞'", () => {
    const s = band(0, null, { base_source: "assumed_surface", top_source: "unknown" });
    expect(s).toBe(`${BASE_ASSUMED_LABEL} – ${TOP_UNKNOWN_LABEL}`);
    expect(s).toContain("하한 미발표(SFC 가정)");
    expect(s).toContain("상한 미발표(무제한 가정)");
    expect(s).not.toContain("∞");
  });
  it("published values", () => {
    expect(band(0, 38000, { base_source: "json", top_source: "json" })).toBe("SFC – FL380");
    expect(band(10000, 30000, { base_source: "json", top_source: "json" })).toBe("10,000 ft – FL300");
  });
  it("top read from raw text is marked; 'TOP ABV' is a lower bound", () => {
    expect(band(0, 30000, { base_source: "json", top_source: "raw_text" })).toBe("SFC – FL300 (원문)");
    expect(band(0, 38000, { base_source: "json", top_source: "raw_text", top_above: true })).toBe("SFC – FL380 이상 (원문)");
    expect(topAboveFromRaw("OEJD SIGMET 3 ... EMBD TS FCST ... TOP ABV FL380 MOV E", 38000)).toBe(true);
    expect(topAboveFromRaw("... TOP FL380 ...", 38000)).toBe(false);
    expect(topAboveFromRaw("... TOP ABV FL380 ...", 30000)).toBe(false);
  });
  it("a 0 base whose source is unknown is not asserted as a published SFC", () => {
    expect(band(0, 20000)).toBe("SFC(출처 미확인) – FL200");
    expect(band(null, 20000)).toBe("— – FL200");
  });
  it("sigmetBandSource reads the feature properties", () => {
    const p = { base_source: "assumed_surface", top_source: "raw_text", raw_text: "TOP ABV FL380", top_ft: 38000 } as Pick<SigmetProps, "base_source" | "top_source" | "raw_text" | "top_ft">;
    expect(sigmetBandSource(p)).toEqual({ base_source: "assumed_surface", top_source: "raw_text", top_above: true });
  });
});

describe("SIGMET client-side expiry (REL-13)", () => {
  const feat = (id: string, validTo: string, geom = true, active = true) => ({
    type: "Feature" as const, id, geometry: geom ? { type: "MultiPolygon" as const, coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] } : null,
    properties: { id, valid_to: validTo, active } as SigmetProps,
  });
  it("drops expired features and features without geometry", () => {
    const fc = { type: "FeatureCollection", features: [feat("a", "2026-09-27T05:09:59Z"), feat("b", "2026-09-27T06:00:00Z"), feat("c", "2026-09-27T06:00:00Z", false)] } as SigmetCollection;
    expect(activeSigmetFeatures(fc, NOW).map((f) => f.properties.id)).toEqual(["b"]);
    expect(activeSigmetFeatures(null, NOW)).toEqual([]);
  });
  it("unparseable valid_to falls back to the server's active flag", () => {
    expect(isExpired({ valid_to: "?", active: true }, NOW)).toBe(false);
    expect(isExpired({ valid_to: "?", active: false }, NOW)).toBe(true);
  });
});

describe("alerts: ETA countdown, close reasons, evidence band", () => {
  const pred: Alert = { id: 2, kind: "PREDICTED", hex: "h", sigmet_id: "S", fir_id: "F", hazard: "TS", entered_at: "2026-09-27T05:09:00Z", eta_s: 240, eta_at: "2026-09-27T05:13:00Z", evidence: { judged_at: "2026-09-27T05:09:00Z" }, estimated: true };
  it("counts down from eta_at and never goes negative", () => {
    expect(etaRemainingS(pred, NOW)).toBe(180);
    expect(etaRemainingS(pred, NOW + 200_000)).toBe(0);
  });
  it("falls back to judged_at + eta_s, then to the static eta_s", () => {
    expect(etaRemainingS({ ...pred, eta_at: null }, NOW)).toBe(180);
    expect(etaRemainingS({ ...pred, eta_at: null, evidence: {} }, NOW)).toBe(240);
    expect(etaRemainingS({ ...pred, eta_at: null, eta_s: null, evidence: {} }, NOW)).toBeNull();
    expect(fmtEta(null)).toBe("—");
    expect(fmtEta(185)).toBe("3m 5s");
  });
  it("labels close reasons", () => {
    expect(closeReasonLabel("signal_lost")).toContain("이탈 미확인");
    expect(closeReasonLabel(null)).toBe("—");
  });
  it("evidence band: null or legacy -1 top is unpublished; sources come from evidence first", () => {
    expect(evidenceBand({ band_ft: [0, null] })).toEqual({ base: 0, top: null });
    expect(evidenceBand({ band_ft: [0, -1] })).toEqual({ base: 0, top: null });
    expect(evidenceBand({})).toBeNull();
    expect(evidenceBandSource({ base_assumed_surface: true, top_assumed_unbounded: true }, null, null)).toEqual({ base_source: "assumed_surface", top_source: "unknown", top_above: false });
    expect(evidenceBandSource({}, { base_source: "json", top_source: "raw_text", raw_text: "TOP ABV FL400" }, 40000)).toEqual({ base_source: "json", top_source: "raw_text", top_above: true });
  });
  it("unknown booleans render as —", () => {
    expect(fmtBool(undefined)).toBe("—");
    expect(fmtBool(null)).toBe("—");
    expect(fmtBool(false)).toBe("no");
  });
});

describe("selected aircraft track (REST once, then extended)", () => {
  it("merges REST points with live points received meanwhile, skipping duplicates and older points", () => {
    const rest = trackFromRest([
      { ts: "2026-09-27T05:00:00Z", lon: 127, lat: 36, alt_ft: 30000 },
      { ts: "2026-09-27T05:00:10Z", lon: 127.1, lat: 36, alt_ft: 30000 },
      { ts: null, lon: 127.2, lat: 36 },
    ]);
    expect(rest).toHaveLength(2);
    const pending = [
      pointFromState({ hex: "h", lat: 36, lon: 127.1, seen_at: "2026-09-27T05:00:05Z" })!, // REST 보다 오래됨
      pointFromState({ hex: "h", lat: 36, lon: 127.3, seen_at: "2026-09-27T05:00:20Z", alt_ft: 31000 })!,
    ];
    const merged = mergeTrack(rest, pending);
    expect(merged.map((p) => p.lon)).toEqual([127, 127.1, 127.3]);
    expect(appendTrackPoint(merged, { ts: Date.parse("2026-09-27T05:00:30Z"), lon: 127.3, lat: 36, alt_ft: 31000 })).toBe(false); // 같은 위치
    expect(appendTrackPoint(merged, { ts: Date.parse("2026-09-27T05:00:30Z"), lon: 127.4, lat: 36, alt_ft: 31000 })).toBe(true);
    expect(trackFeatureCollection(merged).features).toHaveLength(3);
  });
  it("states without seen_at are not added (order unknown); length is capped", () => {
    expect(pointFromState({ hex: "h", lat: 1, lon: 1 })).toBeNull();
    const pts: { ts: number; lon: number; lat: number; alt_ft: null }[] = [];
    for (let i = 0; i < 20; i++) appendTrackPoint(pts, { ts: i, lon: i, lat: 0, alt_ft: null }, 10);
    expect(pts).toHaveLength(10);
    expect(pts[0].ts).toBe(10);
  });
});

describe("10-min prediction line targets (GAP-20)", () => {
  const st = (hex: string, over: Partial<AircraftState> = {}): AircraftState => ({ hex, lat: 36, lon: 127, gs_kt: 450, track_deg: 90, seen_at: "2026-09-27T05:10:00Z", ...over });
  const predAlert = (hex: string, over: Partial<Alert> = {}): Alert => ({ id: 1, kind: "PREDICTED", hex, sigmet_id: "S", fir_id: "F", hazard: "TS", entered_at: "x", evidence: {}, estimated: true, ...over });
  const states = new Map([["p1", st("p1")], ["s1", st("s1")], ["o1", st("o1")]]);
  const sel = (hex: string, available: boolean | null, state: AircraftState | null = st(hex, { lon: 128 })): SelectedInfo =>
    ({ hex, state, prediction: available == null ? null : { available, reason: available ? null : "turning" }, received_at: 0 });

  it("draws for PREDICTED alert targets and for the selected aircraft only when the server says prediction is available", () => {
    expect(predictionTargets(null, [predAlert("p1"), { ...predAlert("o1"), kind: "OBSERVED" }], states).map((s) => s.hex)).toEqual(["p1"]);
    expect(predictionTargets(sel("s1", true), [], states).map((s) => [s.hex, s.lon])).toEqual([["s1", 128]]);
    expect(predictionTargets(sel("s1", null), [], states)).toEqual([]); // 서버 판단 전에는 그리지 않는다
    expect(predictionTargets(sel("p1", false), [predAlert("p1")], states)).toEqual([]); // 선회 등 → 알림이 있어도 최신 판단을 따른다
    expect(predictionTargets(null, [predAlert("p1", { left_at: "y" })], states)).toEqual([]);
  });
  it("feature is labelled 추정 and has 11 points; missing gs/track → none", () => {
    const f = predictionFeature(st("x"), NOW)!;
    expect(f.properties).toMatchObject({ estimated: true, label: expect.stringContaining("추정") });
    expect(f.geometry.coordinates).toHaveLength(11);
    expect(predictionFeature(st("x", { gs_kt: null }), NOW)).toBeNull();
    expect(predictionFeature(st("x", { on_ground: true }), NOW)).toBeNull();
  });
  it("key changes only when inputs change (and, with targets, each second because the line starts at now)", () => {
    expect(predictionKey([st("a")], NOW)).toBe(predictionKey([st("a")], NOW + 999));
    expect(predictionKey([st("a")], NOW)).not.toBe(predictionKey([st("a", { seen_at: "2026-09-27T05:10:10Z" })], NOW));
    expect(predictionKey([st("a")], NOW)).not.toBe(predictionKey([st("a")], NOW + 1000));
    expect(predictionKey([], NOW)).toBe(predictionKey([], NOW + 60_000));
  });
});
