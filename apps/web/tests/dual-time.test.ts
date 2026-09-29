/**
 * 시각 표시 규칙(사용자 요청 2026-09-29 "UTC와 KST 함께 표시" — 계약 v5 §G10 · §G11 의 KST 만 보이던 규칙을 대신한다):
 * 한국 표준시(KST)를 먼저, UTC 를 함께. 한 곳(lib/time.ts · components/DualTime.tsx)에서 만든다.
 * - inline "09-29 14:02:54 KST · 05:02:54 UTC" · 날짜가 자명한 자리 "14:02:54 KST · 05:02:54 UTC"
 * - 표 칸: 첫 줄 KST(머리글 "(KST · UTC)"), 둘째 줄 흐린 UTC — 칸이 넓어지지 않게
 * - compact(상태 바 · 지도 툴팁): "14:02 KST · 05:02Z"
 * - UTC 날짜가 KST 날짜와 다르면 UTC 쪽에 날짜를 붙인다(UTC 자정 전후 — KST 09:00 이전).
 * - 모르면 "—" 만(시간대 글자 없이). 원문(METAR · TAF · SIGMET) · 통계의 UTC 날짜 · 복사 형식은 그대로.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as T from "@/lib/time";
import { DualRange, DualTime } from "@/components/DualTime";
import { byTestId, parseHtml, textOf } from "./helpers/html-tree";

/** UTC 자정 직전(09-28) — KST 로는 다음 날(09-29) 아침: UTC 날짜가 다르다 */
const LATE = "2026-09-28T23:41:14.906Z";
/** 같은 날짜(09-29) */
const NOON = "2026-09-29T05:02:54Z";
const UNKNOWN = [null, undefined, "", "bad", Number.NaN, 8.64e15];

describe("inline", () => {
  it("KST first, UTC with it; the UTC date only when it differs from the KST date", () => {
    expect(T.fmtDual(NOON)).toBe("09-29 14:02:54 KST · 05:02:54 UTC");
    expect(T.fmtDual(LATE)).toBe("09-29 08:41:14 KST · 09-28 23:41:14 UTC");
    expect(T.fmtDual(Date.parse(NOON))).toBe("09-29 14:02:54 KST · 05:02:54 UTC"); // 숫자는 epoch ms
    expect(T.fmtDual("2026-09-28T15:00:00Z")).toBe("09-29 00:00:00 KST · 09-28 15:00:00 UTC"); // KST 자정
    expect(T.fmtDual("2026-09-29T00:00:00Z")).toBe("09-29 09:00:00 KST · 00:00:00 UTC"); // UTC 자정 — 같은 날짜
    expect(T.fmtDual("2026-12-31T20:00:00Z")).toBe("01-01 05:00:00 KST · 12-31 20:00:00 UTC"); // 해가 바뀜
  });
  it("clock form (date self-evident) still names the UTC date when it differs", () => {
    expect(T.fmtDualClock(NOON)).toBe("14:02:54 KST · 05:02:54 UTC");
    expect(T.fmtDualClock(LATE)).toBe("08:41:14 KST · 09-28 23:41:14 UTC");
  });
  it("year and millisecond forms", () => {
    expect(T.fmtDual(LATE, { year: true })).toBe("2026-09-29 08:41:14 KST · 2026-09-28 23:41:14 UTC");
    expect(T.fmtDual(NOON, { year: true })).toBe("2026-09-29 14:02:54 KST · 05:02:54 UTC");
    expect(T.fmtDual(LATE, { ms: true })).toBe("09-29 08:41:14.906 KST · 09-28 23:41:14.906 UTC");
    expect(T.fmtDual(NOON, { seconds: false })).toBe("09-29 14:02 KST · 05:02 UTC");
  });
  it("the two parts separately (for styling the UTC part muted)", () => {
    expect(T.dualPair(LATE)).toEqual({ kst: "09-29 08:41:14 KST", utc: "09-28 23:41:14 UTC", iso: "2026-09-28T23:41:14.906Z" });
    expect(T.dualPair(null)).toBeNull();
  });
});

