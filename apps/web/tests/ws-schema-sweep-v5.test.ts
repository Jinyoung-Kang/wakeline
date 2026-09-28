/**
 * 계약 v5 §E2 · ADR-020(2차 리뷰): 웹 검증기(lib/ws-validate)가 schemas/ws/server.v1.json 과 제약마다 같은가 — 손으로 고른 변형이 아니라 표본
 * (fixtures/ws-samples.v1.json — api 가 실제 빌더로 만든 것) 위의 모든 잎 제약을 훑는다(helpers/schema-sweep).
 * - 틀린 값: 스키마 위반(시험용 검사기로 먼저 확인)이면 웹은 메시지를 버리거나(invalid) 그 원소 · 값을 버리고 센다(dropped ≥ 1) — 틀린 값이 그대로
 *   화면으로 가지 않는다. 너그러운 곳은 "모름"(없는 키 · null)뿐이다 — 이 시험은 그런 변형을 만들지 않는다.
 * - 경계의 맞는 값: 스키마가 허용하는 끝값(최소 · 최대 · 최대 길이 · 열거값 · 시간대가 있는 시각 · 상한 없는 수의 큰 값 · 긴 문자열)은 버리지 않는다
 *   (웹이 스키마보다 엄격하면 맞는 메시지를 형식 오류로 세고 다시 받는다).
 * 예외(ADR-020 에 적은 것): 네 원소 격자 칸(구 서버) · 격자 칸 선종별 수의 합 규칙(스키마로 말할 수 없는 교차 규칙).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateServerMessage, type Validated } from "@/lib/ws-validate";
import { validate } from "./helpers/mini-schema";
import { getAt, mutated, sweep, type Mutation, type Path } from "./helpers/schema-sweep";

type Json = Record<string, unknown>;
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const fixture = read("./fixtures/ws-samples.v1.json") as { server: { name: string; message: Json }[] };
const schema = read("../../../schemas/ws/server.v1.json") as Json;

const shape = (p: Path) => p.map((k) => (typeof k === "number" ? "#" : k)).join(".");
const label = (type: string, m: Mutation) => `${type}.${shape(m.path)} ${m.rule} = ${JSON.stringify(m.value)?.slice(0, 40)}`;

/** 웹이 스키마보다 너그러운 곳(모름이 아닌데) — ADR-020 에 적은 것만 */
const LENIENT: { why: string; match: (type: string, m: Mutation) => boolean }[] = [
  { why: "네 원소 격자 칸(구 서버 — 선종별 수 없음)", match: (t, m) => t === "ships_grid" && m.path[0] === "cells" && m.path.length === 2 && m.rule === "minItems" },
];
/** 웹이 스키마보다 엄격한 곳 — ADR-020 에 적은 것만. 결과까지 본다(그 엄격함만큼만 버렸는가) */
const STRICTER: { why: string; allows: (type: string, m: Mutation, r: Validated) => boolean }[] = [
  {
    why: "격자 칸 선종별 수의 합 = 칸 선박 수(교차 규칙 — 칸 선박 수나 선종별 수 하나만 바꾸면 합이 틀린다: 칸은 두고 선종별 수만 버리고 센다)",
    allows: (t, m, r) => t === "ships_grid" && m.path[0] === "cells" && (m.path[2] === 2 || m.path[2] === 4)
      && r.kind === "ok" && r.msg.type === "ships_grid" && r.dropped === 1 && r.msg.cells[m.path[1] as number]?.counts === null,
  },
];

function unique(kind: "violations" | "boundaries"): { type: string; message: Json; m: Mutation }[] {
  const seen = new Set<string>();
  const out: { type: string; message: Json; m: Mutation }[] = [];
  for (const s of fixture.server) {
    const type = s.message.type as string;
    for (const m of sweep(schema, s.message)[kind]) {
      const key = label(type, m);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type, message: s.message, m });
    }
  }
  return out;
}

describe("the web validator agrees with schemas/ws/server.v1.json constraint by constraint (every leaf of every fixture sample)", () => {
  it("every present-but-wrong value is rejected (message) or dropped and counted (element · value) — never passed on", () => {
    const cases = unique("violations");
    expect(cases.length).toBeGreaterThan(400); // 훑기가 실제로 돌았다
    const notViolations: string[] = [], passed: string[] = [];
    for (const { type, message, m } of cases) {
      if (LENIENT.some((x) => x.match(type, m))) continue;
      const bad = mutated(message, m);
      if (validate(schema, bad).length === 0) { notViolations.push(label(type, m)); continue; }
      const r = validateServerMessage(bad);
      if (r.kind === "invalid") continue;
      if (r.kind === "unknown") { passed.push(`${label(type, m)} → unknown`); continue; }
      const seen = getAt(r.msg, m.path);
      if (r.dropped === 0) passed.push(`${label(type, m)} → ok, nothing dropped`);
      else if (seen !== undefined && JSON.stringify(seen) === JSON.stringify(m.value)) passed.push(`${label(type, m)} → counted but still in the message`);
    }
    expect(notViolations, "the sweep made a value the schema accepts").toEqual([]);
    expect(passed).toEqual([]);
  });

  it("every boundary value the schema allows is accepted whole (nothing dropped)", () => {
    const cases = unique("boundaries");
    expect(cases.length).toBeGreaterThan(300);
    const rejected: string[] = [];
    for (const { type, message, m } of cases) {
      const ok = mutated(message, m);
      expect(validate(schema, ok), label(type, m)).toEqual([]);
      const r = validateServerMessage(ok);
      if (STRICTER.some((x) => x.allows(type, m, r))) continue;
      if (r.kind !== "ok") rejected.push(`${label(type, m)} → ${r.kind}${r.kind === "invalid" ? ` (${r.reason})` : ""}`);
      else if (r.dropped > 0) rejected.push(`${label(type, m)} → dropped ${r.dropped} at ${r.where}`);
    }
    expect(rejected).toEqual([]);
  });

  it("the documented exceptions still hold (so the lists above do not rot)", () => {
    const cell4 = validateServerMessage({ type: "ships_grid", ts: "2026-09-29T00:00:00Z", cell_deg: 2, cells: [[35, 129, 3, "cargo"]] });
    expect(cell4).toMatchObject({ kind: "ok", dropped: 0 });
    const badSum = validateServerMessage({ type: "ships_grid", ts: "2026-09-29T00:00:00Z", cell_deg: 2, cells: [[35, 129, 3, "cargo", [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]] });
    expect(badSum.kind === "ok" && badSum.msg.type === "ships_grid" ? [badSum.dropped, badSum.msg.cells[0].counts] : null).toEqual([1, null]);
  });
});
