/**
 * R-04: 선택 항공기 항적이 수신 공백을 관측한 경로처럼 실선으로 잇지 않는다(선박 항적과 같은 규칙: 끊고 회색 점선 + 라벨).
 */
import { describe, expect, it } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { STALE_AFTER_OPENSKY_S, STALE_AFTER_S } from "@/lib/interpolate";
import { addBaseLayers } from "@/lib/maplayers";
import { pointFromState, TRACK_GAP_MS, trackFeatureCollection, trackFromRest, trackGapMs, type TrackPt } from "@/lib/track";

const T0 = Date.parse("2026-09-28T05:48:07Z");
const pt = (dtS: number, lon: number, lat: number, alt: number | null = 39100): TrackPt => ({ ts: T0 + dtS * 1000, lon, lat, alt_ft: alt });

describe("aircraft track gaps (R-04)", () => {
  it("the gap threshold is the dashboard's stale rule (a position older than this is shown as not currently observed)", () => {
    expect(TRACK_GAP_MS).toBe(STALE_AFTER_S * 1000);
  });

  it("a 950 s reception gap is drawn as a labelled gap connector, not as a solid altitude-coloured segment", () => {
    // 06a10a 실측: 05:48:37Z → 06:04:27Z(950 s, 288 km) 사이 관측 없음
    const pts = [pt(0, 126.0, 37.0), pt(10, 126.03, 37.0), pt(30, 126.1, 37.0), pt(980, 129.3, 37.3), pt(990, 129.33, 37.3)];
    const fc = trackFeatureCollection(pts);
    const kinds = fc.features.map((f) => (f.properties as { kind?: string }).kind);
    expect(kinds).toEqual(["track", "track", "gap", "track"]);
    const gap = fc.features[2];
    expect(gap.properties).toEqual({ kind: "gap", label: "수신 없음 14:48–15:04 KST" }); // 05:48Z–06:04Z 를 한국 표준시 먼저, UTC 함께
    expect((gap.geometry as GeoJSON.LineString).coordinates).toEqual([[126.1, 37.0], [129.3, 37.3]]);
    // 관측 구간은 끝점 고도색 그대로
    expect(fc.features[0].properties).toEqual({ kind: "track", alt_ft: 39100 });
  });

  it("points exactly at the threshold stay connected; unknown altitude stays null", () => {
    const fc = trackFeatureCollection([pt(0, 1, 1), pt(STALE_AFTER_S, 1.1, 1, null)]);
    expect(fc.features.map((f) => f.properties)).toEqual([{ kind: "track", alt_ft: null }]);
  });

  it("the threshold follows each point's recorded provider: OpenSky (global, ~120 s cadence) is not a gap until its own stale rule", () => {
    const osk = (dtS: number, lon: number): TrackPt => ({ ...pt(dtS, lon, 37), provider: "opensky" });
    // 06a10a 처럼 전세계 공급자(OpenSky)로만 잡힌 항공기: 120 s 마다 한 점 — 정상 관측이다(수신 없음이 아니다)
    const regular = trackFeatureCollection([osk(0, 126.0), osk(120, 126.5), osk(240, 127.0)]);
    expect(regular.features.map((f) => (f.properties as { kind: string }).kind)).toEqual(["track", "track"]);
    // OpenSky 기준(300 s)을 넘으면 공백
    const missed = trackFeatureCollection([osk(0, 126.0), osk(STALE_AFTER_OPENSKY_S + 1, 127.5)]);
    expect((missed.features[0].properties as { kind: string }).kind).toBe("gap");
    // 지역 공급자는 그대로 60 s
    const region = trackFeatureCollection([{ ...pt(0, 126, 37), provider: "adsb_fi" }, { ...pt(120, 126.5, 37), provider: "adsb_fi" }]);
    expect((region.features[0].properties as { kind: string }).kind).toBe("gap");
  });

  it("a segment uses the slower cadence of its two ends; an unknown provider keeps the strict regional rule", () => {
    expect(trackGapMs("opensky", "adsb_lol")).toBe(STALE_AFTER_OPENSKY_S * 1000);
    expect(trackGapMs("adsb_lol", "opensky")).toBe(STALE_AFTER_OPENSKY_S * 1000);
    expect(trackGapMs("adsb_fi", "adsb_lol")).toBe(STALE_AFTER_S * 1000);
    expect(trackGapMs(null, undefined)).toBe(STALE_AFTER_S * 1000);
  });

  it("the provider comes from the data: REST track rows and live states carry it", () => {
    const rest = trackFromRest([{ ts: "2026-09-28T05:48:07Z", lon: 126, lat: 37, alt_ft: 1000, provider: "opensky" } as never]);
    expect(rest[0].provider).toBe("opensky");
    const live = pointFromState({ hex: "06a10a", lat: 37, lon: 126, seen_at: "2026-09-28T05:50:07Z", provider: "adsb_fi" } as never);
    expect(live?.provider).toBe("adsb_fi");
    expect(trackFromRest([{ ts: "2026-09-28T05:48:07Z", lon: 126, lat: 37 }])[0].provider).toBeNull();
  });

  it("the map draws only 'track' features with the altitude colour and gaps as a grey dashed line with a label (style-spec valid)", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, Path2D: g.Path2D };
    const ctx = { fillStyle: "", fill: () => {}, getImageData: () => ({ width: 48, height: 48, data: new Uint8ClampedArray(48 * 48 * 4) }) };
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
    g.Path2D = class { constructor(public d: string) {} };
    const layers: { id: string; source?: string; filter?: unknown; paint?: Record<string, unknown>; layout?: Record<string, unknown> }[] = [];
    const sources: Record<string, unknown> = {};
    try {
      addBaseLayers({ addImage: () => {}, addSource: (id: string, s: unknown) => { sources[id] = s; }, addLayer: (l: never) => { layers.push(l); } } as never);
    } finally { g.document = saved.document; g.Path2D = saved.Path2D; }
    const onTracks = layers.filter((l) => l.source === "tracks");
    expect(onTracks.map((l) => l.id)).toEqual(["track-line", "track-gap", "track-gap-label"]);
    expect(onTracks[0].filter).toEqual(["==", ["get", "kind"], "track"]);
    expect(onTracks[1].filter).toEqual(["==", ["get", "kind"], "gap"]);
    expect(onTracks[1].paint?.["line-dasharray"]).toBeDefined();
    expect(onTracks[2].layout?.["text-field"]).toEqual(["get", "label"]);
    expect(validateStyleMin({ version: 8, sources, layers } as never).map((e) => e.message)).toEqual([]);
  });
});
