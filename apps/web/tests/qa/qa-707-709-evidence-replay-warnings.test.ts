/**
 * 출시 QA 2차(docs/qa/2026-10-release) — 규칙 · 표시.
 * QA-707: 근거 카드의 신뢰도 한 줄(SPEC F6)은 판정 때 위치 나이에 a.estimated 를 넘겨 "(추정 위치)"를 붙인다. 그런데 Alert.estimated 는 예측(PREDICTED) 알림이면
 *         늘 true — '진입을 예측했다'는 뜻이지 위치를 추정했다는 뜻이 아니다(근거의 position 은 관측 위치 — AlertStateMachine). 모든 예측 알림이 관측 위치를
 *         "(추정 위치)"로 잘못 보인다.
 * QA-708: 재생 링크(lib/replay-url — 계약 v5 §G51)의 at 은 형식만 보고 Date.parse 에 맡긴다 — 없는 날짜(2026-09-31)를 V8 이 10-01 로 넘겨 다른 시각을 조용히 연다.
 *         기대: 읽을 수 없는 시각으로 안내하고 기본 시각.
 * QA-709: 기상특보 요약(lib/warnings warningsStatus — 'wx' 탭)과 선박 카드 줄(SeaWarningsLineView)은 목록 전체를 "발효 중 N건"으로 센다 — 예비특보(발표 예정 —
 *         아직 발효 아님)와 발효 시각이 아직 오지 않은 특보도 '발효 중'이라고 한다(제품 규칙: 받쳐지지 않는 값을 짐작해 보이지 않는다). 기대: 발효 중은 발효 시각이
 *         지난 정규 특보만, 예비 · 발효 예정은 따로 센다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidenceCard } from "@/components/EvidenceCard";
import { SeaWarningsLineView } from "@/components/ShipCard";
import { parseReplayUrl } from "@/lib/replay-url";
import { parseWarnings, warningsStatus } from "@/lib/warnings";
import type { Alert } from "@/lib/types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("QA-707 predicted alert evidence is not an estimated position", () => {
  it("the judgement-time reliability line of a PREDICTED alert has no '(추정 위치)'", () => {
    const a: Alert = {
      id: 9, kind: "PREDICTED", hex: "71be01", sigmet_id: "RKRR:S1", fir_id: "RKRR", hazard: "TS", entered_at: "2026-10-10T02:00:00Z", eta_s: 300,
      eta_at: "2026-10-10T02:05:00Z", alt_ft: 30000, estimated: true,
      evidence: { method: "dead_reckoning_10min", entry: "lateral", judged_at: "2026-10-10T02:00:00Z", position: [37.5, 127.0], position_age_s: 12, seen_at: "2026-10-10T01:59:48Z" },
    };
    const t = text(renderToStaticMarkup(createElement(EvidenceCard, { a })));
    expect(t).toContain("위치 12s 전");
    expect(t).not.toContain("(추정 위치)");
  });
});

describe("QA-708 replay link with an impossible date", () => {
  it("2026-09-31 is not silently opened as 2026-10-01", () => {
    const r = parseReplayUrl(new URLSearchParams("at=2026-09-31T00:00:00Z"), Date.parse("2026-10-10T00:00:00Z"));
    expect(r.at).toBeNull();
    expect(r.notes[0]).toContain("읽을 수 없음");
  });
});

describe("QA-709 preliminary and not-yet-effective warnings are not 'in force'", () => {
  const now = Date.parse("2026-10-10T03:00:00Z");
  const w = parseWarnings({
    received: true, dropped: 0, source: "기상청 API허브 특보현황",
    meta: { fetched_at: "2026-10-10T02:58:00Z", stale: false },
    items: [
      { zone_code: "S1312020", zone_name: "남해동부바깥먼바다", parent_name: "남해동부전해상", sea: true, kind: "풍랑", level: "예비", command: "발표", preliminary: true,
        issued_at: "2026-10-10T01:00:00Z", effective_from: "2026-10-11T03:00:00Z", effective_to: "2026-10-11T09:00:00Z", effective_text: "10-11 오후(12–18시 KST)", raw: "r" },
      { zone_code: "S1324020", zone_name: "제주도남쪽바깥먼바다", parent_name: "제주도전해상", sea: true, kind: "풍랑", level: "주의보", command: "발표", preliminary: false,
        issued_at: "2026-10-10T02:00:00Z", effective_at: "2026-10-10T09:00:00Z", raw: "r" },   // 발효 예정(18시 KST)
      { zone_code: "S1324110", zone_name: "제주도남동쪽안쪽먼바다", parent_name: "제주도전해상", sea: true, kind: "풍랑", level: "주의보", command: "발표", preliminary: false,
        issued_at: "2026-10-10T01:00:00Z", effective_at: "2026-10-10T02:00:00Z", raw: "r" },   // 발효 중
    ],
  })!;
  it("the wx tab summary counts only the warning already in force", () => {
    expect(warningsStatus(w, null, now).text).toMatch(/^발효 중 1건/);
  });
  it("the ship card line counts only the sea warning already in force", () => {
    expect(text(renderToStaticMarkup(createElement(SeaWarningsLineView, { w })))).toContain("지금 발효 중 1건");
  });
});
