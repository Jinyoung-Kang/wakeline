/**
 * 알림 패널·상태 바의 첫 로드 표시(서버 렌더 — DOM 없음).
 * R-09: 모르는 알림 수를 0 으로 보이지 않는다 · 관심 지역 설정을 받기 전에는 전세계 목록을 '관심 지역'으로 보이지 않는다 ·
 *       배너 자리는 고정 높이 · 정상적인 첫 연결 중('connecting')은 오류색이 아니다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetData, setData } from "@/lib/store";
import { AlertPanel } from "@/components/AlertPanel";
import { StatusBar } from "@/components/StatusBar";
import type { Alert, PublicStatus } from "@/lib/types";

const alert = (id: number, pos: [number, number], kind: Alert["kind"] = "OBSERVED"): Alert => ({
  id, kind, hex: `a${id}`, callsign: `CS${id}`, sigmet_id: `S${id}`, fir_id: "LFRR", hazard: "TS", entered_at: "2026-09-28T01:00:00Z",
  eta_s: kind === "PREDICTED" ? 120 : null, alt_ft: 35000, evidence: { position: pos, judged_at: "2026-09-28T01:00:00Z" }, estimated: kind === "PREDICTED",
} as Alert);
const STATUS = { server_time: "2026-09-28T01:00:00Z", region: { center: [36.5, 127.8], radius_nm: 300, provider: "adsb_fi", aircraft: 1, lag_s: 1, stale: false, fetched_at: null } } as unknown as PublicStatus;
const html = () => renderToStaticMarkup(createElement(AlertPanel));
const text = (h: string) => h.replace(/<[^>]+>/g, "");

beforeEach(() => resetData());
afterEach(() => resetData());

describe("alert panel first load (R-09)", () => {
  it("before the first alerts message the counts are unknown ('—'), not 0", () => {
    setData({ conn: "open", alertsVersion: null });
    const t = text(html());
    expect(t).toContain("전세계 —");
    expect(t).toContain("— inside · — predicted");
    expect(t).not.toMatch(/전세계 0|0 inside/);
  });

  it("the '관심 지역' scope waits for the region setting instead of showing the world list", () => {
    const far = alert(1, [48.0, 2.0]); // 프랑스 — 관심 지역 밖
    const near = alert(2, [36.6, 127.9]);
    setData({ conn: "open", lastRxAt: Date.now(), alertsVersion: 5, alerts: new Map([[1, far], [2, near]]) });
    const before = html();
    expect(before).not.toContain('data-testid="alert-item"');
    expect(before).toContain('data-testid="alerts-region-waiting"');
    expect(before).not.toContain('data-testid="alerts-empty"'); // "없습니다"라고 말하지 않는다
    expect(text(before)).toContain("전세계 2");
    expect(text(before)).toContain("— inside · — predicted");
    setData({ status: STATUS });
    const after = html();
    expect(after.match(/data-testid="alert-item"/g)).toHaveLength(1);
    expect(after).toContain("CS2");
    expect(after).not.toContain("CS1");
    expect(text(after)).toContain("1 inside · 0 predicted");
  });

  it("the event banner slot has a fixed height with or without an event (no layout shift)", () => {
    setData({ conn: "open", alertsVersion: 1 });
    const slot = (h: string) => /<div role="status"[^>]*>/.exec(h)?.[0] ?? "";
    const empty = slot(html());
    setData({ lastEvent: { type: "ENTERED", alert: alert(3, [36.5, 127.8]), at: Date.now() } });
    const withEvent = slot(html());
    expect(empty).toMatch(/class="[^"]*\bh-\[/);
    expect(withEvent).toBe(empty);
  });
});

describe("status bar connection badge (R-09)", () => {
  const conn = () => /class="badge ([a-z]+)" data-testid="conn"/.exec(renderToStaticMarkup(createElement(StatusBar)))?.[1];
  it("a first connection in progress is neutral/warn, not the error colour; retries and closed are errors", () => {
    setData({ conn: "connecting", reconnectAttempt: 0 });
    expect(conn()).toBe("warn");
    setData({ conn: "connecting", reconnectAttempt: 2 });
    expect(conn()).toBe("bad");
    setData({ conn: "closed", reconnectAttempt: 1 });
    expect(conn()).toBe("bad");
    setData({ conn: "open", lastRxAt: Date.now(), reconnectAttempt: 0 });
    expect(conn()).toBe("ok");
  });
});
