/**
 * 계약 v5 §C8 웹 오류 처리 — ApiError 가 problem+json 의 code · request_id 를 보존한다(요청 id 는 화면에서 복사할 수 있게).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiSend } from "@/lib/api";

afterEach(() => { vi.unstubAllGlobals(); });

const problem = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/problem+json", ...headers } });

describe("v5-C8 ApiError keeps code and request_id", () => {
  it("problem+json code and request_id are kept next to status and detail", async () => {
    vi.stubGlobal("fetch", async () => problem(503, { type: "about:blank", title: "Service Unavailable", status: 503, detail: "data store unavailable", code: "STORE_UNAVAILABLE", request_id: "5f2c9a0e1b7d4c3a" }));
    const e = await apiGet("/api/v1/x").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    const a = e as ApiError;
    expect(a.status).toBe(503);
    expect(a.message).toBe("data store unavailable"); // message 는 그대로(서버 detail)
    expect(a.code).toBe("STORE_UNAVAILABLE");
    expect(a.requestId).toBe("5f2c9a0e1b7d4c3a");
  });
  it("without request_id in the body the echoed X-Request-Id header is used; a malformed id is dropped (null), never invented", async () => {
    vi.stubGlobal("fetch", async () => problem(502, "<html>bad gateway</html>", { "Content-Type": "text/html", "X-Request-Id": "0123456789abcdef0123456789abcdef" }));
    const a = (await apiGet("/api/v1/x").catch((x: unknown) => x)) as ApiError;
    expect(a.status).toBe(502);
    expect(a.code).toBeNull();
    expect(a.requestId).toBe("0123456789abcdef0123456789abcdef");
    vi.stubGlobal("fetch", async () => problem(500, { detail: "boom", code: 42, request_id: "<script>" }));
    const b = (await apiGet("/api/v1/x").catch((x: unknown) => x)) as ApiError;
    expect(b.code).toBeNull();
    expect(b.requestId).toBeNull();
    vi.stubGlobal("fetch", async () => problem(500, "not json"));
    const c = (await apiGet("/api/v1/x").catch((x: unknown) => x)) as ApiError;
    expect([c.message, c.code, c.requestId]).toEqual(["500", null, null]);
  });
  it("apiSend keeps them too, and old call sites (status, message[, retryAfter]) still construct", async () => {
    vi.stubGlobal("document", { cookie: "WAKELINE_CSRF=t0k" });
    vi.stubGlobal("fetch", async () => problem(409, { detail: "version mismatch", code: "VERSION_CONFLICT", request_id: "req-0001-abcd" }, { "Retry-After": "7" }));
    const a = (await apiSend("PUT", "/api/v1/ops/settings/x", { value: 1 }).catch((x: unknown) => x)) as ApiError;
    expect([a.status, a.code, a.requestId, a.retryAfterS]).toEqual([409, "VERSION_CONFLICT", "req-0001-abcd", 7]);
    const old = new ApiError(422, "bbox too large");
    expect([old.status, old.message, old.retryAfterS, old.code, old.requestId]).toEqual([422, "bbox too large", null, null, null]);
    expect(old.name).toBe("ApiError");
  });
});
