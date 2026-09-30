/**
 * 기상청 내려받기 '파일 없음' 연속(운영 로그 2026-09-30): 목록(rdr_cmp_file_list)은 RDR_CMP_HSR_EXT_* 를 09:50 KST 까지 싣는데 내려받기(rdr_cmp_file)는
 * 08:15 KST 부터 모든 tm 에 "# file not exist (RDR_CMP_HSR_PUB_<tm>.bin.gz)" 로 답했다. 전에는 화면 어디에도 까닭이 없었다 — KMA 칩은 나이로 STALE 만,
 * 범례 · 레이더 패널 · 운영은 아무 말이 없었다. 이제 api 의 missing(수집기 확인 — 첫 tm · 없다고 답한 tm 수 · 마지막 확인 · 답의 파일 이름 · 목록 종류)을
 * KMA 칩 title · 상세 행 · 레이더 패널 · 범례 · 타임라인 · 운영 공급자 표에 그대로 보인다. 시각은 KST 만, 모르는 값은 짓지 않는다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  KR_MISSING_CHECK_STALE_MIN, KR_MISSING_RECHECK_MIN, KR_MISSING_SLOW_AFTER_MIN, KR_MISSING_SLOW_EVERY_MIN, KR_MISSING_STALE_PROBES, krMissing,
} from "@/lib/kr-radar";
import { providerMissing, providersNowMs, runStatusClass, RUN_STATUS_TITLE } from "@/lib/ops";
import { getData, resetData, setData } from "@/lib/store";
import { detailRows, statusChips, statusInput } from "@/lib/statusbar";
import { KrRadarPanel } from "@/components/KrRadarPanel";
import { MapLegendView } from "@/components/MapLegend";
import { StatusBar } from "@/components/StatusBar";
import { useUi } from "@/lib/ui-store";
import type { KrRadar, KrRadarMissing } from "@/lib/types";

const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&#x27;/g, "'");
/** 09:52 KST — 마지막 확인 뒤 1분 남짓 */
const NOW = Date.parse("2026-09-30T00:52:00Z");
const MISS: KrRadarMissing = {
  since_tm: "202609300815", last_tm: "202609300950", tms: 20, checked_at: "2026-09-30T00:50:31Z",
  file: "RDR_CMP_HSR_PUB_202609300950.bin.gz", listed: ["EXT"],
};
// 잰 것만: 없다는 답을 받은 가장 이른 · 가장 새 tm 과 확인한 서로 다른 tm 수(리뷰 2026-09-30 — "부터 20개"는 그 사이 tm 이 모두 20개라고 읽혔다)
const LINE = "기상청 내려받기 파일(PUB) 없음 — tm 08:15–09:50 KST · 확인한 tm 20개 모두 없음 · 목록에는 EXT · 마지막 확인 09:50:31 KST";
/** 서버 렌더(지금 시각 모름 — 시계 0)에서는 날짜를 붙인다(어제 시각이 오늘처럼 보이지 않게 — lib/time fmtKstDayMinute 와 같은 규칙) */
const LINE_DATED = "기상청 내려받기 파일(PUB) 없음 — tm 09-30 08:15–09:50 KST · 확인한 tm 20개 모두 없음 · 목록에는 EXT · 마지막 확인 09-30 09:50:31 KST";

function kr(o: Partial<KrRadar> = {}): KrRadar {
  const f = { tm: "202609300810", obs_tm: "202609300810", fetched_at: "2026-09-29T23:13:40Z", echo_cells: 12, url: "/api/v1/radar/kr/202609300810.png?v=1" };
  return {
    available: true, latest_tm: "202609300810", georeferenced: true, coordinates: null, legend: [[5, [120, 190, 255, 150]]], min_dbz: "5.0",
    frames: [f], attribution: "기상청", meta: { fetched_at: "2026-09-29T23:13:40Z", stale: true }, missing: MISS, ...o,
  } as KrRadar;
}

