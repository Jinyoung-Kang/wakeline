/**
 * 한국 항만 입출항(ADR-022 개정) — 선박 카드의 "한국 항만 입출항 (해양수산부 PORT-MIS · 최근 30일)".
 * 자료는 api 가 실제 빌더로 만든 WS 표본(fixtures/ws-samples.v1.json — ship_selected.port_calls 의 모든 상태)과, 그 값의 필드만 바꾼 것이다
 * (필드 이름을 지어내지 않는다 · 입출항 값은 수집기가 실제 전체 기록(AZAMARA PURSUIT · 부산)을 해석한 색인 행의 호출부호만 바꾼 것).
 * - 검증: 모르는 상태 · 다른 창 · 읽을 항목 없는 ok · 색인 상태 없는 결과 · 완전하지 않은 none · 까닭 없는 no_call_sign 은 표시하지 않는다.
 *   틀린 묶음은 통째로 버리고 센다(메시지의 나머지는 쓴다).
 * - 화면: 상태마다 문구(기록 없음은 색인이 완전할 때만 · 색인 불완전은 항만청별 이유 · 호출부호를 아직 받지 않음은 '없음' 이 아니다) · 결과는 신고마다 블록(좁은 카드 — 표 아님)
 *   (항만청 · 입항 · 출항 KST+UTC(판) · 선석 · 목적 · 전출항지 → 차항지) · 색인 상태 줄 · 두 이름이 모두 영문일 때만 선명 다름 경고 · 모르면 "—" 만.
 * - 시각은 공유 형식기(lib/time · components/DualTime — 계약 v5 §G13): 표 칸은 첫 줄 KST · 둘째 줄 UTC, 색인 갱신 시각은 inline.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateServerMessage } from "@/lib/ws-validate";
import {
  gapText, legText, noExitTitle, parsePortCalls, portCallStatusText, portText, reportTime, PORT_CALL_CALL_SIGN_TEXT, PORT_CALL_DISABLED_TEXT,
  PORT_CALL_CAVEAT, PORT_CALL_ERROR_TEXT, PORT_CALL_INCOMPLETE_TEXT, PORT_CALL_INDEX_AS_OF_TITLE, PORT_CALL_NONE_TEXT, reportedNameNotes, windowText,
  type PortCallsInfo,
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
const parsed = (name: string) => parsePortCalls(calls(name))!;
const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&#x27;/g, "'");
const render = (c: PortCallsInfo | null, aisName: string | null = "SYNTH ONE") => renderToStaticMarkup(createElement(PortCallsSection, { calls: c, aisName }));
const ALL = ["ship_selected", "ship_selected.static_only", "ship_selected.port_calls_error", "ship_selected.port_calls_disabled", "ship_selected.port_calls_none",
  "ship_selected.port_calls_incomplete", "ship_selected.port_calls_no_call_sign_not_received", "ship_selected.port_calls_no_call_sign_unusable"];

describe("port_calls parsing (every state the api sends)", () => {
  it("ok: the collector's real record (AZAMARA PURSUIT, Busan) with entry, exit from tkoffDt, berth and the final revision", () => {
    const p = parsed("ship_selected");
    expect(p).toMatchObject({ status: "ok", call_sign: "D7AB", window_from: "2026-08-30", window_to: "2026-09-29", truncated: true });
    expect(p.index).toEqual({ complete: true, refreshed_at: "2026-09-29T12:50:00Z", gaps: [] });
    expect(p.items).toHaveLength(20);
    expect(p.items[0]).toEqual({
      port_authority_code: "020", port_authority: "부산", listed_date: "2026-09-24", entry_at: "2026-09-23T23:17:00Z", entry_revision: "최종",
      exit_at: "2026-09-25T05:24:00Z", exit_revision: "최종", berth: "북항크루즈터미널 2선석", purpose: "여객상륙",
      first_port: { code: "JPUKB", name: "KOBE" }, prev_port: { code: "JPSMN", name: "SAKAIMINATO" }, next_port: { code: "JPHIJ", name: "HIROSHIMA" },
      dest_port: { code: "JPHIJ", name: "HIROSHIMA" }, reported_name: "AZAMARA PURSUIT", kind: "크루즈선", nationality: "마샬 제도",
      read_at: "2026-09-29T12:45:00Z",
    });
  });

  it("other states carry only their own fields", () => {
    expect(parsed("ship_selected.port_calls_error")).toMatchObject({ status: "error", call_sign: "D7AC", items: [], index: null });
    expect(parsed("ship_selected.port_calls_disabled")).toMatchObject({ status: "disabled", disabled_reason: "no_key", index: null });
    expect(parsed("ship_selected.port_calls_none")).toMatchObject({ status: "none", call_sign: "D7AE", items: [], index: { complete: true, gaps: [] } });
    const inc = parsed("ship_selected.port_calls_incomplete");
    expect(inc.status).toBe("incomplete");
    expect(inc.index!.complete).toBe(false);
    expect(inc.index!.refreshed_at).toBeNull(); // 한 곳이 색인되지 않았다 — 하나의 '기준 시각' 이 없다
    expect(inc.index!.gaps).toEqual([
      { port_authority_code: "020", port_authority: "부산", issues: ["partial"], covered_from: "2026-09-12", covered_to: "2026-09-29", refreshed_at: "2026-09-29T12:50:00Z", unindexed_days: [] },
      { port_authority_code: "030", port_authority: "인천", issues: ["behind", "stale"], covered_from: "2026-08-30", covered_to: "2026-09-28", refreshed_at: "2026-09-29T10:30:00Z", unindexed_days: [] },
      { port_authority_code: "200", port_authority: "동해", issues: ["unindexed_days"], covered_from: "2026-08-30", covered_to: "2026-09-29", refreshed_at: "2026-09-29T12:50:00Z", unindexed_days: ["2026-09-20", "2026-09-27"] },
      { port_authority_code: "700", port_authority: "포항", issues: ["not_indexed"], covered_from: null, covered_to: null, refreshed_at: null, unindexed_days: [] },
    ]);
    expect(parsed("ship_selected.static_only")).toMatchObject({ status: "no_call_sign", call_sign_state: "not_received", call_sign: null });
    expect(parsed("ship_selected.port_calls_no_call_sign_not_received").call_sign_state).toBe("not_received");
    expect(parsed("ship_selected.port_calls_no_call_sign_unusable").call_sign_state).toBe("unusable");
    // disabled_reason 은 disabled 일 때만 · call_sign_state 는 no_call_sign 일 때만
    expect(parsePortCalls({ ...calls("ship_selected.port_calls_none"), disabled_reason: "no_key", call_sign_state: "unusable" }))
      .toMatchObject({ disabled_reason: null, call_sign_state: null });
  });

  it("'none' is only shown for a complete index; results without their index state are not shown", () => {
    const none = calls("ship_selected.port_calls_none");
    const inc = calls("ship_selected.port_calls_incomplete");
    expect(parsePortCalls({ ...none, index: (inc as Json).index })).toBeNull(); // 서버가 '없음' 이라 해도 색인이 완전하지 않으면 말하지 않는다
    expect(parsePortCalls({ ...inc, index: (none as Json).index })).toBeNull();
    expect(parsePortCalls({ ...none, index: undefined })).toBeNull();
    expect(parsePortCalls({ ...calls("ship_selected"), index: undefined })).toBeNull();
    expect(parsePortCalls({ ...none, index: { ...(none.index as Json), authorities: 11 } })).toBeNull();
    expect(parsePortCalls({ ...none, index: { ...(none.index as Json), stale_after_s: 86400 } })).toBeNull();
    expect(parsePortCalls({ ...none, index: { ...(none.index as Json), gaps: (inc.index as Json).gaps } })).toBeNull(); // 완전하다면서 빈 곳
    expect(parsePortCalls({ ...inc, index: { ...(inc.index as Json), gaps: [{ port_authority_code: "700", port_authority: "포항", issues: ["guessed"] }] } })).toBeNull();
    expect(parsePortCalls({ ...calls("ship_selected.static_only"), call_sign_state: undefined })).toBeNull(); // 까닭을 지어내지 않는다
  });

  it("unknown or retired states, another window, an ok without readable items are not shown (null), never turned into 'none'", () => {
    for (const status of ["maybe", "pending", "limited", "no_static"]) expect(parsePortCalls({ ...calls("ship_selected"), status }), status).toBeNull();
    expect(parsePortCalls({ ...calls("ship_selected"), window_days: 7 })).toBeNull();
    expect(parsePortCalls({ ...calls("ship_selected"), items: [] })).toBeNull();
    expect(parsePortCalls({ ...calls("ship_selected"), items: [1, "x"] })).toBeNull();
    for (const v of [null, undefined, "ok", 1, []]) expect(parsePortCalls(v)).toBeNull();
  });

  it("fields are shape-checked and text is cleaned; times need a zone; a revision needs its time", () => {
    const base = calls("ship_selected");
    const item = { ...(base.items as Json[])[0], port_authority_code: "20", port_authority: "부산‮\u0007", entry_at: "2026-09-24T08:17:00",
      entry_revision: "최종", exit_revision: "추정", prev_port: { code: "jpsmn", name: "SAKAIMINATO" }, next_port: { code: null, name: null },
      reported_name: "  AZAMARA PURSUIT​ ", purpose: "x".repeat(120), listed_date: "24-09-2026" };
    const c = parsePortCalls({ ...base, items: [item] })!.items[0];
    expect(c.port_authority_code).toBeNull();
    expect(c.port_authority).toBe("부산");
    expect(c.entry_at).toBeNull();
    expect(c.entry_revision).toBeNull();
    expect(c.exit_revision).toBeNull();
    expect(c.prev_port).toEqual({ code: null, name: "SAKAIMINATO" });
    expect(c.next_port).toBeNull();
    expect(c.reported_name).toBe("AZAMARA PURSUIT");
    expect(Array.from(c.purpose!)).toHaveLength(80);
    expect(c.listed_date).toBeNull();
  });
});

describe("ws-validate: ship_selected.port_calls is one droppable bundle", () => {
  it("every api sample is accepted with its port_calls", () => {
    for (const name of ALL) {
      const r = validateServerMessage(sample(name));
      expect(r.kind, name).toBe("ok");
      if (r.kind !== "ok" || r.msg.type !== "ship_selected") throw new Error(name);
      expect(r.dropped, name).toBe(0);
      expect(r.msg.port_calls?.status, name).toBe((sample(name).port_calls as Json).status);
    }
  });

  it("a wrong port_calls is dropped and counted; the rest of the message still applies", () => {
    const bad: [string, (pc: Json) => void][] = [
      ["item code", (pc) => { pc.items = [{ ...(pc.items as Json[])[0], port_authority_code: 20 }]; }],
      ["item without read_at", (pc) => { const it = { ...(pc.items as Json[])[0] }; delete it.read_at; pc.items = [it]; }],
      ["guessed revision", (pc) => { pc.items = [{ ...(pc.items as Json[])[0], entry_revision: "추정" }]; }],
      ["retired status", (pc) => { pc.status = "pending"; }],
      ["index authorities", (pc) => { pc.index = { ...(pc.index as Json), authorities: 9 }; }],
      ["index without gaps", (pc) => { const ix = { ...(pc.index as Json) }; delete ix.gaps; pc.index = ix; }],
    ];
    for (const [what, mutate] of bad) {
      const m = sample("ship_selected");
      mutate(m.port_calls as Json);
      const r = validateServerMessage(m);
      expect(r.kind, what).toBe("ok");
      if (r.kind !== "ok" || r.msg.type !== "ship_selected") throw new Error(what);
      expect(r.dropped, what).toBe(1);
      expect(r.where, what).toBe("ship_selected.port_calls");
      expect(r.msg.port_calls, what).toBeNull();
      expect(r.msg.state, what).not.toBeNull();
    }
    const m = sample("ship_selected.port_calls_no_call_sign_unusable");
    (m.port_calls as Json).call_sign_state = "absent";
    const r = validateServerMessage(m);
    expect(r.kind === "ok" && r.dropped === 1 && r.msg.type === "ship_selected" && r.msg.port_calls === null).toBe(true);
    const old = sample("ship_selected");
    delete old.port_calls; // 이전 서버(키 없음) — 모름
    const r2 = validateServerMessage(old);
    expect(r2.kind === "ok" && r2.msg.type === "ship_selected" && r2.msg.port_calls === null && r2.dropped === 0).toBe(true);
  });
});

describe("port-call helpers", () => {
  it("report times: KST 00:00 is shown as a date only (time unverified — no time is made up); other times go to the shared KST formatter", () => {
    // 확인한 실제 응답의 값 2026-09-29T00:00:00+09:00(= 15:00Z) — 날짜만 신고했는지 자정인지 원천이 구분하지 않는다(ADR-022)
    const d = reportTime("2026-09-28T15:00:00Z");
    expect(d).toEqual({ dateOnly: true, kst: "09-29 KST", title: "PORT-MIS 신고 2026-09-29 00:00:00.000 KST — 날짜만 신고했는지 자정인지 원천이 구분하지 않음" });
    expect(reportTime("2026-09-28T15:00:00.001Z")).toEqual({ dateOnly: false }); // 00:00:00.001 — 시각이 있다
    expect(reportTime("2026-09-23T23:17:00Z")).toEqual({ dateOnly: false });
    for (const v of [null, undefined, "", "bad"]) expect(reportTime(v)).toBeNull();
  });

  it("ports and legs: name(code) · either · —", () => {
    expect(portText({ code: "JPHIJ", name: "HIROSHIMA" })).toBe("HIROSHIMA(JPHIJ)");
    expect(portText({ code: "JPHIJ", name: null })).toBe("JPHIJ");
    expect(portText({ code: null, name: "여천항" })).toBe("여천항");
    expect(portText(null)).toBe("—");
    const c = parsed("ship_selected").items[0];
    expect(legText(c)).toBe("SAKAIMINATO(JPSMN) → HIROSHIMA(JPHIJ)");
    expect(legText({ ...c, prev_port: null, next_port: null })).toBe("—");
    expect(legText({ ...c, prev_port: null })).toBe("— → HIROSHIMA(JPHIJ)");
  });

  it("an empty exit says what is known: no exit report in the index as of when the record was last read", () => {
    const c = parsed("ship_selected").items[0];
    expect(noExitTitle({ ...c, exit_at: null })).toBe("출항 신고가 색인에 없음 — 아직 입항 중이거나, 색인이 이 기록을 마지막으로 읽은 09-29 21:45:00 KST 뒤에 출항했을 수 있음");
    expect(noExitTitle({ ...c, exit_at: null, read_at: null })).toBe("출항 신고가 색인에 없음");
  });

  it("gaps name the authority and what is missing", () => {
    const [p, s, h, n] = parsed("ship_selected.port_calls_incomplete").index!.gaps;
    expect(gapText(p)).toBe("부산(020) — 창 앞쪽 일부만 색인됨(2026-09-12부터)");
    expect(gapText(s)).toBe("인천(030) — 오늘(KST) 목록 아직 색인 안 됨(2026-09-28까지 색인) · 색인 갱신이 오래됨");
    expect(gapText(h)).toBe("동해(200) — 끝까지 색인하지 못한 날 2일(2026-09-20, 2026-09-27)");
    expect(gapText(n)).toBe("포항(700) — 아직 색인 안 됨");
    expect(gapText({ ...p, issues: ["partial", "stale"] })).toBe("부산(020) — 창 앞쪽 일부만 색인됨(2026-09-12부터) · 색인 갱신이 오래됨");
    const many = Array.from({ length: 7 }, (_, i) => `2026-09-0${i + 1}`);
    expect(gapText({ ...h, unindexed_days: many })).toBe("동해(200) — 끝까지 색인하지 못한 날 7일(2026-09-01, 2026-09-02, 2026-09-03, 2026-09-04, 2026-09-05 외 2일)");
    expect(gapText({ ...h, unindexed_days: [] })).toBe("동해(200) — 끝까지 색인하지 못한 날 있음"); // 날짜를 읽지 못했다 — 지어내지 않는다
    expect(gapText({ ...s, covered_to: null, issues: ["behind"] })).toBe("인천(030) — 오늘(KST) 목록 아직 색인 안 됨");
  });

  it("unindexed days are read only with their issue, as dates, deduplicated and sorted; anything else is dropped", () => {
    const inc = calls("ship_selected.port_calls_incomplete");
    const gaps = (inc.index as Json).gaps as Json[];
    const hole = { ...gaps[2], unindexed_days: ["2026-09-27", "yesterday", "2026-09-20", "2026-09-27", 5] };
    const p = parsePortCalls({ ...inc, index: { ...(inc.index as Json), gaps: [hole] } });
    expect(p!.index!.gaps[0].unindexed_days).toEqual(["2026-09-20", "2026-09-27"]);
    const noIssue = { ...gaps[0], unindexed_days: ["2026-09-20"] }; // 까닭(issue) 없이 온 날짜는 싣지 않는다
    expect(parsePortCalls({ ...inc, index: { ...(inc.index as Json), gaps: [noIssue] } })!.index!.gaps[0].unindexed_days).toEqual([]);
  });

  it("reported names: only two Latin names are compared (spacing · case · width are the same name); a Hangul name is never a mismatch on its own", () => {
    const c = parsed("ship_selected").items[0]; // 실제 기록의 선명 "AZAMARA PURSUIT"
    expect(reportedNameNotes([c], "AZAMARA PURSUIT")).toEqual([]);
    expect(reportedNameNotes([c], " azamara  pursuit ")).toEqual([]);
    expect(reportedNameNotes([{ ...c, reported_name: "ＡＺＡＭＡＲＡ PURSUIT" }], "AZAMARA PURSUIT")).toEqual([]); // 전각 — NFKC 뒤 같은 영문
    expect(reportedNameNotes([c], "AZAMARA QUEST")).toEqual([{ name: "AZAMARA PURSUIT", note: "differs" }]);
    expect(reportedNameNotes([{ ...c, reported_name: "부광9호" }], "BUKWANG 9")).toEqual([{ name: "부광9호", note: "other_script" }]); // 로마자 표기를 짐작하지 않는다
    expect(reportedNameNotes([c], "부광9호")).toEqual([{ name: "AZAMARA PURSUIT", note: "other_script" }]);
    expect(reportedNameNotes([c, c, { ...c, reported_name: null }], null)).toEqual([{ name: "AZAMARA PURSUIT", note: "no_ais_name" }]); // 비교 불가 — 한 번만
  });

  it("status line for every state", () => {
    expect(portCallStatusText(parsed("ship_selected"))).toBeNull();
    expect(portCallStatusText(parsed("ship_selected.port_calls_none"))).toBe("최근 30일 한국 항만 입출항 기록 없음(호출부호 기준 · 항만청 10곳 색인 완료)");
    expect(portCallStatusText(parsed("ship_selected.port_calls_incomplete"))).toBe(PORT_CALL_INCOMPLETE_TEXT);
    expect(PORT_CALL_INCOMPLETE_TEXT).toContain("'기록 없음' 으로 판정하지 않음");
    expect(portCallStatusText(parsed("ship_selected.port_calls_error"))).toBe(PORT_CALL_ERROR_TEXT);
    const d = parsed("ship_selected.port_calls_disabled");
    expect(portCallStatusText(d)).toBe("공공데이터포털 키 없음 — 서버가 입출항 색인을 만들지 않음");
    expect(portCallStatusText({ ...d, disabled_reason: "fixture" })).toBe(PORT_CALL_DISABLED_TEXT.fixture);
    expect(portCallStatusText({ ...d, disabled_reason: "operator" })).toBe("운영자가 입출항 색인 갱신을 껐음(운영 설정)");
    expect(portCallStatusText({ ...d, disabled_reason: null })).toBe("입출항 색인 꺼짐");
    const nr = parsed("ship_selected.port_calls_no_call_sign_not_received");
    expect(portCallStatusText(nr)).toBe("AIS 호출부호를 아직 받지 않음 — 정적 정보(호출부호)가 오면 색인에서 찾음");
    expect(portCallStatusText(nr)).not.toMatch(/호출부호 없음/); // '없음' 이 아니다
    expect(portCallStatusText(parsed("ship_selected.port_calls_no_call_sign_unusable"))).toBe(PORT_CALL_CALL_SIGN_TEXT.unusable);
    expect(windowText(parsed("ship_selected"))).toBe("2026-08-30 ~ 2026-09-29 (KST 날짜 · 입항일 기준)");
    expect(windowText(d)).toBe("최근 30일");
  });
});

describe("PortCallsSection (server-rendered)", () => {
  it("ok: one stacked block per call (항만청 · 입항 · 출항 KST · UTC with revision · 선석 · 목적 · legs); the index line; truncation", () => {
    const html = render(parsed("ship_selected"), "AZAMARA PURSUIT");
    const t = text(html);
    expect(html).toContain('data-status="ok"');
    // 선박 카드(좁은 옆 칸)에서 6열 표는 선석 이름을 한 글자씩 접었다(설명서 캡처 2026-09-30) — 신고마다 라벨 · 값 두 열 블록
    expect(html).not.toContain("<table");
    expect(html).toMatch(/<ol[^>]*data-testid="port-calls-table"/);
    expect(html.match(/data-testid="port-call-row"/g)).toHaveLength(20);
    expect(html.match(/<dl/g)).toHaveLength(20);
    for (const h of ["입항", "출항", "선석", "목적", "항로"]) expect(html).toMatch(new RegExp(`<dt[^>]*>${h}</dt>`));
    expect(html).toContain('title="한국 표준시(KST) — 00:00(KST) 신고는 날짜만"');
    expect(t).toContain("부산 · 020");
    expect(t).toContain("09-24 08:17:00 KST"); // 입항 — 표 칸(KST 첫 줄 · UTC 둘째 줄)
    expect(t).toContain("09-25 14:24:00 KST"); // 출항(tkoffDt)
    expect(t).toContain("최종 신고");
    expect(t).toContain("북항크루즈터미널 2선석");
    expect(t).toContain("여객상륙");
    expect(t).toContain("SAKAIMINATO(JPSMN) → HIROSHIMA(JPHIJ)");
    expect(t).toContain("최초 출항지 KOBE(JPUKB)");
    expect(t).not.toContain("목적지 HIROSHIMA"); // 차항지와 같은 목적지는 한 번만
    expect(t).toContain("최근 신고 선종 크루즈선 · 국적 마샬 제도");
    expect(t).toContain("색인: 10개 항만청 · 최근 30일 · 갱신 09-29 21:50 KST");
    expect(t).toContain("2026-08-30 ~ 2026-09-29 (KST 날짜 · 입항일 기준)");
    expect(t).toContain("최근 20건만 표시 — 더 있음");
    expect(html).not.toContain("port-calls-name-mismatch");
    expect(html).not.toContain("port-calls-incomplete");
    expect(html).toContain('data-testid="port-calls-caveat"');
    expect(html).toContain('href="https://www.data.go.kr"');
  });

  it("a ship still in port shows — for the exit, with the reason in its title; KST midnight reports are dates only", () => {
    const p = parsed("ship_selected");
    const c = { ...p.items[0], exit_at: null, exit_revision: null, entry_at: "2026-09-28T15:00:00Z" };
    const html = render({ ...p, items: [c], truncated: false });
    expect(html).toMatch(/data-testid="port-call-exit"[^>]*>—|title="출항 신고가 색인에 없음[^"]*"[^>]*data-testid="port-call-exit">—/);
    expect(html).toContain("출항 신고가 색인에 없음 — 아직 입항 중이거나");
    expect(html).toContain('data-testid="port-call-date-only"');
    expect(text(html)).toContain("09-29 KST시각 미확인(00:00 신고)");
    expect(text(html)).not.toContain("09-28 15:00:00 UTC"); // 모르는 시각을 UTC 로 바꾸지 않는다
  });

  it("names: Latin names that differ warn; a Hangul reported name is noted as not compared", () => {
    const p = parsed("ship_selected");
    expect(render(p, "AZAMARA QUEST")).toContain('data-testid="port-calls-name-mismatch"');
    expect(text(render(p, "AZAMARA QUEST"))).toContain("PORT-MIS 선명 AZAMARA PURSUIT — AIS 선명(AZAMARA QUEST)과 다름");
    const hangul = render({ ...p, items: [{ ...p.items[0], reported_name: "부광9호" }], truncated: false }, "BUKWANG 9");
    expect(hangul).not.toContain("port-calls-name-mismatch");
    expect(text(hangul)).toContain("PORT-MIS 선명 부광9호 — AIS 선명(BUKWANG 9)과 표기 체계가 달라 비교하지 않음");
  });

  it("none says so only with a complete index, and shows when the index was refreshed", () => {
    const t = text(render(parsed("ship_selected.port_calls_none")));
    expect(t).toContain(PORT_CALL_NONE_TEXT);
    expect(t).toContain("색인: 10개 항만청 · 최근 30일 · 갱신 09-29 21:50 KST");
    expect(t).not.toContain("색인 불완전");
  });

  it("incomplete is a warning that names each authority and why — never a definite 'no records'", () => {
    const html = render(parsed("ship_selected.port_calls_incomplete"));
    const t = text(html);
    expect(html).toContain('data-status="incomplete"');
    expect(html).toContain("text-warn");
    expect(t).not.toContain(PORT_CALL_NONE_TEXT);
    expect(t).toContain(PORT_CALL_INCOMPLETE_TEXT);
    expect(t).toContain("부산(020) — 창 앞쪽 일부만 색인됨(2026-09-12부터)");
    expect(t).toContain("인천(030) — 오늘(KST) 목록 아직 색인 안 됨(2026-09-28까지 색인) · 색인 갱신이 오래됨 · 마지막 갱신 09-29 19:30 KST");
    expect(t).toContain("동해(200) — 끝까지 색인하지 못한 날 2일(2026-09-20, 2026-09-27)");
    expect(t).toContain("포항(700) — 아직 색인 안 됨");
    expect(t).toContain("갱신 —"); // 10곳의 공통 기준 시각이 없다 — 지어내지 않는다
    expect(t).toContain("색인 불완전");
  });

  it("the index time claims only what it knows: the last 3 days as of that time, older days re-fetched about once a day", () => {
    const html = render(parsed("ship_selected.port_calls_none"));
    expect(html).toContain(`title="${PORT_CALL_INDEX_AS_OF_TITLE}"`);
    expect(PORT_CALL_INDEX_AS_OF_TITLE).toContain("최근 3일은 이 시각까지 올라온 신고가 색인에 있다");
    expect(PORT_CALL_INDEX_AS_OF_TITLE).toContain("더 오래된 날은 하루에 한 번쯤 다시 받으므로");
    expect(html).not.toContain("이 순간까지 올라온 신고가 색인에 있다"); // 모든 날이 그 시각 기준이라고 말하지 않는다(다시 받기는 하루에 한 번쯤)
    expect(PORT_CALL_CAVEAT).toContain("그보다 오래된 날은 하루에 한 번쯤 다시 받습니다");
  });

  it("an ok list from an incomplete index says the list may be missing records", () => {
    const p = parsed("ship_selected");
    const gaps = parsed("ship_selected.port_calls_incomplete").index!;
    const t = text(render({ ...p, index: gaps }));
    expect(t).toContain("색인이 아직 완전하지 않아 목록이 빠졌을 수 있음");
    expect(t).toContain("포항(700) — 아직 색인 안 됨");
  });

  it("disabled · error · no call sign say exactly that", () => {
    expect(text(render(parsed("ship_selected.port_calls_disabled")))).toContain("공공데이터포털 키 없음 — 서버가 입출항 색인을 만들지 않음");
    const err = render(parsed("ship_selected.port_calls_error"));
    expect(err).toContain('role="alert"');
    expect(text(err)).toContain(PORT_CALL_ERROR_TEXT);
    const nr = render(parsed("ship_selected.port_calls_no_call_sign_not_received"));
    expect(text(nr)).toContain("AIS 호출부호를 아직 받지 않음");
    expect(nr).not.toContain('data-testid="port-calls-index"');
    expect(text(render(parsed("ship_selected.port_calls_no_call_sign_unusable")))).toContain("찾는 형식(영문 대문자 · 숫자 3–7자) 밖");
    expect(text(render(null))).toContain("—");
    expect(render(null)).toContain('data-status="unknown"');
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
    const html = renderToStaticMarkup(createElement(ShipCardView, { mmsi: v.msg.mmsi, detail: null, error: null, now: Date.parse("2026-09-29T13:00:00Z") }));
    expect(html).toContain('data-testid="port-calls"');
    expect(html).toContain('data-status="ok"');
    expect(text(html)).toContain(`PORT-MIS 선명 AZAMARA PURSUIT — AIS 선명(${v.msg.static?.name})과 다름`); // 두 이름 모두 영문 — 견준다
  });

  it("without a WS message the section says — (the REST detail carries no port calls)", () => {
    const html = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "440000001", detail: null, error: null, now: 0 }));
    expect(html).toContain('data-status="unknown"');
  });
});

describe("sources", () => {
  it("the footer and /about name PORT-MIS and describe the index", () => {
    expect(attributionText()).toContain("입출항: 해양수산부 선박운항정보(PORT-MIS) (공공데이터포털)");
    expect(CREDITS.find((c) => c.role === "입출항")?.href).toBe("https://www.data.go.kr");
    const about = text(renderToStaticMarkup(createElement(AboutPage)));
    expect(about).toContain("해양수산부 선박운항정보(PORT-MIS)");
    expect(about).toContain("서버 색인(DB)");
    expect(about).toContain("외부에 묻지 않음");
    expect(about).not.toContain("60초에 6척"); // 선택마다 묻던 설계의 한도는 없다
    expect(about).toContain("00:00(KST)으로 온 신고는 날짜만 신고했는지 자정인지 원천이 구분하지 않아 날짜만 보입니다");
  });
});
