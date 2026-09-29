/**
 * 해결 표시(ADR-022 · api /api/v1/ops/resolutions) — lib/resolutions 순수 함수와 일괄 처리.
 * 계약(이름 그대로): POST {"kind","key","upto"?,"note"?} → 201 {"id","kind","key","upto","resolved_at","resolved_by","note"} · DELETE /{id} → 204 ·
 * 항목 · 묶음 · 공급자에 붙는 {"id","upto","resolved_by"} | null · 조회 응답의 resolution_state(ok | stale | unavailable).
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import * as R from "@/lib/resolutions";

describe("resolved refs and 201 bodies are read as given; anything malformed is 'not resolved' (never guessed)", () => {
  it("parseResolvedRef keeps {id, upto, resolved_by}; a malformed object is null", () => {
    expect(R.parseResolvedRef({ id: 12, upto: "2026-09-29T01:59:00.123456Z", resolved_by: "op" })).toEqual({ id: 12, upto: "2026-09-29T01:59:00.123456Z", resolved_by: "op" });
    for (const bad of [null, undefined, [], "x", {}, { id: "12", upto: "2026-09-29T01:59:00Z", resolved_by: "op" }, { id: 0, upto: "2026-09-29T01:59:00Z", resolved_by: "op" },
      { id: 1.5, upto: "2026-09-29T01:59:00Z", resolved_by: "op" }, { id: 3, upto: "yesterday", resolved_by: "op" }, { id: 3, upto: "2026-09-29T01:59:00Z", resolved_by: "" },
      { id: 3, upto: "2026-09-29T01:59:00Z" }]) expect(R.parseResolvedRef(bad), JSON.stringify(bad)).toBeNull();
  });
  it("parseResolution reads the 201 body (note null stays null); an unknown kind is refused", () => {
    const body = { id: 7, kind: "log_group", key: "0123456789abcdef", upto: "2026-09-29T01:59:00Z", resolved_at: "2026-09-29T02:00:01Z", resolved_by: "op", note: null };
    expect(R.parseResolution(body)).toEqual(body);
    expect(R.parseResolution({ ...body, note: "배포 뒤 해결" })!.note).toBe("배포 뒤 해결");
    expect(R.parseResolution({ ...body, kind: "provider_error", key: "adsb_lol" })!.kind).toBe("provider_error");
    expect(R.parseResolution({ ...body, kind: "everything" })).toBeNull();
    expect(R.parseResolution({ ...body, resolved_at: "?" })).toBeNull();
    expect(R.parseResolution(null)).toBeNull();
  });
  it("resolution_state: ok | stale | unavailable, anything else unknown (null)", () => {
    expect(R.parseResolutionState("ok")).toBe("ok");
    expect(R.parseResolutionState("stale")).toBe("stale");
    expect(R.parseResolutionState("unavailable")).toBe("unavailable");
    for (const v of [undefined, null, "OK", 1, "fine"]) expect(R.parseResolutionState(v)).toBeNull();
    expect(R.RESOLUTION_STATE_TEXT.stale).toContain("stale");
    expect(R.RESOLUTION_STATE_TEXT.unavailable).toContain("아무것도 가리지 않음");
  });
  it("hidden counts are non-negative integers or unknown (null)", () => {
    expect(R.hiddenCount(0)).toBe(0);
    expect(R.hiddenCount(12)).toBe(12);
    for (const v of [undefined, null, -1, 1.5, "3", Number.NaN]) expect(R.hiddenCount(v)).toBeNull();
    // "해결 처리로 숨김 N건" — 모르면 "—" 만(단위를 붙인 "—건" 은 센 값처럼 읽힌다)
    expect(R.hiddenText(3)).toBe("3건");
    expect(R.hiddenText(1234)).toBe("1,234건");
    expect(R.hiddenText(null)).toBe("—");
  });
});

describe("upto: the server's own time string, sent back verbatim", () => {
  it("an ISO instant with a zone is kept exactly (µs are not cut to ms — the entry itself must stay covered)", () => {
    // Date 를 거쳐 다시 쓰면 .123456 → .123 이 되어 upto(…00.123) < ts(…00.123456) — 누른 항목이 해결되지 않는다
    expect(R.uptoOf("2026-09-29T01:59:00.123456Z")).toBe("2026-09-29T01:59:00.123456Z");
    expect(R.uptoOf("2026-09-29T10:59:00+09:00")).toBe("2026-09-29T10:59:00+09:00");
    expect(R.uptoOf("2026-09-28T23:40:21.631Z")).toBe("2026-09-28T23:40:21.631Z");
  });
  it("no zone, not a time, a number or nothing → null (the action is not offered — no guessed range)", () => {
    for (const v of ["2026-09-29T01:59:00", "2026-09-29", "yesterday", "", 1790000000000, null, undefined, "2026-13-40T99:99:99Z"]) expect(R.uptoOf(v), String(v)).toBeNull();
  });
});

describe("note and request body follow the contract exactly", () => {
  it("note: trimmed, at most 200 characters (code points), one line; blank is no note", () => {
    expect(R.noteError("")).toBeNull();
    expect(R.noteError("   ")).toBeNull();
    expect(R.noteError("가".repeat(200))).toBeNull();
    expect(R.noteError(`  ${"가".repeat(200)}  `)).toBeNull();
    expect(R.noteError("😀".repeat(200))).toBeNull(); // 코드 포인트로 센다(서버와 같음) — UTF-16 길이 400
    expect(R.noteError("가".repeat(201))).toContain("200");
    expect(R.noteError("a\nb")).toContain("한 줄");
    expect(R.noteError("a\u0007b")).toContain("한 줄");
  });
  it("body: {kind, key} + upto only when known + note only when not blank — no other fields", () => {
    expect(R.resolutionBody({ kind: "log_group", key: "0123456789abcdef", upto: null }, "")).toEqual({ kind: "log_group", key: "0123456789abcdef" });
    expect(R.resolutionBody({ kind: "log_group", key: "0123456789abcdef", upto: "2026-09-29T01:59:00.123456Z" }, "  배포 뒤 해결 "))
      .toEqual({ kind: "log_group", key: "0123456789abcdef", upto: "2026-09-29T01:59:00.123456Z", note: "배포 뒤 해결" });
    expect(Object.keys(R.resolutionBody({ kind: "provider_error", key: "adsb_lol", upto: "2026-09-28T23:40:21.631Z" }, "x"))).toEqual(["kind", "key", "upto", "note"]);
  });
  it("paths: POST/GET /api/v1/ops/resolutions, DELETE /api/v1/ops/resolutions/{id}", () => {
    expect(R.RESOLUTIONS_PATH).toBe("/api/v1/ops/resolutions");
    expect(R.resolutionPath(12)).toBe("/api/v1/ops/resolutions/12");
  });
});

describe("error text (Korean lead; the component adds HTTP · code · request id)", () => {
  it("400 keeps the server's reason, 403 = security token, 404 on revoke = already revoked, 5xx and network are named", () => {
    expect(R.resolveErrorText(new ApiError(400, "upto must not be in the future", null, "BAD_RESOLUTION"), "resolve")).toBe("해결 처리 실패 — 서버가 요청을 거절함: upto must not be in the future");
    expect(R.resolveErrorText(new ApiError(403, "forbidden"), "resolve")).toContain("보안 토큰");
    expect(R.resolveErrorText(new ApiError(404, "not found"), "revoke")).toContain("이미 되돌렸거나 없는 해결");
    expect(R.resolveErrorText(new ApiError(404, "not found"), "resolve")).toContain("해결 API");
    expect(R.resolveErrorText(new ApiError(503, "unavailable"), "resolve")).toContain("잠시 뒤");
    expect(R.resolveErrorText(new ApiError(500, "boom"), "revoke")).toBe("되돌리기 실패 — 서버 오류(HTTP 500) — 잠시 뒤 다시 시도하세요.");
    expect(R.resolveErrorText(new TypeError("Failed to fetch"), "resolve")).toContain("네트워크");
  });
});

describe("bulk: one POST per group, at most 4 at a time; stops launching after an error the rest would share", () => {
  const draft = (i: number): R.ResolutionDraft => ({ kind: "log_group", key: i.toString(16).padStart(16, "0"), upto: "2026-09-29T01:00:00Z" });
  const ok = (d: R.ResolutionDraft, id: number): R.Resolution => ({ id, kind: d.kind, key: d.key, upto: d.upto!, resolved_at: "2026-09-29T02:00:00Z", resolved_by: "op", note: null });
  it("all succeed: every draft once, never more than 4 in flight", async () => {
    let inFlight = 0, peak = 0, n = 0;
    const seen: string[] = [];
    const out = await R.resolveAll(Array.from({ length: 10 }, (_, i) => draft(i)), async (d) => {
      inFlight++; peak = Math.max(peak, inFlight); seen.push(d.key);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return ok(d, ++n);
    });
    expect(out.done).toHaveLength(10);
    expect(out.failed).toEqual([]);
    expect(out.notTried).toBe(0);
    expect(out.stopped).toBeNull();
    expect(new Set(seen).size).toBe(10);
    expect(peak).toBeLessThanOrEqual(R.BULK_CONCURRENCY);
    expect(R.BULK_CONCURRENCY).toBe(4);
  });
  it("a 400 for one group does not stop the others", async () => {
    const out = await R.resolveAll([draft(1), draft(2), draft(3)], async (d) => {
      if (d.key.endsWith("2")) throw new ApiError(400, "bad", null, "BAD_RESOLUTION");
      return ok(d, 1);
    });
    expect(out.done.map((x) => x.draft.key)).toEqual([draft(1).key, draft(3).key]);
    expect(out.failed.map((x) => x.draft.key)).toEqual([draft(2).key]);
    expect(out.stopped).toBeNull();
    expect(out.notTried).toBe(0);
  });
  it("403 / 404 (session) / 5xx / network: no new request after it; the rest are counted as not tried", async () => {
    for (const e of [new ApiError(403, "csrf"), new ApiError(404, "not found"), new ApiError(503, "db"), new TypeError("Failed to fetch")]) {
      let calls = 0;
      const out = await R.resolveAll(Array.from({ length: 12 }, (_, i) => draft(i)), async (d) => {
        calls++;
        await new Promise((r) => setTimeout(r, 1));
        if (d.key.endsWith("0")) throw e; // 첫 요청이 실패 — 이미 떠난 요청(최대 4)만 끝난다
        return ok(d, 1);
      });
      expect(calls, String(e)).toBeLessThanOrEqual(R.BULK_CONCURRENCY);
      expect(out.stopped).toBe(e);
      expect(out.done.length + out.failed.length + out.notTried).toBe(12);
      expect(out.notTried).toBe(12 - calls);
    }
  });
});
