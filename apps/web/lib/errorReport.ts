/**
 * 브라우저 오류 보고(계약 v5 §C8 → §C6 `POST /api/v1/client-errors`). api 가 받아 시스템 로그(service "web-client", untrusted)에 싣는다.
 * - 같은 메시지는 60 s 에 1번, 페이지(문서)당 분당 5번 이하. keepalive — 페이지를 떠나는 중에도 보낸다. 쿠키는 싣지 않는다(인증 불필요 · CSRF 대상 아님).
 * - 본문은 필드 상한(message 2000 · stack 8000 · path 300 · component 200 — 글자 = 코드 포인트, api 검사와 같은 단위)과 전체 8 KiB(UTF-8 바이트)
 *   안으로 자른다(넘으면 api 가 413) — 잘린 곳에 "…(잘림 N자)"(N = 원문에서 뺀 글자 수). 메시지는 비우지 않는다(빈 메시지는 api 가 400).
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

/** 잘림 표시(api LogEvents · collector logsink 와 같은 모양). N = 원문에서 잘라 낸 글자 수(코드 포인트) */
const mark = (n: number) => `…(잘림 ${n}자)`;
/** 표시의 글자 수: "…(잘림 " 5 + N 의 자릿수 + "자)" 2 */
const markLen = (n: number) => 7 + String(n).length;

/** 원문(코드 포인트 배열) 앞 keep 글자 + 표시. keep 이 원문 길이 이상이면 원문 그대로 — 서로게이트 쌍을 가르지 않는다 */
function withMark(chars: readonly string[], keep: number): string {
  return keep >= chars.length ? chars.join("") : chars.slice(0, keep).join("") + mark(chars.length - keep);
}

/** 적어도 한 글자를 잘라 낼 때, 표시를 붙여도 max 글자 안에 드는 가장 긴 앞부분의 글자 수(표시가 max 보다 길면 0) */
function cutKeep(len: number, max: number): number {
  let keep = Math.max(0, Math.min(len - 1, max - markLen(len)));
  // N 의 자릿수가 줄면 한두 글자 더 들어간다
  while (keep + 1 < len && keep + 1 + markLen(len - keep - 1) <= max) keep++;
  return keep;
}

/**
 * 상한(글자 = 코드 포인트)을 넘으면 앞부분을 남기고 끝에 "…(잘림 N자)" — 표시까지 상한 안에 든다.
 * 상한이 표시보다 짧으면 표시만(상한을 넘더라도 말없이 버리지 않는다 — 이 파일의 상한 ≥ 200 에서는 일어나지 않는다).
 */
export function cutText(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : withMark(chars, cutKeep(chars.length, max));
}

/** JSON 으로 보냈을 때의 UTF-8 바이트(이스케이프 포함 — 제어 문자 하나 = 6 B) */
const jsonBytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/**
 * 8 KiB 때문에 메시지를 잘라도 남기는 글자 수. 다른 칸의 상한(path 300 · component 200 · 스택은 표시만 남길 수 있음)으로
 * 최악(모든 칸이 제어 문자 — 글자당 6 B)이어도 이만큼 남기고 8 KiB 안에 든다(시험으로 고정).
 */
export const MESSAGE_MIN_KEEP = 200;

/**
 * 보고 본문. pathname 에서 쿼리·조각은 뺀다(경로만 — 검색어·id 가 쿼리에 실릴 수 있다).
 * JSON 이 8 KiB(UTF-8 바이트)를 넘으면 스택부터, 그다음 메시지를 원문에서 한 번에 자른다 — 예산 안에 드는 가장 긴 앞부분(이분 탐색) + 표시.
 * 한 번에 자르므로 표시의 N 은 늘 원문에서 뺀 글자 수다. 스택만으로 맞출 수 없으면 스택은 가장 짧게(표시만, 원문이 더 짧으면 원문) 두고 메시지를 자른다.
 */
export function buildClientErrorBody(input: ClientErrorInput, pathname: string, nowMs: number): ClientErrorBody {
  const L = CLIENT_ERROR_LIMITS;
  const src = { message: Array.from(input.message || "(no message)"), stack: Array.from(input.stack ?? "") };
  const body: ClientErrorBody = {
    message: cutText(src.message.join(""), L.message),
    stack: cutText(src.stack.join(""), L.stack),
    path: cutText(pathname.split(/[?#]/)[0] || "/", L.path),
    component: input.component ? cutText(input.component, L.component) : null,
    ts: new Date(nowMs).toISOString(),
  };
  for (const field of ["stack", "message"] as const) {
    if (jsonBytes(body) <= L.bodyBytes) break;
    const chars = src[field];
    if (!chars.length) continue;
    const hi = cutKeep(chars.length, L[field]);
    const lo = field === "message" ? Math.min(MESSAGE_MIN_KEEP, hi) : 0;
    const fits = (k: number) => jsonBytes({ ...body, [field]: withMark(chars, k) }) <= L.bodyBytes;
    if (!fits(lo)) {
      // 이 칸만으로는 맞출 수 없다 — 가장 짧게 두고 다음 칸으로
      const least = withMark(chars, lo);
      if (jsonBytes(least) < jsonBytes(body[field])) body[field] = least;
      continue;
    }
    // 바이트는 keep 에 대해 줄지 않는다(한 글자 ≥ 1 B, 표시는 자릿수가 줄 때 1자 줄 뿐) — fits(a) 가 참인 가장 큰 a
    let a = lo, b = hi;
    while (a < b) {
      const m = Math.ceil((a + b) / 2);
      if (fits(m)) a = m; else b = m - 1;
    }
    body[field] = withMark(chars, a);
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
  if (!target || !reporter || typeof target.addEventListener !== "function") return () => {};
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
