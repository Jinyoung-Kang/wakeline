/**
 * 한국 항만 입출항(ADR-022) — 선박 카드의 "한국 항만 입출항 (해양수산부 PORT-MIS · 최근 30일)".
 * 자료는 api 가 실제 빌더로 만든 WS 표본(fixtures/ws-samples.v1.json — ship_selected.port_calls 의 모든 상태)과, 그 값의 필드만 바꾼 것이다
 * (필드 이름을 지어내지 않는다 · 입출항 값은 수집기가 실제 응답 fixture 로 만든 부산 1건).
 * - 검증: 모르는 상태 · 다른 조회 창 · 읽을 항목 없는 ok 는 표시하지 않는다. 틀린 묶음은 통째로 버리고 센다(메시지의 나머지는 쓴다).
 * - 화면: 상태마다 문구(조회 중 = 바쁨 표시) · 결과 표(항만청 · 입항/출항 KST+UTC · 목적 · 전출항지 → 차항지) · 선명이 다르면 경고 · 모르면 "—" 만.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateServerMessage } from "@/lib/ws-validate";
import {
  callTimes, kstUtc, legText, parsePortCalls, portCallStatusText, portText, PORT_CALL_ERROR_KINDS, PORT_CALL_ERROR_TEXT, reportedNameMismatches, windowText,
  type PortCall, type PortCallsInfo,
} from "@/lib/portcalls";
import { PortCallsSection } from "@/components/PortCallsSection";
import { ShipCardView } from "@/components/ShipCard";
import { resetData, setData } from "@/lib/store";
import { attributionText, CREDITS } from "@/lib/attribution";
import AboutPage from "@/app/about/page";

type Json = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/ws-samples.v1.json", import.meta.url), "utf8")) as { server: { name: string; message: Json }[] };
const sample = (name: string) => structuredClone(fixture.server.find((s) => s.name === name)!.message);
const calls = (name: string) => sample(name).port_calls as Json;
const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<");
const render = (c: PortCallsInfo | null, aisName: string | null = "SYNTH ONE") => renderToStaticMarkup(createElement(PortCallsSection, { calls: c, aisName }));

describe("port_calls parsing (every state the api sends)", () => {
  it("ok: the collector's Busan call with the verified fields; unknown fields stay null", () => {
    const p = parsePortCalls(calls("ship_selected"))!;
    expect(p.status).toBe("ok");
    expect(p.call_sign).toBe("D7AB");
    expect(p.window_from).toBe("2026-08-30");
    expect(p.window_to).toBe("2026-09-29");
    expect(p.truncated).toBe(true);
    expect(p.incomplete).toBe(true);
    expect(p.items).toHaveLength(1);
    const c = p.items[0];
    expect(c).toMatchObject({
      port_authority_code: "020", port_authority: "부산", entry_at: "2026-09-28T15:00:00Z", exit_at: null, purpose: "양하",
      prev_port: { code: "KRYOC", name: "여천항" }, next_port: { code: "KRYOC", name: "여천항" }, reported_name: "부광9호", kind: "석유제품 운반선",
      nationality: null,
    });
    expect(c.reports).toEqual([{ kind: "입항", at: "2026-09-28T15:00:00Z", type: "최초" }]);
  });

  it("other states carry only their own fields", () => {
    expect(parsePortCalls(calls("ship_selected.port_calls_error"))).toMatchObject({ status: "error", error_kind: "http", error_code: "503", items: [] });
    expect(parsePortCalls(calls("ship_selected.port_calls_disabled"))).toMatchObject({ status: "disabled", disabled_reason: "no_key", error_kind: null });
    expect(parsePortCalls(calls("ship_selected.port_calls_pending"))).toMatchObject({ status: "pending", call_sign: "D7AE", fetched_at: null });
    expect(parsePortCalls(calls("ship_selected.static_only"))).toMatchObject({ status: "no_call_sign", call_sign: null });
    // error_kind 는 error 일 때만 — 다른 상태에 붙어 와도 쓰지 않는다
    expect(parsePortCalls({ ...calls("ship_selected.port_calls_pending"), error_kind: "http" })!.error_kind).toBeNull();
  });

  it("unknown state, another window or an ok without readable items is not shown (null), never turned into 'none'", () => {
    expect(parsePortCalls({ ...calls("ship_selected"), status: "maybe" })).toBeNull();
    expect(parsePortCalls({ ...calls("ship_selected"), window_days: 7 })).toBeNull();
    expect(parsePortCalls({ ...calls("ship_selected"), items: [] })).toBeNull();
    expect(parsePortCalls({ ...calls("ship_selected"), items: [1, "x"] })).toBeNull();
    for (const v of [null, undefined, "ok", 1, []]) expect(parsePortCalls(v)).toBeNull();
  });

  it("fields are shape-checked and text is cleaned; times need a zone", () => {
    const base = calls("ship_selected");
    const item = { ...(base.items as Json[])[0], port_authority_code: "20", port_authority: "부산‮\u0007", entry_at: "2026-09-29T00:00:00",
      prev_port: { code: "kryoc", name: "여천항" }, next_port: { code: null, name: null }, reported_name: "  부광9호​ ", purpose: "x".repeat(120) };
    const c = parsePortCalls({ ...base, items: [item] })!.items[0];
    expect(c.port_authority_code).toBeNull();
    expect(c.port_authority).toBe("부산");
    expect(c.entry_at).toBeNull();
    expect(c.prev_port).toEqual({ code: null, name: "여천항" });
    expect(c.next_port).toBeNull();
    expect(c.reported_name).toBe("부광9호");
    expect(Array.from(c.purpose!)).toHaveLength(80);
  });
});

describe("ws-validate: ship_selected.port_calls is one droppable bundle", () => {
  it("every api sample is accepted with its port_calls", () => {
    for (const name of ["ship_selected", "ship_selected.static_only", "ship_selected.port_calls_error", "ship_selected.port_calls_disabled", "ship_selected.port_calls_pending"]) {
      const r = validateServerMessage(sample(name));
      expect(r.kind, name).toBe("ok");
      if (r.kind !== "ok" || r.msg.type !== "ship_selected") throw new Error(name);
      expect(r.dropped, name).toBe(0);
      expect(r.msg.port_calls?.status, name).toBe((sample(name).port_calls as Json).status);
    }
  });

  it("a wrong port_calls is dropped and counted; the rest of the message still applies", () => {
    const m = sample("ship_selected");
    (m.port_calls as Json).items = [{ ...((m.port_calls as Json).items as Json[])[0], port_authority_code: 20 }];
    const r = validateServerMessage(m);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok" || r.msg.type !== "ship_selected") throw new Error("kind");
    expect(r.dropped).toBe(1);
    expect(r.where).toBe("ship_selected.port_calls");
    expect(r.msg.port_calls).toBeNull();
    expect(r.msg.state).not.toBeNull();
    const old = sample("ship_selected");
    delete old.port_calls; // 이전 서버(키 없음) — 모름
    const r2 = validateServerMessage(old);
    expect(r2.kind === "ok" && r2.msg.type === "ship_selected" && r2.msg.port_calls === null && r2.dropped === 0).toBe(true);
  });
});

describe("port-call helpers", () => {
  it("KST and UTC of the same instant; unknown is — only (no zone word)", () => {
    expect(kstUtc("2026-09-28T15:00:00Z")).toEqual({ kst: "09-29 00:00 KST", utc: "09-28 15:00 UTC", title: "원본 UTC 2026-09-28T15:00:00.000Z" });
    expect(kstUtc("2026-09-29T00:00:00+09:00").kst).toBe("09-29 00:00 KST");
    for (const v of [null, undefined, "", "bad"]) expect(kstUtc(v)).toEqual({ kst: "—", utc: null, title: undefined });
  });

  it("ports and legs: name(code) · either · —", () => {
    expect(portText({ code: "KRYOC", name: "여천항" })).toBe("여천항(KRYOC)");
    expect(portText({ code: "KRYOC", name: null })).toBe("KRYOC");
    expect(portText({ code: null, name: "여천항" })).toBe("여천항");
    expect(portText(null)).toBe("—");
    const c = parsePortCalls(calls("ship_selected"))!.items[0];
    expect(legText(c)).toBe("여천항(KRYOC) → 여천항(KRYOC)");
    expect(legText({ ...c, prev_port: null, next_port: null })).toBe("—");
    expect(legText({ ...c, prev_port: null })).toBe("— → 여천항(KRYOC)");
  });

  it("entry/exit: the single time, or every report when several differ — never a pick", () => {
    const c: PortCall = { ...parsePortCalls(calls("ship_selected"))!.items[0], entry_at: null,
      reports: [{ kind: "입항", at: "2026-09-28T15:00:00Z", type: "최초" }, { kind: "입항", at: "2026-09-28T16:00:00Z", type: "변경" }, { kind: "출항", at: "2026-09-29T01:00:00Z", type: "최초" }] };
    expect(callTimes(c, "입항")).toEqual({ single: null, reports: ["2026-09-28T15:00:00Z", "2026-09-28T16:00:00Z"] });
    expect(callTimes(c, "출항")).toEqual({ single: null, reports: [] }); // 한 건뿐인데 서버가 exit_at 을 비웠다 — 고르지 않고 모름
    expect(callTimes({ ...c, exit_at: "2026-09-29T01:00:00Z" }, "출항").single).toBe("2026-09-29T01:00:00Z");
  });

  it("reported names that differ from the AIS name (spacing · case · width are the same name)", () => {
    const c = parsePortCalls(calls("ship_selected"))!.items[0];
    expect(reportedNameMismatches([c], "BUKWANG 9")).toEqual(["부광9호"]);
    expect(reportedNameMismatches([{ ...c, reported_name: "Bukwang  9" }], " BUKWANG 9 ")).toEqual([]);
    expect(reportedNameMismatches([{ ...c, reported_name: "ＢＵＫＷＡＮＧ 9" }], "BUKWANG 9")).toEqual([]);
    expect(reportedNameMismatches([c, c, { ...c, reported_name: null }], null)).toEqual(["부광9호"]); // 비교 불가 — 한 번만
  });

  it("status line for every state and every error kind", () => {
    const e = parsePortCalls(calls("ship_selected.port_calls_error"))!;
    expect(portCallStatusText(e)).toBe("조회 실패 — PORT-MIS HTTP 오류 (503) · 선택해 두면 5분 뒤 다시 조회");
    for (const k of PORT_CALL_ERROR_KINDS) expect(portCallStatusText({ ...e, error_kind: k, error_code: null })).toContain(PORT_CALL_ERROR_TEXT[k]);
    expect(portCallStatusText({ ...e, error_kind: null, error_code: null })).toContain("원인 모름");
    const d = parsePortCalls(calls("ship_selected.port_calls_disabled"))!;
    expect(portCallStatusText(d)).toBe("공공데이터포털 키 없음 — 조회하지 않음");
    expect(portCallStatusText({ ...d, disabled_reason: "fixture" })).toBe("fixture 모드 — 외부 조회 없음");
    expect(portCallStatusText({ ...d, disabled_reason: "operator" })).toBe("운영자가 조회를 껐음(운영 설정)");
    expect(portCallStatusText({ ...d, disabled_reason: null })).toBe("조회 꺼짐");
    expect(portCallStatusText({ ...d, status: "none" })).toBe("최근 30일 한국 항만 입출항 기록 없음(호출부호 기준)");
    expect(portCallStatusText({ ...d, status: "no_call_sign" })).toBe("호출부호 없음 — 조회 불가");
    expect(portCallStatusText(parsePortCalls(calls("ship_selected"))!)).toBeNull();
    expect(windowText(parsePortCalls(calls("ship_selected"))!)).toBe("2026-08-30 ~ 2026-09-29 (KST 날짜 · 입항일 기준)");
    expect(windowText(d)).toBe("최근 30일");
  });
});

describe("PortCallsSection (server-rendered)", () => {
  it("pending: a busy indicator announced politely, not a static label", () => {
    const html = render(parsePortCalls(calls("ship_selected.port_calls_pending")));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-testid="port-calls-busy"');
    expect(html).toContain("wl-busy");
    expect(text(html)).toContain("조회 중 — PORT-MIS 항만청 10곳에 차례로 묻는 중");
    expect(text(html)).toContain("호출부호 D7AE");
  });

  it("none · disabled · error · no call sign say exactly that", () => {
    const d = parsePortCalls(calls("ship_selected.port_calls_disabled"))!;
    expect(text(render({ ...d, status: "none", disabled_reason: null, window_from: "2026-08-30", window_to: "2026-09-29" })))
      .toContain("최근 30일 한국 항만 입출항 기록 없음(호출부호 기준)");
    expect(text(render(d))).toContain("공공데이터포털 키 없음");
    const err = render(parsePortCalls(calls("ship_selected.port_calls_error")));
    expect(err).toContain('role="alert"');
    expect(text(err)).toContain("조회 실패 — PORT-MIS HTTP 오류 (503)");
    expect(text(err)).toContain("조회 09-29 12:00 KST (09-29 03:00 UTC)");
    const none = text(render(parsePortCalls(calls("ship_selected.static_only"))));
    expect(none).toContain("호출부호 없음 — 조회 불가");
    expect(none).not.toContain("KST 날짜"); // 조회하지 않았다 — 조회 창을 말하지 않는다
    expect(text(render(null))).toContain("한국 항만 입출항 (해양수산부 PORT-MIS · 최근 30일)—");
  });

  it("ok: compact table with KST and UTC, purpose and legs; name mismatch, truncation and incompleteness are explicit", () => {
    const html = render(parsePortCalls(calls("ship_selected")), "SYNTH ONE");
    const t = text(html);
    expect(html.match(/data-testid="port-call-row"/g)).toHaveLength(1);
    for (const h of ["항만청", "입항", "출항", "목적", "전출항지 → 차항지"]) expect(t).toContain(h);
    expect(t).toContain("부산020");
    expect(t).toContain("09-29 00:00 KST09-28 15:00 UTC");
    expect(html).toContain('title="원본 UTC 2026-09-28T15:00:00Z"'.replace("15:00:00Z", "15:00:00.000Z"));
    expect(t).toContain("양하");
    expect(t).toContain("여천항(KRYOC) → 여천항(KRYOC)");
    expect(t).not.toContain("목적지 여천항"); // 차항지와 같으면 되풀이하지 않는다
    expect(t).toContain("PORT-MIS 선명 부광9호 — AIS 선명(SYNTH ONE)과 다름");
    expect(t).toContain("최근 신고 선종 석유제품 운반선 · 국적 —");
    expect(t).toContain("최근 20건만 표시 — 더 있음");
    expect(t).toContain("항만청당 300건");
    expect(t).toContain("2026-08-30 ~ 2026-09-29 (KST 날짜 · 입항일 기준) · 조회 09-29 12:00 KST (09-29 03:00 UTC)");
    expect(t).toContain("출처 해양수산부 선박운항정보(PORT-MIS) · 공공데이터포털");
    // 모르는 출항 시각은 "—" 만(시간대·단위 글자 없음)
    expect(t).not.toMatch(/— ?(KST|UTC)/);
    expect(text(render(parsePortCalls(calls("ship_selected")), null))).toContain("PORT-MIS 선명 부광9호 — AIS 선명 없음(비교 불가)");
  });

  it("ambiguous entry times are all listed, and a different destination is shown under the legs", () => {
    const p = parsePortCalls(calls("ship_selected"))!;
    const c: PortCall = { ...p.items[0], entry_at: null, dest_port: { code: "KRPUS", name: "부산항" },
      reports: [{ kind: "입항", at: "2026-09-28T15:00:00Z", type: "최초" }, { kind: "입항", at: "2026-09-28T16:30:00Z", type: "변경" }] };
    const t = text(render({ ...p, items: [c], truncated: false, incomplete: false }));
    expect(t).toContain("입항 신고 2건 · 시각 다름");
    expect(t).toContain("09-29 00:00 KST09-28 15:00 UTC");
    expect(t).toContain("09-29 01:30 KST09-28 16:30 UTC");
    expect(t).toContain("목적지 부산항(KRPUS)");
    expect(t).not.toContain("더 있음");
  });
});

describe("ship card shows the section from ship_selected", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());

  it("renders the port calls the WS delivered for this ship (AIS name from the static report)", () => {
    const m = sample("ship_selected");
    const v = validateServerMessage(m);
    if (v.kind !== "ok" || v.msg.type !== "ship_selected") throw new Error("sample");
    setData({ shipSelected: { mmsi: v.msg.mmsi, state: v.msg.state, static: v.msg.static, destination_info: v.msg.destination_info, port_calls: v.msg.port_calls, received_at: 1 } });
    const html = renderToStaticMarkup(createElement(ShipCardView, { mmsi: v.msg.mmsi, detail: null, error: null, now: Date.parse("2026-09-29T03:00:00Z") }));
    expect(html).toContain('data-testid="port-calls"');
    expect(html).toContain('data-status="ok"');
    expect(text(html)).toContain(`PORT-MIS 선명 부광9호 — AIS 선명(${v.msg.static?.name})과 다름`);
  });

  it("without a WS message the section says — (the REST detail carries no port calls)", () => {
    const html = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "440000001", detail: null, error: null, now: 0 }));
    expect(html).toContain('data-status="unknown"');
  });
});

describe("sources", () => {
  it("the footer and /about name PORT-MIS", () => {
    expect(attributionText()).toContain("입출항: 해양수산부 선박운항정보(PORT-MIS) (공공데이터포털)");
    expect(CREDITS.find((c) => c.role === "입출항")?.href).toBe("https://www.data.go.kr");
    const about = text(renderToStaticMarkup(createElement(AboutPage)));
    expect(about).toContain("해양수산부 선박운항정보(PORT-MIS)");
    expect(about).toContain("호출부호로만 수집기가 조회");
  });
});
