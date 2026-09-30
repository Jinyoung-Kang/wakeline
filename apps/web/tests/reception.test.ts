/**
 * 관측 수신 범위(계약 v5 §G27 · ADR-027) — api /ships/coverage 의 0.5° 칸(이 서비스가 최근 24 h 에 실제로 선박 위치를 받은 곳)을 옅게 칠한다.
 * 응답 검증(틀린 칸은 버리고 센다 · 봉투가 틀리면 null) · 칸 → 정사각형(속성: 칸 번호 · 선박 · 위치 · 마지막 수신) · 선박 수 구간의 불투명도(범례와 지도가
 * 같은 표 · MapLibre 스타일 규격) · 화면 안 칸 수(날짜변경선을 넘는 펼친 경도 포함) · 툴팁(KST 만) · 상태 줄(덮음 상태 · 부트스트랩 · 상한을 글로) · 조회기.
 */
import { describe, expect, it } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import {
  addReceptionLayers, cellsInView, parseReception, RECEPTION_CELL_DEG, RECEPTION_LAYERS, RECEPTION_POLL_MS, RECEPTION_SOURCE, RECEPTION_URL,
  receptionFeatures, receptionOpacityExpr, receptionPoller, receptionStatusLine, receptionTip, type Reception,
} from "@/lib/reception";
import { RECEPTION_BINS, RECEPTION_COLOR, RECEPTION_FILL_LAYER, RECEPTION_LINE_LAYER } from "@/lib/reception-meta";
import type { PollState } from "@/lib/etag-poller";

function body(over: Record<string, unknown> = {}) {
  return {
    cell_deg: 0.5,
    window: { hours: 24, bucket_s: 3600, from: "2026-09-29T09:00:00Z", to: "2026-09-30T09:40:12.345Z" },
    since: "2026-09-29T09:00:00Z", covered: "full",
    api_started_at: "2026-09-30T09:37:25.500Z", live_from: "2026-09-30T09:37:00Z",
    bootstrap: { state: "done", hours_loaded: 25, hours_total: 25, rows: 1234, loaded_from: "2026-09-29T09:00:00Z", finished_at: "2026-09-30T09:38:10.100Z" },
    generated_at: "2026-09-30T09:40:12.345Z",
    cells: [[139.5, 35.0, 0.5, 12, 40, "2026-09-30T08:59:59Z"], [126.0, 37.0, 0.5, 304, 5120, "2026-09-30T09:40:01Z"]],
    cell_count: 2, positions: 5160, truncated: false, dropped_positions: 0, limits: { max_cells: 16000, max_ship_cells: 200000 },
    sampling: "first_fix_per_60s", note: "x", time_zone: "x", meta: { stale: false },
    ...over,
  };
}
const rec = (over: Record<string, unknown> = {}) => parseReception(body(over)) as Reception;

