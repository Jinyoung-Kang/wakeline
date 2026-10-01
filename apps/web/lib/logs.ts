/**
 * 시스템 로그 화면 보조(계약 v5 §C7) — 순수 함수. 항목 형식은 schemas/log_event.v1.json, 조회 API 는 §C4(`/api/v1/ops/logs*`, 운영 세션 전용).
 * 모르는 값은 null/"—"(0·빈 값으로 채우지 않는다). 형식이 틀린 항목은 보이지 않고 수만 센다.
 * 시각: api 항목의 ts 는 UTC(원본 — JSON 복사 · NDJSON 은 그대로). 화면은 KST 만(계약 v5 §G20 · lib/time), 텍스트 복사 · .txt 는 KST ISO(+09:00 — lib/kst).
 * §G2: api 는 서버 로그(wakeline:logs)와 브라우저 오류(wakeline:logs:client)를 합쳐 준다 — 항목마다 stream. 두 스트림은 id 를 따로 매기므로
 * 같은 id 가 둘 다에 있을 수 있어 화면은 항목을 stream + id(entryKey)로 가른다(같은 id 는 server 가 앞 — api 순서).
 * 해결 표시(ADR-024 — lib/resolutions): 항목 · 묶음에 resolved({id, upto, resolved_by} | null), 목록 · 묶음 응답에 hidden_resolved(가린 수) ·
 * resolution_state. 요청은 resolved=hide|show 를 늘 명시한다(기본 hide — 해결 처리한 지문의 upto 이하 항목을 빼고 뺀 수를 알린다).
 */
import { REQUEST_ID_RE } from "./api";
import { pathSegment } from "./endpoints/path";
import { isoKst } from "./kst";
import { logHeaderLine } from "./log-line";
import { hiddenCount, parseResolutionState, parseResolvedRef, type ResolutionState, type ResolvedMode, type ResolvedRef } from "./resolutions";

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
/** 다음 쪽 커서(§G2): "server:<id>" | "client:<id>" — 스트림 id 만 있는 것은 §G2 전 api(서버 스트림) */
const CURSOR_RE = /^(?:(?:server|client):)?\d{1,16}-\d{1,10}$/;
/** 로그 스트림 두 개(§G2) — 항목의 stream 값과 Redis 키, 보관 수(근사 MAXLEN) */
export const LOG_STREAMS = ["server", "client"] as const;
export type LogStreamName = (typeof LOG_STREAMS)[number];
export const LOG_STREAM_KEY: Record<LogStreamName, string> = { server: "wakeline:logs", client: "wakeline:logs:client" };
export const LOG_STREAM_LABEL: Record<LogStreamName, string> = { server: "서버 로그", client: "브라우저 오류" };
export const LOG_STREAM_KEEP: Record<LogStreamName, number> = { server: 3_000, client: 1_000 };
/**
 * Redis 스트림 내부 노드 하나의 항목 수(stream-node-max-entries 기본값). 근사 트림(MAXLEN ~)은 노드를 통째로만 잘라 한 스트림에 보관 수 + 99건까지
 * 남을 수 있다.
 */
export const LOG_STREAM_NODE = 100;
/** 요청 하나가 훑는 항목 상한(api LogReader.SCAN_MAX = 스트림마다 보관 수 + 노드 하나의 합 = 4,200 — 근사 트림이 남기는 두 스트림 전체) */
export const LOG_SCAN_MAX = LOG_STREAM_KEEP.server + LOG_STREAM_NODE + LOG_STREAM_KEEP.client + LOG_STREAM_NODE;
const FP_RE = /^[0-9a-f]{16}$/;

export interface LogException { type: string; message: string | null; stack: string }
export interface LogEntry {
  id: string;
  /** 어느 스트림의 항목인가(§G2) — api 가 주지 않았으면(§G2 전) null = 서버 스트림 하나뿐이던 때 */
  stream: LogStreamName | null;
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
  /** 이 항목을 덮는 유효 해결(그 지문의 upto ≥ ts) — 없거나 형식이 틀리면 null(해결되지 않은 것으로 보인다) */
  resolved: ResolvedRef | null;
  /** api 가 준 항목 그대로(JSON 복사 · NDJSON 내려받기는 이것 — 화면용 정리를 섞지 않는다) */
  raw: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nonNeg = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
export const validStreamId = (v: unknown): v is string => typeof v === "string" && STREAM_ID_RE.test(v);
export const validCursor = (v: unknown): v is string => typeof v === "string" && CURSOR_RE.test(v);
const streamName = (v: unknown): LogStreamName | null => (v === "server" || v === "client" ? v : null);
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
    id: v.id, stream: streamName(v.stream), ts: v.ts, service: v.service, instance: str(v.instance), level: v.level, logger: str(v.logger), thread: str(v.thread),
    message: v.message, exception, fp: validFp(v.fp) ? v.fp : null, request_id: validRid(v.request_id) ? v.request_id : null,
    context, suppressed: nonNeg(v.suppressed), untrusted: v.untrusted === true, resolved: parseResolvedRef(v.resolved), raw: v,
  };
}