describe("compact (status bar, map tooltips)", () => {
  it("HH:MM KST · HH:MMZ; seconds and the KST date on request; the UTC date when it differs", () => {
    expect(T.fmtDualCompact(NOON)).toBe("14:02 KST · 05:02Z");
    expect(T.fmtDualCompact(LATE)).toBe("08:41 KST · 09-28 23:41Z");
    expect(T.fmtDualCompact(NOON, { seconds: true })).toBe("14:02:54 KST · 05:02:54Z");
    expect(T.fmtDualCompact(NOON, { date: true })).toBe("09-29 14:02 KST · 05:02Z");
    expect(T.fmtDualCompact(LATE, { date: true, seconds: true })).toBe("09-29 08:41:14 KST · 09-28 23:41:14Z");
  });
  it("day-aware: the KST date only when it is not today's KST date", () => {
    const NOW = Date.parse("2026-09-29T01:00:00Z"); // KST 09-29 10:00
    expect(T.fmtDualDayMinute("2026-09-28T15:30:00Z", NOW)).toBe("00:30 KST · 09-28 15:30Z"); // KST 로는 오늘, UTC 로는 전날
    expect(T.fmtDualDayMinute("2026-09-29T00:30:00Z", NOW)).toBe("09:30 KST · 00:30Z");
    expect(T.fmtDualDayMinute("2026-09-28T14:30:00Z", NOW)).toBe("09-28 23:30 KST · 14:30Z"); // KST 로 전날
    expect(T.fmtDualDayMinute("2026-09-28T14:30:00Z", 0)).toBe("09-28 23:30 KST · 14:30Z"); // 지금을 모르면 날짜를 붙인다
  });
  it("hh:mm spans (map line labels, AIS gap badge) name each zone once", () => {
    expect(T.fmtDualSpan("2026-09-29T05:40:00Z", "2026-09-29T05:45:00Z")).toBe("14:40–14:45 KST · 05:40–05:45Z");
    expect(T.fmtDualSpan("2026-09-28T23:40:00Z", "2026-09-28T23:45:00Z")).toBe("08:40–08:45 KST · 09-28 23:40–23:45Z");
    expect(T.fmtDualSpan("2026-09-28T23:50:00Z", "2026-09-29T00:05:00Z")).toBe("08:50–09:05 KST · 09-28 23:50–09-29 00:05Z");
    expect(T.fmtDualSpan(null, "2026-09-29T05:45:00Z")).toBe("—–14:45 KST · —–05:45Z");
    expect(T.fmtDualSpan(null, null)).toBe("—");
  });
  it("from-time (open spans): '08:40 KST · 09-28 23:40Z 부터'", () => {
    expect(T.fmtDualFrom("2026-09-28T23:40:00Z")).toBe("08:40 KST · 09-28 23:40Z 부터");
    expect(T.fmtDualFrom(null)).toBe("—");
  });
});

describe("ranges", () => {
  it("each zone once at the end; UTC dates on both ends when either end's UTC date differs from its KST date", () => {
    expect(T.fmtDualRange("2026-09-29T01:00:00Z", "2026-09-29T05:00:00Z")).toBe("09-29 10:00:00 – 09-29 14:00:00 KST · 01:00:00 – 05:00:00 UTC");
    expect(T.fmtDualRange("2026-09-28T23:00:00Z", "2026-09-29T03:00:00Z")).toBe("09-29 08:00:00 – 09-29 12:00:00 KST · 09-28 23:00:00 – 09-29 03:00:00 UTC");
    expect(T.fmtDualRange("2026-09-29T01:00:00Z", "2026-09-29T05:00:00Z", { seconds: false })).toBe("09-29 10:00 – 09-29 14:00 KST · 01:00 – 05:00 UTC");
  });
  it("an unknown end is — on its side only; an open end can say so; nothing known → '— – —'", () => {
    expect(T.fmtDualRange("2026-09-28T23:00:00Z", null)).toBe("09-29 08:00:00 KST · 09-28 23:00:00 UTC – —");
    expect(T.fmtDualRange(null, "2026-09-29T03:00:00Z")).toBe("— – 09-29 12:00:00 KST · 03:00:00 UTC");
    expect(T.fmtDualRange(null, "bad")).toBe("— – —");
    expect(T.fmtDualRange("2026-09-28T23:00:00Z", null, { open: "진행 중" })).toBe("09-29 08:00:00 KST · 09-28 23:00:00 UTC – 진행 중");
  });
});

describe("table cell", () => {
  it("KST on the first line, UTC (muted) on the second; the UTC date when it differs; ms on request", () => {
    expect(T.dualCell(NOON)).toEqual({ kst: "09-29 14:02:54", utc: "05:02:54 UTC", iso: "2026-09-29T05:02:54.000Z" });
    expect(T.dualCell(LATE)).toEqual({ kst: "09-29 08:41:14", utc: "09-28 23:41:14 UTC", iso: LATE });
    expect(T.dualCell(LATE, { ms: true })).toMatchObject({ kst: "09-29 08:41:14.906", utc: "09-28 23:41:14.906 UTC" });
    expect(T.dualCell(null)).toBeNull();
  });
});

