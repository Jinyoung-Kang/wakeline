/**
 * 브라우저 오류 보고(계약 v5 §C8 → §C6 `POST /api/v1/client-errors`). api 가 받아 시스템 로그(service "web-client", untrusted)에 싣는다.
 * - 같은 메시지는 60 s 에 1번, 페이지(문서)당 분당 5번 이하. keepalive — 페이지를 떠나는 중에도 보낸다. 쿠키는 싣지 않는다(인증 불필요 · CSRF 대상 아님).
 * - 본문은 필드 상한(message 2000 · stack 8000 · path 300 · component 200)과 전체 8 KiB 안으로 자른다(넘으면 api 가 413) — 잘린 곳에 "…(잘림 N자)".
 * - 보고기 자신은 오류를 만들지 않는다: fetch 실패·예외는 삼킨다(보고의 보고로 되돌지 않는다).
 * 값은 브라우저가 준 것 그대로 — 모르는 스택은 빈 문자열(지어내지 않는다). 비밀값 가림은 api 가 한다(§C5).
 */
import { ApiError, errorLine } from "./api";

export const CLIENT_ERRORS_PATH = "/api/v1/client-errors";
export const CLIENT_ERROR_LIMITS = { message: 2000, stack: 8000, path: 300, component: 200, bodyBytes: 8192 } as const;
/** 같은 메시지를 다시 보내기까지(ms) */
export const SAME_MESSAGE_MS = 60_000;
/** 분당 상한(페이지당) */
export const MAX_PER_MINUTE = 5;

export interface ClientErrorInput { message: string; stack?: string | null; component?: string | null }
export interface ClientErrorBody { message: string; stack: string; path: string; component: string | null; ts: string }
/** sent = 요청을 보냄(수신 확인은 하지 않는다) · duplicate = 같은 메시지를 60 s 안에 이미 보냄 · rate_limited = 분당 상한 · unavailable = 보낼 수 없음 */
export type ReportResult = "sent" | "duplicate" | "rate_limited" | "unavailable";

/** 상한을 넘으면 앞부분을 남기고 끝에 "…(잘림 N자)"(N = 잘라 낸 글자 수) — 표시 자체도 상한 안에 든다 */
export function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  let keep = max;
  for (let i = 0; i < 3; i++) keep = Math.max(0, max - `…(잘림 ${s.length - keep}자)`.length);
  const mark = `…(잘림 ${s.length - keep}자)`;
  return mark.length > max ? s.slice(0, max) : s.slice(0, keep) + mark;
}