export interface LogPage {
  items: LogEntry[];
  nextCursor: string | null;
  /** 이 요청이 훑은 스트림 항목 수(§C4) — 없으면 null */
  scanned: number | null;
  /** 훑기 상한(LOG_SCAN_MAX — 두 스트림 합 4,200)에 걸려 필터 결과가 불완전할 수 있음 — 없으면 null */
  scanTruncated: boolean | null;
  /** 화면이 형식 오류로 버린 항목 수 */
  invalid: number;
  /** api 가 스키마 검증에 실패해 건너뛴 항목 수(§C4) — 없으면 null */
  serverInvalid: number | null;
  /** 이 목록을 이룬 요청 수(첫 쪽 + '이전 항목 더 보기') — invalid · serverInvalid · hiddenResolved 는 이 쪽들의 합 */
  pages: number;
  /** 해결 처리로 가린 항목 수(api hidden_resolved — 훑은 범위에서 다른 필터에 맞은 것만) — 없으면 null */
  hiddenResolved: number | null;
  /** 해결 기록의 상태(api resolution_state) — 없으면 null */
  resolutionState: ResolutionState | null;
}

/** 항목 하나의 응답(§C4) — {item: …} 으로 싸여 오면 벗긴다(그 밖은 그대로). 스키마와 맞지 않으면 null */
export function parseLogItemResponse(v: unknown): LogEntry | null {
  return parseLogEntry(typeof v === "object" && v !== null && "item" in v ? (v as { item: unknown }).item : v);
}

export function parseLogPage(v: unknown): LogPage {
  const r = isObj(v) ? v : {};
  const raw = Array.isArray(r.items) ? r.items : [];
  const items: LogEntry[] = [];
  for (const x of raw) { const e = parseLogEntry(x); if (e) items.push(e); }
  return {
    items, nextCursor: validCursor(r.next_cursor) ? r.next_cursor : null, scanned: nonNeg(r.scanned), scanTruncated: bool(r.scan_truncated),
    invalid: raw.length - items.length, serverInvalid: nonNeg(r.invalid), pages: 1,
    hiddenResolved: hiddenCount(r.hidden_resolved), resolutionState: parseResolutionState(r.resolution_state),
  };
}

/**
 * '이전 항목 더 보기': 다음 쪽을 뒤에 붙인다(겹친 항목은 한 번). 커서 · 훑은 수 · 잘림은 마지막 요청의 값(다음 쪽을 말한다),
 * 건너뜀 수는 두 가지 모두 불러온 쪽들의 합 — 같은 범위끼리 나란히 보인다. api 값을 모르는 쪽이 있으면 합도 모른다(null — 아는 쪽만 더해 전체처럼 보이지 않는다).
 */
export function appendLogPage(prev: LogPage, next: LogPage): LogPage {
  const seen = new Set(prev.items.map(entryKey));
  return {
    items: [...prev.items, ...next.items.filter((e) => !seen.has(entryKey(e)))],
    nextCursor: next.nextCursor, scanned: next.scanned, scanTruncated: next.scanTruncated,
    invalid: prev.invalid + next.invalid,
    serverInvalid: prev.serverInvalid == null || next.serverInvalid == null ? null : prev.serverInvalid + next.serverInvalid,
    pages: prev.pages + next.pages,
    hiddenResolved: prev.hiddenResolved == null || next.hiddenResolved == null ? null : prev.hiddenResolved + next.hiddenResolved,
    resolutionState: next.resolutionState,
  };
}

export interface LogGroup {
  fp: string; service: string | null; level: string | null; logger: string | null; exception_type: string | null; sample_message: string | null;
  count: number | null; suppressed: number | null; first_at: string | null; last_at: string | null; last_id: string | null;
  /** 묶음의 모든 항목을 덮는 해결(api 가 정한다 — 하나라도 해결되지 않았으면 null) */
  resolved: ResolvedRef | null;
}