describe("parseReception: the api answer, checked again (bad cells are dropped and counted)", () => {
  it("reads every field the screen uses", () => {
    const r = rec();
    expect(r.cellDeg).toBe(RECEPTION_CELL_DEG);
    expect(r.windowHours).toBe(24);
    expect(r.from).toBe("2026-09-29T09:00:00Z");
    expect(r.to).toBe("2026-09-30T09:40:12.345Z");
    expect(r.since).toBe("2026-09-29T09:00:00Z");
    expect(r.covered).toBe("full");
    expect(r.liveFrom).toBe("2026-09-30T09:37:00Z");
    expect(r.bootstrap).toEqual({ state: "done", hoursLoaded: 25, hoursTotal: 25, error: null });
    expect(r.cells).toEqual([[139.5, 35.0, 0.5, 12, 40, "2026-09-30T08:59:59Z"], [126.0, 37.0, 0.5, 304, 5120, "2026-09-30T09:40:01Z"]]);
    expect(r.positions).toBe(5160);
    expect(r.truncated).toBe(false);
    expect(r.droppedPositions).toBe(0);
    expect(r.maxCells).toBe(16000);
    expect(r.dropped).toBe(0);
  });

  it("drops malformed cells and counts them — off lattice, out of range, zero ships, more ships than positions, bad time, wrong size", () => {
    const r = rec({
      cells: [
        [126.25, 37.0, 0.5, 1, 1, "2026-09-30T09:00:00Z"],
        [180.0, 37.0, 0.5, 1, 1, "2026-09-30T09:00:00Z"],
        [126.0, 90.0, 0.5, 1, 1, "2026-09-30T09:00:00Z"],
        [126.0, 37.0, 0.5, 0, 1, "2026-09-30T09:00:00Z"],
        [126.0, 37.0, 0.5, 3, 2, "2026-09-30T09:00:00Z"],
        [126.0, 37.0, 0.5, 1, 1, "yesterday"],
        [126.0, 37.0, 1.0, 1, 1, "2026-09-30T09:00:00Z"],
        [126.0, 37.0, 0.5, 1.5, 2, "2026-09-30T09:00:00Z"],
        "nope",
        [-180.0, -90.0, 0.5, 1, 1, "2026-09-30T09:00:00Z"],
      ],
    });
    expect(r.cells).toEqual([[-180, -90, 0.5, 1, 1, "2026-09-30T09:00:00Z"]]);
    expect(r.dropped).toBe(9);
  });

  it("an envelope the screen cannot read is null (the last good value stays)", () => {
    for (const over of [
      { cell_deg: 1 }, { covered: "complete" }, { window: null }, { window: { hours: 24, from: "x", to: "2026-09-30T09:40:12Z" } }, { since: 5 },
      { bootstrap: { state: "weird" } }, { cells: "x" }, { truncated: "no" }, { live_from: null },
    ]) expect(parseReception(body(over)), JSON.stringify(over)).toBeNull();
    expect(parseReception(null)).toBeNull();
    expect(parseReception([])).toBeNull();
  });

  it("the bootstrap error is a known kind or nothing (server text is never shown)", () => {
    const failed = rec({ covered: "since_api_start", since: "2026-09-30T09:37:00Z", bootstrap: { state: "failed", hours_loaded: 0, hours_total: 25, rows: 0,
      loaded_from: "2026-09-30T09:37:00Z", error: "connection", finished_at: "2026-09-30T09:37:56Z" } });
    expect(failed.bootstrap.error).toBe("connection");
    const odd = rec({ bootstrap: { state: "failed", hours_loaded: 0, hours_total: 25, rows: 0, loaded_from: "2026-09-30T09:37:00Z", error: "<script>" } });
    expect(odd.bootstrap.error).toBe("error");
  });
});

describe("map features and style", () => {
  it("one square per cell with the cell key, ships, positions and last seen", () => {
    const fc = receptionFeatures(rec().cells);
    expect(fc.features).toHaveLength(2);
    const f = fc.features[1];
    expect(f.properties).toEqual({ g: "37,126", s: 304, n: 5120, t: "2026-09-30T09:40:01Z" });
    expect(f.geometry.coordinates[0]).toEqual([[126, 37], [126.5, 37], [126.5, 37.5], [126, 37.5], [126, 37]]);
  });

  it("fill opacity steps by ships with the legend's bins, and the layers pass the MapLibre style spec", () => {
    expect(receptionOpacityExpr()).toEqual(["step", ["get", "s"], RECEPTION_BINS[0].opacity, ...RECEPTION_BINS.slice(1).flatMap((b) => [b.min, b.opacity])]);
    const added: { id: string; spec: unknown; before?: string }[] = [];
    const sources: Record<string, unknown> = {};
    const host = {
      addSource: (id: string, spec: unknown) => { sources[id] = spec; },
      addLayer: (spec: unknown, before?: string) => { added.push({ id: (spec as { id: string }).id, spec, before }); },
      getSource: (id: string) => sources[id],
      getLayer: (id: string) => added.find((a) => a.id === id),
    };
    addReceptionLayers(host, "traffic-grid-fill");
    addReceptionLayers(host, "traffic-grid-fill"); // 두 번 불러도 한 벌
    expect(Object.keys(sources)).toEqual([RECEPTION_SOURCE]);
    expect(added.map((a) => a.id)).toEqual([...RECEPTION_LAYERS]);
    expect(RECEPTION_LAYERS).toEqual([RECEPTION_FILL_LAYER, RECEPTION_LINE_LAYER]);
    expect(added.every((a) => a.before === "traffic-grid-fill")).toBe(true);
    const style = { version: 8, sources: { [RECEPTION_SOURCE]: { type: "geojson", data: { type: "FeatureCollection", features: [] } } }, layers: added.map((a) => a.spec) };
    expect(validateStyleMin(style as never)).toEqual([]);
    expect(JSON.stringify(added[0].spec)).toContain(RECEPTION_COLOR);
  });
});

