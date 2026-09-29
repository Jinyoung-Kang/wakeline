/**
 * 해결 표시(ADR-022 · api /api/v1/ops/resolutions — 사용자 요청 "해결 완료된 [운영/로그] 메뉴에 있는 error 는 지우는 기능") — 순수 함수와 일괄 처리.
 * 지우지 않고 가린다: 운영자가 (kind, key, upto) 를 적으면 조회가 그 key 의 upto 이하 발생을 기본으로 빼고 뺀 수를 알린다. upto 뒤의 재발은 다시 보인다.
 * - kind = "log_group"(key = 로그 지문 fp) | "provider_error"(key = 공급자 이름)
 * - POST {"kind","key","upto"?,"note"?} → 201 {"id","kind","key","upto","resolved_at","resolved_by","note"} · DELETE /{id} → 204(행은 남는다)
 * - 항목 · 묶음 · 공급자에 붙는 {"id","upto","resolved_by"} | null · 조회 응답 hidden_resolved(_errors) · resolution_state(ok | stale | unavailable)
 * upto 는 서버가 준 시각 문자열(항목 ts · 묶음 last_at · 공급자 last_error_at)을 그대로 되돌려 보낸다 — 브라우저 시계로 만든 시각은 미래일 수 있고(서버가 거절),
 * Date 를 거쳐 다시 쓰면 µs 가 ms 로 잘려 누른 항목 자신이 upto 뒤가 된다. 형식을 모르면 해결 처리를 내놓지 않는다(범위를 지어내지 않는다).
 */
import { ApiError } from "./api";

export const RESOLUTIONS_PATH = "/api/v1/ops/resolutions";
export const resolutionPath = (id: number) => `${RESOLUTIONS_PATH}/${id}`;
export type ResolutionKind = "log_group" | "provider_error";
/** 조회의 resolved 매개변수(기본 hide) — 웹은 늘 명시해 보낸다(요청만 보고도 가렸는지 안다) */
export type ResolvedMode = "hide" | "show";
export type ResolutionState = "ok" | "stale" | "unavailable";
/** 메모 상한(코드 포인트 — api 와 같은 규칙: 앞뒤 공백을 뗀 뒤 200 글자 이하 한 줄) */
export const NOTE_MAX = 200;
/** 일괄 해결의 동시 요청 수 — 요청마다 DB 트랜잭션(해결 + 감사)이라 한꺼번에 쏟지 않는다 */
export const BULK_CONCURRENCY = 4;

/** 항목 · 묶음 · 공급자에 붙는 유효 해결 */
export interface ResolvedRef { id: number; upto: string; resolved_by: string }
/** 201 본문 */
export interface Resolution extends ResolvedRef { kind: ResolutionKind; key: string; resolved_at: string; note: string | null }
/** 보낼 해결(메모 빼고) — upto 가 null 이면 보내지 않는다(api 의 지금) */
export interface ResolutionDraft { kind: ResolutionKind; key: string; upto: string | null }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** {id, upto, resolved_by} — 형식이 틀리면 null(해결됨으로 보이지 않는다: 모르는 것을 해결로 치지 않는다) */
export function parseResolvedRef(v: unknown): ResolvedRef | null {
  if (!isObj(v) || !posInt(v.id) || !isTime(v.upto) || typeof v.resolved_by !== "string" || !v.resolved_by) return null;
  return { id: v.id, upto: v.upto, resolved_by: v.resolved_by };
}

/** 201 본문. kind 가 두 값이 아니거나 시각 · 사람이 틀리면 null */
export function parseResolution(v: unknown): Resolution | null {
  const ref = parseResolvedRef(v);
  if (!ref || !isObj(v) || (v.kind !== "log_group" && v.kind !== "provider_error") || typeof v.key !== "string" || !v.key || !isTime(v.resolved_at)) return null;
  return { id: ref.id, kind: v.kind, key: v.key, upto: ref.upto, resolved_at: v.resolved_at, resolved_by: ref.resolved_by, note: typeof v.note === "string" ? v.note : null };
}

