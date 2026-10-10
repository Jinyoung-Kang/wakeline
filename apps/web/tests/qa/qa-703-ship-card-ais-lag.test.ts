/**
 * QA-703(출시 QA 2차 · 기능): 선박 카드의 신뢰도 한 줄(SPEC F6)은 공급자 지연을 "상태 바와 같은 값"으로 보인다(ShipCard useAisLag — lib/ships aisBadge).
 * 1) AIS 가 끊겼을 때(aisBadge kind down — lag 모름) `lag ?? 0` 으로 "공급자 지연 0s"를 지어 보인다 — 제품 규칙(받쳐지지 않는 값을 짐작해 보이지 않는다 · 모르면 —).
 * 2) 연결은 살아 있는데 지연이 경고 기준(AIS_LAG_WARN_S 120 s)을 넘으면 상태 바는 '주의'인데 카드는 '정상'(stale 은 tone === "bad" 일 때만).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "../helpers/mini-dom";
import { mounter } from "../helpers/mount";
import { resetData, setData } from "@/lib/store";
import type { AisStatus } from "@/lib/ships";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); resetData(); });

const NOW = Date.parse("2026-10-10T03:00:00Z");
const ais = (p: Partial<AisStatus>): AisStatus => ({ connected: true, lag_s: 5, msgs_per_s: 12, gap_open_since: null, last_gap: null, state: "live", coverage: null, received_at: NOW, ...p } as AisStatus);

async function lagPart(status: AisStatus): Promise<{ text: string; grade: string | null }> {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  setData({ ais: status, conn: "open", lastRxAt: NOW });
  const { ShipCardView } = await import("@/components/ShipCard");
  await m.render(m.React.createElement(ShipCardView, { mmsi: "440123456", detail: null, error: null, now: NOW }));
  await m.settle();
  const line = m.byTestId("reliability")!;
  const span = m.findAll((e) => (e.textContent ?? "").includes("공급자 지연"), line).pop()!;
  return { text: span.textContent ?? "", grade: span.getAttribute?.("data-grade") ?? null };
}

describe("QA-703 ship card AIS lag", () => {
  it("a disconnected AIS feed says the lag is unknown, not 0 s", async () => {
    const p = await lagPart(ais({ connected: false, state: "backoff", lag_s: null }));
    expect(p.text).not.toMatch(/공급자 지연 0s/);
  });
  it("a live feed over the warning threshold is graded like the status bar (주의), not 정상", async () => {
    const p = await lagPart(ais({ lag_s: 300 }));
    expect(p.grade).not.toBe("ok");
  });
});
