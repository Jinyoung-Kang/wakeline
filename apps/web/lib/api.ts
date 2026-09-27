/** 같은 출처(edge) REST 호출. 브라우저는 API 주소·키를 모른다. */
export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { Accept: "application/json, application/geo+json, application/problem+json", ...(init?.headers ?? {}) }, credentials: "same-origin" });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { const p = await res.json(); detail = p.detail ?? p.title ?? detail; } catch { /* ignore */ }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function csrfToken(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)SKYWX_CSRF=([^;]+)/);
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
  if (!res.ok) {
    let detail = `${res.status}`;
    try { const p = await res.json(); detail = p.detail ?? p.title ?? detail; } catch { /* ignore */ }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
