/**
 * 알림 패널·상태 바의 첫 로드 표시(서버 렌더 — DOM 없음).
 * R-09: 모르는 알림 수를 0 으로 보이지 않는다 · 관심 지역 설정을 받기 전에는 전세계 목록을 '관심 지역'으로 보이지 않는다 ·
 *       배너 자리는 고정 높이 · 정상적인 첫 연결 중('connecting')은 오류색이 아니다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getData, resetData, setData } from "@/lib/store";
import { alertListState, EVENT_BANNER_TTL_MS, eventBannerVisible } from "@/lib/alerts";
import { RX_FRESH_MS } from "@/lib/ws-protocol";
import { EvidenceCard } from "@/components/EvidenceCard";
import { WakelineWsClient, type SocketLike } from "@/lib/ws";
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
  it("the region lag badge (NO DATA) is not the error colour during a normal first connection; real staleness and no data after a failed attempt stay red", () => {
    const lag = () => /class="badge ([a-z]+)" data-testid="lag-badge"[^>]*>([^<]*)</.exec(renderToStaticMarkup(createElement(StatusBar))) ?? [];
    setData({ conn: "connecting", reconnectAttempt: 0 });
    // 수정 전: feedLag 가 피드 없음을 stale 로 돌려 첫 로드부터 빨간 NO DATA(연결 배지는 이미 warn)
    expect(lag()[1]).toBe("warn");
    expect(lag()[2]).toBe("NO DATA");
    setData({ conn: "connecting", reconnectAttempt: 2 }); // 재시도 중 — 연결 배지처럼 오류색
    expect(lag()[1]).toBe("bad");
    setData({ conn: "closed", reconnectAttempt: 1 });
    expect(lag()[1]).toBe("bad");
    const now = Date.now();
    setData({ conn: "open", lastRxAt: now, reconnectAttempt: 0, feeds: { region: { provider: "adsb_fi", fetched_at: null, lag_s: 120, stale: true, received_at: now }, global: null } });
    expect(lag()[1]).toBe("bad"); // 실제로 오래된 피드
    setData({ feeds: { region: { provider: "adsb_fi", fetched_at: null, lag_s: 2, stale: false, received_at: now }, global: null } });
    expect(lag()[1]).toBe("ok");
  });
});

describe("last-event banner (R-23)", () => {
  it("shows when the event was received (server clock), not just what happened", () => {
    setData({ conn: "open", alertsVersion: 1, lastEvent: { type: "ENTERED", alert: alert(3, [36.5, 127.8]), at: Date.parse("2026-09-28T01:02:03Z") } });
    const h = html();
    expect(h).toContain('data-testid="alert-banner"');
    expect(text(h)).toContain("수신 01:02:03Z");
  });
  it("is hidden once older than the TTL (5 min) — an old entry is not shown as if it just happened", () => {
    expect(EVENT_BANNER_TTL_MS).toBe(5 * 60_000);
    const at = 1_000_000;
    expect(eventBannerVisible(at, 0)).toBe(true); // 시계를 아직 모름(첫 렌더) → 숨기지 않음
    expect(eventBannerVisible(at, at + EVENT_BANNER_TTL_MS)).toBe(true);
    expect(eventBannerVisible(at, at + EVENT_BANNER_TTL_MS + 1)).toBe(false);
  });
  it("a new connection (welcome) clears the previous connection's banner", () => {
    let sock: SocketLike & { recv: (m: unknown) => void; open: () => void } | null = null;
    const client = new WakelineWsClient({ postMessage: () => {} }, {
      url: "ws://test/ws/v1", isHidden: () => false,
      createSocket: () => {
        const s = { readyState: 0, send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null } as unknown as SocketLike & { recv: (m: unknown) => void; open: () => void };
        s.open = () => { s.readyState = 1; s.onopen?.({}); };
        s.recv = (m: unknown) => s.onmessage?.({ data: JSON.stringify(m) });
        sock = s;
        return s;
      },
    });
    setData({ lastEvent: { type: "ENTERED", alert: alert(3, [36.5, 127.8]), at: Date.now() - 3 * 3600_000 } });
    client.connect();
    sock!.open();
    sock!.recv({ type: "welcome" });
    expect(getData().lastEvent).toBeNull();
    client.close();
  });
});

describe("alert list freshness follows the status bar's receive rule (R-58)", () => {
  const pred = { ...alert(9, [36.5, 127.8], "PREDICTED"), eta_at: new Date(Date.now() + 600_000).toISOString() } as Alert;
  it("an open connection that has received nothing for RX_FRESH_MS is not 'live'", () => {
    expect(alertListState("open", 3, true)).toBe("live");
    expect(alertListState("open", 3, false)).toBe("silent");
    expect(alertListState("open", null, false)).toBe("waiting");
    expect(alertListState("closed", 3, false)).toBe("disconnected");
  });
  it("half-open connection (45–75 s without messages): the list is marked stale and the ETA stops, like the status bar's STALE", () => {
    setData({ conn: "open", alertsVersion: 3, alerts: new Map([[9, pred]]), status: STATUS, lastRxAt: Date.now() - (RX_FRESH_MS + 5_000) });
    const h = html();
    expect(h).toContain('data-testid="alerts-stale"');
    expect(h).toContain('data-state="silent"');
    expect(text(h)).toContain("추정 ETA —");
    expect(renderToStaticMarkup(createElement(EvidenceCard, { a: pred }))).toMatch(/ETA\(추정\)<\/span><span class="text-right"><span class="mono">—</);
    setData({ lastRxAt: Date.now() });
    const live = html();
    expect(live).not.toContain('data-testid="alerts-stale"');
    expect(text(live)).not.toContain("추정 ETA —");
  });
  it("the frozen ETA's tooltip names the state: silent is 'open but nothing received', not 'connection lost'", () => {
    const etaTitle = () => /<span class="badge est ml-auto" title="([^"]*)" data-testid="alert-eta"/.exec(html())?.[1];
    setData({ conn: "open", alertsVersion: 3, alerts: new Map([[9, pred]]), status: STATUS, lastRxAt: Date.now() - (RX_FRESH_MS + 5_000) });
    const silent = etaTitle();
    // 수정 전: 모든 멈춤 상태에서 "연결이 끊겨 갱신되지 않음" — 연결은 열려 있다(상태 바·목록 안내와 모순)
    expect(silent).not.toContain("끊겨");
    expect(silent).toContain("수신 없음(연결은 열림)");
    expect(silent).toContain("갱신되지 않음");
    setData({ conn: "closed" });
    expect(etaTitle()).toContain("연결이 끊겨 갱신되지 않음");
    setData({ conn: "paused" });
    expect(etaTitle()).toContain("일시정지(탭 숨김)");
    setData({ conn: "open", alertsVersion: null });
    expect(etaTitle()).toContain("알림 수신 대기");
    setData({ conn: "open", alertsVersion: 4, lastRxAt: Date.now() });
    expect(etaTitle()).toContain("직선 외삽"); // 실시간이면 판정 시각·방법
  });
});
