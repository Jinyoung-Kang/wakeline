/**
 * 공역 알림의 화면(계약 v5 §G48 · SPEC F2 · ADR-035): 알림 행 · 배너의 구역 글(SIGMET 은 예전 그대로), '정보' 수준은 배너로 알리지 않음, 닫힘 문구
 * (sigmet_ended · zone_ended — 전에는 sigmet_ended 의 문구가 없어 '—'), 근거 카드의 공역 변형(구역 · 수준 · 고도 범위 기준 · 차수 · 가정 · 경계 근처),
 * 항공기 카드의 '들어 있는 공역'(수평만 본 것은 그렇다고).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import samples from "./fixtures/ws-samples.v1.json";
import { alertZone, closeReasonLabel, EVENT_LABEL } from "@/lib/alerts";
import { applyAlertsBatch } from "@/lib/ws-protocol";
import { validateServerMessage } from "@/lib/ws-validate";
import type { Alert } from "@/lib/types";
import { EvidenceCard } from "@/components/EvidenceCard";
import { AirspaceRow } from "@/components/AircraftCard";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&amp;/g, "&");
const sample = (samples as unknown as { server: { name: string; message: Record<string, unknown> }[] }).server.find((s) => s.name === "alerts_batch.airspace")!.message;
const items = (sample.items as { event: string; alert: Alert }[]);
const inZone = items[0].alert;

describe("airspace alerts from the api builders", () => {
  it("the fixture sample passes the web validator whole", () => {
    const r = validateServerMessage(sample);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.msg.type === "alerts_batch") expect(r.msg.items).toHaveLength(2);
  });
  it("row and banner text name the airspace, not a SIGMET; SIGMET alerts keep hazard · FIR", () => {
    expect(alertZone(inZone)).toEqual({ kind: "공역", label: "RK P99", sub: "비행금지구역", color: "#e5484d" });
    expect(alertZone({ ...inZone, level: "info" }).sub).toBe("정보");
    const sig = { id: 1, kind: "OBSERVED", hex: "abcdef", sigmet_id: "S", fir_id: "RKRR", hazard: "TS", qualifier: "EMBD", entered_at: "x", evidence: {}, estimated: false } as Alert;
    expect(alertZone(sig)).toMatchObject({ kind: "SIGMET", label: "TS EMBD", sub: "RKRR" });
  });
  it("an info-level airspace alert is listed but never becomes the banner", () => {
    const info = { ...inZone, id: 9, level: "info" as const };
    const r = applyAlertsBatch({ alerts: new Map(), version: 1 }, 2, [{ event: "ENTERED", alert: info }])!;
    expect(r.alerts.has(9)).toBe(true);
    expect(r.last).toBeNull();
    const r2 = applyAlertsBatch({ alerts: new Map(), version: 1 }, 2, [{ event: "ENTERED", alert: inZone }])!;
    expect(r2.last?.alert.id).toBe(inZone.id);
    const ended = applyAlertsBatch(r2, 3, [{ event: "ZONE_ENDED", alert: items[1].alert }])!;
    expect(ended.alerts.size).toBe(0);
  });
  it("close reasons and events have words (sigmet_ended used to show '—')", () => {
    expect(closeReasonLabel("sigmet_ended")).toBe("경보 종료(SIGMET 만료·철회 — 이탈 아님)");
    expect(closeReasonLabel("zone_ended")).toBe("구역 종료(공역 차수 교체·판정 끔 — 이탈 아님)");
    expect(EVENT_LABEL.ZONE_ENDED).toBe("구역 종료");
  });
});

describe("evidence card and aircraft card", () => {
  it("the airspace evidence shows zone, level, band with its reference, edition and the altitude assumption", () => {
    const t = text(renderToStaticMarkup(createElement(EvidenceCard, { a: { ...inZone, evidence: { ...inZone.evidence, altitude_uncertain: true } } })));
    expect(t).toContain("공역 비행금지구역 · RK P99 시험 금지구역 A");
    expect(t).toContain("수준 알림");
    expect(t).toContain("고도 범위 지면 – 무제한");
    expect(t).toContain("기준 차수 합성 시험 공역 1차 · 국토교통부");
    expect(t).toContain("기압고도(표준 기압)를 해면 고도로 봄 — QNH 보정 없음");
    expect(t).toContain("고도 경계 근처(500 ft 안) — 판정 불확실");
    expect(t).toContain("관측 · 공역 안");
    expect(t).not.toContain("SIGMET id");
    const closed = text(renderToStaticMarkup(createElement(EvidenceCard, { a: items[1].alert })));
    expect(closed).toContain("구역 종료(공역 차수 교체·판정 끔 — 이탈 아님) · 새 차수에 없음");
  });
  it("the aircraft card lists the areas it is in, saying when only the horizontal was checked", () => {
    const t = text(renderToStaticMarkup(createElement(AirspaceRow, { v: { edition: "AIP 25년 5차", items: [
      { id: 1, category: "prohibited", type_ko: "비행금지구역", label: "RK P73", name: "P73", level: "alert", vertical: "inside" },
      { id: 2, category: "danger", type_ko: "위험구역", label: "RK D99", name: "D99", vertical: "not_judged" },
      { id: 3, category: "restricted", type_ko: "비행제한구역", label: "RK R1", name: "R1", level: "info", vertical: "unknown" },
    ] } })));
    expect(t).toContain("AIP 25년 5차 기준 · 국토교통부");
    expect(t).toContain("RK P73 비행금지구역 고도대 안");
    expect(t).toContain("RK D99 위험구역 고도 판정 안 함(지면 기준 — 수평만)");
    expect(t).toContain("RK R1 비행제한구역 · 정보 항공기 고도 모름 — 수평만");
    expect(text(renderToStaticMarkup(createElement(AirspaceRow, { v: { edition: "x", items: [] } })))).toContain("들어 있는 금지 · 제한 · 위험구역 없음");
  });
});

describe("ops setting airspace_alerts", () => {
  it("accepts off · shadow · on only (the api checks again)", async () => {
    const ops = await import("@/lib/ops");
    expect(ops.parseSetting("airspace_alerts", "on")).toEqual({ ok: true, value: "on" });
    expect(ops.parseSetting("airspace_alerts", "shadow")).toEqual({ ok: true, value: "shadow" });
    expect(ops.parseSetting("airspace_alerts", "ON").ok).toBe(false);
    expect(ops.parseSetting("airspace_alerts", "maybe").ok).toBe(false);
  });
});
