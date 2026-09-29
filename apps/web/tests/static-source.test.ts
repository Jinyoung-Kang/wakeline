/**
 * 선택 선박 정적 정보의 출처(계약 v5 §G17 · static-fallback) — api 재시작 뒤 실시간 스트림에 정적 보고가 없는 선박은 DB 에 저장된 마지막 AIS 정적
 * 보고로 채우고 stored 로 밝힌다(static_updated_at = 저장 행의 updated_at).
 * - 검증(lib/ws-validate): api 가 실제 빌더로 만든 표본(fixtures/ws-samples.v1.json — live · stored · none · stored_unavailable)을 모두 받는다.
 *   출처가 틀리거나 static 과 어긋나면 그 값만 모름(null)으로 두고 센다 — 저장값에 실시간 표시를, 없는 정적 정보에 출처를 붙이지 않는다.
 * - 카드(ShipCard): 보이는 정적 정보가 저장값이면 정적 필드 바로 위에 "저장된 AIS 정적 보고 · DB 기록 수신 시각 <KST · UTC> (경과)" — 실시간 값이 아님.
 *   시각은 저장 행의 updated_at 이고 그 내용의 첫 수신도 마지막 수신도 아니다(수집기 재시작 · 30분 무수신 뒤 같은 내용도 새 시각 — 수집기 test_ais_book).
 *   출처는 그 정적 정보를 준 쪽(WS → REST)의 것만. DB 를 읽지 못했으면 '없음' 이 아니라 '모름'. 실시간 값 · 정적 정보 없음에는 표시하지 않는다.
 *   '입출항도 이 호출부호로 찾음' 은 아래 입출항(WS port_calls)을 그 호출부호로 찾았을 때만 — WS 가 저장 보고를 읽지 못했으면 찾지 않았다고 적는다(리뷰).
 *   보이는 본문도 저장 행이 한 보고가 아님을 말한다(계약 v5 §G19 · 리뷰): 저장 행은 받은 필드만 덮으므로 그 시각의 보고가 싣지 않은 필드는 앞선 보고의 값.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseShipDetail, ShipCardView } from "@/components/ShipCard";
import { fmtDuration } from "@/lib/format";
import {
  staticProvenance, storedPortCallsNote, STORED_STATIC_FIELDS_TEXT, STORED_STATIC_LABEL, STORED_STATIC_PORT_CALLS_TEXT, STORED_STATIC_PORT_CALLS_UNREAD_TEXT,
  STORED_STATIC_TIME_LABEL,
  STORED_STATIC_TITLE, STORED_STATIC_UNAVAILABLE_TEXT, type ShipStatic,
} from "@/lib/ships";
import { resetData, setData } from "@/lib/store";
import { validateServerMessage, type ShipSelectedMsg } from "@/lib/ws-validate";
import { unpairedKst } from "./helpers/dual-time";

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

// ---------------------------------------------------------------- 카드

const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/** 저장 시각을 고정한 표본(api 표본은 만든 때의 시각 — 글자 비교를 위해 같은 순간으로 옮긴다) */
const STORED_AT = "2026-09-29T03:00:00Z";
const NOW = Date.parse("2026-09-29T08:00:00Z");
function selected(name: string, over: (m: Json) => void = () => {}): ShipSelectedMsg {
  const m = sample(name);
  over(m);
  return accept(m).msg;
}
function show(msg: ShipSelectedMsg | null, detail: ReturnType<typeof parseShipDetail> | null = null, mmsi = msg?.mmsi ?? "440000010"): string {
  if (msg) {
    setData({ shipSelected: { mmsi: msg.mmsi, state: msg.state, static: msg.static, static_source: msg.static_source, static_updated_at: msg.static_updated_at,
      destination_info: msg.destination_info, port_calls: msg.port_calls, received_at: 1 } });
  }
  return renderToStaticMarkup(createElement(ShipCardView, { mmsi, detail, error: null, now: NOW }));
}
const storedMsg = () => selected("ship_selected.static_stored", (m) => {
  (m.static as Json).updated_at = STORED_AT;
  m.static_updated_at = STORED_AT;
});

