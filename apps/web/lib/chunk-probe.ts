/**
 * 받지 못한 화면 조각(components/LazyPart — ADR-026)의 청크가 서버에 있는지 확인한다.
 * 청크 이름은 내용 해시이고 새 웹 이미지는 자기 청크만 싣는다(apps/web/Dockerfile 의 .next/static 복사) — 페이지를 연 뒤 새 판이 배포되면
 * 옛 청크 주소는 404 로 남아 '다시 시도'로는 받을 수 없다. 화면은 이 확인의 결과(서버 응답 상태)로 '새로 고침'과 '다시 시도' 가운데 무엇을 권할지 정한다.
 * - 확인은 같은 출처의 /_next/static/ 주소 하나에만, HTTP 캐시를 거치지 않는 HEAD 한 번(본문을 받지 않는다). 다른 출처 주소는 확인하지 않는다.
 * - 이 모듈은 던지지 않는다: 확인하지 못하면 까닭과 함께 'unknown'.
 */
import { describeThrown } from "./errorReport";

export type ChunkCheck =
  /** 404 · 410 — 서버에 그 청크가 없다(새 판이 배포됨): 새로 고침이 필요하다 */
  | { kind: "missing"; status: number; url: string }
  /** 2xx — 서버에 있다: 다시 받으면 된다 */
  | { kind: "present"; status: number; url: string }
  /** 그 밖의 상태(5xx 등) */
  | { kind: "other"; status: number; url: string }
  /** 주소를 모름 · 요청 실패 · 시간 초과 */
  | { kind: "unknown"; why: string; url: string | null };

/** 확인 요청을 기다리는 최대 시간(선택값 — 화면이 '확인 중'에 오래 머물지 않게. 청크 자체를 받는 데 걸리는 시간과는 무관한 HEAD 한 번) */
export const CHUNK_CHECK_TIMEOUT_MS = 5_000;

const CHUNK_PATH = /(?:https?:\/\/[^\s/"']+)?\/_next\/static\/[A-Za-z0-9_\-.~/]+?\.js\b/;

/** 오류(Turbopack 의 ChunkLoadError 문구 등)에서 같은 출처의 청크 경로. 없거나 다른 출처 · 출처를 모르면 null(지어내지 않는다) */
export function chunkUrlOf(reason: unknown, origin: string | null): string | null {
  if (!origin) return null;
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : typeof reason === "string" ? reason : describeThrown(reason).message;
  const m = CHUNK_PATH.exec(text);
  if (!m) return null;
  try {
    const u = new URL(m[0], origin);
    return u.origin === new URL(origin).origin ? u.pathname : null;
  } catch {
    return null;
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, "status">>;

/** 서버에 청크가 있는지 한 번 확인한다(던지지 않는다) */
export async function checkChunk(url: string | null, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<ChunkCheck> {
  if (!url) return { kind: "unknown", why: "오류 문구에 같은 출처의 청크 주소가 없음", url: null };
  const fetchImpl: FetchLike | undefined = opts.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (!fetchImpl) return { kind: "unknown", why: "이 환경에 fetch 가 없음", url };
  const timeoutMs = opts.timeoutMs ?? CHUNK_CHECK_TIMEOUT_MS;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl?.abort(); }, timeoutMs);
  try {
    const r = await fetchImpl(url, { method: "HEAD", cache: "no-store", credentials: "same-origin", signal: ctl?.signal });
    if (r.status === 404 || r.status === 410) return { kind: "missing", status: r.status, url };
    if (r.status >= 200 && r.status < 300) return { kind: "present", status: r.status, url };
    return { kind: "other", status: r.status, url };
  } catch (e) {
    return { kind: "unknown", why: timedOut ? `${timeoutMs / 1000} s 안에 답이 없음` : describeThrown(e).message, url };
  } finally {
    clearTimeout(timer);
  }
}

/** 확인 결과 한 줄(화면 · 시스템 로그 보고가 같은 문구를 쓴다). null = 아직 확인 중 */
export function chunkCheckText(c: ChunkCheck | null): string {
  if (!c) return "서버에 청크가 있는지 확인하는 중";
  switch (c.kind) {
    case "missing": return `서버에 이 청크가 없음(HTTP ${c.status})`;
    case "present": return `서버에 청크가 있음(HTTP ${c.status})`;
    case "other": return `서버가 청크를 주지 못함(HTTP ${c.status})`;
    case "unknown": return `청크를 확인하지 못함(${c.why})`;
  }
}
