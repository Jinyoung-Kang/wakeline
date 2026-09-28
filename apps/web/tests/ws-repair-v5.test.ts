/**
 * 계약 v5 §E2(2차 리뷰): 버린 메시지 뒤의 복구가 그 종류에 맞는가.
 * - 알림: 배치는 증분이라 다음 배치로 바로잡히지 않는다 — 버린 alerts/alerts_batch · 버린 알림 원소 · 버전 틈(v > 현재+1)이면 알림 수를 모름("—")으로
 *   두고 {type:"resync", scope:"alerts"} 로 전체 목록을 다시 받는다. 첫 전체 목록을 버렸으면 뒤이은 배치가 수를 "아는 것"으로 만들지 않는다(R-09).
 * - SIGMET · 레이더: 그 목록만 scope 로 다시 받는다. status · selected · demand · error 는 다음 갱신(30 s heartbeat · 바뀔 때)에 오고 resync 하지 않는다 —
 *   항공기 스냅샷(1만 대면 2 MB)을 끌어오지 않는다. 항공기 · 선박 흐름과 JSON 이 아닌 프레임만 scope 없는 resync.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertPanel } from "@/components/AlertPanel";
import { alertListState } from "@/lib/alerts";
import { applyAlertsBatch } from "@/lib/ws-protocol";
import type { Alert } from "@/lib/types";
import { getData, resetData, setData } from "@/lib/store";
import { ac, setup, snap, TS, welcomed } from "./helpers/fake-ws";
import { validate } from "./helpers/mini-schema";

type Json = Record<string, unknown>;
const clientSchema = JSON.parse(readFileSync(new URL("../../../schemas/ws/client.v1.json", import.meta.url), "utf8")) as Json;

const hexOf = (id: number) => (0xaaa000 + id).toString(16);
const alert = (id: number, kind: "OBSERVED" | "PREDICTED" = "OBSERVED") => ({
  id, kind, hex: hexOf(id), sigmet_id: "RKRR:S1", fir_id: "RKRR", hazard: "TS", entered_at: TS, evidence: { judged_at: TS }, estimated: kind === "PREDICTED",
});
const full = (version: number, ids: number[]) => ({ type: "alerts", version, alerts: ids.map((i) => alert(i)) });
const batch = (version: number, items: [string, number][]) => ({ type: "alerts_batch", version, items: items.map(([event, id]) => ({ event, alert: alert(id) })) });
const ids = () => [...getData().alerts.keys()].sort((a, b) => a - b);
type T = ReturnType<typeof setup>;
/** scope 없는 resync(항공기 · 선박 스냅샷) 수 */
const plainResyncs = (t: T) => t.ws().sent.filter((m) => m.type === "resync" && m.scope === undefined).length;
/** scope 가 있는 resync 수 */
const scoped = (t: T, scope: string) => t.ws().sent.filter((m) => m.type === "resync" && m.scope === scope).length;
const panel = () => renderToStaticMarkup(createElement(AlertPanel)).replace(/<[^>]+>/g, "");

beforeEach(() => { resetData(); vi.useFakeTimers(); vi.setSystemTime(Date.parse(TS)); });
afterEach(() => { vi.useRealTimers(); resetData(); });

