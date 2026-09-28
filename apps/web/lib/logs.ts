/**
 * 시스템 로그 화면 보조(계약 v5 §C7) — 순수 함수. 항목 형식은 schemas/log_event.v1.json, 조회 API 는 §C4(`/api/v1/ops/logs*`, 운영 세션 전용).
 * 모르는 값은 null/"—"(0·빈 값으로 채우지 않는다). 형식이 틀린 항목은 보이지 않고 수만 센다. 시각은 UTC.
 */
import { REQUEST_ID_RE } from "./api";

export const LOGS_PATH = "/api/v1/ops/logs";
export const LOG_SERVICES = ["api", "collector", "ais", "web-client"] as const;
export const LOG_LEVELS = ["ERROR", "WARN"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
/** 기간 선택(§C7) → ms */
export const LOG_PERIODS = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 } as const;
export type LogPeriod = keyof typeof LOG_PERIODS;
export const LOG_PERIOD_LABEL: Record<LogPeriod, string> = { "1h": "1 h", "6h": "6 h", "24h": "24 h", "7d": "7 d" };
/** 한 쪽 기본 · 상한(§C4: limit ≤ 200, 기본 100) */
export const LOGS_PAGE = 100;
export const LOGS_PAGE_MAX = 200;
/** 스트림 id(XADD 가 준 "ms-seq") */
const STREAM_ID_RE = /^\d{1,16}-\d{1,10}$/;
const FP_RE = /^[0-9a-f]{16}$/;