export function parseLogGroups(v: unknown): {
  groups: LogGroup[]; scanned: number | null; scanTruncated: boolean | null; invalid: number; hiddenResolved: number | null; resolutionState: ResolutionState | null;
} {
  const r = isObj(v) ? v : {};
  const raw = Array.isArray(r.groups) ? r.groups : [];
  const groups: LogGroup[] = [];
  for (const g of raw) {
    if (!isObj(g) || !validFp(g.fp)) continue;
    groups.push({
      fp: g.fp, service: str(g.service), level: str(g.level), logger: str(g.logger), exception_type: str(g.exception_type), sample_message: str(g.sample_message),
      count: nonNeg(g.count), suppressed: nonNeg(g.suppressed), first_at: isTime(g.first_at) ? g.first_at : null, last_at: isTime(g.last_at) ? g.last_at : null,
      last_id: validStreamId(g.last_id) ? g.last_id : null, resolved: parseResolvedRef(g.resolved),
    });
  }
  return {
    groups, scanned: nonNeg(r.scanned), scanTruncated: bool(r.scan_truncated), invalid: raw.length - groups.length,
    hiddenResolved: hiddenCount(r.hidden_resolved), resolutionState: parseResolutionState(r.resolution_state),
  };
}

/**
 * 201 을 받은 해결을 묶음에 붙인다(낙관적 표시 — 201 뒤에만): 같은 지문이고 묶음의 마지막 항목이 upto 이하면 그 묶음 전체가 해결됐다.
 * upto 가 마지막 항목보다 이르면(그 뒤 재발) 붙이지 않는다 — 다시 불러온 목록이 정한다.
 */
export function withGroupResolutions<G extends { groups: LogGroup[] }>(g: G, created: readonly { key: string; id: number; upto: string; resolved_by: string }[]): G {
  const by = new Map(created.map((r) => [r.key, r]));
  return {
    ...g,
    groups: g.groups.map((x) => {
      const r = by.get(x.fp);
      return r && x.last_at != null && Date.parse(x.last_at) <= Date.parse(r.upto) ? { ...x, resolved: { id: r.id, upto: r.upto, resolved_by: r.resolved_by } } : x;
    }),
  };
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
  /** 해결된 항목: hide = 빼고 수만(기본), show = 흐리게 함께 */
  resolved: ResolvedMode;
}
export const DEFAULT_LOG_FILTER: LogFilter = { services: [], level: "", period: "1h", q: "", rid: "", fp: "", resolved: "hide" };
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
  if (opts.cursor && validCursor(opts.cursor)) p.set("cursor", opts.cursor);
  p.set("limit", String(Math.min(LOGS_PAGE_MAX, Math.max(1, Math.floor(opts.limit ?? LOGS_PAGE)))));
  p.set("resolved", f.resolved);
  return `${LOGS_PATH}?${p}`;
}

/** 묶음 요청(§C4: since · service · level + 해결 표시 — 글자 검색 · 요청 id 는 묶음에 적용되지 않는다) */
export function logGroupsUrl(f: Pick<LogFilter, "services" | "level" | "period" | "resolved">, nowMs: number): string {
  const p = new URLSearchParams();
  p.set("since", sinceIso(f.period, nowMs));
  if (f.services.length) p.set("service", f.services.join(","));
  if (f.level) p.set("level", f.level);
  p.set("resolved", f.resolved);
  return `${LOGS_PATH}/groups?${p}`;
}

/** 항목 하나(§C4). stream 을 주면 그 스트림에서만 — 없으면 api 가 server → client 순으로 찾는다(§G2). id 는 경로 조각(빈 값 · "." · ".." 는 던진다 — lib/endpoints/path) */
export const logItemUrl = (id: string, stream?: LogStreamName | null) => `${LOGS_PATH}/${pathSegment(id)}${stream ? `?stream=${stream}` : ""}`;

/** 첫 필터: /logs#rid=… 는 시각을 모르므로 가장 긴 기간(7 d)으로, #fp=… 는 그 묶음만. #id=…(&stream=…) 는 그 항목의 상세를 연다 */
export function initialLogsState(hash: string): { filter: LogFilter; openId: string | null; openStream: LogStreamName | null } {
  const h = parseLogsHash(hash);
  const filter: LogFilter = { ...DEFAULT_LOG_FILTER, ...(h.rid ? { rid: h.rid, period: "7d" as const } : {}), ...(h.fp ? { fp: h.fp } : {}) };
  return { filter, openId: h.id ?? null, openStream: h.stream ?? null };
}