const utf8Len = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** 보고 본문. pathname 에서 쿼리·조각은 뺀다(경로만 — 검색어·id 가 쿼리에 실릴 수 있다). JSON 이 8 KiB 를 넘으면 스택부터, 그다음 메시지를 줄인다. */
export function buildClientErrorBody(input: ClientErrorInput, pathname: string, nowMs: number): ClientErrorBody {
  const L = CLIENT_ERROR_LIMITS;
  const path = cutText((pathname.split(/[?#]/)[0] || "/"), L.path);
  const body: ClientErrorBody = {
    message: cutText(input.message || "(no message)", L.message),
    stack: cutText(input.stack ?? "", L.stack),
    path,
    component: input.component ? cutText(input.component, L.component) : null,
    ts: new Date(nowMs).toISOString(),
  };
  for (const field of ["stack", "message"] as const) {
    for (let guard = 0; guard < 8 && utf8Len(body) > L.bodyBytes && body[field].length > 0; guard++) {
      const over = utf8Len(body) - L.bodyBytes;
      // 넘친 바이트만큼 글자를 줄인다(글자 하나 ≥ 1바이트) — 표시 글자 몫까지 여유를 둔다
      body[field] = cutText(body[field], Math.max(0, body[field].length - over - 16));
    }
  }
  return body;
}

/** 던져진 값 → 메시지 · 스택. ApiError 는 HTTP 상태 · code · 요청 id 까지(errorLine) */
export function describeThrown(v: unknown): { message: string; stack: string } {
  if (v instanceof ApiError) return { message: `ApiError: ${errorLine(v)}`, stack: v.stack ?? "" };
  if (v instanceof Error) return { message: `${v.name}: ${v.message}`, stack: v.stack ?? "" };
  if (typeof v === "string") return { message: v, stack: "" };
  try { return { message: JSON.stringify(v) ?? String(v), stack: "" }; } catch { return { message: String(v), stack: "" }; }
}

interface ReporterEnv {
  fetch: (url: string, init: RequestInit & { keepalive?: boolean }) => Promise<Response>;
  now: () => number;
  pathname: () => string;
}
export interface Reporter { report(input: ClientErrorInput): ReportResult }

export function createReporter(env: ReporterEnv): Reporter {
  const lastByMessage = new Map<string, number>();
  let sentAt: number[] = [];
  return {
    report(input) {
      const now = env.now();
      const key = input.message || "(no message)";
      const prev = lastByMessage.get(key);
      if (prev != null && now - prev < SAME_MESSAGE_MS) return "duplicate";
      sentAt = sentAt.filter((t) => now - t < 60_000);
      if (sentAt.length >= MAX_PER_MINUTE) return "rate_limited";
      let body: ClientErrorBody;
      try {
        body = buildClientErrorBody(input, env.pathname(), now);
        const p = env.fetch(CLIENT_ERRORS_PATH, {
          method: "POST", keepalive: true, credentials: "omit",
          headers: { "Content-Type": "application/json", Accept: "application/problem+json" },
          body: JSON.stringify(body),
        });
        void Promise.resolve(p).catch(() => { /* 보고 실패는 삼킨다 — 다시 보고하지 않는다 */ });
      } catch {
        return "unavailable";
      }
      sentAt.push(now);
      lastByMessage.set(key, now);
      // 오래된 메시지 기록을 비운다(무한히 자라지 않게)
      if (lastByMessage.size > 100) for (const [m, t] of lastByMessage) if (now - t >= SAME_MESSAGE_MS) lastByMessage.delete(m);
      return "sent";
    },
  };
}

let shared: Reporter | null = null;
/** 페이지 공용 보고기(문서 하나에 하나 — 상한은 문서 단위) */
function sharedReporter(): Reporter | null {
  if (typeof window === "undefined" || typeof fetch !== "function") return null;
  shared ??= createReporter({ fetch: (u, i) => fetch(u, i), now: () => Date.now(), pathname: () => window.location?.pathname ?? "/" });
  return shared;
}

/** 오류 경계(app/error.tsx · global-error.tsx) 등에서 직접 보고. 서버 렌더 중에는 보내지 않는다 */
export function reportClientError(input: ClientErrorInput): ReportResult {
  return sharedReporter()?.report(input) ?? "unavailable";
}

/** 브라우저 확장 스크립트(우리 코드가 아님)의 오류는 보내지 않는다 */
const EXTENSION_SCHEME = /^(chrome|moz|safari|safari-web|ms-browser)-extension:/;

type ErrorLike = Event & { message?: string; error?: unknown; filename?: string; lineno?: number; colno?: number };
type RejectionLike = Event & { reason?: unknown };

/**
 * window 의 error(처리되지 않은 예외) · unhandledrejection(처리되지 않은 Promise 거부)을 보고한다. 되돌리는 함수를 돌려준다.
 * 스택이 없으면 파일:줄:열(쿼리 제외)만 — 그것도 없으면 빈 문자열.
 */
export function installErrorReporter(target: EventTarget | null = typeof window === "undefined" ? null : window, reporter: Reporter | null = sharedReporter()): () => void {
  if (!target || !reporter) return () => {};
  const onError = (ev: Event) => {
    try {
      const e = ev as ErrorLike;
      const file = typeof e.filename === "string" ? e.filename : "";
      if (EXTENSION_SCHEME.test(file)) return;
      const thrown = e.error != null ? describeThrown(e.error) : null;
      const where = file ? `at ${file.split(/[?#]/)[0]}:${e.lineno ?? 0}:${e.colno ?? 0}` : "";
      // ApiError 는 브라우저 문구("Uncaught …")에 없는 HTTP 상태 · code · 요청 id 를 싣는다
      const message = e.error instanceof ApiError && thrown ? thrown.message : e.message || thrown?.message || "(no message)";
      reporter.report({ message, stack: thrown?.stack || where, component: null });
    } catch { /* 보고기 자신은 오류를 만들지 않는다 */ }
  };
  const onRejection = (ev: Event) => {
    try {
      const d = describeThrown((ev as RejectionLike).reason);
      reporter.report({ message: `Unhandled rejection: ${d.message}`, stack: d.stack, component: null });
    } catch { /* 위와 같음 */ }
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
