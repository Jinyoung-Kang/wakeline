/**
 * 기상청 합성 레이더의 부분 합성(ADR-021, 2026-09-29 관찰: 저장된 프레임 절반가량이 레이더 15곳 중 5–9곳만 합성된 채 표시).
 * - 합성 크기를 명시한다: "합성 12/15곳"(헤더의 지점 수 / 지난 60분 저장 프레임 중 최대 — 수집기 기준). 모르면 "—"(단위를 붙이지 않는다).
 * - 부분 합성 프레임은 숨기지 않지만(실자료) 완전한 것처럼 보이지 않는다 — 경고 표시와 툴팁:
 *   "일부 지점만 합성(N/M곳) — 기상청이 아직 채우는 중, 다음 주기에 다시 받음"(수집기의 다시 받기 기한 refetch_until 전),
 *   기한이 지나면 "… — 끝까지 채워지지 않음". 기한이나 지금 시각을 모르면 뒤 문장을 붙이지 않는다(지어내지 않는다).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KR_REF_WINDOW_MIN, krComposite, krLayerId, krPartialSummary } from "@/lib/kr-radar";
import { resetData, setData } from "@/lib/store";
import { KrRadarPanel } from "@/components/KrRadarPanel";
import { StatusBar } from "@/components/StatusBar";
import { MapLegendView } from "@/components/MapLegend";
import { useUi } from "@/lib/ui-store";
import type { KrRadar, KrRadarFrame } from "@/lib/types";

const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<");
const UNTIL = "2026-09-29T05:40:00Z"; // 14:10 KST tm + 30분
const BEFORE = Date.parse(UNTIL) - 60_000;
const AFTER = Date.parse(UNTIL) + 60_000;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `K${String(i).padStart(2, "0")}`);

function frame(tm: string, o: Partial<KrRadarFrame> = {}): KrRadarFrame {
  return { tm, obs_tm: tm, fetched_at: "2026-09-29T05:13:40Z", echo_cells: 1000, url: `/api/v1/radar/kr/${tm}.png?v=1`, ...o };
}
const full = (tm: string) => frame(tm, { stations: 15, station_ids: ids(15), stations_ref: 15, partial: false, refetches: 0, upgrades: 0 });
const partial = (tm: string, o: Partial<KrRadarFrame> = {}) =>
  frame(tm, { stations: 7, station_ids: ids(7), stations_ref: 15, partial: true, refetches: 1, upgrades: 0, refetch_until: UNTIL, ...o });
const legacy = (tm: string) => frame(tm, { url: `/api/v1/radar/kr/${tm}.png` });

function kr(frames: KrRadarFrame[]): KrRadar {
  const last = frames[frames.length - 1];
  return {
    available: true, latest_tm: last?.tm ?? null, georeferenced: true, coordinates: null, legend: [[5, [120, 190, 255, 150]]], min_dbz: "5.0",
    frames, attribution: "기상청", meta: { fetched_at: last?.fetched_at ?? null, stale: false },
    stations: last?.stations, station_ids: last?.station_ids, stations_ref: last?.stations_ref, partial: last?.partial,
  } as KrRadar;
}

describe("krComposite: composite size and partial wording from the frame's own fields", () => {
  it("full frame: 합성 15/15곳, no warning", () => {
    const c = krComposite(full("202609291405"), BEFORE);
    expect(c.label).toBe("합성 15/15곳");
    expect(c.state).toBe("full");
    expect(c.warn).toBeNull();
    expect(c.title).toContain("합성 지점 15곳 / 기준 15곳");
  });
  it("partial frame before the collector's refetch deadline: still being filled, fetched again next cycle", () => {
    const c = krComposite(partial("202609291410"), BEFORE);
    expect(c.label).toBe("합성 7/15곳");
    expect(c.state).toBe("filling");
    expect(c.warn).toBe("일부 지점만 합성(7/15곳) — 기상청이 아직 채우는 중, 다음 주기에 다시 받음");
    expect(c.title).toContain(c.warn!);
    expect(c.title).toContain("다시 받음 1회 · 지점이 늘어 바꿈 0회");
    expect(c.title).toContain("K00, K01, K02, K03, K04, K05, K06");
  });
  it("partial frame after the deadline: never filled in", () => {
    const c = krComposite(partial("202609291410"), AFTER);
    expect(c.state).toBe("final");
    expect(c.warn).toBe("일부 지점만 합성(7/15곳) — 끝까지 채워지지 않음");
  });
  it("unknown deadline or unknown clock: the partial marker stays, the refetch sentence is not invented", () => {
    expect(krComposite(partial("202609291410", { refetch_until: null }), BEFORE).warn).toBe("일부 지점만 합성(7/15곳)");
    expect(krComposite(partial("202609291410"), 0).warn).toBe("일부 지점만 합성(7/15곳)");
    expect(krComposite(partial("202609291410"), 0).state).toBe("partial");
  });
  it("unknown fields (frames from before the change) are — without a unit", () => {
    const c = krComposite(legacy("202609291400"), BEFORE);
    expect(c.label).toBe("합성 —");
    expect(c.state).toBe("unknown");
    expect(c.warn).toBeNull();
    expect(c.title).toContain("합성 지점 수 모름");
    expect(krComposite(null, BEFORE).label).toBe("합성 —");
    expect(krComposite(frame("202609291400", { stations: 12 }), BEFORE).label).toBe("합성 12곳 · 기준 —");
    expect(krComposite(frame("202609291400", { stations: "12" as never, stations_ref: 15 }), BEFORE).label).toBe("합성 —");
  });
  it("partial summary counts known flags and names the unknown ones", () => {
    expect(krPartialSummary([full("1"), partial("2"), legacy("3")])).toBe("1 / 2 · 모름 1");
    expect(krPartialSummary([full("1"), full("2")])).toBe("0 / 2");
    expect(krPartialSummary([legacy("1")])).toBe("—");
    expect(krPartialSummary([])).toBe("—");
  });
});

describe("KMA panel, status bar and legend never present a partial composite as complete", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());

  it("KMA panel: latest partial → 합성 7/15곳 with a warn marker and the sentence on screen; station codes listed; partial frame count", () => {
    setData({ radarKr: kr([full("202609291405"), partial("202609291410")]) });
    const html = renderToStaticMarkup(createElement(KrRadarPanel, { onClose: () => {} }));
    expect(text(html)).toContain("합성(최신)합성 7/15곳");
    expect(html).toMatch(/data-testid="kr-panel-partial"[^>]*title="일부 지점만 합성\(7\/15곳\)/);
    expect(text(html)).toContain("일부 지점만 합성(7/15곳)"); // 툴팁만이 아니라 화면에
    expect(text(html)).toContain("레이더K00, K01, K02, K03, K04, K05, K06");
    expect(text(html)).toContain("부분 합성 프레임1 / 2");
  });
  it("KMA panel: latest full → no warn marker; legacy frames → — everywhere", () => {
    setData({ radarKr: kr([partial("202609291405"), full("202609291410")]) });
    const html = renderToStaticMarkup(createElement(KrRadarPanel, { onClose: () => {} }));
    expect(text(html)).toContain("합성(최신)합성 15/15곳");
    expect(html).not.toContain('data-testid="kr-panel-partial"');
    setData({ radarKr: kr([legacy("202609291405"), legacy("202609291410")]) });
    const old = text(renderToStaticMarkup(createElement(KrRadarPanel, { onClose: () => {} })));
    expect(old).toContain("합성(최신)합성 —");
    expect(old).toContain("레이더—");
    expect(old).toContain("부분 합성 프레임—");
    expect(old).not.toMatch(/—\s*곳/);
  });
  it("status bar: KMA chip names the latest composite; a partial latest frame gets a warn badge with the sentence", () => {
    setData({ conn: "open", lastRxAt: Date.now(), radarKr: kr([full("202609291405"), partial("202609291410")]) });
    const html = renderToStaticMarkup(createElement(StatusBar));
    expect(text(html)).toContain("KMA 2f 14:10 KST · 합성 7/15곳");
    expect(html).toMatch(/data-testid="kr-status-partial"[^>]*title="일부 지점만 합성\(7\/15곳\)[^"]*"/);
    expect(text(html)).toContain("KMA 일부 합성");
    setData({ radarKr: kr([partial("202609291405"), full("202609291410")]) });
    const ok = renderToStaticMarkup(createElement(StatusBar));
    expect(text(ok)).toContain("KMA 2f 14:10 KST · 합성 15/15곳");
    expect(ok).not.toContain('data-testid="kr-status-partial"');
    setData({ radarKr: kr([legacy("202609291410")]) });
    expect(text(renderToStaticMarkup(createElement(StatusBar)))).toContain("KMA 1f 14:10 KST · 합성 —");
  });
  it("legend (KMA): explains the composite size and the partial marker", () => {
    setData({ radarKr: kr([full("202609291405")]) });
    const html = renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers: { ...useUi.getState().layers, radar: true }, radarSource: "kma" }));
    expect(text(html)).toContain("합성 N/M곳");
    expect(text(html)).toContain("일부 합성");
    expect(text(html)).toContain("지난 60분");
  });
});

describe("the words on screen follow the collector's choices", () => {
  it("the reference window named on screen is the collector's REF_WINDOW_S (a choice, not a measurement)", () => {
    const py = readFileSync(new URL("../../collector/wakeline_collector/jobs/kma_radar.py", import.meta.url), "utf8");
    const m = /^REF_WINDOW_S = (\d+) \* 60\b/m.exec(py);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(KR_REF_WINDOW_MIN);
  });
  it("map layer ids carry the image version so a re-downloaded frame gets a new layer; unversioned URLs keep the old id", () => {
    expect(krLayerId({ tm: "202609291440", url: "/api/v1/radar/kr/202609291440.png?v=1790662419000" })).toBe("kmar-202609291440-1790662419000");
    expect(krLayerId({ tm: "202609291440", url: "/api/v1/radar/kr/202609291440.png" })).toBe("kmar-202609291440");
  });
});