describe("cells in view", () => {
  const cells = rec({ cells: [[126.0, 37.0, 0.5, 1, 1, "2026-09-30T09:00:00Z"], [179.5, 50.0, 0.5, 1, 1, "2026-09-30T09:00:00Z"],
    [-180.0, 50.0, 0.5, 1, 1, "2026-09-30T09:00:00Z"], [10.0, -40.0, 0.5, 1, 1, "2026-09-30T09:00:00Z"]] }).cells;
  it("counts cells whose square overlaps the visible bounds — touching an edge is not inside", () => {
    expect(cellsInView(cells, [120, 30, 135, 43])).toBe(1);
    expect(cellsInView(cells, [126.5, 30, 135, 43])).toBe(0);
    expect(cellsInView(cells, [-10, -60, 20, 0])).toBe(1);
  });
  it("handles bounds unwrapped across the date line (MapLibre getBounds east > 180)", () => {
    expect(cellsInView(cells, [170, 45, 190, 55])).toBe(2);
    expect(cellsInView(cells, [-190, 45, -170, 55])).toBe(2);
    expect(cellsInView(cells, [-400, -85, 400, 85])).toBe(4);
  });
});

describe("tooltip and status line — KST only, the reason in words", () => {
  it("tooltip: ships, positions (the stored 60 s sample), last seen and the window, and that it is not the subscription area", () => {
    const tip = receptionTip({ g: "37,126", s: 304, n: 5120, t: "2026-09-30T09:40:01Z" }, rec())!;
    expect(tip.title).toBe("관측 수신 칸");
    expect(tip.subtitle).toBe("37.0–37.5°N · 126.0–126.5°E");
    expect(tip.rows).toEqual([
      ["선박", "304척"],
      ["위치", "5,120건(60 s 창마다 1건)"],
      ["마지막 수신", "09-30 18:40:01 KST"],
      ["창", "09-29 18:00 – 09-30 18:40 KST"],
    ]);
    expect(tip.flags).toEqual([{ text: "받은 위치의 집계 — 구독 범위 아님", tone: "muted" }]);
    expect(JSON.stringify(tip)).not.toContain("UTC");
    const south = receptionTip({ g: "-34,-151.5", s: 1, n: 1, t: "x" }, null)!;
    expect(south.subtitle).toBe("34.0–33.5°S · 151.5–151.0°W");
    expect(south.rows[2]).toEqual(["마지막 수신", "—"]);
    expect(south.rows[3]).toEqual(["창", "—"]);
    expect(receptionTip({}, rec())).toBeNull();
  });

  it("tooltip warns when the window is only partly counted", () => {
    const tip = receptionTip({ g: "37,126", s: 1, n: 1, t: "2026-09-30T09:40:01Z" }, rec({ covered: "since_api_start", since: "2026-09-30T09:37:00Z" }))!;
    expect(tip.flags).toContainEqual({ text: "09-30 18:37 KST 부터만 셈(api 시작 뒤)", tone: "warn" });
  });

  it("status line: loading, error, full, partial, since api start (pending · running · failed), truncated", () => {
    expect(receptionStatusLine(null, null, null)).toEqual({ text: "불러오는 중…", tone: "muted", detail: null });
    expect(receptionStatusLine(null, "HTTP 503", null)).toEqual({ text: "조회 실패 — HTTP 503", tone: "bad", detail: null });
    const full = receptionStatusLine(rec(), null, 1);
    expect(full.text).toBe("칸 2개(0.5°) · 이 화면 1개 · 창 09-29 18:00 – 09-30 18:40 KST");
    expect(full.tone).toBe("ok");
    expect(full.detail).toBeNull();
    expect(receptionStatusLine(rec(), "HTTP 502", 1).text).toContain("조회 실패(HTTP 502) — 마지막 값");
    expect(receptionStatusLine(rec(), null, null).text).toBe("칸 2개(0.5°) · 창 09-29 18:00 – 09-30 18:40 KST");
    const partial = receptionStatusLine(rec({ covered: "partial", since: "2026-09-30T07:00:00Z", bootstrap: { state: "failed", hours_loaded: 3, hours_total: 25, rows: 1,
      loaded_from: "2026-09-30T07:00:00Z", error: "statement_timeout", finished_at: "2026-09-30T09:38:10Z" } }), null, 1);
    expect(partial.tone).toBe("warn");
    expect(partial.detail).toBe("창의 일부만 셈 — 09-30 16:00 KST 부터(기동 전 기록 3/25시간만 읽음 — DB 문장 상한 초과)");
    const pending = receptionStatusLine(rec({ covered: "since_api_start", since: "2026-09-30T09:37:00Z",
      bootstrap: { state: "pending", hours_loaded: 0, hours_total: 0, rows: 0, loaded_from: "2026-09-30T09:37:00Z" } }), null, 1);
    expect(pending.detail).toBe("창의 일부만 셈 — 09-30 18:37 KST 부터(api 시작 뒤 · 기동 전 기록은 곧 읽음)");
    const running = receptionStatusLine(rec({ covered: "since_api_start", since: "2026-09-30T09:37:00Z",
      bootstrap: { state: "running", hours_loaded: 0, hours_total: 25, rows: 0, loaded_from: "2026-09-30T09:37:00Z" } }), null, 1);
    expect(running.detail).toBe("창의 일부만 셈 — 09-30 18:37 KST 부터(api 시작 뒤 · 기동 전 기록 읽는 중 0/25시간)");
    const failed = receptionStatusLine(rec({ covered: "since_api_start", since: "2026-09-30T09:37:00Z",
      bootstrap: { state: "failed", hours_loaded: 0, hours_total: 25, rows: 0, loaded_from: "2026-09-30T09:37:00Z", error: "connection", finished_at: "2026-09-30T09:37:56Z" } }), null, 1);
    expect(failed.detail).toBe("창의 일부만 셈 — 09-30 18:37 KST 부터(api 시작 뒤 · 기동 전 기록 읽기 실패 — DB 연결 실패)");
    const capped = receptionStatusLine(rec({ truncated: true, dropped_positions: 7 }), null, 1);
    expect(capped.tone).toBe("warn");
    expect(capped.detail).toBe("메모리 상한(칸 16,000) — 위치 7건 세지 못함");
    const bad = receptionStatusLine(rec({ cells: [[126.25, 37.0, 0.5, 1, 1, "2026-09-30T09:00:00Z"]] }), null, 0);
    expect(bad.detail).toBe("형식 오류로 뺀 칸 1");
    for (const l of [full, partial, pending, running, failed, capped]) expect(`${l.text} ${l.detail ?? ""}`).not.toContain("UTC");
  });
});

describe("poller", () => {
  it("polls the coverage endpoint with ETag and publishes parsed values", async () => {
    const states: PollState<Reception>[] = [];
    const calls: { url: string; inm?: string }[] = [];
    const answers = [
      () => new Response(JSON.stringify(body()), { status: 200, headers: { ETag: '"o1"' } }),
      () => new Response(null, { status: 304 }),
    ];
    const p = receptionPoller((s) => states.push(s), undefined, async (url, init) => {
      calls.push({ url, inm: (init.headers as Record<string, string>)["If-None-Match"] });
      return answers.shift()!();
    }, () => false, () => 5);
    await p.poll();
    await p.poll();
    expect(calls).toEqual([{ url: RECEPTION_URL, inm: undefined }, { url: RECEPTION_URL, inm: '"o1"' }]);
    expect(states.at(-1)!.version).toBe(1);
    expect(states.at(-1)!.data!.cells).toHaveLength(2);
    expect(RECEPTION_POLL_MS).toBe(120_000);
  });
});
