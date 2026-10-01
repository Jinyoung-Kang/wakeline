/**
 * GET /api/v1/radar/kr 본문 검사(web-review B10 · PLAN W10). WS 메시지는 lib/ws-validate 가 모두 검사하지만 이 REST 본문은 캐스트만 했다:
 * 200 이면서 frames 가 없는 본문(available:true)이 store 에 들어가면 RadarTimeline 이 그리다 던져 경로 오류 경계가 상황판 전체를 바꿨다.
 * parseKrRadar 는 화면이 바로 읽는 값을 본다 — 틀리면 null(부른 쪽이 마지막 값을 둔다), 참고 값(좌표 · 범례 · 격자)이 틀리면 그 값만 모름(null).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { parseKrRadar } from "@/lib/kr-radar";
import { resetData, setData } from "@/lib/store";

/** api WeatherController#radarKr 가 만드는 모양(값은 합성) */
const BODY = {
  available: true, status: "200", note: null, product: "HSR", cmp: "HSR", latest_tm: "202609300810", georeferenced: true,
  coordinates: [[120.5, 39.2], [132.1, 39.2], [132.1, 31.1], [120.5, 31.1]], projection: "LCC", grid: { nx: 2305, ny: 2881, res_m: 500, ref: [1121, 1681] },
  legend: [[5, [120, 190, 255, 150]], [10, [80, 160, 250, 170]]], min_dbz: "5.0", stations: 12, station_ids: ["KSN", "BRI"], stations_ref: 12, partial: false,
  image_size: [1200, 1500],
  frames: [{ tm: "202609300810", obs_tm: "202609300810", fetched_at: "2026-09-29T23:13:40Z", echo_cells: 12, url: "/api/v1/radar/kr/202609300810.png?v=1", stations: 12 }],
  time_zone: "KST(UTC+9) for tm; fetched_at is UTC", attribution: "기상청 API허브",
  meta: { provider: "kma_apihub", fetched_at: "2026-09-29T23:13:40Z", lag_s: 30, stale: false, generated_at: "2026-09-29T23:14:10Z", request_id: null },
};

describe("parseKrRadar", () => {
  it("accepts the api's body as it is", () => {
    const k = parseKrRadar(BODY)!;
    expect(k).not.toBeNull();
    expect(k.frames).toHaveLength(1);
    expect(k.coordinates).toEqual(BODY.coordinates);
    expect(k.legend).toEqual(BODY.legend);
    expect(k.grid).toEqual(BODY.grid);
    expect(k.meta?.fetched_at).toBe("2026-09-29T23:13:40Z");
    expect(k.latest_tm).toBe("202609300810");
    expect(parseKrRadar({ ...BODY, available: false, frames: [], coordinates: null, legend: null, grid: null })).not.toBeNull(); // 수집 전 · 만료
  });

  it("refuses a body the screen cannot read: not an object, no boolean 'available', no frames array", () => {
    expect(parseKrRadar(null)).toBeNull();
    expect(parseKrRadar("x")).toBeNull();
    expect(parseKrRadar([])).toBeNull();
    expect(parseKrRadar({ available: true, latest_tm: "202609281200" })).toBeNull(); // review A.9 — frames 없음
    expect(parseKrRadar({ ...BODY, available: "true" })).toBeNull();
    expect(parseKrRadar({ ...BODY, frames: { tm: "202609300810" } })).toBeNull();
  });

  it("drops frames the map cannot place (tm not 12 digits, no url, no echo count)", () => {
    const f = BODY.frames[0];
    const k = parseKrRadar({ ...BODY, frames: [f, { ...f, tm: "2026-09-30" }, { ...f, url: null }, { ...f, echo_cells: "12" }, null, "x"] })!;
    expect(k.frames).toEqual([f]);
  });

  it("an unreadable reference value becomes unknown (null), not a guess: corners, legend entries, grid, meta", () => {
    const k = parseKrRadar({ ...BODY, coordinates: [[120.5, 39.2], [132.1, 39.2]], legend: [[5, [1, 2, 3]], ["x", [1, 2, 3]], [10, [1]]], grid: { nx: 2305 }, meta: "x" })!;
    expect(k.coordinates).toBeNull();
    expect(k.legend).toEqual([[5, [1, 2, 3]]]);
    expect(k.grid).toBeNull();
    expect(k.meta).toBeNull();
    expect(parseKrRadar({ ...BODY, coordinates: [[120.5, "39"], [132.1, 39.2], [132.1, 31.1], [120.5, 31.1]] })!.coordinates).toBeNull();
    expect(parseKrRadar({ ...BODY, legend: "x" })!.legend).toBeNull();
  });
});

describe("RadarTimeline with what the store can hold", () => {
  afterEach(() => resetData());
  it("renders the parsed body; the unparsed A.9 body never reaches the store", async () => {
    const { RadarTimeline } = await import("@/components/RadarTimeline");
    setData({ radarKr: parseKrRadar(BODY) });
    expect(() => renderToStaticMarkup(createElement(RadarTimeline))).not.toThrow();
    expect(parseKrRadar({ available: true, latest_tm: "202609281200" })).toBeNull();
  });
});