describe("krMissing: the collector's missing-file streak in words (KST, values as given)", () => {
  it("one line and a tooltip from the api fields — the kind comes from KMA's own file name, the listing kinds as listed", () => {
    const m = krMissing(MISS, NOW)!;
    expect(m.text).toBe(LINE);
    expect(m.word).toBe("파일 없음");
    expect(m.title).toContain("기상청 목록에는 tm 이 있는데 내려받기가 '파일 없음'으로 답함");
    expect(m.title).toContain("기상청 답의 파일: RDR_CMP_HSR_PUB_202609300950.bin.gz");
    expect(m.title).toContain("목록의 파일 종류: EXT");
    expect(m.title).toContain("마지막 확인 2026-09-30 09:50:31.000 KST");
    expect(m.title).toContain("첫 tm 08:15 KST · 마지막 tm 09:50 KST(없다는 답을 받은 가장 이른 · 가장 새 tm) · 확인한 서로 다른 tm 20개 모두 없음 — 확인하지 않은 tm 은 세지 않음");
    expect(m.title).toContain(`수집기가 주기마다 목록의 가장 새 tm 과 ${KR_MISSING_RECHECK_MIN}분 넘게 앞선 가장 새 tm 만 확인`);
    expect(m.stale).toBe(false);
    expect(`${m.text}\n${m.title}`).not.toMatch(/UTC|\d\d:\d\d(:\d\d)?Z\b|\+00:00/);
  });
  it("unknown file name or listing kinds are left out, never guessed", () => {
    const m = krMissing({ ...MISS, file: null, listed: null }, NOW)!;
    expect(m.text).toBe("기상청 내려받기 파일 없음 — tm 08:15–09:50 KST · 확인한 tm 20개 모두 없음 · 마지막 확인 09:50:31 KST");
    expect(m.title).toContain("기상청 답의 파일 이름 모름");
    expect(m.title).toContain("목록의 파일 종류 모름");
  });
  it("another KST day than now carries its date; a streak across midnight names both days; one tm is one tm", () => {
    expect(krMissing(MISS, Date.parse("2026-10-01T01:00:00Z"))!.text).toContain("tm 09-30 08:15–09:50 KST · 확인한 tm 20개 모두 없음");
    const night = krMissing({ ...MISS, since_tm: "202609292350", last_tm: "202609300010", tms: 5, checked_at: "2026-09-29T15:10:31Z" }, Date.parse("2026-09-29T15:12:00Z"))!;
    expect(night.text).toContain("tm 09-29 23:50 – 09-30 00:10 KST · 확인한 tm 5개 모두 없음");
    expect(krMissing({ ...MISS, since_tm: "202609300950", tms: 1 }, NOW)!.text).toContain("tm 09:50 KST · 확인한 tm 1개 없음 ·");
  });
  it("a last check older than the collector's carry-over bound (15 min) is marked 확인 멈춤 — the streak may no longer be current", () => {
    const at = Date.parse(MISS.checked_at);
    expect(krMissing(MISS, at + KR_MISSING_CHECK_STALE_MIN * 60_000)!.stale).toBe(false); // 경계 포함 — 넘어야
    const old = krMissing(MISS, at + KR_MISSING_CHECK_STALE_MIN * 60_000 + 1000)!;
    expect(old.stale).toBe(true);
    expect(old.word).toBe("파일 없음 · 확인 멈춤");
    expect(old.text).toBe(`${LINE} — ${KR_MISSING_CHECK_STALE_MIN}분 넘게 다시 확인하지 않음(확인 멈춤)`);
    expect(old.title).toContain(`마지막 확인 뒤 ${KR_MISSING_CHECK_STALE_MIN}분 넘게 확인 없음 — 지금도 없는지는 모름`);
    expect(krMissing(MISS, 0)!.stale).toBe(false); // 지금을 모르면 판정하지 않는다
  });
  it("the minutes named on screen are the collector's choices (MISSING_RECHECK_S · MISSING_CARRY_S)", () => {
    const py = readFileSync(new URL("../../collector/wakeline_collector/jobs/kma_radar.py", import.meta.url), "utf8");
    expect(Number(/^MISSING_RECHECK_S = (\d+) \* 60\b/m.exec(py)?.[1])).toBe(KR_MISSING_RECHECK_MIN);
    expect(Number(/^MISSING_CARRY_S = (\d+) \* 60\b/m.exec(py)?.[1])).toBe(KR_MISSING_CHECK_STALE_MIN);
  });
  it("a wrong or missing core value → no streak (null), not a partial sentence", () => {
    for (const bad of [null, undefined, "x", {}, { ...MISS, since_tm: "08:15" }, { ...MISS, tms: 0 }, { ...MISS, tms: "20" }, { ...MISS, checked_at: "yesterday" }, { ...MISS, checked_at: "2026-09-30T00:50:31" } /* 시간대 없음 — 해석이 갈린다 */,
      { ...MISS, last_tm: "202609300810" }]) {
      expect(krMissing(bad, NOW), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("status bar: the KMA chip and 상세 say why no new frame comes", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());
  const chip = () => statusChips(statusInput(getData(), NOW, NOW)).find((c) => c.key === "kma")!;
  it("chip: word 파일 없음 with the sentence, warn at least (pinned), the reason in the chip title", () => {
    setData({ conn: "open", lastRxAt: NOW, radarKr: kr({ meta: { fetched_at: "2026-09-30T00:45:00Z", stale: false } }) });
    const c = chip();
    expect(c.words.map((w) => w.text)).toEqual(["파일 없음"]);
    expect(c.words[0]).toMatchObject({ testId: "kr-status-missing", title: expect.stringContaining(LINE) });
    expect(c.health).toBe("warn");
    expect(c.pinned).toBe(true);
    expect(c.title).toContain(LINE);
    setData({ radarKr: kr() }); // 나이도 넘었다 — STALE(경고) + 까닭
    expect(chip().words.map((w) => w.text)).toEqual(["STALE", "파일 없음"]);
    expect(chip().health).toBe("bad");
    const html = renderToStaticMarkup(createElement(StatusBar));
    expect(html).toMatch(/data-testid="kr-status-missing" title="기상청 내려받기 파일\(PUB\) 없음/);
  });
  it("상세: a row of its own with the first tm, count, KMA's answer, the listing and the last check (KST)", () => {
    setData({ radarKr: kr() });
    const rows = detailRows(statusInput(getData(), NOW, NOW));
    const kma = rows.find((r) => r.key === "kma")!;
    expect(kma.state).toBe("STALE · 파일 없음");
    const m = rows.find((r) => r.key === "kma-missing")!;
    expect(rows.indexOf(m)).toBe(rows.indexOf(kma) + 1);
    expect(m).toMatchObject({ name: "기상청 내려받기 파일", health: "warn", state: "없음", value: "tm 08:15–09:50 KST · 확인한 tm 20개 모두 없음" });
    expect(m.source).toBe("기상청 답: RDR_CMP_HSR_PUB_202609300950.bin.gz 없음 · 목록에는 EXT · 마지막 확인 09:50:31 KST");
    expect(m.sourceTitle).toBe("마지막 확인 2026-09-30 09:50:31.000 KST");
    expect(m.rule).toContain(`수집기가 주기마다 목록의 가장 새 tm 과 ${KR_MISSING_RECHECK_MIN}분 넘게 앞선 가장 새 tm 만 확인`);
    // 마지막 확인이 오래됐다 — 칩 낱말 · 상세 상태가 '확인 멈춤'
    const later = Date.parse("2026-09-30T01:20:00Z");
    const c = statusChips(statusInput(getData(), later, later)).find((x) => x.key === "kma")!;
    expect(c.words.map((w) => w.text)).toEqual(["STALE", "파일 없음 · 확인 멈춤"]);
    expect(detailRows(statusInput(getData(), later, later)).find((r) => r.key === "kma-missing")!.state).toBe("없음 · 확인 멈춤");
  });
  it("no streak → no word and no row (unchanged)", () => {
    setData({ radarKr: kr({ missing: undefined, meta: { fetched_at: "2026-09-30T00:45:00Z", stale: false } }) });
    expect(chip().words).toEqual([]);
    expect(detailRows(statusInput(getData(), NOW, NOW)).some((r) => r.key === "kma-missing")).toBe(false);
  });
  it("frames expired (not available) but the streak is known → the chip stays, with the reason", () => {
    setData({ radarKr: kr({ available: false, frames: [], note: "" }) });
    const c = chip();
    expect(c.words.map((w) => w.text)).toContain("파일 없음");
    const kma = detailRows(statusInput(getData(), NOW, NOW)).find((r) => r.key === "kma")!;
    expect(kma.state).toBe("사용 불가 · STALE · 파일 없음"); // 칩과 같은 상태 · 낱말
    expect(kma.health).toBe("bad");
  });
});

describe("KMA chip after the frames expired without a streak (listing stall · provider error)", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());
  const find = () => statusChips(statusInput(getData(), NOW, NOW)).find((c) => c.key === "kma");
  it("once collected, the chip stays with STALE and the api's reason — a stalled source is not hidden (2026-10-01)", () => {
    setData({ radarKr: kr({ available: false, frames: [], missing: undefined, note: "기상청 목록이 16분 넘게 새 tm 을 싣지 않음" }) });
    const c = find();
    expect(c).toBeDefined();
    expect(c!.words.map((w) => w.text)).toEqual(["STALE"]);
    expect(c!.health).toBe("bad");
    expect(c!.title).toContain("기상청 레이더 사용 불가 — 기상청 목록이 16분 넘게 새 tm 을 싣지 않음");
    const row = detailRows(statusInput(getData(), NOW, NOW)).find((r) => r.key === "kma")!;
    expect(row.health).toBe("bad"); // 칩과 같은 판정(전에는 'unknown')
    expect(row.state).toBe("사용 불가 · STALE");
  });
  it("never collected (no first-fetch time — e.g. no key) → no chip, as before", () => {
    setData({ radarKr: kr({ available: false, frames: [], missing: undefined, meta: {} as KrRadar["meta"], note: "" }) });
    expect(find()).toBeUndefined();
    expect(detailRows(statusInput(getData(), NOW, NOW)).find((r) => r.key === "kma")!.health).toBe("unknown");
  });
});

describe("KMA panel, legend and radar timeline name the reason", () => {
  beforeEach(() => resetData());
  afterEach(() => { resetData(); useUi.setState({ radarSource: "rainviewer" }); });
  it("panel: a warn note with the sentence (available and not available)", () => {
    setData({ radarKr: kr() });
    const html = renderToStaticMarkup(createElement(KrRadarPanel, { onClose: () => {} }));
    expect(html).toMatch(/data-testid="kr-panel-missing"/);
    expect(text(html)).toContain(`${LINE_DATED} — 새 프레임이 오지 않는 까닭`);
    setData({ radarKr: kr({ available: false, frames: [], note: "" }) });
    const off = text(renderToStaticMarkup(createElement(KrRadarPanel, { onClose: () => {} })));
    expect(off).toContain("사용 불가");
    expect(off).toContain(LINE_DATED);
  });
  it("legend (KMA section): the reason line", () => {
    setData({ radarKr: kr() });
    const html = renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers: { ...useUi.getState().layers, radar: true }, radarSource: "kma" }));
    expect(html).toMatch(/data-testid="legend-kr-missing"/);
    expect(text(html)).toContain(LINE_DATED);
    setData({ radarKr: kr({ available: false, frames: [] }) });
    expect(text(renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers: { ...useUi.getState().layers, radar: true }, radarSource: "kma" }))))
      .toContain(`기상청 레이더 사용 불가 — ${LINE_DATED}`);
  });
  // 타임라인(KMA 출처)은 클라이언트 렌더 시험(tests/mapview-lifecycle — 서버 렌더는 zustand 초기 상태라 출처를 바꿀 수 없다)
});