export function parseResolutionState(v: unknown): ResolutionState | null {
  return v === "ok" || v === "stale" || v === "unavailable" ? v : null;
}
/** ok 가 아닐 때 화면이 알리는 문구 — 가림이 조용히 바뀌지 않게(api: 읽지 못하면 마지막 값으로 가리거나, 한 번도 못 읽었으면 가리지 않는다) */
export const RESOLUTION_STATE_TEXT: Record<Exclude<ResolutionState, "ok">, string> = {
  stale: "해결 기록을 DB 에서 다시 읽지 못함 — 마지막으로 읽은 해결로 가림(stale)",
  unavailable: "해결 기록을 읽지 못함 — 아무것도 가리지 않음(unavailable)",
};

/** hidden_resolved · hidden_resolved_errors: 0 이상 정수만, 그 밖은 모름(null) */
export const hiddenCount = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
/** "3건" — 모르면 "—" 만(단위를 붙이지 않는다) */
export const hiddenText = (n: number | null): string => (n == null ? "—" : `${n.toLocaleString("en-US")}건`);

/** 시간대가 붙은 ISO 시각(Z · ±hh:mm) — 소수 초는 자리수 그대로 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** 해결 범위의 끝으로 보낼 서버 시각 — 형식이 맞으면 받은 글자 그대로, 아니면 null(해결 처리를 내놓지 않는다) */
export function uptoOf(v: unknown): string | null {
  return typeof v === "string" && ISO_INSTANT.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

/**
 * 두 ISO 시각의 순서 — 시간대와 1 ms 아래 자리까지(api 는 Instant 전체를 비교한다). a 가 앞이면 음수, 같으면 0, 뒤면 양수. 둘 중 하나라도 읽을 수 없으면 null.
 * Date 는 ms 까지만 담으므로 초 단위까지는 Date 로(시간대 반영), 소수 초는 글자 그대로 9 자리로 맞춰 비교한다(시간대는 소수 초를 바꾸지 않는다).
 */
export function compareInstants(a: unknown, b: unknown): number | null {
  const x = uptoOf(a), y = uptoOf(b);
  if (x == null || y == null) return null;
  const whole = (s: string) => Date.parse(s.replace(/\.\d+/, ""));
  const frac = (s: string) => Number((/\.(\d+)/.exec(s)?.[1] ?? "").padEnd(9, "0"));
  return Math.sign(whole(x) - whole(y)) || Math.sign(frac(x) - frac(y));
}

/** 메모 검사(보내기 전 — 서버가 다시 검사한다). 문제가 없으면 null. 빈 글은 "메모 없음" */
export function noteError(note: string): string | null {
  const t = note.trim();
  // 제어 문자(줄바꿈 포함 — C0 · DEL · C1, api 의 \p{Cc} 와 같은 범위)를 거른다
  if (/[\u0000-\u001f\u007f-\u009f]/.test(t)) return "메모는 한 줄이어야 합니다(줄바꿈 · 제어 문자 없음).";
  return [...t].length > NOTE_MAX ? `메모는 ${NOTE_MAX}자 이하입니다(지금 ${[...t].length}자).` : null;
}

/** 요청 본문 — 계약의 필드만: kind · key, upto 는 알 때만, note 는 비어 있지 않을 때만 */
export function resolutionBody(d: ResolutionDraft, note: string): { kind: ResolutionKind; key: string; upto?: string; note?: string } {
  const t = note.trim();
  return { kind: d.kind, key: d.key, ...(d.upto != null ? { upto: d.upto } : {}), ...(t ? { note: t } : {}) };
}

/** 쓰기 실패 → 한국어 첫 문구(요소가 HTTP · code · 요청 id 를 붙인다). 400 은 서버가 말한 규칙을 그대로 싣는다 */
export function resolveErrorText(e: unknown, op: "resolve" | "revoke"): string {
  const lead = op === "resolve" ? "해결 처리 실패" : "되돌리기 실패";
  if (!(e instanceof ApiError)) return `${lead} — 서버에 연결할 수 없습니다(네트워크) — 연결을 확인한 뒤 다시 시도하세요.`;
  switch (e.status) {
    case 400: return `${lead} — 서버가 요청을 거절함: ${e.message}`;
    case 403: return `${lead} — 요청이 거부되었습니다(보안 토큰) — 페이지를 새로 고친 뒤 다시 시도하세요.`;
    case 404: return op === "revoke" ? `${lead} — 이미 되돌렸거나 없는 해결입니다(다른 운영자 · 다른 탭) — 목록을 다시 불러옵니다.`
      : `${lead} — 해결 API 를 찾지 못함 — api 가 해결 표시(ADR-022)를 지원하는 버전인지 확인하세요.`;
    case 429: return `${lead} — 요청이 너무 많습니다 — 잠시 뒤 다시 시도하세요.`;
    default: return e.status >= 500 ? `${lead} — 서버 오류(HTTP ${e.status}) — 잠시 뒤 다시 시도하세요.` : `${lead}(HTTP ${e.status}).`;
  }
}

/** 확인 패널이 말하는 결과(무엇이 일어나고 무엇이 그대로인지) — kind 마다 한 곳 */
export const RESOLVE_EFFECT: Record<ResolutionKind | "revoke", string> = {
  log_group: "upto 이하의 이 지문 항목을 목록 · 묶음에서 숨깁니다(기본 보기). 지우지 않습니다 — '해결된 항목 보기'로 다시 보고 되돌릴 수 있습니다. "
    + "upto 뒤에 같은 지문이 다시 나면 다시 보입니다. 감사 기록(RESOLVE)에 남습니다.",
  provider_error: "upto 이하의 이 공급자 오류를 해결됨으로 표시합니다: 공급자 표의 last error 는 흐리게 '해결됨', 수집 실행 요약(24 h)의 error 행에서 빠집니다. "
    + "지우지 않습니다 — 실행 기록 · 공급자 상태는 그대로이고 '해결된 오류 포함'으로 다시 봅니다. 그 뒤의 새 오류는 다시 보입니다. 감사 기록(RESOLVE)에 남습니다.",
  revoke: "되돌리면 이 해결로 가렸던 오류가 다시 보입니다 — 같은 대상에 앞선 해결이 있으면 그 범위는 계속 가립니다. "
    + "해결 기록은 지우지 않고 되돌린 사람 · 시각을 남깁니다(감사 UNRESOLVE).",
};

export interface BulkOutcome<D extends ResolutionDraft> {
  /** 201 을 받은 해결 — 본문 형식을 읽지 못했으면 res = null(저장은 됐다) */
  done: { draft: D; res: Resolution | null }[];
  failed: { draft: D; error: unknown }[];
  /** 멈춘 뒤 보내지 않은 수 */
  notTried: number;
  /** 멈추게 한 오류(나머지도 같은 이유로 실패할 오류 — 400 이 아닌 모든 실패). 멈추지 않았으면 null */
  stopped: unknown;
}

/**
 * 일괄 해결: 묶음마다 POST 하나(api 에 일괄 경로가 없다 — 해결 · 감사가 요청마다 한 트랜잭션), 동시에 최대 BULK_CONCURRENCY.
 * 400(그 묶음만의 문제 — 예: upto 형식)은 건너뛰고 계속한다. 그 밖의 실패(세션 · CSRF · 경로 없음 · DB · 네트워크)는 나머지도 같으므로
 * 새 요청을 멈추고(이미 떠난 요청만 끝낸다) 보내지 않은 수를 센다 — 실패를 수십 번 되풀이하지 않는다.
 */
export async function resolveAll<D extends ResolutionDraft>(drafts: readonly D[], create: (d: D) => Promise<Resolution | null>, concurrency = BULK_CONCURRENCY): Promise<BulkOutcome<D>> {
  const out: BulkOutcome<D> = { done: [], failed: [], notTried: 0, stopped: null };
  let next = 0;
  const worker = async () => {
    while (out.stopped == null && next < drafts.length) {
      const d = drafts[next++];
      try {
        out.done.push({ draft: d, res: await create(d) });
      } catch (e) {
        out.failed.push({ draft: d, error: e });
        if (!(e instanceof ApiError && e.status === 400) && out.stopped == null) out.stopped = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, drafts.length)) }, worker));
  out.notTried = drafts.length - next;
  return out;
}
