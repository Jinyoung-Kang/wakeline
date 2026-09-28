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

// ---- 복사 · 내려받기(§C7 · §C8): clipboard → textarea + execCommand 대체 · Blob + object URL(쓰고 나서 해제) ----

/** 대체 경로가 쓰는 만큼만 흉내 낸 document */
function fakeDoc(copyOk = true) {
  const log: string[] = [];
  const els: Record<string, unknown>[] = [];
  const doc = {
    activeElement: { focus: () => log.push("refocus") },
    body: {
      appendChild: (e: Record<string, unknown>) => { log.push(`append ${String(e.tag)}`); return e; },
      removeChild: (e: Record<string, unknown>) => { log.push(`remove ${String(e.tag)}`); return e; },
    },
    createElement: (tag: string) => {
      const e: Record<string, unknown> = {
        tag, style: {}, attrs: {} as Record<string, string>,
        setAttribute(k: string, v: string) { (this.attrs as Record<string, string>)[k] = v; },
        select() { log.push(`select ${String(this.value)}`); },
        click() { log.push(`click ${String(this.download)} ${String(this.href)}`); },
      };
      els.push(e);
      return e;
    },
    execCommand: (cmd: string) => { log.push(`exec ${cmd}`); return copyOk; },
  };
  return { doc, log, els };
}

describe("v5-C7/C8 copy and download helpers", () => {
  it("copyText uses navigator.clipboard.writeText when it is there", async () => {
    const { copyText } = await import("@/lib/copy");
    const written: string[] = [];
    const { doc, log } = fakeDoc();
    expect(await copyText("rid=abc", { navigator: { clipboard: { writeText: async (t: string) => { written.push(t); } } }, document: doc as never })).toBe(true);
    expect(written).toEqual(["rid=abc"]);
    expect(log).toEqual([]); // 대체 경로를 쓰지 않았다
  });
  it("without clipboard (plain http on a LAN address) or when it is refused, a hidden textarea + execCommand('copy') is used and removed", async () => {
    const { copyText } = await import("@/lib/copy");
    const { doc, log, els } = fakeDoc();
    expect(await copyText("line 1\nline 2", { navigator: {}, document: doc as never })).toBe(true);
    expect(log).toEqual(["append textarea", "select line 1\nline 2", "exec copy", "remove textarea", "refocus"]);
    expect((els[0].attrs as Record<string, string>).readonly).toBe("");
    const refused = fakeDoc();
    expect(await copyText("x", { navigator: { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } } }, document: refused.doc as never })).toBe(true);
    expect(refused.log).toContain("exec copy");
    const failing = fakeDoc(false);
    expect(await copyText("x", { navigator: {}, document: failing.doc as never })).toBe(false);
    expect(failing.log).toContain("remove textarea"); // 실패해도 치운다
    expect(await copyText("x", { navigator: {}, document: undefined })).toBe(false);
  });
  it("downloadText makes a Blob, clicks a download link and revokes the object URL afterwards", async () => {
    const { downloadText } = await import("@/lib/copy");
    const { doc, log } = fakeDoc();
    const blobs: Blob[] = [];
    const revoked: string[] = [];
    let later: (() => void) | null = null;
    const env = {
      document: doc as never,
      URL: { createObjectURL: (b: Blob) => { blobs.push(b); return "blob:x/1"; }, revokeObjectURL: (u: string) => { revoked.push(u); } },
      setTimeout: (f: () => void) => { later = f; return 0; },
    };
    expect(downloadText("wakeline-logs.ndjson", '{"a":1}\n', "application/x-ndjson", env)).toBe(true);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("application/x-ndjson;charset=utf-8");
    expect(await blobs[0].text()).toBe('{"a":1}\n');
    expect(log).toEqual(["append a", "click wakeline-logs.ndjson blob:x/1", "remove a"]);
    expect(revoked).toEqual([]); // 클릭 직후가 아니라 조금 뒤에
    later!();
    expect(revoked).toEqual(["blob:x/1"]);
  });
});