describe("운영: the provider hash streak and the run status colours", () => {
  const P = { name: "kma_radar", missing_since_tm: "202609300815", missing_last_tm: "202609300950", missing_tms: "20",
    missing_checked_at: "2026-09-30T00:50:31Z", missing_file: "RDR_CMP_HSR_PUB_202609300950.bin.gz", missing_listed: "EXT" };
  it("providerMissing reads the collector's missing_* strings (empty = closed streak)", () => {
    expect(providerMissing(P, NOW)?.text).toBe(LINE);
    expect(providerMissing(P, Date.parse("2026-09-30T01:20:00Z"))?.stale).toBe(true); // 수집기가 멈춰 지우지 못한 연속 — 운영 표도 '확인 멈춤'

    expect(providerMissing({ ...P, missing_listed: "EXT,KMA" }, NOW)?.text).toContain("목록에는 EXT/KMA");
    expect(providerMissing({ ...P, missing_since_tm: "", missing_last_tm: "", missing_tms: "", missing_checked_at: "" }, NOW)).toBeNull();
    expect(providerMissing({ name: "adsb_lol" }, NOW)).toBeNull();
    expect(providerMissing({ ...P, missing_tms: "many" }, NOW)).toBeNull();
  });
  it("providersNowMs: the server's generated_at (with an offset) is 'now' for the ops row — unknown is 0, never the browser clock", () => {
    expect(providersNowMs({ generated_at: "2026-09-30T00:52:00.123Z" })).toBe(Date.parse("2026-09-30T00:52:00.123Z"));
    expect(providersNowMs({ generated_at: "2026-09-30T09:52:00+09:00" })).toBe(Date.parse("2026-09-30T00:52:00Z"));
    for (const bad of [{}, null, { generated_at: "2026-09-30T00:52:00" }, { generated_at: 1790000000000 }, { generated_at: "yesterday" }]) expect(providersNowMs(bad)).toBe(0);
    expect(providerMissing(P, providersNowMs({}))?.stale).toBe(false); // 모르면 판정하지 않는다
  });
  it("run status: ok green, missing · quarantined amber with an explanation, other statuses as before", () => {
    expect(runStatusClass("ok", "item")).toBe("text-ok");
    expect(runStatusClass("missing", "item")).toBe("text-warn");
    expect(runStatusClass("quarantined", "item")).toBe("text-warn");
    expect(runStatusClass("error", "item")).toBe("text-bad");
    expect(runStatusClass("error", "summary")).toBe("text-warn");
    expect(RUN_STATUS_TITLE.missing).toContain("저장한 프레임 없음");
    expect(RUN_STATUS_TITLE.quarantined).toContain("격리");
  });
});

