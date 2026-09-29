/**
 * 기상청 합성 레이더의 부분 합성(ADR-021, 2026-09-29 관찰: 저장된 프레임 절반가량이 레이더 15곳 중 5–9곳만 합성된 채 표시).
 * - 합성 크기를 명시한다: "합성 12/15곳"(헤더의 지점 수 / 지난 60분 저장 프레임 중 최대 — 수집기 기준). 모르면 "—"(단위를 붙이지 않는다).
 * - 부분 합성 프레임은 숨기지 않지만(실자료) 완전한 것처럼 보이지 않는다 — 경고 표시와 툴팁:
 *   "일부 지점만 합성(N/M곳) — HH:MM KST · HH:MMZ까지 다시 받기 대상(지점이 늘면 바꿈)"(수집기의 다시 받기 기한 refetch_until 전 — 주기당 개수 · 예산에
 *   따라 실제로 다시 받는지는 조건부라 '다음 주기에 다시 받음' 이라고 하지 않는다). 기한이 지나면 수집기의 기록(refetches)대로:
 *   다시 받았으면 "기한 … 까지 다시 받은 N회에도 기준 미만", 0회면 "기한 … 안에 다시 받지 못함", 모르면 "다시 받기 기한 … 지남".
 *   기한이나 지금 시각을 모르면 뒤 문장을 붙이지 않는다(지어내지 않는다).
 * - 어디에도 '완전'이라고 하지 않는다: partial=false 는 "기준 도달"(지난 60분 최대와 같음 — 기상청 합성이 완전한지는 자료에 없다). 기준이 그 프레임
 *   하나뿐이면 수집기가 판정을 두지 않고, 화면은 "합성 N/M곳 · 판정 —".
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KR_REF_MIN_SUPPORT, KR_REF_WINDOW_MIN, krComposite, krLayerId, krPartialSummary } from "@/lib/kr-radar";
import { getData, resetData, setData } from "@/lib/store";
import { detailRows, statusInput } from "@/lib/statusbar";
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
  it("frame at the reference: 합성 15/15곳, no warning, and it is called 기준 도달 — never complete", () => {
    const c = krComposite(full("202609291405"), BEFORE);
    expect(c.label).toBe("합성 15/15곳");
    expect(c.state).toBe("at_ref");
    expect(c.warn).toBeNull();
    expect(c.title).toContain("합성 지점 15곳 / 기준 15곳");
    expect(c.title).toContain("기준 도달 — 지난 60분 저장 프레임 중 최대와 같음(기상청 합성이 완전한지는 자료에 없음)");
    expect(c.title).not.toMatch(/= 완전|완전함|완전 합성/);
  });
  it("no verdict although both counts are known (the reference is this frame alone): 판정 —, not complete", () => {
    const c = krComposite(frame("202609291410", { stations: 7, station_ids: ids(7), stations_ref: 7 }), BEFORE);
    expect(c.label).toBe("합성 7/7곳 · 판정 —");
    expect(c.state).toBe("unknown");
    expect(c.warn).toBeNull();
    expect(c.title).toContain("판정 없음 — 기준(7곳)에 닿은 저장 프레임이 이 프레임뿐이거나(첫 프레임 · 공백 뒤) 판정 값이 없음");
  });
  it("partial frame before the collector's refetch deadline: a refetch candidate until the deadline (KST) — not 'next cycle'", () => {
    const c = krComposite(partial("202609291410"), BEFORE);
    expect(c.label).toBe("합성 7/15곳");
    expect(c.state).toBe("filling");
    expect(c.warn).toBe("일부 지점만 합성(7/15곳) — 14:40 KST까지 다시 받기 대상(지점이 늘면 바꿈)");
    expect(c.warn).not.toContain("다음 주기");
    expect(c.warn).not.toContain("채우는 중"); // 기상청이 채우는 중인지는 이 프레임의 자료에 없다(레이더 장애일 수도)
    expect(c.title).toContain(c.warn!);
    expect(c.title).toContain("다시 받음 1회 · 지점이 늘어 바꿈 0회");
    expect(c.title).toContain("K00, K01, K02, K03, K04, K05, K06");
  });
  it("partial frame after the deadline: says only what the collector recorded (refetched N times · never refetched · unknown)", () => {
    const c = krComposite(partial("202609291410", { refetches: 2 }), AFTER);
    expect(c.state).toBe("final");
    expect(c.warn).toBe("일부 지점만 합성(7/15곳) — 기한 14:40 KST까지 다시 받은 2회에도 기준 미만");
    expect(krComposite(partial("202609291410", { refetches: 0 }), AFTER).warn).toBe("일부 지점만 합성(7/15곳) — 기한 14:40 KST 안에 다시 받지 못함");
    expect(krComposite(partial("202609291410", { refetches: null }), AFTER).warn).toBe("일부 지점만 합성(7/15곳) — 다시 받기 기한 14:40 KST 지남");
    for (const re of [0, 2, null]) expect(krComposite(partial("202609291410", { refetches: re }), AFTER).warn).not.toContain("끝까지");
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
  it("status bar: the KMA chip warns on a partial latest frame (word + sentence); the details name the latest composite", () => {
    // 상태 바는 칩(이름 · 모양 · 경과 · 낱말) + 상세 표(프레임 수 · 최신 tm · 합성 크기) — 사용자 요청 2026-09-30, lib/statusbar
    const kmaRow = () => { const now = Date.now(); return detailRows(statusInput(getData(), now, now)).find((r) => r.key === "kma")!.value; };
    setData({ conn: "open", lastRxAt: Date.now(), radarKr: kr([full("202609291405"), partial("202609291410")]) });
    const html = renderToStaticMarkup(createElement(StatusBar));
    expect(kmaRow()).toMatch(/^2f · 최신 tm (\d\d-\d\d )?14:10 KST · 합성 7\/15곳$/);
    expect(html).toMatch(/data-testid="kr-status-partial" title="일부 지점만 합성\(7\/15곳\)[^"]*"/);
    expect(text(html)).toContain("일부 합성");
    expect(html).toMatch(/data-chip="kma" data-pinned="true"[^>]*data-health="warn"/);
    setData({ radarKr: kr([partial("202609291405"), full("202609291410")]) });
    const ok = renderToStaticMarkup(createElement(StatusBar));
    expect(kmaRow()).toMatch(/^2f · 최신 tm (\d\d-\d\d )?14:10 KST · 합성 15\/15곳$/);
    expect(ok).not.toContain('data-testid="kr-status-partial"');
    setData({ radarKr: kr([legacy("202609291410")]) });
    expect(kmaRow()).toMatch(/^1f · 최신 tm (\d\d-\d\d )?14:10 KST · 합성 —$/);
  });
  it("legend (KMA): explains the composite size and the partial marker", () => {
    setData({ radarKr: kr([full("202609291405")]) });
    const html = renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers: { ...useUi.getState().layers, radar: true }, radarSource: "kma" }));
    expect(text(html)).toContain("합성 N/M곳");
    expect(text(html)).toContain("일부 합성");
    expect(text(html)).toContain("지난 60분");
    expect(text(html)).toContain("기준 도달");
    expect(text(html)).toContain("완전한지는 모름");
    expect(text(html)).toContain("판정 —");
    expect(text(html)).not.toContain("채우는 중");
  });
  it("KMA panel and status bar: the STALE tooltip names the time the latest tm was first collected (refetches do not move it)", () => {
    const stale = { ...kr([full("202609291405"), full("202609291410")]), meta: { fetched_at: "2026-09-29T05:13:40Z", stale: true } } as KrRadar;
    setData({ conn: "open", lastRxAt: Date.now(), radarKr: stale });
    const bar = renderToStaticMarkup(createElement(StatusBar));
    expect(bar).toMatch(/data-testid="kr-radar-stale"[^>]*title="[^"]*최신 tm 첫 수집 [^"]*"/);
    const panel = renderToStaticMarkup(createElement(KrRadarPanel, { onClose: () => {} }));
    expect(panel).toMatch(/data-testid="kr-panel-stale"[^>]*title="최신 tm 첫 수집 [^"]*"/);
  });
});

describe("the words on screen follow the collector's choices", () => {
  it("the reference window named on screen is the collector's REF_WINDOW_S (a choice, not a measurement)", () => {
    const py = readFileSync(new URL("../../collector/wakeline_collector/jobs/kma_radar.py", import.meta.url), "utf8");
    const m = /^REF_WINDOW_S = (\d+) \* 60\b/m.exec(py);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(KR_REF_WINDOW_MIN);
  });
  it("the '기준 도달' support named on screen is the collector's REF_MIN_SUPPORT (a choice)", () => {
    const py = readFileSync(new URL("../../collector/wakeline_collector/jobs/kma_radar.py", import.meta.url), "utf8");
    const m = /^REF_MIN_SUPPORT = (\d+)\b/m.exec(py);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(KR_REF_MIN_SUPPORT);
  });
  it("map layer ids carry the image version so a re-downloaded frame gets a new layer; unversioned URLs keep the old id", () => {
    expect(krLayerId({ tm: "202609291440", url: "/api/v1/radar/kr/202609291440.png?v=1790662419000" })).toBe("kmar-202609291440-1790662419000");
    expect(krLayerId({ tm: "202609291440", url: "/api/v1/radar/kr/202609291440.png" })).toBe("kmar-202609291440");
  });
});