describe("ship card: a stored static report is labelled next to the static fields", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());

  it("stored: the note names the stored report and the receive time recorded on the stored row (KST · UTC, age) — above the static rows", () => {
    const html = show(storedMsg());
    const t = text(html);
    expect(html).toContain('data-testid="ship-static-stored"');
    expect(t).toContain(`${STORED_STATIC_LABEL} · ${STORED_STATIC_TIME_LABEL} 09-29 12:00:00 KST · 03:00:00 UTC (${fmtDuration(5 * 3600)} 전)`);
    expect(t).toContain("실시간 값이 아님");
    expect(html).toContain(`title="${STORED_STATIC_TITLE}"`);
    expect(html).toContain('<time dateTime="2026-09-29T03:00:00.000Z"');
    expect(unpairedKst(t)).toEqual([]);
    // 정적 필드는 저장된 보고의 값이고, 표시는 그 필드들보다 앞(선박명 행 위)에 있다
    expect(t).toContain("SYNTH STORED");
    expect(html).toMatch(/data-field="호출부호"[^]*D7AG/);
    expect(html.indexOf('data-testid="ship-static-stored"')).toBeLessThan(html.indexOf('data-field="선박명"'));
    // 입출항도 이 호출부호로(WS 가 저장된 호출부호로 찾은 결과)
    expect(t).toContain("D7AG");
    expect(t).toContain(`${STORED_STATIC_FIELDS_TEXT} · ${STORED_STATIC_PORT_CALLS_TEXT}`);
  });

  it("the visible line says the fields are stored values and that fields the last stored report did not carry are earlier reports' values (contract v5 §G19)", () => {
    // 리뷰: 전에는 보이는 줄이 '아래 … 는 이 보고의 값' — 24A(선명)만 저장한 뒤의 호출부호(며칠 전 저장)를 그 시각의 보고로 말했다
    const t = text(show(storedMsg()));
    expect(STORED_STATIC_FIELDS_TEXT).toMatch(/실시간 값이 아님/);
    expect(STORED_STATIC_FIELDS_TEXT).toMatch(/DB 에 저장된 값/);
    expect(STORED_STATIC_FIELDS_TEXT).toMatch(/위 시각의 보고가 싣지 않은 필드는 그보다 앞서 저장된 보고의 값/);
    expect(STORED_STATIC_FIELDS_TEXT).not.toMatch(/이 보고의 값/);
    expect(t).toContain(STORED_STATIC_FIELDS_TEXT);
    expect(t).not.toContain("이 보고의 값");
  });

  it("the time is called neither the first nor the last reception — the title says what rewrites it; without a readable time the note still says stored, with —", () => {
    // ship.updated_at 은 수집기 메모리가 '바뀜' 으로 본 메시지의 수신 시각 — 수집기 재시작 · 30분 무수신(메모리에서 빠짐) 뒤 같은 내용도 새 시각이다
    expect(STORED_STATIC_TIME_LABEL).not.toMatch(/첫|처음|마지막|최초/);
    expect(STORED_STATIC_TIME_LABEL).toBe("DB 기록 수신 시각");
    expect(STORED_STATIC_TITLE).toMatch(/첫 수신도 마지막 수신도 아닙니다/);
    expect(STORED_STATIC_TITLE).toMatch(/내용이 바뀔 때/);
    expect(STORED_STATIC_TITLE).toMatch(/수집기가 다시 시작/);
    expect(STORED_STATIC_TITLE).toMatch(/30분 넘게/);
    expect(STORED_STATIC_TITLE).not.toMatch(/첫 메시지|처음 받은/);
    // 계약 v5 §G19: 저장 행은 받은 필드만 덮는다 — 시각은 마지막으로 저장한 보고의 것, 그 보고가 싣지 않은 부분은 더 앞선 보고의 값
    expect(STORED_STATIC_TITLE).toMatch(/마지막으로 정적 보고를 저장한 메시지/);
    expect(STORED_STATIC_TITLE).toMatch(/싣지 않은 부분.*앞서 저장된 보고의 값/);
    expect(STORED_STATIC_TITLE).not.toMatch(/지금 저장된 내용을 DB 에 쓴 메시지/);
    const t = text(show(selected("ship_selected.static_stored", (m) => { m.static_updated_at = "later"; })));
    expect(t).toContain(`${STORED_STATIC_LABEL} · ${STORED_STATIC_TIME_LABEL} —`);
  });

  it("live, none and a static without a known source show no note; a DB read failure says unknown, not none", () => {
    for (const name of ["ship_selected", "ship_selected.static_only", "ship_selected.static_none"]) {
      resetData();
      const html = show(selected(name));
      expect(html, name).not.toContain("ship-static-stored");
      expect(html, name).not.toContain("ship-static-unavailable");
    }
    resetData();
    const old = selected("ship_selected", (m) => { delete m.static_source; delete m.static_updated_at; });
    expect(show(old)).not.toContain(STORED_STATIC_LABEL);
    resetData();
    const down = text(show(selected("ship_selected.static_stored_unavailable")));
    expect(down).toContain(STORED_STATIC_UNAVAILABLE_TEXT);
    expect(down).not.toContain(`${STORED_STATIC_LABEL} ·`);
  });

  it("REST detail: the same note when the card shows the stored static from /ships/{mmsi} (before or without a WS value)", () => {
    const body = { state: null, static: { name: "SYN STORED REST", call_sign: "D9RS", updated_at: STORED_AT, provider: "aisstream" }, static_source: "stored",
      static_updated_at: STORED_AT, first_recorded_at: "2026-09-20T00:00:00Z", meta: {} };
    const d = parseShipDetail("440000077", body);
    expect(d.static_source).toBe("stored");
    expect(d.static_updated_at).toBe(STORED_AT);
    const t = text(show(null, d, "440000077"));
    expect(t).toContain(`${STORED_STATIC_LABEL} · ${STORED_STATIC_TIME_LABEL} 09-29 12:00:00 KST · 03:00:00 UTC`);
    expect(text(show(null, parseShipDetail("440000077", { ...body, static_source: "live", static_updated_at: undefined }), "440000077")))
      .not.toContain(STORED_STATIC_LABEL);
  });

  it("WS stored_unavailable + REST stored: the note never says the port calls used this call sign — it says they were not looked up (review)", () => {
    // WS: 서버가 선택 때 저장 보고를 읽지 못했다(static null · port_calls no_call_sign/not_received). REST: 같은 행을 읽었다(stored · V7A3884).
    const ws = selected("ship_selected.static_stored_unavailable");
    const d = parseShipDetail(ws.mmsi, { state: null, static: { name: "SYN REST ONLY", call_sign: "V7A3884", updated_at: STORED_AT, provider: "aisstream" },
      static_source: "stored", static_updated_at: STORED_AT, meta: {} });
    const html = show(ws, d);
    const t = text(html);
    expect(html).toContain('data-testid="ship-static-stored"');
    expect(html).toMatch(/data-field="호출부호"[^]*V7A3884/);
    expect(t).toContain(STORED_STATIC_FIELDS_TEXT);
    expect(t).not.toContain(STORED_STATIC_PORT_CALLS_TEXT);
    expect(html).toContain('data-testid="ship-static-stored-portcalls"');
    expect(t).toContain(STORED_STATIC_PORT_CALLS_UNREAD_TEXT);
    expect(STORED_STATIC_TITLE).not.toMatch(/입출항/); // 설명(title)도 조건 없이 말하지 않는다
    // REST 만(WS 아직 — 아래 입출항 없음): 찾았다고도 찾지 않았다고도 하지 않는다
    resetData();
    const only = text(show(null, d, ws.mmsi));
    expect(only).toContain(`${STORED_STATIC_LABEL} ·`);
    expect(only).not.toContain(STORED_STATIC_PORT_CALLS_TEXT);
    expect(only).not.toContain(STORED_STATIC_PORT_CALLS_UNREAD_TEXT);
  });

  it("storedPortCallsNote: 'looked up' only when the WS port calls carry the shown call sign (server-normalized); 'not looked up' only for WS stored_unavailable", () => {
    const calls = (call_sign: string | null) => ({ static_source: "stored" as const, port_calls: { call_sign } });
    expect(storedPortCallsNote("D7AG", calls("D7AG"))).toBe("looked_up");
    expect(storedPortCallsNote(" d7ag ", calls("D7AG"))).toBe("looked_up"); // 서버 정규화(앞뒤 공백 · 대문자)와 같은 규칙
    expect(storedPortCallsNote("D7AG", calls("D7AH"))).toBeNull(); // 다른 호출부호로 찾은 결과
    expect(storedPortCallsNote("AB", calls(null))).toBeNull(); // 형식 밖 — 입출항 절이 스스로 말한다
    expect(storedPortCallsNote("D7ÄG", calls("D7ÄG"))).toBeNull(); // ASCII 밖은 서버가 찾지 않는다
    expect(storedPortCallsNote(null, calls("D7AG"))).toBeNull();
    expect(storedPortCallsNote("V7A3884", { static_source: "stored_unavailable", port_calls: { call_sign: null } })).toBe("not_looked_up");
    expect(storedPortCallsNote("V7A3884", { static_source: "none", port_calls: { call_sign: null } })).toBeNull();
    expect(storedPortCallsNote("V7A3884", null)).toBeNull();
  });

  it("parseShipDetail: a source only with a static, only live or stored; the time only for stored", () => {
    const st = { name: "X", updated_at: STORED_AT };
    expect(parseShipDetail("440000077", { static: null, static_source: "stored", static_updated_at: STORED_AT }).static_source).toBeNull();
    expect(parseShipDetail("440000077", { static: st, static_source: "none" }).static_source).toBeNull();
    expect(parseShipDetail("440000077", { static: st, static_source: "guessed" }).static_source).toBeNull();
    const live = parseShipDetail("440000077", { static: st, static_source: "live", static_updated_at: STORED_AT });
    expect([live.static_source, live.static_updated_at]).toEqual(["live", null]);
    expect(parseShipDetail("440000077", { static: st, static_source: "stored", static_updated_at: 5 }).static_updated_at).toBeNull();
  });

  it("staticProvenance: the source of the static the card shows (WS first, then REST) — never the other side's", () => {
    const s = { mmsi: "440000077", updated_at: STORED_AT } as ShipStatic;
    const rest = { static: s, static_source: "stored" as const, static_updated_at: STORED_AT };
    expect(staticProvenance({ static: s, static_source: "live", static_updated_at: null }, rest)).toEqual({ source: "live", storedAt: null });
    expect(staticProvenance({ static: null, static_source: "none" }, rest)).toEqual({ source: "stored", storedAt: STORED_AT });
    expect(staticProvenance({ static: null, static_source: "stored_unavailable" }, null)).toEqual({ source: "stored_unavailable", storedAt: null });
    expect(staticProvenance({ static: s }, null)).toEqual({ source: null, storedAt: null }); // 이전 서버 — 모름
    expect(staticProvenance(null, { static: null, static_source: null, static_updated_at: null })).toEqual({ source: null, storedAt: null });
  });
});
