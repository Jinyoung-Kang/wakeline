/**
 * 기상특보 탭 · 선박 카드 한 줄(계약 v5 §G49 · ADR-036 · SPEC F3): 응답 검증(틀린 항목은 버리고 셈) · 묶기(해상은 상위 구역별 먼저, 육상은 따로) ·
 * 발효 글(예비는 때 — 시각을 짐작하지 않음) · 상태 줄(수신 전 · N건 · 오래됨 · 조회 실패 — KST) · 조회기(ETag) · 화면.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { effectiveText, groupWarnings, parseWarnings, warningsPoller, warningsStatus, WARNINGS_URL, type Warnings } from "@/lib/warnings";
import { WarningPanelView } from "@/components/WarningPanel";
import { SeaWarningsLineView } from "@/components/ShipCard";
import type { PollState } from "@/lib/etag-poller";

const NOW = Date.parse("2026-10-09T07:10:00Z");
const pre = {
  zone_code: "S1312020", zone_name: "남해동부바깥먼바다", parent_code: "S1310000", parent_name: "남해동부전해상", sea: true, kind: "풍랑", level: "예비",
  command: "발표", preliminary: true, issued_at: "2026-10-09T07:00:00Z", effective_from: "2026-10-10T03:00:00Z", effective_to: "2026-10-10T09:00:00Z",
  effective_text: "10-10 오후(12–18시 KST)", raw: "S1310000, 남해동부전해상, S1312020, …,=",
};
const land = { zone_code: "L1100100", zone_name: "서울", sea: false, kind: "호우", level: "주의보", command: "발표", preliminary: false,
  issued_at: "2026-10-09T06:00:00Z", effective_at: "2026-10-09T07:00:00Z", end_notice: "202610091800", raw: "L…,=" };
const storm = { ...pre, zone_code: "S1324020", zone_name: "제주도남쪽바깥먼바다", parent_name: "제주도전해상", level: "경보", preliminary: false,
  effective_at: "2026-10-09T08:00:00Z", effective_text: undefined, effective_from: undefined, effective_to: undefined };
const body = (over: Record<string, unknown> = {}) => ({ received: true, items: [pre, land, storm], dropped: 0, source: "기상청 API허브 특보현황",
  meta: { stale: false, fetched_at: "2026-10-09T07:05:00Z" }, ...over });
const ws = (over: Record<string, unknown> = {}) => parseWarnings(body(over)) as Warnings;
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("parse and group", () => {
  it("reads the list and drops bad items", () => {
    const w = ws({ items: [pre, { ...land, zone_code: "X" }, { ...land, sea: "no" }, land] });
    expect(w.items.map((x) => x.zone_code)).toEqual(["S1312020", "L1100100"]);
    expect(w.bad).toBe(2);
    expect(parseWarnings({ ...body(), meta: null })).toBeNull();
    expect(parseWarnings(null)).toBeNull();
  });
  it("sea first by parent area (warning before advisory before preliminary), land separate", () => {
    const g = groupWarnings(ws().items);
    expect(g.sea.map((x) => x.parent)).toEqual(["남해동부전해상", "제주도전해상"]);
    expect(g.land.map((x) => x.zone_code)).toEqual(["L1100100"]);
  });
  it("a preliminary warning shows its time slot, never an invented time", () => {
    const w = ws();
    expect(effectiveText(w.items[0])).toBe("10-10 오후(12–18시 KST) 예상");
    expect(effectiveText(w.items[1])).toBe("10-09 16:00 KST 발효");
    expect(effectiveText({ ...w.items[1], effective_at: undefined })).toBe("—");
  });
});

describe("status line", () => {
  it("not received, counts, stale and errors", () => {
    expect(warningsStatus(ws({ received: false, items: [] }), null, NOW).text).toMatch(/^특보 목록 수신 전/);
    // 발효 중은 발효 시각이 지난 정규 특보만 — 예비 · 발효 예정(경보 08:00Z)은 따로(QA-709)
    expect(warningsStatus(ws(), null, NOW)).toEqual({ text: "발효 중 1건(해상 0 · 육상 1) · 발효 예정 1 · 예비 1 · 기상청 API허브 특보현황 · 받음 16:05 KST", tone: "ok" });
    expect(warningsStatus(ws(), null, NOW + 3600_000).text).toMatch(/^발효 중 2건\(해상 1 · 육상 1\) · 예비 1 · /);
    expect(warningsStatus(ws(), null, NOW + 20 * 60_000).text).toMatch(/오래됨 — 25분 전 목록$/);
    expect(warningsStatus(ws({ dropped: 2 }), "HTTP 503", NOW)).toMatchObject({ tone: "warn" });
    expect(warningsStatus(null, "HTTP 503", NOW)).toEqual({ text: "조회 실패(HTTP 503)", tone: "bad" });
    expect(warningsStatus(null, null, NOW).text).toBe("받는 중…");
  });
});

describe("views", () => {
  const poll = (data: Warnings | null): PollState<Warnings> => ({ data, etag: null, error: null, version: 1, checkedAt: 1 });
  it("panel lists sea groups and folds land; empty says so", () => {
    const t = text(renderToStaticMarkup(createElement(WarningPanelView, { poll: poll(ws()), nowMs: NOW })));
    expect(t).toContain("해상 · 남해동부전해상");
    expect(t).toContain("남해동부바깥먼바다 풍랑 예비 · 발표 · 10-10 오후(12–18시 KST) 예상");
    expect(t).toContain("육상 특보 1건");
    expect(t).toContain("해제예고 202610091800");
    const e = text(renderToStaticMarkup(createElement(WarningPanelView, { poll: poll(ws({ items: [] })), nowMs: NOW })));
    expect(e).toContain("지금 발효 중인 기상특보가 없습니다");
  });
  it("ship card line counts sea warnings without judging the ship's area", () => {
    const t = text(renderToStaticMarkup(createElement(SeaWarningsLineView, { w: ws() })));
    // 시각을 주지 않으면 목록을 받은 때(07:05Z) 기준 — 경보(08:00Z 발효)는 발효 예정, 예비는 따로(QA-709)
    expect(t).toContain("해상특보: 지금 발효 중 0건 · 발효 예정 1 · 예비 1 — 이 선박의 구역은 판정하지 않음(구역 경계 자료 없음)");
    const later = text(renderToStaticMarkup(createElement(SeaWarningsLineView, { w: ws(), now: NOW + 3600_000 })));
    expect(later).toContain("해상특보: 지금 발효 중 1건(풍랑 경보) · 예비 1 — ");
    expect(renderToStaticMarkup(createElement(SeaWarningsLineView, { w: null }))).toBe("");
    expect(renderToStaticMarkup(createElement(SeaWarningsLineView, { w: ws({ received: false, items: [] }) }))).toBe("");
  });
});

describe("poller", () => {
  it("uses ETag", async () => {
    const calls: (string | undefined)[] = [];
    const answers = [() => new Response(JSON.stringify(body()), { status: 200, headers: { ETag: '"w1"' } }), () => new Response(null, { status: 304 })];
    const states: PollState<Warnings>[] = [];
    const p = warningsPoller((s) => states.push(s), undefined, async (url, init) => {
      expect(url).toBe(WARNINGS_URL);
      calls.push((init.headers as Record<string, string>)["If-None-Match"]);
      return answers.shift()!();
    }, () => false, () => 5);
    await p.poll();
    await p.poll();
    expect(calls).toEqual([undefined, '"w1"']);
    expect(states.at(-1)!.data!.items).toHaveLength(3);
  });
});
