/**
 * 같은 출처(edge) REST 호출. 브라우저는 API 주소·키를 모른다.
 * 부른 쪽의 머리는 형식(객체 · Headers · 배열)과 상관없이 보낸다 — 객체 펼치기는 Headers 인스턴스의 값을 말없이 버렸다(web-review B16). 기본 Accept 는 정하지 않았을 때만.
 */
export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json, application/geo+json, application/problem+json");
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) throw await apiError(res);
  return (await res.json()) as T;
}

/**
 * retryAfterS = Retry-After(초) — 429·503 에서 서버가 알려 준 대기 시간(없으면 null).
 * code · requestId = problem+json 확장 필드(계약 v5 §C8). 요청 id 는 본문에 없으면 api 가 에코한 X-Request-Id 헤더 — 둘 다 없거나 형식이 틀리면 null.
 * 요청 id 로 운영 화면 /logs 에서 같은 요청의 서버 로그를 찾는다.
 */
export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfterS: number | null = null,
              public code: string | null = null, public requestId: string | null = null) {
    super(message);
    this.name = "ApiError";
  }
}

/** 요청 id 형식(schemas/log_event.v1.json request_id 와 같음) — 그 밖의 값은 버린다(화면·링크에 임의 문자열을 싣지 않는다) */
export const REQUEST_ID_RE = /^[0-9A-Za-z-]{8,64}$/;
const CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const pick = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);

async function apiError(res: Response): Promise<ApiError> {
  let detail = `${res.status}`, code: string | null = null, rid: string | null = null;
  try {
    const p = await res.json();
    detail = p.detail ?? p.title ?? detail;
    code = pick(p.code, CODE_RE);
    rid = pick(p.request_id, REQUEST_ID_RE);
  } catch { /* ignore */ }
  const ra = res.headers?.get?.("Retry-After") ?? null;
  const secs = ra != null && /^\d{1,6}$/.test(ra.trim()) ? Number(ra.trim()) : null;
  rid ??= pick(res.headers?.get?.("X-Request-Id")?.trim(), REQUEST_ID_RE);
  return new ApiError(res.status, detail, secs, code, rid);
}

/** 오류 → 한 줄 문구(복사·보고용). ApiError 면 HTTP 상태 · code · 요청 id 를 붙인다(모르는 것은 싣지 않는다). */
export function errorLine(e: unknown): string {
  if (e instanceof ApiError) {
    const tags = [`HTTP ${e.status}`, e.code, e.requestId ? `요청 id ${e.requestId}` : null].filter(Boolean).join(" · ");
    return `${e.message} (${tags})`;
  }
  return e instanceof Error ? e.message : String(e);
}

export function csrfToken(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)WAKELINE_CSRF=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export async function apiSend<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const token = csrfToken();
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { "X-CSRF-Token": token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