/** 묶음 보기의 자동 확인이 견주는 값: 묶음마다 지문 · 수 · 마지막 id · 해결(순서 포함) — 훑은 수 같은 다른 값은 보지 않는다 */
export const logGroupsSig = (g: { groups: readonly Pick<LogGroup, "fp" | "count" | "last_id" | "resolved">[] } | null) =>
  (g ? g.groups.map((x) => `${x.fp}:${x.count}:${x.last_id}:${x.resolved?.id ?? ""}`).join("|") : "");

/** /logs#rid=… · #id=…(&stream=…) · #fp=… (오류 문구의 "로그 보기" · 항목 링크). 형식이 틀린 값은 버린다 */
export function parseLogsHash(hash: string): { rid?: string; id?: string; stream?: LogStreamName; fp?: string } {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const out: { rid?: string; id?: string; stream?: LogStreamName; fp?: string } = {};
  const rid = p.get("rid"), id = p.get("id"), fp = p.get("fp"), stream = streamName(p.get("stream"));
  if (validRid(rid)) out.rid = rid;
  if (validStreamId(id)) { out.id = id; if (stream) out.stream = stream; }
  if (validFp(fp)) out.fp = fp;
  return out;
}

/** 항목 링크의 해시: #id=…(스트림을 알면 &stream=… — 같은 id 가 다른 스트림에도 있을 수 있다) */
export const logLinkHash = (e: Pick<LogEntry, "id" | "stream">) => `#id=${encodeURIComponent(e.id)}${e.stream ? `&stream=${e.stream}` : ""}`;

/** 화면에서 항목을 가르는 값(React key · 선택 · 겹침 검사): "stream:id" — stream 을 모르면(§G2 전 api) 서버 스트림 */
export const entryKey = (e: Pick<LogEntry, "id" | "stream">) => `${e.stream ?? "server"}:${e.id}`;

// ---- 새 항목(자동 새로고침 — 보던 줄이 움직이지 않게) ----

/** 스트림 id 비교(ms, 그다음 순번) */
export function streamIdCmp(a: string, b: string): number {
  const [am, as] = a.split("-").map(Number), [bm, bs] = b.split("-").map(Number);
  return am !== bm ? Math.sign(am - bm) : Math.sign(as - bs);
}

/** api 목록 순서의 비교(§G2): 스트림 id, 같으면 server 가 앞(더 새 것으로 친다). 양수 = a 가 더 새 것 */
export function entryCmp(a: Pick<LogEntry, "id" | "stream">, b: Pick<LogEntry, "id" | "stream">): number {
  const c = streamIdCmp(a.id, b.id);
  if (c !== 0) return c;
  const rank = (e: Pick<LogEntry, "stream">) => (e.stream === "client" ? 0 : 1);
  return Math.sign(rank(a) - rank(b));
}

/**
 * 새로 받은 첫 쪽에서 지금 목록의 맨 위보다 새 항목만(api 순서 — entryCmp). 받은 쪽이 가득 찼고 모두 새 항목이면 그 뒤(더 오래된 쪽)에도
 * 새 항목이 있을 수 있다(more).
 */
export function pendingEntries(shown: readonly LogEntry[], fresh: readonly LogEntry[], limit: number): { items: LogEntry[]; more: boolean } {
  const top = shown[0] ?? null;
  const items = top == null ? [...fresh] : fresh.filter((e) => entryCmp(e, top) > 0);
  return { items, more: top != null && fresh.length >= limit && items.length === fresh.length };
}

/** 새 항목을 위에 붙인다(같은 항목 — stream + id — 은 한 번만) */
export function applyPending(shown: readonly LogEntry[], pending: readonly LogEntry[]): LogEntry[] {
  const seen = new Set(pending.map(entryKey));
  return [...pending, ...shown.filter((e) => !seen.has(entryKey(e)))];
}

// ---- 표시 · 복사 형식 ----

/** 텍스트 복사의 시각: 오프셋을 붙인 KST ISO 8601("2026-09-29T08:41:14.906+09:00"). 모르면 "—" */
const isoText = (v: string | null | undefined): string => isoKst(v) ?? "—";

// 목록 시각은 <KstTime variant="cell" ms /> — KST "MM-DD HH:MM:SS.mmm"(ms 유지 — 같은 초의 항목 순서가 보인다, 머리글 "(KST)" — lib/time 의 표 칸 형식)

