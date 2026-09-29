/**
 * 화면 시각은 한국 표준시(KST)만(사용자 결정 2026-09-30 "[상황판·재생·통계·공항 화면]을 포함한 필요한 메뉴에 시각을 UTC 지우고, KST 표시" —
 * 계약 v5 §G19 가 §G13 의 "KST 먼저 · UTC 함께" 를 대신한다). 한 곳(lib/time.ts · components/KstTime.tsx)에서 만든다 — 화면 시간대도 그 한 곳
 * (DISPLAY_TZ)이 정한다. UTC 는 저장 · 전송 형식(API · WS · DB · 로그)으로만 남는다.
 * - inline "09-29 14:02:54 KST" · 날짜가 자명한 자리 "14:02:54 KST" · 좁은 자리(분까지) "14:02 KST"
 * - 표 칸: "09-29 14:02:54"(머리글 "(KST)" — 화면 읽기에는 "… KST")
 * - 구간: 끝에 한 번 "09-29 10:00:00 – 09-29 14:00:00 KST", hh:mm 구간 "08:40–08:45 KST"
 * - title: 연도 · ms 까지의 KST "2026-09-29 08:41:14.906 KST"(원본 UTC ISO 는 화면 어디에도 없다), <time dateTime> 은 같은 순간의 ISO +09:00
 * - 모르면 "—" 만(시간대 글자 없이)
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다(새 API 가 없었다).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as T from "@/lib/time";
import { KstRange, KstTime } from "@/components/KstTime";
import { DualTime } from "@/components/DualTime";
import { byTestId, parseHtml, textOf } from "./helpers/html-tree";

/** UTC 자정 직전(09-28) — KST 로는 다음 날(09-29) 아침 */
const LATE = "2026-09-28T23:41:14.906Z";
/** 같은 날짜(09-29) */
const NOON = "2026-09-29T05:02:54Z";
const UNKNOWN = [null, undefined, "", "bad", Number.NaN, 8.64e15];

describe("the display zone is decided in one place", () => {
  it("DISPLAY_TZ names KST (+09:00, Asia/Seoul); every formatter labels with it", () => {
    expect(T.DISPLAY_TZ).toMatchObject({ label: "KST", iana: "Asia/Seoul", offsetMs: 9 * 3_600_000 });
    expect(T.fmtKst(NOON).endsWith(` ${T.DISPLAY_TZ.label}`)).toBe(true);
  });
});

describe("inline", () => {
  it("KST only — across the UTC and KST date changes (the UTC date never appears)", () => {
    expect(T.fmtKst(NOON)).toBe("09-29 14:02:54 KST");
    expect(T.fmtKst(LATE)).toBe("09-29 08:41:14 KST");
    expect(T.fmtKst(Date.parse(NOON))).toBe("09-29 14:02:54 KST"); // 숫자는 epoch ms
    expect(T.fmtKst("2026-09-28T14:59:59Z")).toBe("09-28 23:59:59 KST"); // KST 자정 직전
    expect(T.fmtKst("2026-09-28T15:00:00Z")).toBe("09-29 00:00:00 KST"); // KST 자정
    expect(T.fmtKst("2026-09-29T00:00:00Z")).toBe("09-29 09:00:00 KST"); // UTC 자정
    expect(T.fmtKst("2026-12-31T15:00:00Z", { year: true })).toBe("2027-01-01 00:00:00 KST"); // 해가 바뀜
    expect(T.fmtKst("2028-02-28T15:00:00Z")).toBe("02-29 00:00:00 KST"); // 윤일
    expect(T.fmtKst("2026-09-29T08:41:14.906+09:00")).toBe("09-29 08:41:14 KST"); // 이미 +09:00 인 ISO 도 같은 순간
  });
  it("clock, minute, year and millisecond forms", () => {
    expect(T.fmtKstClock(LATE)).toBe("08:41:14 KST");
    expect(T.fmtKstMinute(LATE)).toBe("08:41 KST");
    expect(T.fmtKstMinute(LATE, { date: true })).toBe("09-29 08:41 KST");
    expect(T.fmtKst(LATE, { year: true })).toBe("2026-09-29 08:41:14 KST");
    expect(T.fmtKst(LATE, { ms: true })).toBe("09-29 08:41:14.906 KST");
    expect(T.fmtKst(NOON, { seconds: false })).toBe("09-29 14:02 KST");
    expect(T.fmtKst(NOON, { date: false, seconds: false })).toBe("14:02 KST");
  });
  it("day-aware minute form: the KST date only when it is not today's KST date (or today is unknown)", () => {
    const NOW = Date.parse("2026-09-29T01:00:00Z"); // KST 09-29 10:00
    expect(T.fmtKstDayMinute("2026-09-28T15:30:00Z", NOW)).toBe("00:30 KST"); // UTC 로는 전날이지만 KST 로는 오늘
    expect(T.fmtKstDayMinute("2026-09-29T00:30:00Z", NOW)).toBe("09:30 KST");
    expect(T.fmtKstDayMinute("2026-09-28T14:30:00Z", NOW)).toBe("09-28 23:30 KST"); // KST 로 전날
    expect(T.fmtKstDayMinute("2026-09-28T14:30:00Z", 0)).toBe("09-28 23:30 KST"); // 지금을 모르면 날짜를 붙인다
    expect(T.fmtKstDayMinute(null, NOW)).toBe("—");
  });
});

