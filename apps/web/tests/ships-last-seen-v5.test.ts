/**
 * 계약 v5 §G4(웹): 저장만 된 선박(실시간 아님)은 api 의 last_seen_at(마지막 수신 기록 — ship.last_seen, 저장 위치가 더 늦으면 그 시각)으로
 * "마지막 수신 hh:mm" 을 보인다 — 선박 카드 · 통합 검색(표 · 선택 문구). 모르면 "—"(지어내지 않는다). 실시간 선박은 관측 시각이 마지막 수신이다.
 * MMSI·선명은 합성(SYNTHETIC) 값이다. 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notLiveText, sortShipRows, type ShipRow } from "@/lib/ships";
import { parseShipSearchResponse, shipChoice, shipRowFromHit } from "@/lib/search";
import { resetData, setData } from "@/lib/store";
import { ShipTable } from "@/components/ShipTable";
import { SearchResultsView } from "@/components/AircraftSearch";
import { parseShipDetail, ShipCardView } from "@/components/ShipCard";

const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
const NOW = Date.parse("2026-09-28T03:00:00Z");

describe("v5-G4 last reception of a ship that is not live", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());

  it("search items: last_seen_at is read for stored-only ships; a live item never carries one (seen_at is its last reception)", () => {
    const hits = parseShipSearchResponse({ items: [
      { mmsi: "440123456", name: "SYN ALPHA", live: true, lat: 35.1, lon: 129.1, seen_at: "2026-09-28T02:59:00Z", last_position_at: "2026-09-28T02:58:00Z", last_seen_at: "2026-09-28T02:00:00Z" },
      { mmsi: "440999999", name: "SYN BRAVO", live: false, last_position_at: "2026-09-28T01:00:00Z", last_seen_at: "2026-09-28T01:05:00Z" },
      { mmsi: "440999998", name: "SYN OLD", live: false, last_position_at: null, last_seen_at: "2026-09-24T10:00:00Z" },
      { mmsi: "440999997", name: "SYN OLDER API", live: false, last_position_at: null }, // §G4 전 api — 모름
      { mmsi: "440999996", name: "SYN BAD", live: false, last_seen_at: "yesterday" },
    ] });
    expect(hits.map((h) => h.last_seen_at)).toEqual([null, "2026-09-28T01:05:00Z", "2026-09-24T10:00:00Z", null, null]);
    expect(shipRowFromHit(hits[1], null).last_seen_at).toBe("2026-09-28T01:05:00Z");
  });

  it("not-live text: 마지막 수신 then 마지막 저장, hh:mm UTC (date when another UTC day), — when unknown", () => {
    expect(notLiveText({ lastSeenAt: "2026-09-28T02:59:00Z", lastPositionAt: "2026-09-28T02:40:00Z" }, NOW)).toBe("실시간 아님 · 마지막 수신 02:59 UTC · 마지막 저장 02:40 UTC");
    expect(notLiveText({ lastSeenAt: "2026-09-24T10:00:00Z", lastPositionAt: null }, NOW)).toBe("실시간 아님 · 마지막 수신 09-24 10:00 UTC · 마지막 저장 —");
    expect(notLiveText({ lastSeenAt: null, lastPositionAt: null }, NOW)).toBe("실시간 아님 · 마지막 수신 — · 마지막 저장 —");
  });

  it("choosing a stored-only ship from the search says when it was last heard", () => {
    const [stored] = parseShipSearchResponse({ items: [{ mmsi: "440999999", name: null, live: false, last_position_at: "2026-09-28T01:00:00Z", last_seen_at: "2026-09-28T01:05:00Z" }] });
    expect(shipChoice(stored, null, NOW).message).toBe("MMSI 440999999 선택 — 실시간 아님 · 마지막 수신 01:05 UTC · 마지막 저장 01:00 UTC · 카드만(지도에 위치를 그리지 않음)");
  });

  it("search table: a not-live row shows 마지막 수신 and 저장 (— when unknown); the age sort uses the last reception", () => {
    const ships = { hits: parseShipSearchResponse({ items: [
      { mmsi: "440999999", name: "SYN BRAVO", ship_type: 80, live: false, last_position_at: "2026-09-28T01:00:00Z", last_seen_at: "2026-09-28T01:05:00Z" },
      { mmsi: "440999998", name: "SYN OLD", ship_type: 80, live: false, last_position_at: null, last_seen_at: null },
    ] }), state: "done" as const, msg: "2건" };
    const html = renderToStaticMarkup(createElement(SearchResultsView, {
      uid: "s", aircraft: { hits: [], state: "idle" as const, msg: "" }, ships, active: -1, now: NOW, shipSort: null,
      onShipSort: () => {}, onChooseAircraft: () => {}, onChooseShip: () => {}, onHover: () => {},
    }));
    const r1 = /data-mmsi="440999999".*?<\/tr>/.exec(html)![0];
    expect(text(r1)).toContain("실시간 아님");
    expect(text(r1)).toContain("마지막 수신 01:05 UTC");
    expect(text(r1)).toContain("저장 01:00 UTC");
    expect(r1).toContain('title="마지막 수신 2026-09-28T01:05:00.000Z');
    const r2 = /data-mmsi="440999998".*?<\/tr>/.exec(html)![0];
    expect(text(r2)).toContain("마지막 수신 —");
    expect(text(html)).toContain("마지막 수신·저장 시각은 UTC");
    const row = (mmsi: string, over: Partial<ShipRow>): ShipRow => ({ mmsi, name: null, category: "unknown", sog_kn: null, nav_status: null, live: false, seen_at: null, last_position_at: null, last_seen_at: null, ...over });
    // 저장 위치는 같지만 마지막 수신이 다르면 수신이 늦은 쪽이 경과가 짧다
    const rows = [row("300000001", { last_position_at: "2026-09-28T01:00:00Z", last_seen_at: "2026-09-28T01:00:00Z" }), row("300000002", { last_position_at: "2026-09-28T01:00:00Z", last_seen_at: "2026-09-28T02:30:00Z" })];
    expect(sortShipRows(rows, { key: "age", dir: "asc" }, NOW).map((r) => r.mmsi)).toEqual(["300000002", "300000001"]);
    const plain = renderToStaticMarkup(createElement(ShipTable, { rows, now: NOW, sort: null, onSort: () => {}, onPick: () => {}, testId: "ship-list" }));
    expect(text(plain)).toContain("마지막 수신 02:30 UTC");
  });

  it("ship card: a not-live ship shows the 마지막 수신 row (with the elapsed time) and the badge; — when the api gives none; a live ship has no such row", () => {
    const detail = parseShipDetail("431011305", { state: null, static: { name: "SYN BRAVO", ship_type: 70 }, first_recorded_at: "2026-09-20T01:02:03Z", last_position_at: "2026-09-28T01:00:00Z", last_seen_at: "2026-09-28T01:05:00Z", meta: {} });
    expect(detail.last_seen_at).toBe("2026-09-28T01:05:00Z");
    const html = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "431011305", detail, error: null, now: NOW }));
    const t = text(html);
    expect(t).toContain("마지막 수신09-28 01:05:00Z (1h 55m 전)");
    expect(t).toContain("실시간 아님 · 마지막 수신 01:05 UTC · 마지막 저장 01:00 UTC");
    expect(html).toMatch(/data-field="마지막 수신"/);
    const unknown = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "431011305", detail: parseShipDetail("431011305", { state: null, static: null, last_seen_at: 7 }), error: null, now: NOW }));
    expect(text(unknown)).toContain("마지막 수신—");
    expect(text(unknown)).toContain("실시간 아님 · 마지막 수신 — · 마지막 저장 —");
    setData({ shipSelected: { mmsi: "431011305", received_at: 0, static: null, state: { mmsi: "431011305", lat: 35, lon: 129, sog_kn: 1, cog_deg: null, heading_deg: null, ship_type: 70, name: "SYN BRAVO", seen_at: "2026-09-28T02:59:00Z", position_source: null, nav_status: null, rot: null, provider: "fixture", msg_type: null, class: "A" } } });
    const live = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "431011305", detail, error: null, now: NOW }));
    expect(live).not.toMatch(/data-field="마지막 수신"/);
  });
});