export const firstLine = (s: string) => s.split(/\r?\n/, 1)[0];

/** 복사 텍스트 첫 줄: `[시각(KST, +09:00) 수준 서비스/로거] rid=…` — 요청 id 가 없으면 rid=— */
export { logHeaderLine } from "./log-line";

/** 예외 종류 표시(§G5): 빈 글(브라우저 오류 — 종류를 보내지 않는다)과 모름은 "—" */
export const exceptionTypeText = (t: string | null | undefined): string => (t && t.trim() ? t : "—");

/**
 * 항목 텍스트(사람이 읽고 붙여 넣기 좋게): 첫 줄 머리, 메시지, 예외, 스택, 그리고 사실 한 줄(id · 스트림(알 때) · fp · instance · thread · 억제 · 신뢰 여부), context.
 */
export function logText(e: LogEntry): string {
  const lines = [logHeaderLine(e.ts, e.level, e.service, e.logger ?? "—", e.request_id), e.message];
  if (e.exception) {
    lines.push(`예외 ${exceptionTypeText(e.exception.type)}${e.exception.message != null ? `: ${e.exception.message}` : ""}`);
    if (e.exception.stack) lines.push(e.exception.stack);
  }
  const facts = [`id=${e.id}`, ...(e.stream ? [`stream=${e.stream}(${LOG_STREAM_KEY[e.stream]})`] : []), `fp=${e.fp ?? "—"}`, `instance=${e.instance ?? "—"}`,
    `thread=${e.thread ?? "—"}`, `억제 ${e.suppressed ?? "—"}`];
  if (e.untrusted) facts.push("브라우저가 보낸 내용(검증 안 됨)");
  if (e.resolved) facts.push(`해결됨 #${e.resolved.id}(${e.resolved.resolved_by} · upto ${isoText(e.resolved.upto)})`);
  lines.push(facts.join(" · "));
  const ctx = Object.entries(e.context);
  if (ctx.length) lines.push(`context: ${ctx.map(([k, v]) => `${k}=${v === null ? "null" : String(v)}`).join(" · ")}`);
  return lines.join("\n");
}

/** 보이는 목록 전체(텍스트) — 항목 사이 빈 줄 */
export const logsText = (items: readonly LogEntry[]) => items.map(logText).join("\n\n");

/** 항목 JSON(복사용, 들여쓰기) — api 가 준 그대로(ts 는 UTC) */
export const logJson = (e: LogEntry) => JSON.stringify(e.raw, null, 2);

/** NDJSON — 한 줄에 항목 하나(api 가 준 그대로, 스트림 id 포함 · ts 는 UTC — 화면의 KST 로 바꾸지 않는다), 끝에 줄바꿈 */
export const logsNdjson = (items: readonly LogEntry[]) => items.map((e) => JSON.stringify(e.raw)).join("\n") + (items.length ? "\n" : "");

/** 내려받기 파일 이름: wakeline-logs-YYYYMMDDTHHMMSS+0900.<ext> — 내려받은 시각(KST, ISO 8601 기본 형식 + 오프셋) */
export function logsFileName(ext: "txt" | "ndjson", nowMs: number): string {
  const s = isoKst(nowMs);
  return `wakeline-logs-${s ? `${s.slice(0, 19).replace(/[-:]/g, "")}+0900` : "time-unknown"}.${ext}`;
}

/** 묶음의 항목 수: "12건". 모르면 "—" 만 — 단위를 붙인 "—건" 은 센 값처럼 읽힌다(지연의 "— ms" 와 같은 규칙) */
export const groupCountText = (count: number | null): string => (count == null ? "—" : `${count}건`);

/** 묶음 전체 텍스트: 묶음 머리(건수 · 억제 합 · 처음 · 마지막) + 붙인 항목이 묶음의 전부인지 + 항목들 */
export function groupText(g: LogGroup, items: readonly LogEntry[], meta: { truncated: boolean }): string {
  const head = `[묶음 fp=${g.fp} ${g.level ?? "—"} ${g.service ?? "—"}/${g.logger ?? "—"}] 항목 ${groupCountText(g.count)} · 억제 합 ${g.suppressed ?? "—"} · 처음 ${isoText(g.first_at)} · 마지막 ${isoText(g.last_at)}`;
  const lines = [head, `예외 종류 ${exceptionTypeText(g.exception_type)}`, `표본 메시지 ${g.sample_message ?? "—"}`,
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