describe("spans and ranges name the zone once at the end", () => {
  it("hh:mm spans (map line labels, AIS gap badge); an unknown side is —; both unknown → —", () => {
    expect(T.fmtKstSpan("2026-09-29T05:40:00Z", "2026-09-29T05:45:00Z")).toBe("14:40–14:45 KST");
    expect(T.fmtKstSpan("2026-09-28T23:50:00Z", "2026-09-29T00:05:00Z")).toBe("08:50–09:05 KST");
    expect(T.fmtKstSpan(null, "2026-09-29T05:45:00Z")).toBe("—–14:45 KST");
    expect(T.fmtKstSpan(null, null)).toBe("—");
    expect(T.fmtKstFrom("2026-09-28T23:40:00Z")).toBe("08:40 KST 부터");
    expect(T.fmtKstFrom(null)).toBe("—");
  });
  it("ranges: both ends dated, the zone once; an unknown end is — on its side only; an open end can say so", () => {
    expect(T.fmtKstRange("2026-09-28T23:00:00Z", "2026-09-29T03:00:00Z")).toBe("09-29 08:00:00 – 09-29 12:00:00 KST");
    expect(T.fmtKstRange("2026-09-29T01:00:00Z", "2026-09-29T05:00:00Z", { seconds: false })).toBe("09-29 10:00 – 09-29 14:00 KST");
    expect(T.fmtKstRange("2026-09-28T23:00:00Z", null)).toBe("09-29 08:00:00 KST – —");
    expect(T.fmtKstRange(null, "2026-09-29T03:00:00Z")).toBe("— – 09-29 12:00:00 KST");
    expect(T.fmtKstRange("2026-09-28T23:00:00Z", null, { open: "진행 중" })).toBe("09-29 08:00:00 KST – 진행 중");
    expect(T.fmtKstRange(null, "bad")).toBe("— – —");
  });
});

describe("table cell and titles", () => {
  it("cell: KST without the zone letters (the column header says (KST)); ms on request", () => {
    expect(T.kstCell(NOON)).toEqual({ text: "09-29 14:02:54", iso: "2026-09-29T14:02:54.000+09:00" });
    expect(T.kstCell(LATE, { ms: true })).toEqual({ text: "09-29 08:41:14.906", iso: "2026-09-29T08:41:14.906+09:00" });
    expect(T.kstCell(null)).toBeNull();
  });
  it("tooltips: the full KST instant (year · ms) — never the UTC original", () => {
    expect(T.fmtTimeTitle(LATE)).toBe("2026-09-29 08:41:14.906 KST");
    expect(T.fmtRangeTitle("2026-09-28T23:00:00Z", null)).toBe("2026-09-29 08:00:00.000 KST – —");
    expect(T.fmtRangeTitle(null, "bad")).toBeUndefined();
    for (const s of [T.fmtTimeTitle(LATE), T.fmtRangeTitle(LATE, NOON)]) expect(s).not.toMatch(/UTC|\d(Z|\.\d{3}Z)\b/);
  });
  it("copy format stays ISO 8601 with +09:00 (ms kept)", () => {
    expect(T.fmtIsoKst(LATE)).toBe("2026-09-29T08:41:14.906+09:00");
    expect(T.fmtIsoKst(null)).toBe("—");
  });
});

describe("KST days (stats aggregate by KST day — contract v5 §G19)", () => {
  it("the KST date of an instant", () => {
    expect(T.kstDayOf("2026-09-28T14:59:59Z")).toBe("2026-09-28");
    expect(T.kstDayOf("2026-09-28T15:00:00Z")).toBe("2026-09-29");
    expect(T.kstDayOf(null)).toBeNull();
  });
  it("the 24 hours of a KST day in order, each labelled with its KST hour (unknown date → the hour only)", () => {
    const h = T.kstDayHours("2026-09-29");
    expect(h.map((x) => x.label)).toEqual(Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")));
    expect(h[0].full).toBe("09-29 00시 KST");
    expect(h[23].full).toBe("09-29 23시 KST");
    for (const d of [null, "2026-9-29", "2026-02-30"]) expect(T.kstDayHours(d)[7].full, String(d)).toBe("07시 KST");
  });
  it("a UTC-day bucket (provider budget day) stated as its KST window — never relabelled as a KST date", () => {
    expect(T.utcDayWindowKst("2026-09-29")).toBe("09-29 09:00 – 09-30 08:59 KST");
    expect(T.utcDayWindowKst("2026-12-31")).toBe("12-31 09:00 – 01-01 08:59 KST");
    expect(T.utcDayWindowKst("2026-02-30")).toBeNull();
    expect(T.utcDayWindowKst(null)).toBeNull();
  });
});

describe("unknown values", () => {
  it("'—' only (no zone letters), no title; out-of-range values do not throw", () => {
    for (const v of UNKNOWN) {
      expect(T.fmtKst(v)).toBe("—");
      expect(T.fmtKstClock(v)).toBe("—");
      expect(T.fmtKstMinute(v)).toBe("—");
      expect(T.kstCell(v)).toBeNull();
      expect(T.timeParts(v)).toBeNull();
      expect(T.fmtTimeTitle(v)).toBeUndefined();
    }
  });
  it("the machine's time zone does not matter (no local-time reads)", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      expect(T.fmtKst(LATE)).toBe("09-29 08:41:14 KST");
    } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
  });
});

