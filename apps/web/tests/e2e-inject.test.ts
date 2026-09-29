/**
 * e2e/dashboard-layout.spec.ts 가 fixture 스택의 WS 에 끼워 넣는 메시지가 계약(schemas/ws/server.v1.json)과 웹 검증기(lib/ws-validate)를
 * 버림 없이 통과하는지 — 스택 없이 미리 확인한다(e2e 가 형식 오류로 조용히 다른 화면을 재지 않게).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateServerMessage } from "@/lib/ws-validate";
import { parseRoute } from "@/lib/route";
import { predictedEvent, withPendingRoute } from "../e2e/ws-inject";
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
  it("the injected PREDICTED alerts_batch passes the schema and the web validator without drops", () => {
    const m = predictedEvent(Date.parse("2026-09-30T02:43:56Z"));
    expect(validate(schema, m)).toEqual([]);
    expect(validateServerMessage(m)).toMatchObject({ kind: "ok", dropped: 0 });
  });
});
