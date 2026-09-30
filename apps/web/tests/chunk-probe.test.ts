/**
 * 받지 못한 화면 조각의 청크가 서버에 있는지(lib/chunk-probe — ADR-026). 청크 이름은 내용 해시이고 새 웹 이미지는 자기 청크만 싣는다(Dockerfile) —
 * 페이지를 연 뒤 새 판이 배포되면 옛 청크 주소는 404 로 남아 '다시 시도'로는 되살릴 수 없다. 그래서 실패하면 그 주소를 한 번 확인해 화면이
 * '새로 고침'을 권할지 '다시 시도'를 권할지 정한다(추측이 아니라 서버의 응답 상태로).
 */
import { describe, expect, it, vi } from "vitest";
import { CHUNK_CHECK_TIMEOUT_MS, checkChunk, chunkCheckText, chunkUrlOf } from "@/lib/chunk-probe";

const ORIGIN = "http://localhost:8700";

describe("chunk address from the load error", () => {
  it("reads Turbopack's ChunkLoadError message (same-origin /_next/static/ paths only)", () => {
    const e = Object.assign(new Error("Failed to load chunk /_next/static/chunks/2fqx8-h0u9z_7.js from module 76195"), { name: "ChunkLoadError" });
    expect(chunkUrlOf(e, ORIGIN)).toBe("/_next/static/chunks/2fqx8-h0u9z_7.js");
    expect(chunkUrlOf(new Error("Failed to load chunk /_next/static/chunks/03~yq9q893hmn.js"), ORIGIN)).toBe("/_next/static/chunks/03~yq9q893hmn.js");
    expect(chunkUrlOf(new Error(`Loading chunk failed: ${ORIGIN}/_next/static/chunks/0.8z-24o~zj6q.js`), ORIGIN)).toBe("/_next/static/chunks/0.8z-24o~zj6q.js");
    expect(chunkUrlOf("Failed to load chunk /_next/static/chunks/a.js", ORIGIN)).toBe("/_next/static/chunks/a.js");
  });
  it("gives nothing it cannot back: another origin, no chunk path, no origin known", () => {
    expect(chunkUrlOf(new Error("Failed to load https://evil.example/_next/static/chunks/a.js"), ORIGIN)).toBeNull();
    expect(chunkUrlOf(new Error("boom"), ORIGIN)).toBeNull();
    expect(chunkUrlOf(new Error("Failed to load chunk /_next/static/chunks/a.js"), null)).toBeNull();
  });
});

describe("checking the chunk on the server", () => {
  const res = (status: number) => Promise.resolve({ status } as Response);
  it("one HEAD request past the HTTP cache; 404 and 410 = missing (a newer deploy), 2xx = present, others = the status", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const f = vi.fn((u: string, init?: RequestInit) => { calls.push([u, init]); return res(404); });
    expect(await checkChunk("/_next/static/chunks/a.js", { fetchImpl: f })).toEqual({ kind: "missing", status: 404, url: "/_next/static/chunks/a.js" });
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ method: "HEAD", cache: "no-store", credentials: "same-origin" });
    expect((await checkChunk("/x.js", { fetchImpl: () => res(410) })).kind).toBe("missing");
    expect(await checkChunk("/x.js", { fetchImpl: () => res(200) })).toEqual({ kind: "present", status: 200, url: "/x.js" });
    expect(await checkChunk("/x.js", { fetchImpl: () => res(503) })).toEqual({ kind: "other", status: 503, url: "/x.js" });
  });
  it("a failed or hanging check is 'unknown' with the reason — it never throws", async () => {
    expect(await checkChunk("/x.js", { fetchImpl: () => Promise.reject(new TypeError("Failed to fetch")) }))
      .toEqual({ kind: "unknown", why: "TypeError: Failed to fetch", url: "/x.js" });
    vi.useFakeTimers();
    try {
      const p = checkChunk("/x.js", { fetchImpl: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))) });
      await vi.advanceTimersByTimeAsync(CHUNK_CHECK_TIMEOUT_MS);
      expect(await p).toEqual({ kind: "unknown", why: `${CHUNK_CHECK_TIMEOUT_MS / 1000} s 안에 답이 없음`, url: "/x.js" });
    } finally { vi.useRealTimers(); }
    expect(await checkChunk(null, { fetchImpl: () => res(200) })).toEqual({ kind: "unknown", why: "오류 문구에 같은 출처의 청크 주소가 없음", url: null });
  });
  it("says what it saw, with the status (the screen and the system log use the same line)", () => {
    expect(chunkCheckText({ kind: "missing", status: 404, url: "/a.js" })).toBe("서버에 이 청크가 없음(HTTP 404)");
    expect(chunkCheckText({ kind: "present", status: 200, url: "/a.js" })).toBe("서버에 청크가 있음(HTTP 200)");
    expect(chunkCheckText({ kind: "other", status: 503, url: "/a.js" })).toBe("서버가 청크를 주지 못함(HTTP 503)");
    expect(chunkCheckText({ kind: "unknown", why: "TypeError: Failed to fetch", url: "/a.js" })).toBe("청크를 확인하지 못함(TypeError: Failed to fetch)");
    expect(chunkCheckText(null)).toBe("서버에 청크가 있는지 확인하는 중");
  });
});