// ---- 브라우저 오류 보고(§C8 → §C6 POST /api/v1/client-errors) ----

describe("v5-C8 client error reporter", () => {
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
  /** "앞부분…(잘림 N자)" → { kept: 남긴 글자 수(코드 포인트), n: N } · 표시가 없으면 null */
  const cutParts = (s: string) => { const m = /…\(잘림 (\d+)자\)$/.exec(s); return m ? { kept: Array.from(s.slice(0, m.index)).length, n: Number(m[1]) } : null; };
  type Sent = { url: string; init: RequestInit & { keepalive?: boolean }; body: Record<string, unknown> };
  async function reporter(nowRef: { t: number }, fetchImpl?: (url: string, init: RequestInit) => Promise<Response>) {
    const { createReporter } = await import("@/lib/errorReport");
    const sent: Sent[] = [];
    const r = createReporter({
      fetch: fetchImpl ?? (async (url: string, init: RequestInit) => { sent.push({ url, init, body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); }),
      now: () => nowRef.t,
      pathname: () => "/stats",
    });
    return { r, sent };
  }

  it("the body follows §C6: field limits with a cut marker, path only, ISO ts, and the whole JSON fits in 8 KiB", async () => {
    const { buildClientErrorBody, CLIENT_ERROR_LIMITS: L } = await import("@/lib/errorReport");
    const b = buildClientErrorBody({ message: "m".repeat(2500), stack: "s".repeat(9000), component: "c".repeat(300) }, "/replay?at=2026-09-29T00:00:00Z#x", Date.parse("2026-09-29T01:02:03.456Z"));
    expect(b.message.length).toBeLessThanOrEqual(L.message);
    expect(b.message).toMatch(/…\(잘림 \d+자\)$/);
    expect(b.stack.length).toBeLessThanOrEqual(L.stack);
    expect(b.component!.length).toBeLessThanOrEqual(L.component);
    expect(b.path).toBe("/replay"); // 쿼리·조각 제거
    expect(b.ts).toBe("2026-09-29T01:02:03.456Z");
    expect(bytes(b)).toBeLessThanOrEqual(8192);
    // 한글(UTF-8 3바이트)이 많아도 8 KiB 안 — 스택부터 줄인다
    const k = buildClientErrorBody({ message: "오류".repeat(1000), stack: "스택".repeat(4000), component: null }, "/", 0);
    expect(bytes(k)).toBeLessThanOrEqual(8192);
    expect(k.message).toBe("오류".repeat(1000)); // 메시지는 필드 상한 안이면 그대로
    expect(k.component).toBeNull();
    expect(buildClientErrorBody({ message: "", stack: undefined }, "/" + "p".repeat(400), 0)).toMatchObject({ message: "(no message)", stack: "" });
    expect(buildClientErrorBody({ message: "x" }, "/" + "p".repeat(400), 0).path.length).toBeLessThanOrEqual(L.path);
  });

  it("8 KiB is counted in UTF-8 bytes: a multibyte stack keeps as much as fits (never dropped silently), N = characters removed from the original", async () => {
    const { buildClientErrorBody } = await import("@/lib/errorReport");
    // 메시지 2000자(6000 B) + 스택 8000자(24000 B) — 스택을 남는 만큼 남기고 표시를 단다(예전: 스택을 통째로 비우고 표시도 없었다)
    const k = buildClientErrorBody({ message: "오류".repeat(1000), stack: "스택".repeat(4000), component: null }, "/", 0);
    expect(bytes(k)).toBeLessThanOrEqual(8192);
    expect(bytes(k)).toBeGreaterThan(8192 - 3); // 한 글자(3 B) 더 넣으면 넘친다 — 예산을 거의 다 쓴다
    expect(k.message).toBe("오류".repeat(1000));
    const p = cutParts(k.stack)!;
    expect(p).not.toBeNull();
    expect(p.kept).toBeGreaterThan(600);
    expect(p.kept + p.n).toBe(8000);
    // 한글 5000자 스택 + 짧은 메시지: 약 2,700자가 들어간다
    const g = buildClientErrorBody({ message: "TypeError: x", stack: "가".repeat(5000) }, "/", 0);
    const q = cutParts(g.stack)!;
    expect(bytes(g)).toBeLessThanOrEqual(8192);
    expect(q.kept).toBeGreaterThan(2600);
    expect(q.kept + q.n).toBe(5000);
  });

  it("a field cut twice (field limit, then bytes) is cut once from the original: the marker counts every removed character", async () => {
    const { buildClientErrorBody } = await import("@/lib/errorReport");
    const b = buildClientErrorBody({ message: "m".repeat(2000), stack: "s".repeat(20_000) }, "/", 0);
    expect(bytes(b)).toBeLessThanOrEqual(8192);
    expect(b.message).toBe("m".repeat(2000));
    const p = cutParts(b.stack)!;
    expect(p.kept + p.n).toBe(20_000); // 예전: '…(잘림 1929자)' — 실제로는 13,929자를 뺐다
    expect(p.kept).toBeGreaterThan(5000);
  });

  it("the message is never emptied (the api answers an empty message with 400): control characters (6 B each in JSON) are cut with a marker", async () => {
    const { buildClientErrorBody, MESSAGE_MIN_KEEP } = await import("@/lib/errorReport");
    const b = buildClientErrorBody({ message: "\u0001".repeat(2000), stack: "at x (y.js:1:2)" }, "/", 0);
    expect(bytes(b)).toBeLessThanOrEqual(8192);
    const p = cutParts(b.message)!;
    expect(p).not.toBeNull();
    expect(p.kept).toBeGreaterThanOrEqual(MESSAGE_MIN_KEEP);
    expect(p.kept + p.n).toBe(2000);
    expect(b.stack).toBe("at x (y.js:1:2)"); // 표시보다 짧은 스택은 잘라도 줄지 않는다 — 그대로 둔다
    // 모든 칸이 상한 · 최악 바이트(제어 문자)여도 8 KiB 안이고, 메시지는 MESSAGE_MIN_KEEP 글자 이상
    const worst = buildClientErrorBody({ message: "\u0001".repeat(3000), stack: "\u0002".repeat(9000), component: "\u0003".repeat(300) }, "/" + "\u0004".repeat(400), 0);
    expect(bytes(worst)).toBeLessThanOrEqual(8192);
    expect(cutParts(worst.message)!.kept).toBeGreaterThanOrEqual(MESSAGE_MIN_KEEP);
    expect(cutParts(worst.message)!.kept + cutParts(worst.message)!.n).toBe(3000);
    expect(cutParts(worst.stack)).toMatchObject({ n: 9000 - cutParts(worst.stack)!.kept });
  });

  it("characters are code points (the api counts code points): no lone surrogate is left, limits hold in code points", async () => {
    const { buildClientErrorBody, cutText, CLIENT_ERROR_LIMITS: L } = await import("@/lib/errorReport");
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const e = buildClientErrorBody({ message: "😀".repeat(2500), stack: "🚢".repeat(3000) }, "/", 0);
    expect(bytes(e)).toBeLessThanOrEqual(8192);
    for (const [f, n] of [["message", 2500], ["stack", 3000]] as const) {
      expect(lone.test(e[f])).toBe(false);
      const p = cutParts(e[f])!;
      expect(p.kept + p.n).toBe(n);
    }
    expect(Array.from(e.message).length).toBeLessThanOrEqual(L.message);
    const c = cutText("😀".repeat(10), 9);
    expect(lone.test(c)).toBe(false);
    expect(Array.from(c).length).toBeLessThanOrEqual(9);
    expect(cutParts(c)).toEqual({ kept: 1, n: 9 });
    // 상한이 표시보다 짧으면 표시만 — 말없이 잘라 버리지 않는다(이 파일의 상한 ≥ 200 에서는 일어나지 않음)
    expect(cutText("x".repeat(50), 5)).toBe("…(잘림 50자)");
    expect(cutText("abc", 5)).toBe("abc");
  });

  it("POSTs JSON with keepalive and no cookies; the same message is sent once per 60 s", async () => {
    const now = { t: 1_000_000 };
    const { r, sent } = await reporter(now);
    expect(r.report({ message: "TypeError: x is undefined", stack: "at a (b.js:1:2)" })).toBe("sent");
    expect(r.report({ message: "TypeError: x is undefined", stack: "at a (b.js:1:2)" })).toBe("duplicate");
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/v1/client-errors");
    expect(sent[0].init).toMatchObject({ method: "POST", keepalive: true, credentials: "omit" });
    expect((sent[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(sent[0].body).toEqual({ message: "TypeError: x is undefined", stack: "at a (b.js:1:2)", path: "/stats", component: null, ts: new Date(1_000_000).toISOString() });
    now.t += 59_999;
    expect(r.report({ message: "TypeError: x is undefined" })).toBe("duplicate");
    now.t += 1;
    expect(r.report({ message: "TypeError: x is undefined" })).toBe("sent");
  });

  it("at most 5 reports per minute per page, whatever the messages", async () => {
    const now = { t: 5_000_000 };
    const { r, sent } = await reporter(now);
    const res = Array.from({ length: 7 }, (_, i) => r.report({ message: `e${i}` }));
    expect(res).toEqual(["sent", "sent", "sent", "sent", "sent", "rate_limited", "rate_limited"]);
    expect(sent).toHaveLength(5);
    now.t += 60_000;
    expect(r.report({ message: "e5" })).toBe("sent"); // 창이 지나면 다시
  });

  it("a failing or throwing fetch never throws into the page (the reporter must not create new errors)", async () => {
    const now = { t: 0 };
    const rejecting = await reporter(now, async () => { throw new TypeError("Failed to fetch"); });
    expect(rejecting.r.report({ message: "a" })).toBe("sent");
    const throwing = await reporter(now, () => { throw new Error("sync"); });
    expect(throwing.r.report({ message: "b" })).toBe("unavailable");
    await new Promise((res) => setTimeout(res, 5)); // 처리되지 않은 거부가 생기면 vitest 가 실패시킨다
  });

  it("installs error / unhandledrejection listeners that report (ApiError keeps HTTP · code · request id), skips browser-extension scripts, and uninstalls", async () => {
    const { installErrorReporter, createReporter } = await import("@/lib/errorReport");
    const { ApiError } = await import("@/lib/api");
    const bodies: Record<string, unknown>[] = [];
    const r = createReporter({ fetch: async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }, now: () => 0, pathname: () => "/" });
    const target = new EventTarget();
    const off = installErrorReporter(target, r);
    const boom = new Error("boom");
    target.dispatchEvent(Object.assign(new Event("error"), { message: "Uncaught Error: boom", error: boom, filename: "http://localhost:8700/_next/static/chunks/app.js", lineno: 1, colno: 2 }));
    target.dispatchEvent(Object.assign(new Event("error"), { message: "ext", error: new Error("ext"), filename: "chrome-extension://abc/content.js" }));
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new ApiError(500, "internal error", null, "INTERNAL", "rid-0000-1111") }));
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "plain string" }));
    target.dispatchEvent(Object.assign(new Event("error"), { message: "Script error.", error: null, filename: "", lineno: 0, colno: 0 }));
    expect(bodies.map((b) => b.message)).toEqual([
      "Uncaught Error: boom",
      "Unhandled rejection: ApiError: internal error (HTTP 500 · INTERNAL · 요청 id rid-0000-1111)",
      "Unhandled rejection: plain string",
      "Script error.",
    ]);
    expect(bodies[0].stack).toBe(boom.stack);
    expect(bodies[3].stack).toBe(""); // 스택 없음 — 지어내지 않는다
    off();
    target.dispatchEvent(Object.assign(new Event("error"), { message: "after", error: new Error("after") }));
    expect(bodies).toHaveLength(4);
  });
});
