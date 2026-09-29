/**
 * e2e/dashboard-layout.spec.ts 가 fixture 스택의 WS 에 끼워 넣는 메시지가 계약(schemas/ws/server.v1.json)과 웹 검증기(lib/ws-validate)를
 * 버림 없이 통과하는지 — 스택 없이 미리 확인한다(e2e 가 형식 오류로 조용히 다른 화면을 재지 않게).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateServerMessage } from "@/lib/ws-validate";
import { parseRoute } from "@/lib/route";
import { applyAlertsBatch } from "@/lib/ws-protocol";
import { predictedEvent, withoutBannerEvents, withPendingRoute } from "../e2e/ws-inject";
import { validate } from "./helpers/mini-schema";

const schema = JSON.parse(readFileSync(new URL("../../../schemas/ws/server.v1.json", import.meta.url), "utf8")) as Record<string, unknown>;
const samples = JSON.parse(readFileSync(new URL("./fixtures/ws-samples.v1.json", import.meta.url), "utf8")) as { server: { name: string; message: Record<string, unknown> }[] };

describe("e2e WS injections are valid messages", () => {
  it("a server 'selected' with its route rewritten to pending passes the schema and the web validator, and reads as pending", () => {
    const sel = samples.server.find((s) => s.name === "selected.route_found")!.message;
    const m = withPendingRoute(structuredClone(sel));
    expect(validate(schema, m)).toEqual([]);
    const v = validateServerMessage(m);
    expect(v).toMatchObject({ kind: "ok", dropped: 0 });
    expect(parseRoute(m.route)).toMatchObject({ status: "pending", callsign: "SYN081", source: "adsbdb" });
    // 상태가 없는 selected(스냅샷에 없음)는 그대로
    const gone = samples.server.find((s) => s.name === "selected.gone")!.message;
    expect(withPendingRoute(structuredClone(gone))).toEqual(gone);
  });
  it("the banner test drops the fixture server's own banner events, so the injected one is the only banner (review finding: live OBSERVED alerts replaced it)", () => {
    const batch = samples.server.find((s) => s.name === "alerts_batch")!.message as { items: { event: string; alert: unknown }[] };
    const all = ["ENTERED", "LEFT", "LOST", "SIGMET_ENDED", "PREDICTED", "PREDICTION_UPDATED", "PREDICTION_CLEARED"];
    const a0 = batch.items[0].alert;
    const m = { ...batch, items: all.map((event) => ({ event, alert: a0 })) };
    const out = withoutBannerEvents(structuredClone(m)) as typeof m;
    // 배너 이벤트(ENTERED · LEFT · LOST · PREDICTED)만 빠지고 나머지는 그대로 — 목록 반영은 계속된다
    expect(out.items.map((x) => x.event)).toEqual(["SIGMET_ENDED", "PREDICTION_UPDATED", "PREDICTION_CLEARED"]);
    expect(validate(schema, out)).toEqual([]);
    expect(validateServerMessage(out)).toMatchObject({ kind: "ok", dropped: 0 });
    // 웹 반영: 이 배치로는 배너(lastEvent)가 생기지 않는다 · 원래 배치는 생긴다
    expect(applyAlertsBatch({ alerts: new Map(), version: 1 }, 2, out.items as never)!.last).toBeNull();
    expect(applyAlertsBatch({ alerts: new Map(), version: 1 }, 2, m.items as never)!.last).not.toBeNull();
    // 빈 목록이 되어도 형식은 맞다 · 다른 메시지는 그대로
    const empty = withoutBannerEvents({ ...batch, items: [{ event: "ENTERED", alert: a0 }] });
    expect(validate(schema, empty)).toEqual([]);
    const sel = samples.server.find((s) => s.name === "selected.route_found")!.message;
    expect(withoutBannerEvents(sel)).toBe(sel);
  });
  it("the injected PREDICTED alerts_batch passes the schema and the web validator without drops", () => {
    const m = predictedEvent(Date.parse("2026-09-30T02:43:56Z"));
    expect(validate(schema, m)).toEqual([]);
    expect(validateServerMessage(m)).toMatchObject({ kind: "ok", dropped: 0 });
  });
});