describe("performance: parsing an instant is cached (tables re-render every second with the same times)", () => {
  it("returns the same parts object for the same input, bounded", () => {
    const a = T.timeParts(LATE), b = T.timeParts(LATE);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    for (let i = 0; i < T.TIME_CACHE_MAX + 10; i++) T.timeParts(1_700_000_000_000 + i * 1000);
    expect(T.timeCacheSize()).toBeLessThanOrEqual(T.TIME_CACHE_MAX);
  });
});

describe("<KstTime> / <KstRange>", () => {
  const html = (el: ReturnType<typeof createElement>) => parseHtml(renderToStaticMarkup(el));
  it("inline: one <time> — KST text, dateTime = the instant as ISO +09:00, title = the full KST instant", () => {
    const s = renderToStaticMarkup(createElement(KstTime, { v: LATE, testId: "t" }));
    expect(s).toBe('<time dateTime="2026-09-29T08:41:14.906+09:00" title="2026-09-29 08:41:14.906 KST" class="mono whitespace-nowrap" data-testid="t">09-29 08:41:14 KST</time>');
    expect(textOf(byTestId(html(createElement(KstTime, { v: NOON, date: false, testId: "c" })), "c")!)).toBe("14:02:54 KST");
  });
  it("cell: the header names the zone; screen readers still hear KST", () => {
    const c = byTestId(html(createElement(KstTime, { v: LATE, variant: "cell", ms: true, testId: "c" })), "c")!;
    expect(textOf(c)).toBe("09-29 08:41:14.906 KST");
    expect(renderToStaticMarkup(createElement(KstTime, { v: LATE, variant: "cell" }))).toContain('09-29 08:41:14<span class="sr-only"> KST</span>');
  });
  it("range: each end nowrap, wraps only at the dash; title = both KST instants", () => {
    const r = renderToStaticMarkup(createElement(KstRange, { a: "2026-09-28T22:00:00Z", b: "2026-09-29T02:00:00Z" }));
    expect(r).toContain('<span class="whitespace-nowrap">09-29 07:00:00</span> – <span class="whitespace-nowrap">09-29 11:00:00 KST</span>');
    expect(r).toContain('title="2026-09-29 07:00:00.000 KST – 2026-09-29 11:00:00.000 KST"');
    expect(r.replace(/<[^>]+>/g, "")).toBe("09-29 07:00:00 – 09-29 11:00:00 KST");
    expect(renderToStaticMarkup(createElement(KstRange, { a: "2026-09-28T23:10:00Z", b: null, open: "진행 중" })).replace(/<[^>]+>/g, "")).toBe("09-29 08:10:00 KST – 진행 중");
  });
  it("unknown → — with no title and no <time>", () => {
    const s = renderToStaticMarkup(createElement(KstTime, { v: null }));
    expect(s.replace(/<[^>]+>/g, "")).toBe("—");
    expect(s).not.toContain("title=");
    expect(s).not.toContain("<time");
  });
});

describe("deprecated aliases kept for the other lane's files draw KST only (removed after the merge — contract v5 §G19)", () => {
  it("fmtDual · dualPair · <DualTime> (inline · compact · cell) never draw UTC", () => {
    expect(T.fmtDual(LATE)).toBe("09-29 08:41:14 KST");
    expect(T.dualPair(LATE, { date: false })).toEqual({ kst: "08:41:14 KST", iso: "2026-09-29T08:41:14.906+09:00" });
    expect(T.dualPair(null)).toBeNull();
    const txt = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/<[^>]+>/g, "");
    expect(txt(createElement(DualTime, { v: LATE }))).toBe("09-29 08:41:14 KST");
    expect(txt(createElement(DualTime, { v: LATE, variant: "compact", seconds: true }))).toBe("08:41:14 KST"); // 상태 바 region 시각
    expect(txt(createElement(DualTime, { v: LATE, variant: "compact" }))).toBe("08:41 KST");
    expect(txt(createElement(DualTime, { v: LATE, date: false }))).toBe("08:41:14 KST"); // 알림 배너
    expect(txt(createElement(DualTime, { v: LATE, variant: "cell" }))).toBe("09-29 08:41:14 KST");
    expect(renderToStaticMarkup(createElement(DualTime, { v: LATE }))).not.toMatch(/UTC|\d(Z|\.\d{3}Z)"/);
  });
});