describe("alerts: a dropped or missing piece makes the counts unknown and asks for the full list (scope alerts)", () => {
  it("a malformed alerts_batch: counts '—', one alerts resync (no aircraft snapshot); later batches are applied but the counts stay unknown until the full list", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(full(1, [1, 2]));
    expect(getData().alertsVersion).toBe(1);
    t.ws().recv({ type: "alerts_batch", version: 2, items: "ENTERED 3" });
    expect(getData().alertsVersion).toBeNull();
    expect(getData().alertsIncomplete).toBe(true);
    expect(scoped(t, "alerts")).toBe(1);
    expect(plainResyncs(t)).toBe(0);
    t.ws().recv(batch(3, [["ENTERED", 4]]));
    expect(ids()).toEqual([1, 2, 4]); // 받은 증분은 반영한다(실제 서버 값)
    expect(getData().alertsVersion).toBeNull(); // 그래도 목록은 빠진 것이 있다 — 수는 모름
    setData({ status: { region: { center: [36.5, 127.8], radius_nm: 250 } } as never, lastRxAt: Date.now() });
    expect(panel()).toContain("전세계 —");
    expect(panel()).toContain("— inside · — predicted");
    t.ws().recv(full(3, [1, 2, 3, 4]));
    expect(ids()).toEqual([1, 2, 3, 4]);
    expect(getData().alertsVersion).toBe(3);
    expect(getData().alertsIncomplete).toBe(false);
    t.ws().recv(batch(4, [["LEFT", 1]]));
    expect(ids()).toEqual([2, 3, 4]);
    expect(getData().alertsVersion).toBe(4);
    expect(scoped(t, "alerts")).toBe(1);
  });

  it("a version gap (v > current + 1) is a lost batch: counts '—' and one alerts resync", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(full(1, [1]));
    t.ws().recv(batch(3, [["ENTERED", 3]]));
    expect(getData().alertsVersion).toBeNull();
    expect(getData().alertsIncomplete).toBe(true);
    expect(scoped(t, "alerts")).toBe(1);
    expect(plainResyncs(t)).toBe(0);
  });

  it("an old or repeated batch (v ≤ current) is ignored without a resync", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(full(5, [1]));
    t.ws().recv(batch(5, [["ENTERED", 9]]));
    t.ws().recv(batch(4, [["ENTERED", 8]]));
    expect(ids()).toEqual([1]);
    expect(getData().alertsVersion).toBe(5);
    expect(scoped(t, "alerts")).toBe(0);
  });

  it("the first full list dropped: a later batch does not make the counts known (R-09)", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv({ type: "alerts", version: 7, alerts: "broken" });
    expect(scoped(t, "alerts")).toBe(1);
    t.ws().recv(batch(8, [["ENTERED", 3]]));
    expect(getData().alertsVersion).toBeNull();
    expect(panel()).toContain("전세계 —");
    t.ws().recv(full(8, [1, 2, 3]));
    expect(getData().alertsVersion).toBe(8);
    expect(ids()).toEqual([1, 2, 3]);
  });

  it("a malformed item inside an alerts_batch (element dropped) also asks for the full list", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(full(1, [1]));
    t.ws().recv({ type: "alerts_batch", version: 2, items: [{ event: "ENTERED", alert: alert(2) }, { event: "ENTERED", alert: { ...alert(3), kind: "GUESSED" } }] });
    expect(ids()).toEqual([1, 2]);
    expect(getData().alertsVersion).toBeNull();
    expect(getData().wsInvalid.elements).toBe(1);
    expect(scoped(t, "alerts")).toBe(1);
  });

  it("a full list with a malformed element is applied but its counts stay unknown — no re-request (the api would send the same list)", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv({ type: "alerts", version: 4, alerts: [alert(1), { ...alert(2), hex: "XYZ" }] });
    expect(ids()).toEqual([1]);
    expect(getData().alertsVersion).toBeNull();
    expect(getData().alertsIncomplete).toBe(true);
    expect(scoped(t, "alerts")).toBe(0);
  });

  it("asks once until the full list arrives (10 s gate), and a new connection starts clean", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(full(1, [1]));
    t.ws().recv(batch(3, [["ENTERED", 3]]));
    t.ws().recv(batch(5, [["ENTERED", 5]]));
    t.ws().recv({ type: "alerts_batch", version: 6, items: 1 });
    expect(scoped(t, "alerts")).toBe(1);
    vi.advanceTimersByTime(10_001);
    t.ws().recv(batch(7, [["ENTERED", 7]]));
    expect(scoped(t, "alerts")).toBe(2);
    // 새 연결: welcome 이 모름 상태 · 게이트를 지운다(서버가 초기 세트에 전체 목록을 보낸다)
    t.ws().close();
    vi.advanceTimersByTime(31_000);
    t.ws().open();
    t.ws().recv({ type: "welcome", session_id: "s2", server_time: TS, snapshot_version: 1, limits: {} });
    expect(getData().alertsIncomplete).toBe(false);
    t.ws().recv(full(9, [1]));
    t.ws().recv(batch(11, [["ENTERED", 2]]));
    expect(scoped(t, "alerts")).toBe(1); // 새 소켓에서 첫 요청
  });

  it("the panel says the list is incomplete (not 'previous connection') and stops the ETA countdown", () => {
    expect(alertListState("open", null, true, true)).toBe("incomplete");
    expect(alertListState("open", null, true, false)).toBe("waiting");
    expect(alertListState("closed", null, true, true)).toBe("waiting"); // 끊긴 뒤는 이전 연결의 목록
    setData({ conn: "open", lastRxAt: Date.now(), alertsVersion: null, alertsIncomplete: true, alerts: new Map([[2, { ...alert(2, "PREDICTED"), eta_s: 120, eta_at: TS } as never]]) });
    const h = renderToStaticMarkup(createElement(AlertPanel));
    expect(h).toContain('data-state="incomplete"');
    expect(h.replace(/<[^>]+>/g, "")).toContain("알림 목록 일부 누락");
    expect(h.replace(/<[^>]+>/g, "")).not.toContain("이전 연결");
    expect(h.replace(/<[^>]+>/g, "")).toContain("추정 ETA —");
  });
});