describe("unknown values", () => {
  it("'—' only (no zone letters), no title; out-of-range values do not throw", () => {
    for (const v of UNKNOWN) {
      expect(T.fmtDual(v)).toBe("—");
      expect(T.fmtDualClock(v)).toBe("—");
      expect(T.fmtDualCompact(v)).toBe("—");
      expect(T.dualCell(v)).toBeNull();
      expect(T.dualParts(v)).toBeNull();
    }
  });
  it("the machine's time zone does not matter (no local-time reads)", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      expect(T.fmtDual(LATE)).toBe("09-29 08:41:14 KST · 09-28 23:41:14 UTC");
    } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
  });
});

describe("KMA tm (KST wall time from KMA) → the instant, shown in both zones", () => {
  it("YYYYMMDDHHMM read as +09:00; malformed or impossible → null", () => {
    expect(T.kstWallMs("202609290840")).toBe(Date.parse("2026-09-28T23:40:00Z"));
    for (const v of [null, "", "20260929084", "202602300840", "202609292400", "abc"]) expect(T.kstWallMs(v)).toBeNull();
    expect(T.fmtDualCompact(T.kstWallMs("202609290840"))).toBe("08:40 KST · 09-28 23:40Z");
  });
});

describe("performance: parsing an instant is cached (tables re-render every second with the same times)", () => {
  it("returns the same parts object for the same input, bounded", () => {
    const a = T.dualParts(LATE), b = T.dualParts(LATE);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    for (let i = 0; i < T.DUAL_CACHE_MAX + 10; i++) T.dualParts(1_700_000_000_000 + i * 1000);
    expect(T.dualCacheSize()).toBeLessThanOrEqual(T.DUAL_CACHE_MAX);
  });
});

describe("<DualTime>", () => {
  const html = (el: ReturnType<typeof createElement>) => parseHtml(renderToStaticMarkup(el));
  it("inline: KST, then the UTC part muted; the whole reads as the inline text; <time datetime> carries the ISO instant; title has the UTC original", () => {
    const root = html(createElement(DualTime, { v: LATE, testId: "t" }));
    const t = byTestId(root, "t")!;
    expect(textOf(t)).toBe("09-29 08:41:14 KST · 09-28 23:41:14 UTC");
    expect(t.attrs.title).toBe("원본 UTC 2026-09-28T23:41:14.906Z");
    expect(renderToStaticMarkup(createElement(DualTime, { v: LATE }))).toContain('<time dateTime="2026-09-28T23:41:14.906Z"');
    expect(renderToStaticMarkup(createElement(DualTime, { v: LATE }))).toMatch(/<span class="text-fg-3"> · <span class="whitespace-nowrap">09-28 23:41:14 UTC<\/span><\/span>/);
  });
  it("a narrow card wraps between the KST and UTC parts, never inside one (each part is nowrap, the separator is not)", () => {
    const s = renderToStaticMarkup(createElement(DualTime, { v: LATE }));
    expect(s).toContain('<time dateTime="2026-09-28T23:41:14.906Z" class="whitespace-nowrap">09-29 08:41:14 KST</time>');
    const r = renderToStaticMarkup(createElement(DualRange, { a: "2026-09-28T22:00:00Z", b: "2026-09-29T02:00:00Z" }));
    expect(r).toContain('<span class="whitespace-nowrap">09-29 07:00:00 – 09-29 11:00:00 KST</span>');
    expect(r).toContain('<span class="text-fg-3"> · <span class="whitespace-nowrap">09-28 22:00:00 – 09-29 02:00:00 UTC</span></span>');
    expect(r.replace(/<[^>]+>/g, "")).toBe("09-29 07:00:00 – 09-29 11:00:00 KST · 09-28 22:00:00 – 09-29 02:00:00 UTC");
  });
  it("cell: two lines; screen readers hear both zones", () => {
    const root = html(createElement(DualTime, { v: LATE, variant: "cell", testId: "c" }));
    const c = byTestId(root, "c")!;
    expect(textOf(c)).toBe("09-29 08:41:14 KST · 09-28 23:41:14 UTC");
    expect(renderToStaticMarkup(createElement(DualTime, { v: LATE, variant: "cell" }))).toMatch(/<span class="block text-\[10px\] text-fg-3">09-28 23:41:14 UTC<\/span>/);
  });
  it("compact and clock variants", () => {
    expect(textOf(html(createElement(DualTime, { v: NOON, variant: "compact", seconds: true })))).toBe("14:02:54 KST · 05:02:54Z");
    expect(textOf(html(createElement(DualTime, { v: NOON, date: false })))).toBe("14:02:54 KST · 05:02:54 UTC");
  });
  it("unknown → — with no title and no <time>", () => {
    const s = renderToStaticMarkup(createElement(DualTime, { v: null }));
    expect(s.replace(/<[^>]+>/g, "")).toBe("—");
    expect(s).not.toContain("title=");
    expect(s).not.toContain("<time");
  });
});
