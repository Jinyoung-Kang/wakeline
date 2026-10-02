/**
 * QA-310 — .badge · .label 의 text-transform: uppercase 가 분 · 초 단위를 대문자로 바꿨다: 예측 ETA 배지 "추정 ETA 9m 55s" → "9M 55S",
 * 공항 METAR 줄 "35m 19s 전" → "35M 19S 전"(브라우저 접근성 이름도 그렇게 — 화면 읽기 프로그램도 그렇게 읽는다). 같은 화면에서 m 은 미터다.
 * 이제 그런 상자 안의 경과 · 남은 시간은 normal-case 조각에 둔다(보이는 글자 · 접근성 이름 모두 쓴 그대로).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetData, setData } from "@/lib/store";
import { AlertPanel } from "@/components/AlertPanel";
import type { Alert, PublicStatus } from "@/lib/types";

const STATUS = { server_time: "2026-09-28T01:00:00Z", region: { center: [36.5, 127.8], radius_nm: 300, provider: "adsb_fi", aircraft: 1, lag_s: 1, stale: false, fetched_at: null } } as unknown as PublicStatus;
beforeEach(() => resetData());
afterEach(() => resetData());

describe("QA-310 time units keep their case inside upper-case badges and labels", () => {
  it("the predicted ETA badge puts the remaining time in a normal-case span (\"9m 55s\", not \"9M 55S\")", () => {
    const pred = {
      id: 9, kind: "PREDICTED", hex: "a9", callsign: "CS9", sigmet_id: "S9", fir_id: "RKRR", hazard: "TS", entered_at: "2026-09-28T01:00:00Z",
      eta_s: 595, alt_ft: 35000, evidence: { position: [36.6, 127.9], judged_at: "2026-09-28T01:00:00Z" }, estimated: true,
    } as unknown as Alert;
    setData({ conn: "open", lastRxAt: Date.now(), alertsVersion: 3, alerts: new Map([[9, pred]]), status: STATUS });
    const badge = /<span class="badge est ml-auto"[^>]*data-testid="alert-eta">(.*?)<\/span><\/button>/.exec(renderToStaticMarkup(createElement(AlertPanel)))?.[1];
    expect(badge).toMatch(/^추정 ETA <span class="normal-case">(\d+m )?\d+s<\/span>$/);
  });
  it("the airport page METAR label, the SIGMET 'pending' badge and the log detail period labels do the same", () => {
    const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    expect(src("app/airports/[icao]/page.tsx")).toMatch(/<div className="label mb-1">METAR · .*<span className="normal-case">\{fmtDuration\(age\)\}<\/span> 전/);
    expect(src("components/SigmetCard.tsx")).toMatch(/className="badge" data-testid="sigmet-pending"[^>]*>발효 전 · <span className="normal-case">\{fmtDuration\(startsIn\)\}<\/span> 뒤/);
    expect(src("components/logs/LogDetail.tsx").match(/최근 <span className="normal-case">\{LOG_PERIOD_LABEL\[/g)).toHaveLength(2);
    // 대문자 상자(.label · .badge) 안에서 경과 · 남은 시간을 normal-case 없이 쓰는 곳이 남지 않았다
    for (const f of ["components/AlertPanel.tsx", "app/airports/[icao]/page.tsx", "components/SigmetCard.tsx", "components/AirportCard.tsx", "components/AircraftCard.tsx", "components/ShipCard.tsx"]) {
      expect(src(f), f).not.toMatch(/className="(?:badge|label)[^"]*"[^>]*>[^<]*\{[^}<]*fmt(?:Duration|Eta)\(/);
    }
  });
});
