/**
 * 선택 선박 정적 정보의 출처(계약 v5 §G17 · static-fallback) — api 재시작 뒤 실시간 스트림에 정적 보고가 없는 선박은 DB 에 저장된 마지막 AIS 정적
 * 보고로 채우고 stored 로 밝힌다(static_updated_at = 저장 행의 updated_at).
 * - 검증(lib/ws-validate): api 가 실제 빌더로 만든 표본(fixtures/ws-samples.v1.json — live · stored · none · stored_unavailable)을 모두 받는다.
 *   출처가 틀리거나 static 과 어긋나면 그 값만 모름(null)으로 두고 센다 — 저장값에 실시간 표시를, 없는 정적 정보에 출처를 붙이지 않는다.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateServerMessage, type ShipSelectedMsg } from "@/lib/ws-validate";

type Json = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/ws-samples.v1.json", import.meta.url), "utf8")) as { server: { name: string; message: Json }[] };
const sample = (name: string): Json => {
  const s = fixture.server.find((x) => x.name === name);
  if (!s) throw new Error(`no fixture sample ${name}`);
  return structuredClone(s.message);
};
const accept = (m: Json): { msg: ShipSelectedMsg; dropped: number; where: string | null } => {
  const r = validateServerMessage(m);
  if (r.kind !== "ok" || r.msg.type !== "ship_selected") throw new Error(`not accepted: ${JSON.stringify(r).slice(0, 200)}`);
  return { msg: r.msg, dropped: r.dropped, where: r.where };
};

describe("ws-validate: ship_selected.static_source · static_updated_at", () => {
  it("every api sample is accepted whole with its source; only stored carries the row's time", () => {
    const seen = new Set<string | null>();
    for (const s of fixture.server.filter((x) => x.message.type === "ship_selected")) {
      const { msg, dropped } = accept(structuredClone(s.message));
      expect(dropped, s.name).toBe(0);
      expect(msg.static_source, s.name).toBe(s.message.static_source);
      expect(msg.static_updated_at, s.name).toBe(s.message.static_updated_at);
      seen.add(msg.static_source);
    }
    expect([...seen].sort()).toEqual(["live", "none", "stored", "stored_unavailable"]);
    const stored = accept(sample("ship_selected.static_stored")).msg;
    expect(stored.static?.call_sign).toBe("D7AG");
    expect(stored.static_updated_at).toBe(stored.static?.updated_at);
    expect(stored.port_calls?.call_sign).toBe("D7AG"); // 저장된 호출부호로 찾은 입출항
    const down = accept(sample("ship_selected.static_stored_unavailable")).msg;
    expect(down.static).toBeNull();
    expect(down.port_calls?.status === "no_call_sign" && down.port_calls.call_sign_state).toBe("not_received");
  });

  it("a source that is unknown or disagrees with static becomes unknown (null) and is counted — the rest applies", () => {
    const cases: [string, string, (m: Json) => void][] = [
      ["unknown value", "ship_selected", (m) => { m.static_source = "guessed"; }],
      ["live without a static", "ship_selected.static_none", (m) => { m.static_source = "live"; }],
      ["stored without a static", "ship_selected.static_none", (m) => { m.static_source = "stored"; }],
      ["none with a static", "ship_selected", (m) => { m.static_source = "none"; }],
      ["stored_unavailable with a static", "ship_selected.static_stored", (m) => { m.static_source = "stored_unavailable"; m.static_updated_at = null; }],
    ];
    for (const [what, name, mutate] of cases) {
      const m = sample(name);
      mutate(m);
      const { msg, dropped, where } = accept(m);
      expect(msg.static_source, what).toBeNull();
      expect(dropped, what).toBe(1);
      expect(where, what).toBe("ship_selected.static_source");
      expect(msg.static, what).toEqual(accept(sample(name)).msg.static); // 정적 정보 자체는 그대로(출처만 모름)
    }
  });

  it("the stored time is kept only for stored, and only as a zoned date-time", () => {
    const live = sample("ship_selected");
    live.static_updated_at = "2026-09-29T08:00:00Z"; // 실시간 값에 저장 시각
    let r = accept(live);
    expect(r.msg.static_source).toBe("live");
    expect(r.msg.static_updated_at).toBeNull();
    expect(r.where).toBe("ship_selected.static_updated_at");
    const bad = sample("ship_selected.static_stored");
    bad.static_updated_at = "5 hours ago";
    r = accept(bad);
    expect(r.msg.static_source).toBe("stored"); // 저장값이라는 사실은 그대로 — 시각만 모름
    expect(r.msg.static_updated_at).toBeNull();
    expect(r.dropped).toBe(1);
    const zoned = sample("ship_selected.static_stored");
    zoned.static_updated_at = "2026-09-29T20:00:00.123456+09:00";
    expect(accept(zoned).msg.static_updated_at).toBe("2026-09-29T20:00:00.123456+09:00");
  });

  it("an older server without the keys: unknown source, nothing counted", () => {
    const old = sample("ship_selected");
    delete old.static_source;
    delete old.static_updated_at;
    const r = accept(old);
    expect(r.msg.static_source).toBeNull();
    expect(r.msg.static_updated_at).toBeNull();
    expect(r.dropped).toBe(0);
    expect(r.msg.static?.name).toBe("SYNTH ONE");
  });
});
