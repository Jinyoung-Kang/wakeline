/**
 * 근거 공유 · 신뢰도 한 줄(SPEC F5 · F6 · 계약 v5 §G51): 재생 링크 검증(범위 밖 시각 · 너무 큰 bbox · 잘못된 hex → 버리고 안내) · 링크 만들기 ·
 * 알림 한 건 응답 해석(엔진 · DB, 공역 고도 한계 채움) · JSON 내려받기 모양 · 근거 화면 · 신뢰도 경계값과 모름.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { boundsAround, parseReplayUrl, replayLink } from "@/lib/replay-url";
import { alertJson, alertReplayLink, evidencePosition, parseAlertDetail } from "@/lib/alert-detail";
import { gapsPart, lagPart, positionPart, REL_MARK, REL_WORD, reliabilityText } from "@/lib/reliability";
import { HEALTH_MARK, HEALTH_WORD } from "@/lib/statusbar";
import { AlertSheet } from "@/components/AlertSheet";
import { EvidenceCard } from "@/components/EvidenceCard";
import { utcLeaks } from "./helpers/kst-only";

const NOW = Date.parse("2026-10-09T10:00:00Z");
const q = (s: string) => new URLSearchParams(s);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&amp;/g, "&");

describe("replay link (F5-4)", () => {
  it("reads a valid link", () => {
    expect(parseReplayUrl(q("at=2026-10-09T09:30:00Z&bbox=126,36,129,38&hex=71BE01"), NOW))
      .toEqual({ at: Date.parse("2026-10-09T09:30:00Z"), bbox: [126, 36, 129, 38], hex: "71be01", notes: [] });
    expect(parseReplayUrl(q(""), NOW)).toEqual({ at: null, bbox: null, hex: null, notes: [] });
  });
  it("drops bad values with a note: outside the 30-day window, not UTC Z, a wrong or too large bbox, a bad hex", () => {
    const r = parseReplayUrl(q("at=2026-08-01T00:00:00Z&bbox=100,0,160,60&hex=xyz"), NOW);
    expect([r.at, r.bbox, r.hex]).toEqual([null, null, null]);
    expect(r.notes).toEqual([
      "링크의 시각이 재생할 수 있는 구간(최근 30일 ~ 1분 전) 밖 — 기본 시각(10분 전)으로 엽니다",
      "링크의 영역이 재생 조회 상한(2,500 sq°)보다 넓음 — 기본 영역으로 엽니다",
      "링크의 항공기(hex)가 6자리 16진수가 아님 — 고르지 않고 엽니다",
    ]);
    // 방금 열린 알림의 '그 시각 재생'(관측 1분 안 — 아직 기록 중): 재생할 수 있는 마지막 시각(1분 전)으로 열고 알린다. 더 먼 미래는 그대로 버린다
    expect(parseReplayUrl(q("at=2026-10-09T09:59:30Z"), NOW)).toMatchObject({ at: NOW - 60_000, notes: ["링크의 시각이 아직 기록 중(1분 안) — 재생할 수 있는 마지막 시각(1분 전)으로 엽니다"] });
    expect(parseReplayUrl(q("at=2026-10-09T10:04:00Z"), NOW).at).toBe(NOW - 60_000); // 브라우저 시계가 몇 분 느려도
    expect(parseReplayUrl(q("at=2026-10-09T10:05:01Z"), NOW).at).toBeNull();
    expect(parseReplayUrl(q("at=2026-10-09T18:30:00+09:00"), NOW).notes[0]).toContain("…Z 로 끝나는 ISO 형식이 아님");
    for (const bad of ["129,36,126,38", "126,36,129", "a,b,c,d", "126,36,129,95", "126,,129,38"])
      expect(parseReplayUrl(q(`bbox=${bad}`), NOW).notes[0], bad).toBe("링크의 영역(bbox)을 읽을 수 없음 — 기본 영역으로 엽니다");
  });
  it("builds links that read back the same; bounds stay inside the world", () => {
    const link = replayLink({ at: "2026-10-09T09:30:12.345Z", bbox: [126, 36, 129, 38], hex: "71BE01" });
    expect(link).toBe("/replay?at=2026-10-09T09:30:12Z&bbox=126,36,129,38&hex=71be01");
    const back = parseReplayUrl(new URL(link, "http://x").searchParams, NOW);
    expect([back.at, back.bbox, back.hex, back.notes]).toEqual([Date.parse("2026-10-09T09:30:12Z"), [126, 36, 129, 38], "71be01", []]);
    expect(boundsAround(89.5, 179.5)).toEqual([178, 88, 180, 90]);
  });
  it("the replay page reads the link (not useSearchParams — no new Suspense boundary) and passes the bounds to the map once", () => {
    const page = readFileSync(resolve(__dirname, "../app/replay/page.tsx"), "utf8");
    expect(page).toMatch(/parseReplayUrl\(new URLSearchParams\(window\.location\.search\)/);
    expect(page).toContain("initialBounds={initialBounds}");
    expect(page).not.toMatch(/useSearchParams\(/);
  });
});

const ENGINE = {
  alert: { id: 77, kind: "OBSERVED", hex: "71be01", callsign: "KAL081", sigmet_id: "RKRR:S1", fir_id: "RKRR", hazard: "TS", entered_at: "2026-10-09T09:00:00Z",
    alt_ft: 30000, evidence: { method: "observed_point_in_polygon", seen_at: "2026-10-09T08:59:50Z", provider: "adsb_lol", position: [37.5, 127.0], position_age_s: 12, judged_at: "2026-10-09T09:00:00Z" }, estimated: false },
  source: "engine", sigmet: { id: "RKRR:S1", fir_id: "RKRR", hazard: "TS", base_ft: 0, valid_from: "2026-10-09T08:00:00Z", valid_to: "2026-10-09T12:00:00Z", raw_text: "RKRR SIGMET 1 VALID 090800/091200 RKSI-", provider: "awc" },
  retention_days: 30, meta: {},
};
const DB_AIRSPACE = {
  alert: { id: 78, kind: "OBSERVED", hex: "71be02", entered_at: "2026-10-09T09:00:00Z", left_at: "2026-10-09T09:10:00Z", close_reason: "left", evidence: { position: [37.6, 126.9] },
    zone_type: "airspace", level: "alert", airspace: { id: 5, category: "prohibited", type_ko: "비행금지구역", ident: "RK P73", name: "P73", label: "RK P73", edition: "AIP 25년 5차" } },
  source: "db", airspace: { id: 5, category: "prohibited", type_ko: "비행금지구역", ident: "RK P73", name: "P73", lower_basis: "SFC", lower_raw: "GND", upper_ft: 18000, upper_basis: "FL", upper_raw: "FL 180", edition: "AIP 25년 5차", edition_active: false },
  retention_days: 30, meta: {},
};
// DB 장애 때의 열린 알림(IM-20): api 가 503 대신 200 · meta.db_unavailable · 메모리 사본(메모리에도 없으면 null)으로 답한다
const ENGINE_AIRSPACE_NO_DB = {
  alert: { id: 79, kind: "OBSERVED", hex: "71be03", entered_at: "2026-10-09T09:00:00Z", evidence: { position: [37.6, 126.9] }, estimated: false, zone_type: "airspace", level: "alert",
    airspace: { id: 5, category: "prohibited", type_ko: "비행금지구역", ident: "RK P73", name: "P73", label: "RK P73", edition: "AIP 25년 5차",
      lower: { ft: null, basis: "SFC", raw: "GND" }, upper: { ft: 18000, basis: "FL", raw: "FL 180" } } },
  source: "engine", sigmet: null, airspace: null, retention_days: 30, meta: { db_unavailable: true },
};
const sheetText = (body: unknown) => text(renderToStaticMarkup(createElement(AlertSheet, { d: parseAlertDetail(body)! })));

describe("alert detail (F5 · §G51)", () => {
  it("parses engine and db answers; fills a db airspace alert's limits from the copy; a wrong body is null", () => {
    const e = parseAlertDetail(ENGINE)!;
    expect([e.source, e.alert.id, e.sigmet?.raw_text, e.airspace]).toEqual(["engine", 77, "RKRR SIGMET 1 VALID 090800/091200 RKSI-", null]);
    const d = parseAlertDetail(DB_AIRSPACE)!;
    expect(d.alert.estimated).toBe(false);
    expect(d.alert.airspace?.lower).toEqual({ ft: null, basis: "SFC", raw: "GND" });
    expect(d.alert.airspace?.upper).toEqual({ ft: 18000, basis: "FL", raw: "FL 180" });
    expect(parseAlertDetail({ alert: { id: "x" }, source: "db" })).toBeNull();
    expect(parseAlertDetail({ ...ENGINE, source: "cache" })).toBeNull();
  });
  it("replay link from the evidence (seen time, 3° box, the aircraft) and the JSON download keeps the answer as is", () => {
    const e = parseAlertDetail(ENGINE)!;
    expect(evidencePosition(e.alert)).toEqual({ lat: 37.5, lon: 127 });
    expect(alertReplayLink(e.alert)).toBe("/replay?at=2026-10-09T08:59:50Z&bbox=125.5,36,128.5,39&hex=71be01");
    expect(JSON.parse(alertJson(e, "10-09 19:00:00 KST", "2026-10-09T10:00:00.000Z"))).toEqual({ downloaded_at_kst: "10-09 19:00:00 KST", downloaded_at: "2026-10-09T10:00:00.000Z", response: ENGINE });
  });
  it("the sheet: closed state with its reason, coordinates instead of a map, the airspace copy with an old edition, KST only", () => {
    const t = text(renderToStaticMarkup(createElement(AlertSheet, { d: parseAlertDetail(DB_AIRSPACE)! })));
    expect(t).toContain("닫힘 10-09 18:10:00 KST · 이탈 확인(바깥 관측 3회)");
    expect(t).toContain("위도 · 경도 37.6000, 126.9000");
    expect(t).toContain("고도 한계(원문) 하한 GND · 상한 FL 180");
    expect(t).toContain("기준 차수 AIP 25년 5차 (지금 쓰는 차수 아님)");
    expect(t).toContain("고도 범위 지면 – FL180"); // 근거 카드의 고도 범위가 사본으로 채워졌다
    expect(t).not.toContain("근거 링크"); // 이 화면 자신의 링크는 없다
    expect(t).toContain("그 시각 재생");
    expect(utcLeaks(t)).toEqual([]);
    const e = text(renderToStaticMarkup(createElement(AlertSheet, { d: parseAlertDetail(ENGINE)! })));
    expect(e).toContain("열림(지금 판정 중)");
    expect(e).toContain("RKRR SIGMET 1 VALID 090800/091200 RKSI-");
    expect(utcLeaks(e.replace("RKRR SIGMET 1 VALID 090800/091200 RKSI-", ""))).toEqual([]); // 원문(발표 형식)은 그대로 — 그 밖에는 KST 만
  });
  it("an open alert answered without the DB (meta.db_unavailable — IM-20): the parser keeps the flag and the sheet says the copies are memory values", () => {
    expect(parseAlertDetail(ENGINE)!.dbUnavailable).toBe(false);
    expect(parseAlertDetail({ ...ENGINE, meta: { db_unavailable: "true" } })!.dbUnavailable).toBe(false);
    expect(parseAlertDetail({ ...ENGINE, meta: undefined })!.dbUnavailable).toBe(false);
    const d = parseAlertDetail({ ...ENGINE, meta: { db_unavailable: true } })!;
    expect(d.dbUnavailable).toBe(true);
    const t = sheetText({ ...ENGINE, meta: { db_unavailable: true } });
    expect(t).toContain("DB 일시 사용 불가 — 판정 사본을 메모리 값으로 보입니다(저장 사본 아님)");
    expect(t).toContain("RKRR SIGMET 1 VALID 090800/091200 RKSI-"); // 메모리 사본은 그대로 그린다
    expect(sheetText(ENGINE)).not.toContain("DB 일시 사용 불가");
    expect(utcLeaks(t.replace("RKRR SIGMET 1 VALID 090800/091200 RKSI-", ""))).toEqual([]);
  });
  it("a zone copy the answer does not carry is said ('사본을 읽지 못함'), not silently dropped; an alert without that zone gets no such line", () => {
    // SIGMET 알림 · DB 없음 · 메모리에도 사본 없음
    const s = sheetText({ ...ENGINE, sigmet: null, meta: { db_unavailable: true } });
    expect(s).toContain("DB 일시 사용 불가 — 판정 사본을 메모리 값으로 보입니다(저장 사본 아님)");
    expect(s).toContain("SIGMET 사본 · RKRR · TS 사본을 읽지 못함");
    expect(s).not.toContain("공역 사본");
    // 공역 알림 · DB 없음 · 메모리에도 사본 없음
    const a = sheetText(ENGINE_AIRSPACE_NO_DB);
    expect(a).toContain("공역 사본 · 비행금지구역 · RK P73 사본을 읽지 못함");
    expect(a).not.toContain("SIGMET 사본");
    expect(utcLeaks(a)).toEqual([]);
    // DB 는 있는데 사본 행이 아직 없다(저장 순서 큐가 밀려 열린 알림이 먼저 보임) — 같은 안내, DB 줄은 없다
    const q = sheetText({ ...ENGINE, sigmet: null });
    expect(q).toContain("SIGMET 사본 · RKRR · TS 사본을 읽지 못함");
    expect(q).not.toContain("DB 일시 사용 불가");
    // 받은 사본은 그대로 · 가리키지 않는 구역은 아무 줄도 없다
    expect(sheetText(DB_AIRSPACE)).not.toContain("사본을 읽지 못함");
    expect(sheetText(ENGINE)).not.toContain("사본을 읽지 못함");
  });
  it("the evidence card links to its permalink and replay, and states the judgement-time reliability", () => {
    const h = renderToStaticMarkup(createElement(EvidenceCard, { a: parseAlertDetail(ENGINE)!.alert }));
    expect(h).toContain('href="/alerts/77"');
    expect(h).toContain('href="/replay?at=2026-10-09T08:59:50Z&amp;bbox=125.5,36,128.5,39&amp;hex=71be01"');
    expect(text(h)).toContain("판정 때 ■ 위치 12s 전 (정상) □ 공급자 지연 기록 없음 (모름) □ 수신 공백 기록 없음 (모름)");
  });
});

describe("reliability line (F6)", () => {
  it("uses the status bar's grade marks and words (copied, not imported — first-screen chunking)", () => {
    expect(REL_MARK).toEqual(HEALTH_MARK);
    expect(REL_WORD).toEqual(HEALTH_WORD);
  });
  it("position age boundaries per kind, estimated said, unknown is 모름", () => {
    expect([30, 31, 120, 121].map((s) => positionPart("aircraft", s).grade)).toEqual(["ok", "warn", "warn", "bad"]);
    expect([300, 301, 900, 901].map((s) => positionPart("ship", s).grade)).toEqual(["ok", "warn", "warn", "bad"]);
    expect(positionPart("aircraft", 200, true).text).toBe("위치 3m 전(추정 위치)");
    expect(positionPart("ship", null)).toEqual({ key: "position", grade: "unknown", text: "위치 나이 모름" });
  });
  it("lag: stale → 경고, missing → 모름; gaps: 0 → 정상, some → 주의, not loaded → 모름; never one score", () => {
    expect(lagPart({ lag: 3, stale: false })).toEqual({ key: "lag", grade: "ok", text: "공급자 지연 3s" });
    expect(lagPart({ lag: 400, stale: true }).grade).toBe("bad");
    expect(lagPart(null).text).toBe("공급자 지연 모름");
    expect(gapsPart({ count: 0, window: "최근 6 h" })).toEqual({ key: "gaps", grade: "ok", text: "최근 6 h 수신 공백 없음" });
    expect(gapsPart({ count: 2, window: "최근 6 h" }).text).toBe("최근 6 h 수신 공백 2회");
    expect(gapsPart(null).grade).toBe("unknown");
    expect(reliabilityText([positionPart("aircraft", 12), lagPart({ lag: 3, stale: false }), gapsPart(null)])).toBe("위치 12s 전 · 공급자 지연 3s · 수신 공백 모름");
  });
});