/**
 * 계약 v5 §G26(2026-09-30 저녁): 긴 연속에서 수집기가 확인 간격을 늘린다(연속이 60분을 넘으면 15분마다 — 수집기 선택값) — 기상청이 모든 바이너리 합성을
 * 멈춘 날, 5분마다 확인해 예산 1,000 을 하루 안에 넘을 속도였다. api missing.probe_every_s(초 — 수집기 해시 missing_probe_every_s 그대로)로 화면이 'N분마다
 * 확인'을 적고, '확인 멈춤' 기준도 그 간격 × 3(수집기 MISSING_STALE_PROBES — 아래로는 15분)을 따른다 — 고정 15분이면 늦춘 뒤 확인마다 '확인 멈춤'이
 * 깜박였다. 간격을 모르면(옛 api · 틀린 값) 전과 같다. 고치기 전 코드에서 실패하는 것을 먼저 확인했다.
 */
describe("§G26: the collector's probe interval says 'N분마다 확인' and sets the 확인 멈춤 bound", () => {
  const SLOW: KrRadarMissing = { ...MISS, probe_every_s: 900 };
  it("one line names the interval; the tooltip states the collector's rule", () => {
    const m = krMissing(SLOW, NOW)!;
    expect(m.text).toBe(`${LINE} · 15분마다 확인`);
    expect(m.title).toContain(`그동안 수집기가 15분마다 목록의 가장 새 tm 과 ${KR_MISSING_RECHECK_MIN}분 넘게 앞선 가장 새 tm 만 확인(수집기 선택값 — 연속이 ${KR_MISSING_SLOW_AFTER_MIN}분을 넘으면 ${KR_MISSING_SLOW_EVERY_MIN}분마다로 늘린다)`);
    expect(krMissing({ ...MISS, probe_every_s: 300 }, NOW)!.text).toBe(`${LINE} · 5분마다 확인`);
    expect(m.everyS).toBe(900);
  });
  it("확인 멈춤 after three intervals — 45 min when every 15 min, never below 15 min", () => {
    const at = Date.parse(MISS.checked_at);
    expect(krMissing(SLOW, at + 20 * 60_000)!.stale).toBe(false); // 전에는 15분에서 '확인 멈춤' — 늦춘 뒤 확인마다 깜박였다
    expect(krMissing(SLOW, at + 45 * 60_000)!.stale).toBe(false);
    const old = krMissing(SLOW, at + 45 * 60_000 + 1000)!;
    expect(old.stale).toBe(true);
    expect(old.staleMin).toBe(45);
    expect(old.text).toBe(`${LINE} · 15분마다 확인 — 45분 넘게 다시 확인하지 않음(확인 멈춤)`);
    expect(old.title).toContain("마지막 확인 뒤 45분 넘게 확인 없음 — 지금도 없는지는 모름");
    expect(krMissing({ ...MISS, probe_every_s: 300 }, at + 15 * 60_000 + 1000)!.stale).toBe(true);
    expect(krMissing({ ...MISS, probe_every_s: 60 }, at + 15 * 60_000)!.stale).toBe(false); // 아래로는 15분
  });
  it("an unknown or wrong interval is left out — the old wording and the 15 min bound", () => {
    for (const bad of [undefined, null, 0, -900, 1.5, "900", 86_401]) {
      const m = krMissing({ ...MISS, probe_every_s: bad as unknown as number }, NOW)!;
      expect(m.text, String(bad)).toBe(LINE);
      expect(m.everyS).toBeNull();
      expect(m.staleMin).toBe(KR_MISSING_CHECK_STALE_MIN);
      expect(m.title).toContain(`수집기가 주기마다 목록의 가장 새 tm 과 ${KR_MISSING_RECHECK_MIN}분 넘게 앞선 가장 새 tm 만 확인`);
    }
  });
  it("the numbers are the collector's choices (MISSING_SLOW_AFTER_S · MISSING_SLOW_EVERY_S · MISSING_STALE_PROBES)", () => {
    const py = readFileSync(new URL("../../collector/wakeline_collector/jobs/kma_radar.py", import.meta.url), "utf8");
    expect(Number(/^MISSING_SLOW_AFTER_S = (\d+) \* 60\b/m.exec(py)?.[1])).toBe(KR_MISSING_SLOW_AFTER_MIN);
    expect(Number(/^MISSING_SLOW_EVERY_S = (\d+) \* 60\b/m.exec(py)?.[1])).toBe(KR_MISSING_SLOW_EVERY_MIN);
    expect(Number(/^MISSING_STALE_PROBES = (\d+)\b/m.exec(py)?.[1])).toBe(KR_MISSING_STALE_PROBES);
  });
  it("status bar 상세 rule and the ops row follow the interval", () => {
    resetData();
    setData({ radarKr: kr({ missing: SLOW }) });
    const row = detailRows(statusInput(getData(), NOW, NOW)).find((r) => r.key === "kma-missing")!;
    expect(row.rule).toContain("수집기가 15분마다 목록의 가장 새 tm 과");
    expect(row.rule).toContain("마지막 확인이 45분을 넘으면 확인 멈춤(수집기 선택값)");
    resetData();
    const P = { name: "kma_radar", missing_since_tm: "202609300815", missing_last_tm: "202609300950", missing_tms: "20",
      missing_checked_at: "2026-09-30T00:50:31Z", missing_file: "RDR_CMP_HSR_PUB_202609300950.bin.gz", missing_listed: "EXT", missing_probe_every_s: "900" };
    expect(providerMissing(P, NOW)?.text).toBe(`${LINE} · 15분마다 확인`);
    expect(providerMissing(P, Date.parse("2026-09-30T01:20:00Z"))?.stale).toBe(false); // 29분 — 늦춘 간격의 기준(45분) 안
    expect(providerMissing({ ...P, missing_probe_every_s: "" }, NOW)?.text).toBe(LINE);
  });
  it("run status waiting (the collector did not call KMA in that cycle): amber with its meaning", () => {
    expect(runStatusClass("waiting", "item")).toBe("text-warn");
    expect(RUN_STATUS_TITLE.waiting).toContain("기상청을 부르지 않음");
    expect(RUN_STATUS_TITLE.waiting).toContain("공급자 오류가 아니다");
  });
});