export interface LogException { type: string; message: string | null; stack: string }
export interface LogEntry {
  id: string;
  ts: string;
  service: string;
  instance: string | null;
  level: LogLevel;
  logger: string | null;
  thread: string | null;
  message: string;
  exception: LogException | null;
  fp: string | null;
  request_id: string | null;
  context: Record<string, string | number | boolean | null>;
  /** 직전 전송 뒤 같은 지문으로 억제한 건수 — 필드가 없으면 null(모름) */
  suppressed: number | null;
  /** 브라우저가 보낸 내용(web-client) — 사실로 믿지 말 것 */
  untrusted: boolean;
  /** api 가 준 항목 그대로(JSON 복사 · NDJSON 내려받기는 이것 — 화면용 정리를 섞지 않는다) */
  raw: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nonNeg = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
export const validStreamId = (v: unknown): v is string => typeof v === "string" && STREAM_ID_RE.test(v);
export const validRid = (v: unknown): v is string => typeof v === "string" && REQUEST_ID_RE.test(v);
export const validFp = (v: unknown): v is string => typeof v === "string" && FP_RE.test(v);

/** 항목 하나. 핵심 필드(id · ts · service · level · message)가 틀리면 null — 나머지는 틀리면 null 로 둔다 */
export function parseLogEntry(v: unknown): LogEntry | null {
  if (!isObj(v) || !validStreamId(v.id) || !isTime(v.ts) || typeof v.service !== "string" || !v.service) return null;
  if (v.level !== "ERROR" && v.level !== "WARN") return null;
  if (typeof v.message !== "string") return null;
  let exception: LogException | null = null;
  if (isObj(v.exception) && typeof v.exception.type === "string") {
    exception = { type: v.exception.type, message: str(v.exception.message), stack: str(v.exception.stack) ?? "" };
  }
  const context: LogEntry["context"] = {};
  if (isObj(v.context)) {
    for (const [k, x] of Object.entries(v.context)) {
      if (x === null || typeof x === "string" || typeof x === "number" || typeof x === "boolean") context[k] = x;
    }
  }
  return {
    id: v.id, ts: v.ts, service: v.service, instance: str(v.instance), level: v.level, logger: str(v.logger), thread: str(v.thread),
    message: v.message, exception, fp: validFp(v.fp) ? v.fp : null, request_id: validRid(v.request_id) ? v.request_id : null,
    context, suppressed: nonNeg(v.suppressed), untrusted: v.untrusted === true, raw: v,
  };
}

export interface LogPage {
  items: LogEntry[];
  nextCursor: string | null;
  /** 이 요청이 훑은 스트림 항목 수(§C4) — 없으면 null */
  scanned: number | null;
  /** 훑기 상한(3,000)에 걸려 필터 결과가 불완전할 수 있음 — 없으면 null */
  scanTruncated: boolean | null;
  /** 화면이 형식 오류로 버린 항목 수 */
  invalid: number;
  /** api 가 스키마 검증에 실패해 건너뛴 항목 수(§C4) — 없으면 null */
  serverInvalid: number | null;
  /** 이 목록을 이룬 요청 수(첫 쪽 + '이전 항목 더 보기') — invalid · serverInvalid 는 이 쪽들의 합 */
  pages: number;
}

export function parseLogPage(v: unknown): LogPage {
  const r = isObj(v) ? v : {};
  const raw = Array.isArray(r.items) ? r.items : [];
  const items: LogEntry[] = [];
  for (const x of raw) { const e = parseLogEntry(x); if (e) items.push(e); }
  return {
    items, nextCursor: validStreamId(r.next_cursor) ? r.next_cursor : null, scanned: nonNeg(r.scanned), scanTruncated: bool(r.scan_truncated),
    invalid: raw.length - items.length, serverInvalid: nonNeg(r.invalid), pages: 1,
  };
}

/**
 * '이전 항목 더 보기': 다음 쪽을 뒤에 붙인다(겹친 항목은 한 번). 커서 · 훑은 수 · 잘림은 마지막 요청의 값(다음 쪽을 말한다),
 * 건너뜀 수는 두 가지 모두 불러온 쪽들의 합 — 같은 범위끼리 나란히 보인다. api 값을 모르는 쪽이 있으면 합도 모른다(null — 아는 쪽만 더해 전체처럼 보이지 않는다).
 */
export function appendLogPage(prev: LogPage, next: LogPage): LogPage {
  const seen = new Set(prev.items.map((e) => e.id));
  return {
    items: [...prev.items, ...next.items.filter((e) => !seen.has(e.id))],
    nextCursor: next.nextCursor, scanned: next.scanned, scanTruncated: next.scanTruncated,
    invalid: prev.invalid + next.invalid,
    serverInvalid: prev.serverInvalid == null || next.serverInvalid == null ? null : prev.serverInvalid + next.serverInvalid,
    pages: prev.pages + next.pages,
  };
}

export interface LogGroup {
  fp: string; service: string | null; level: string | null; logger: string | null; exception_type: string | null; sample_message: string | null;
  count: number | null; suppressed: number | null; first_at: string | null; last_at: string | null; last_id: string | null;
}

export function parseLogGroups(v: unknown): { groups: LogGroup[]; scanned: number | null; scanTruncated: boolean | null; invalid: number } {
  const r = isObj(v) ? v : {};
  const raw = Array.isArray(r.groups) ? r.groups : [];
  const groups: LogGroup[] = [];
  for (const g of raw) {
    if (!isObj(g) || !validFp(g.fp)) continue;
    groups.push({
      fp: g.fp, service: str(g.service), level: str(g.level), logger: str(g.logger), exception_type: str(g.exception_type), sample_message: str(g.sample_message),
      count: nonNeg(g.count), suppressed: nonNeg(g.suppressed), first_at: isTime(g.first_at) ? g.first_at : null, last_at: isTime(g.last_at) ? g.last_at : null,
      last_id: validStreamId(g.last_id) ? g.last_id : null,
    });
  }
  return { groups, scanned: nonNeg(r.scanned), scanTruncated: bool(r.scan_truncated), invalid: raw.length - groups.length };
}

// ---- 요청(§C4) ----

export interface LogFilter {
  /** 비면 전체 */
  services: string[];
  /** "" = 전체 */
  level: "" | LogLevel;
  period: LogPeriod;
  q: string;
  rid: string;
  fp: string;
}
export const DEFAULT_LOG_FILTER: LogFilter = { services: [], level: "", period: "1h", q: "", rid: "", fp: "" };
/** 글자 검색 상한(화면 입력) */
export const LOG_Q_MAX = 200;

const sinceIso = (period: LogPeriod, nowMs: number) => new Date(nowMs - LOG_PERIODS[period]).toISOString();

/** 목록 요청. 서비스는 쉼표로 잇고(여러 개), 형식이 틀린 요청 id · 지문은 보내지 않는다 */
export function logsUrl(f: LogFilter, nowMs: number, opts: { cursor?: string | null; limit?: number } = {}): string {
  const p = new URLSearchParams();
  if (f.services.length) p.set("service", f.services.join(","));
  if (f.level) p.set("level", f.level);
  p.set("since", sinceIso(f.period, nowMs));
  const q = f.q.trim().slice(0, LOG_Q_MAX);
  if (q) p.set("q", q);
  if (validRid(f.rid.trim())) p.set("rid", f.rid.trim());
  if (validFp(f.fp)) p.set("fp", f.fp);
  if (opts.cursor && validStreamId(opts.cursor)) p.set("cursor", opts.cursor);
  p.set("limit", String(Math.min(LOGS_PAGE_MAX, Math.max(1, Math.floor(opts.limit ?? LOGS_PAGE)))));
  return `${LOGS_PATH}?${p}`;
}

/** 묶음 요청(§C4: since · service · level 만 — 글자 검색 · 요청 id 는 묶음에 적용되지 않는다) */
export function logGroupsUrl(f: Pick<LogFilter, "services" | "level" | "period">, nowMs: number): string {
  const p = new URLSearchParams();
  p.set("since", sinceIso(f.period, nowMs));
  if (f.services.length) p.set("service", f.services.join(","));
  if (f.level) p.set("level", f.level);
  return `${LOGS_PATH}/groups?${p}`;
}

export const logItemUrl = (id: string) => `${LOGS_PATH}/${encodeURIComponent(id)}`;

/** /logs#rid=… · #id=… · #fp=… (오류 문구의 "로그 보기" · 항목 링크). 형식이 틀린 값은 버린다 */
export function parseLogsHash(hash: string): { rid?: string; id?: string; fp?: string } {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const out: { rid?: string; id?: string; fp?: string } = {};
  const rid = p.get("rid"), id = p.get("id"), fp = p.get("fp");
  if (validRid(rid)) out.rid = rid;
  if (validStreamId(id)) out.id = id;
  if (validFp(fp)) out.fp = fp;
  return out;
}

// ---- 새 항목(자동 새로 고침 — 보던 줄이 움직이지 않게) ----

/** 스트림 id 비교(ms, 그다음 순번) */
export function streamIdCmp(a: string, b: string): number {
  const [am, as] = a.split("-").map(Number), [bm, bs] = b.split("-").map(Number);
  return am !== bm ? Math.sign(am - bm) : Math.sign(as - bs);
}

/**
 * 새로 받은 첫 쪽에서 지금 목록의 맨 위보다 새 항목만. 받은 쪽이 가득 찼고 모두 새 항목이면 그 뒤(더 오래된 쪽)에도 새 항목이 있을 수 있다(more).
 */
export function pendingEntries(shown: readonly LogEntry[], fresh: readonly LogEntry[], limit: number): { items: LogEntry[]; more: boolean } {
  const top = shown[0]?.id ?? null;
  const items = top == null ? [...fresh] : fresh.filter((e) => streamIdCmp(e.id, top) > 0);
  return { items, more: top != null && fresh.length >= limit && items.length === fresh.length };
}

/** 새 항목을 위에 붙인다(같은 id 는 한 번만) */
export function applyPending(shown: readonly LogEntry[], pending: readonly LogEntry[]): LogEntry[] {
  const seen = new Set(pending.map((e) => e.id));
  return [...pending, ...shown.filter((e) => !seen.has(e.id))];
}

// ---- 표시 · 복사 형식 ----

const iso = (v: string | null | undefined): string => {
  if (!v) return "—";
  const t = Date.parse(v);
  return Number.isNaN(t) ? "—" : new Date(t).toISOString();
};

/** 목록 시각: UTC "MM-DD HH:MM:SS.mmmZ" */
export function fmtLogTime(v: string | null | undefined): string {
  const s = iso(v);
  return s === "—" ? s : `${s.slice(5, 10)} ${s.slice(11, 23)}Z`;
}

export const firstLine = (s: string) => s.split(/\r?\n/, 1)[0];

/** 복사 텍스트 첫 줄: `[시각 수준 서비스/로거] rid=…` — 요청 id 가 없으면 rid=— */
export function logHeaderLine(ts: string, level: string, service: string, logger: string, rid: string | null): string {
  return `[${ts} ${level} ${service}/${logger}] rid=${rid ?? "—"}`;
}

/**
 * 항목 텍스트(사람이 읽고 붙여 넣기 좋게): 첫 줄 머리, 메시지, 예외, 스택, 그리고 사실 한 줄(id · fp · instance · thread · 억제 · 신뢰 여부), context.
 */
export function logText(e: LogEntry): string {
  const lines = [logHeaderLine(iso(e.ts), e.level, e.service, e.logger ?? "—", e.request_id), e.message];
  if (e.exception) {
    lines.push(`예외 ${e.exception.type}${e.exception.message != null ? `: ${e.exception.message}` : ""}`);
    if (e.exception.stack) lines.push(e.exception.stack);
  }
  const facts = [`id=${e.id}`, `fp=${e.fp ?? "—"}`, `instance=${e.instance ?? "—"}`, `thread=${e.thread ?? "—"}`, `억제 ${e.suppressed ?? "—"}`];
  if (e.untrusted) facts.push("브라우저가 보낸 내용(검증 안 됨)");
  lines.push(facts.join(" · "));
  const ctx = Object.entries(e.context);
  if (ctx.length) lines.push(`context: ${ctx.map(([k, v]) => `${k}=${v === null ? "null" : String(v)}`).join(" · ")}`);
  return lines.join("\n");
}

/** 보이는 목록 전체(텍스트) — 항목 사이 빈 줄 */
export const logsText = (items: readonly LogEntry[]) => items.map(logText).join("\n\n");

/** 항목 JSON(복사용, 들여쓰기) — api 가 준 그대로 */
export const logJson = (e: LogEntry) => JSON.stringify(e.raw, null, 2);

/** NDJSON — 한 줄에 항목 하나(api 가 준 그대로, 스트림 id 포함), 끝에 줄바꿈 */
export const logsNdjson = (items: readonly LogEntry[]) => items.map((e) => JSON.stringify(e.raw)).join("\n") + (items.length ? "\n" : "");

/** 내려받기 파일 이름: wakeline-logs-YYYYMMDDTHHMMSSZ.<ext> */
export function logsFileName(ext: "txt" | "ndjson", nowMs: number): string {
  return `wakeline-logs-${new Date(nowMs).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z.${ext}`;
}

/** 묶음 전체 텍스트: 묶음 머리(건수 · 억제 합 · 처음 · 마지막) + 붙인 항목이 묶음의 전부인지 + 항목들 */
export function groupText(g: LogGroup, items: readonly LogEntry[], meta: { truncated: boolean }): string {
  const head = `[묶음 fp=${g.fp} ${g.level ?? "—"} ${g.service ?? "—"}/${g.logger ?? "—"}] 항목 ${g.count ?? "—"}건 · 억제 합 ${g.suppressed ?? "—"} · 처음 ${iso(g.first_at)} · 마지막 ${iso(g.last_at)}`;
  const lines = [head, `예외 종류 ${g.exception_type ?? "—"}`, `표본 메시지 ${g.sample_message ?? "—"}`,
    `아래 항목 ${items.length}건${meta.truncated ? " — 묶음의 일부만(목록 상한 또는 스캔 잘림)" : ""}`];
  return [lines.join("\n"), ...items.map(logText)].join("\n\n");
}

// ---- AIS 수신 공백 탭(GET /api/v1/ais/gaps) ----

export interface GapRow {
  key: string;
  /** 구역(수신 상자 문자열). null = 구역 없음(옛 기록 — 모든 구역에 적용) 또는 열린 공백 합계 */
  scope: string | null;
  startedAt: string;
  endedAt: string | null;
  /** 끝난 공백 = 끝 − 시작, 열린 공백 = 응답 시각(to) − 시작. 모르면 null */
  durationS: number | null;
  reason: string | null;
  provider: string | null;
  open: boolean;
}

/** 응답 → 표 행: 열린 공백을 맨 위에, 그다음 끝난 공백을 최근 것부터. 형식이 틀린 항목은 수만 센다 */
export function aisGapRows(resp: unknown): { rows: GapRow[]; truncated: boolean | null; from: string | null; to: string | null; invalid: number } {
  const r = isObj(resp) ? resp : {};
  const to = isTime(r.to) ? r.to : null;
  const raw = Array.isArray(r.items) ? r.items : [];
  const secs = (a: string, b: string | null) => {
    if (b == null) return null;
    const d = (Date.parse(b) - Date.parse(a)) / 1000;
    return Number.isFinite(d) && d >= 0 ? d : null;
  };
  const closed: GapRow[] = [];
  for (const x of raw) {
    if (!isObj(x) || !isTime(x.started_at)) continue;
    const ended = isTime(x.ended_at) ? x.ended_at : null;
    closed.push({
      key: `c:${x.started_at}:${str(x.scope) ?? ""}`, scope: str(x.scope), startedAt: x.started_at, endedAt: ended, durationS: secs(x.started_at, ended),
      reason: str(x.reason), provider: str(x.provider), open: false,
    });
  }
  closed.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const rows: GapRow[] = [];
  if (isObj(r.open) && isTime(r.open.started_at)) {
    rows.push({ key: `o:${r.open.started_at}`, scope: null, startedAt: r.open.started_at, endedAt: null, durationS: secs(r.open.started_at, to), reason: str(r.open.reason), provider: null, open: true });
  }
  rows.push(...closed);
  return { rows, truncated: bool(r.truncated), from: isTime(r.from) ? r.from : null, to, invalid: raw.length - closed.length };
}