describe("applyAlertsBatch: the version is known only for the batch right after the list it applies to", () => {
  const cur = (version: number | null) => ({ alerts: new Map<number, Alert>([[1, alert(1) as unknown as Alert]]), version });
  const items = [{ event: "ENTERED", alert: alert(2) as unknown as Alert }];
  it("current + 1 → that version; a gap, an unknown current version or a batch without version → items applied, version null", () => {
    expect(applyAlertsBatch(cur(4), 5, items)!.version).toBe(5);
    for (const [c, v] of [[4, 6], [null, 5], [4, undefined]] as const) {
      const r = applyAlertsBatch(cur(c), v, items)!;
      expect([...r.alerts.keys()]).toEqual([1, 2]);
      expect(r.version).toBeNull();
    }
    expect(applyAlertsBatch(cur(4), 4, items)).toBeNull();
  });
});

describe("other message types use their own repair path", () => {
  it("malformed sigmets / radar ask for that list only; status · selected · demand · error are counted and reported without any resync", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(snap([ac("aaa001")]));
    t.ws().recv({ type: "sigmets", v: 2, fetched_at: TS, provider: "awc_isigmet", computed_at: TS, collection: { type: "FeatureCollection", features: "x" } });
    t.ws().recv({ type: "radar", host: 42, generated: 1, past: [], fetched_at: TS, provider: "rainviewer" });
    t.ws().recv({ type: "status", status: "ok" });
    t.ws().recv({ type: "selected", hex: "zz", state: null, prediction: { available: false }, route: null });
    t.ws().recv({ type: "error", code: 42 });
    expect(scoped(t, "sigmets")).toBe(1);
    expect(scoped(t, "radar")).toBe(1);
    expect(plainResyncs(t)).toBe(0);
    expect(scoped(t, "alerts")).toBe(0);
    expect(getData().wsInvalid.messages).toBe(5);
    expect(t.reports.filter((r) => /malformed (sigmets|radar|status|selected|error)/.test(r.message))).toHaveLength(5);
  });

  it("the sigmets / radar requests are gated until that list arrives", () => {
    const t = setup();
    welcomed(t);
    const bad = { type: "radar", host: 42, generated: 1, past: [], fetched_at: TS, provider: "rainviewer" };
    t.ws().recv(bad);
    t.ws().recv(bad);
    expect(scoped(t, "radar")).toBe(1);
    t.ws().recv({ type: "radar", host: "https://tilecache.rainviewer.com", generated: 1, past: [], fetched_at: TS, provider: "rainviewer" });
    t.ws().recv(bad);
    expect(scoped(t, "radar")).toBe(2);
  });

  it("a frame that is not JSON (type unknown) asks for everything: aircraft · ships snapshot, alerts, sigmets, radar", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(snap([ac("aaa001")]));
    t.ws().recv(full(1, [1]));
    t.ws().recv("{not json");
    expect(plainResyncs(t)).toBe(1);
    expect(["alerts", "sigmets", "radar"].map((s) => scoped(t, s))).toEqual([1, 1, 1]);
    expect(getData().alertsVersion).toBeNull(); // 알림 배치였을 수 있다
  });

  it("every resync the web sends satisfies schemas/ws/client.v1.json", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv("{not json");
    vi.advanceTimersByTime(11_000);
    const sent = t.ws().sent.filter((m) => m.type === "resync");
    expect(sent.length).toBe(4);
    for (const m of sent) expect(validate(clientSchema, m), JSON.stringify(m)).toEqual([]);
  });
});
