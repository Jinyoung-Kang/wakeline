/**
 * 선택 선박의 한국 항만 입출항(ADR-022 개정) — 순수 함수(테스트 가능).
 * - 자료: 수집기가 해양수산부 선박운항정보(PORT-MIS, 공공데이터포털)의 항만청 10곳 입출항 신고를 KST 날짜별로 모두 받아 둔 서버 색인에서, api 가
 *   AIS 호출부호로 찾아 ship_selected.port_calls 로 보낸다. 선택은 외부 호출을 만들지 않는다(예전에는 선택마다 호출부호로 물었으나 원천이 호출부호로
 *   거르지 않아 거의 모든 선박이 '기록 없음' 으로 보였다 — 그 설계를 버렸다).
 * - '기록 없음'(none)은 서버가 10곳 모두 30일 창을 오늘까지 빈 곳 없이 색인했고 2시간 안에 갱신했다고 할 때만 — 웹도 index.complete 와 빈 곳 없음을
 *   다시 확인하고, 어긋나면 표시하지 않는다(null → "—"). 색인이 모자라면 incomplete — 어느 항만청이 왜(색인 안 됨 · 앞쪽 일부만 · 오늘 목록 아직 ·
 *   갱신 오래됨 · 끝까지 색인하지 못한 날짜)를 그대로 적는다.
 * - 서버 값도 믿지 않는다: 모르는 상태는 null, 형식이 틀린 필드는 그 필드만 null. 문자열은 api 와 같게 제어·서식 문자 제거 · 코드포인트 길이 절단.
 *   모르는 값은 "—"(단위도 붙이지 않는다) — 추측해 채우지 않는다.
 * - 호출부호로만 찾는다(선명으로 찾지 않는다). PORT-MIS 신고 선명이 AIS 선명과 다르면 밝힌다 — 같은 선박인지는 판정하지 않는다. 두 이름이 모두 영문일
 *   때만 비교한다(한글 · 영문처럼 표기 체계가 다른 것은 다름의 신호가 아니다 — 로마자 표기를 짐작하지 않는다).
 * - 신고 시각은 KST 와 UTC 를 함께(공유 형식기 lib/time · components/DualTime, 계약 v5 §G13). 단 KST 00:00:00 은 날짜만 신고했는지 자정인지 원천이
 *   구분하지 않으므로 날짜만 보이고 UTC 로 바꾸지 않는다(reportTime). 색인 갱신 시각 · 읽은 시각은 우리 시각이라 늘 KST+UTC.
 */
import { dualParts, fmtIsoKst, fmtKstDateOnly, isKstMidnight } from "./time";

export const PORT_CALL_STATUSES = ["ok", "none", "incomplete", "disabled", "no_call_sign", "error"] as const;
export type PortCallStatus = (typeof PORT_CALL_STATUSES)[number];
export const PORT_CALL_CALL_SIGN_STATES = ["not_received", "unusable"] as const;
export type PortCallCallSignState = (typeof PORT_CALL_CALL_SIGN_STATES)[number];
export const PORT_CALL_DISABLED_REASONS = ["no_key", "fixture", "operator"] as const;
export type PortCallDisabledReason = (typeof PORT_CALL_DISABLED_REASONS)[number];
export const PORT_CALL_GAP_ISSUES = ["not_indexed", "partial", "behind", "stale", "unindexed_days"] as const;
export type PortCallGapIssue = (typeof PORT_CALL_GAP_ISSUES)[number];
/** 신고의 판(최종 → 최초 — 서버가 시각이 있는 앞 판을 골라 이름을 함께 보낸다) */
export const PORT_CALL_REVISIONS = ["최종", "최초"] as const;
export type PortCallRevision = (typeof PORT_CALL_REVISIONS)[number];
/** 색인이 덮는 항만청 수(api PortCallReader.PORT_AUTHORITIES · schemas/vectors/port-authorities.v1.json) — 서버가 보낸 authorities 가 이 값일 때만 받는다 */
export const PORT_CALL_AUTHORITIES = 10;
/** 색인 꼬리 갱신이 이보다 오래되면 '오래됨'(api PortCallsInfo.STALE_AFTER_S — 수집기 갱신 주기 1시간의 두 배) */
export const PORT_CALL_STALE_AFTER_S = 7200;
/** 색인 창(일) — 서버가 보낸 window_days 가 이 값일 때만 받는다(스키마 const) */
export const PORT_CALL_WINDOW_DAYS = 30;
export const PORT_CALL_SOURCE = "해양수산부 선박운항정보(PORT-MIS)";
export const PORT_CALL_SOURCE_URL = "https://www.data.go.kr";
export const PORT_CALL_MAX_ITEMS = 20;

export interface PortRef { code: string | null; name: string | null }
export interface PortCall {
  port_authority_code: string | null;
  port_authority: string | null;
  listed_date: string | null;
  entry_at: string | null;
  entry_revision: PortCallRevision | null;
  exit_at: string | null;
  exit_revision: PortCallRevision | null;
  berth: string | null;
  purpose: string | null;
  first_port: PortRef | null;
  prev_port: PortRef | null;
  next_port: PortRef | null;
  dest_port: PortRef | null;
  reported_name: string | null;
  kind: string | null;
  nationality: string | null;
  read_at: string | null;
}
export interface PortCallGap {
  port_authority_code: string;
  port_authority: string;
  issues: PortCallGapIssue[];
  covered_from: string | null;
  covered_to: string | null;
  refreshed_at: string | null;
  /** 창 안에서 받았지만 끝까지 색인하지 못한 날(KST 날짜 · 오름차순) — issues 에 unindexed_days 가 있을 때만, 없으면 빈 배열 */
  unindexed_days: string[];
}
export interface PortCallIndex { complete: boolean; refreshed_at: string | null; gaps: PortCallGap[] }
export interface PortCallsInfo {
  status: PortCallStatus;
  call_sign: string | null;
  call_sign_state: PortCallCallSignState | null;
  window_from: string | null;
  window_to: string | null;
  items: PortCall[];
  truncated: boolean;
  index: PortCallIndex | null;
  disabled_reason: PortCallDisabledReason | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const CONTROL_FORMAT_RE = /[\p{Cc}\p{Cf}]/gu;
const TEXT_MAX = 80;
const PA_CODE_RE = /^[0-9]{3}$/;
const PORT_CODE_RE = /^[A-Z0-9]{2,10}$/;
const CALL_SIGN_RE = /^[A-Z0-9]{3,7}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

/** 문자열: 제어·서식 문자 제거 → 앞뒤 공백 제거 → max 글자(코드포인트)로 절단(api PortCallReader.text 와 같은 규칙). 빈 값·문자열이 아니면 null */
function text(v: unknown, max = TEXT_MAX): string | null {
  if (typeof v !== "string") return null;
  let t = v.replace(CONTROL_FORMAT_RE, "").trim();
  const cps = Array.from(t);
  if (cps.length > max) t = cps.slice(0, max).join("").trim();
  return t.length ? t : null;
}
const code = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);
const time = (v: unknown): string | null => (typeof v === "string" && v.length <= 40 && TIME_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const day = (v: unknown): string | null => (typeof v === "string" && DATE_RE.test(v) ? v : null);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | null => (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : null);

function parsePort(v: unknown): PortRef | null {
  if (!isObj(v)) return null;
  const p = { code: code(v.code, PORT_CODE_RE), name: text(v.name) };
  return p.code == null && p.name == null ? null : p;
}

function parseItem(v: unknown): PortCall | null {
  if (!isObj(v)) return null;
  const entry_at = time(v.entry_at), exit_at = time(v.exit_at);
  return {
    port_authority_code: code(v.port_authority_code, PA_CODE_RE), port_authority: text(v.port_authority), listed_date: day(v.listed_date),
    entry_at, entry_revision: entry_at ? oneOf(v.entry_revision, PORT_CALL_REVISIONS) : null,
    exit_at, exit_revision: exit_at ? oneOf(v.exit_revision, PORT_CALL_REVISIONS) : null,
    berth: text(v.berth), purpose: text(v.purpose), first_port: parsePort(v.first_port), prev_port: parsePort(v.prev_port),
    next_port: parsePort(v.next_port), dest_port: parsePort(v.dest_port), reported_name: text(v.reported_name), kind: text(v.kind),
    nationality: text(v.nationality), read_at: time(v.read_at),
  };
}

function parseGap(v: unknown): PortCallGap | null {
  if (!isObj(v)) return null;
  const pa = code(v.port_authority_code, PA_CODE_RE), name = text(v.port_authority);
  const issues = Array.isArray(v.issues) ? v.issues.map((i) => oneOf(i, PORT_CALL_GAP_ISSUES)).filter((i): i is PortCallGapIssue => i != null) : [];
  if (pa == null || name == null || issues.length === 0) return null;
  const days = issues.includes("unindexed_days") && Array.isArray(v.unindexed_days)
    ? [...new Set(v.unindexed_days.slice(0, PORT_CALL_WINDOW_DAYS + 1).map(day).filter((d): d is string => d != null))].sort() : [];
  return {
    port_authority_code: pa, port_authority: name, issues: [...new Set(issues)], covered_from: day(v.covered_from), covered_to: day(v.covered_to),
    refreshed_at: time(v.refreshed_at), unindexed_days: days,
  };
}

/** index → 값. 항만청 수 · 오래됨 기준이 이 화면의 것과 다르거나, 완전하다면서 빈 곳이 있거나, 빈 곳을 읽을 수 없으면 null(색인 상태를 모른다). */
function parseIndex(v: unknown): PortCallIndex | null {
  if (!isObj(v) || v.authorities !== PORT_CALL_AUTHORITIES || v.stale_after_s !== PORT_CALL_STALE_AFTER_S || typeof v.complete !== "boolean" || !Array.isArray(v.gaps)) return null;
  const gaps = v.gaps.slice(0, PORT_CALL_AUTHORITIES).map(parseGap);
  if (gaps.some((g) => g == null) || (v.complete && gaps.length > 0) || (!v.complete && gaps.length === 0)) return null;
  return { complete: v.complete, refreshed_at: time(v.refreshed_at), gaps: gaps as PortCallGap[] };
}

/**
 * ship_selected.port_calls → 값. 모르는 상태 · 다른 창 · 읽을 항목 없는 ok · 색인 상태 없는 ok/none/incomplete · 완전하지 않은 none · 완전한 incomplete ·
 * 까닭 없는 no_call_sign 은 null(표시하지 않음 — '기록 없음' 으로 바꾸지 않는다).
 */
export function parsePortCalls(v: unknown): PortCallsInfo | null {
  if (!isObj(v)) return null;
  const status = oneOf(v.status, PORT_CALL_STATUSES);
  if (status == null || v.window_days !== PORT_CALL_WINDOW_DAYS) return null;
  const items = status === "ok" && Array.isArray(v.items)
    ? v.items.slice(0, PORT_CALL_MAX_ITEMS).map(parseItem).filter((x): x is PortCall => x != null) : [];
  if (status === "ok" && items.length === 0) return null;
  const searched = status === "ok" || status === "none" || status === "incomplete";
  const index = searched ? parseIndex(v.index) : null;
  if (searched && index == null) return null;
  if (status === "none" && !index!.complete) return null; // 서버가 '없음' 이라 해도 색인이 완전하지 않으면 말하지 않는다
  if (status === "incomplete" && index!.complete) return null;
  const call_sign_state = status === "no_call_sign" ? oneOf(v.call_sign_state, PORT_CALL_CALL_SIGN_STATES) : null;
  if (status === "no_call_sign" && call_sign_state == null) return null; // 까닭을 지어내지 않는다
  return {
    status,
    call_sign: code(v.call_sign, CALL_SIGN_RE),
    call_sign_state,
    window_from: searched ? day(v.window_from) : null,
    window_to: searched ? day(v.window_to) : null,
    items,
    truncated: status === "ok" && v.truncated === true,
    index,
    disabled_reason: status === "disabled" ? oneOf(v.disabled_reason, PORT_CALL_DISABLED_REASONS) : null,
  };
}

// ---------------------------------------------------------------- 표시 문구

export const PORT_CALL_TITLE = "한국 항만 입출항 (해양수산부 PORT-MIS · 최근 30일)";
export const PORT_CALL_NONE_TEXT = `최근 ${PORT_CALL_WINDOW_DAYS}일 한국 항만 입출항 기록 없음(호출부호 기준 · 항만청 ${PORT_CALL_AUTHORITIES}곳 색인 완료)`;
export const PORT_CALL_INCOMPLETE_TEXT =
  "색인에서 이 호출부호의 기록을 찾지 못함 — 색인이 아직 완전하지 않아 '기록 없음' 으로 판정하지 않음(아래 항만청)";
export const PORT_CALL_CALL_SIGN_TEXT: Record<PortCallCallSignState, string> = {
  not_received: "AIS 호출부호를 아직 받지 않음 — 정적 정보(호출부호)가 오면 색인에서 찾음",
  unusable: "AIS 호출부호가 찾는 형식(영문 대문자 · 숫자 3–7자) 밖 — 찾지 않음",
};
export const PORT_CALL_DISABLED_TEXT: Record<PortCallDisabledReason, string> = {
  no_key: "공공데이터포털 키 없음 — 서버가 입출항 색인을 만들지 않음",
  fixture: "fixture 모드 — 외부 조회 없음(입출항 색인 없음)",
  operator: "운영자가 입출항 색인 갱신을 껐음(운영 설정)",
};
export const PORT_CALL_ERROR_TEXT = "입출항 색인을 읽지 못함(서버 데이터베이스) — 잠시 뒤 다시 읽음";
export const PORT_CALL_GAP_TEXT: Record<PortCallGapIssue, string> = {
  not_indexed: "아직 색인 안 됨",
  partial: "창 앞쪽 일부만 색인됨",
  behind: "오늘(KST) 목록 아직 색인 안 됨",
  stale: "색인 갱신이 오래됨",
  unindexed_days: "끝까지 색인하지 못한 날 있음",
};
/** 빈 곳 한 줄에 적는 날짜 수 상한(넘으면 "외 N일") */
const GAP_DAYS_SHOWN = 5;
/** 색인 갱신 시각의 뜻(title) — 모든 날이 그 시각 기준이라고 말하지 않는다(최근 3일만). */
export const PORT_CALL_INDEX_AS_OF_TITLE =
  "항만청 10곳의 최근 3일(오늘 포함) 다시 받기 중 가장 오래된 것 — 최근 3일은 이 시각까지 올라온 신고가 색인에 있다. 더 오래된 날은 하루에 한 번쯤 다시 받으므로 그보다 이른 때까지의 신고다";
export const PORT_CALL_CAVEAT =
  "AIS 호출부호로만 찾습니다 — 선박이 보낸 호출부호가 틀리거나 같은 호출부호를 쓰는 다른 선박이 있으면 다른 선박의 신고일 수 있습니다. 서버가 항만청 10곳의 신고를 날짜별로 미리 모은 색인에서 찾으며(고를 때 외부에 묻지 않습니다), 색인은 한 시간마다 최근 3일을, 그보다 오래된 날은 하루에 한 번쯤 다시 받습니다. 입출항 시각은 PORT-MIS 신고 시각입니다 — 00:00(KST)으로 온 신고는 날짜만 신고했는지 자정인지 원천이 구분하지 않아 날짜만 보이고 UTC 로 바꾸지 않습니다.";

/** 상태 한 줄(ok 가 아닐 때). ok 면 null. */
export function portCallStatusText(p: PortCallsInfo): string | null {
  switch (p.status) {
    case "ok": return null;
    case "none": return PORT_CALL_NONE_TEXT;
    case "incomplete": return PORT_CALL_INCOMPLETE_TEXT;
    case "no_call_sign": return p.call_sign_state ? PORT_CALL_CALL_SIGN_TEXT[p.call_sign_state] : null;
    case "disabled": return p.disabled_reason ? PORT_CALL_DISABLED_TEXT[p.disabled_reason] : "입출항 색인 꺼짐";
    case "error": return PORT_CALL_ERROR_TEXT;
  }
}

/**
 * 빈 곳 한 줄의 글자(시각은 화면이 DualTime 으로 따로 그린다): "부산(020) — 창 앞쪽 일부만 색인됨(2026-09-12부터) · 색인 갱신이 오래됨".
 * behind 는 색인한 마지막 날(covered_to), unindexed_days 는 그 날짜들(많으면 앞의 5개와 "외 N일") — 모르면 문구만.
 */
export function gapText(g: PortCallGap): string {
  const parts = g.issues.map((i) => {
    if (i === "partial" && g.covered_from) return `${PORT_CALL_GAP_TEXT.partial}(${g.covered_from}부터)`;
    if (i === "behind" && g.covered_to) return `${PORT_CALL_GAP_TEXT.behind}(${g.covered_to}까지 색인)`;
    if (i === "unindexed_days" && g.unindexed_days.length > 0) {
      const shown = g.unindexed_days.slice(0, GAP_DAYS_SHOWN).join(", ");
      const more = g.unindexed_days.length - GAP_DAYS_SHOWN;
      return `끝까지 색인하지 못한 날 ${g.unindexed_days.length}일(${shown}${more > 0 ? ` 외 ${more}일` : ""})`;
    }
    return PORT_CALL_GAP_TEXT[i];
  });
  return `${g.port_authority}(${g.port_authority_code}) — ${parts.join(" · ")}`;
}

/**
 * PORT-MIS 신고 시각 한 칸. 원천 시각은 +09:00 이고, 확인한 실제 응답의 값(2026-09-29T00:00:00+09:00)이 날짜만 신고한 것인지 자정인지 원천이
 * 구분하지 않는다(ADR-022). 그래서 KST 00:00:00.000 인 시각은 날짜만(dateOnly — 시각 미확인, lib/time fmtKstDateOnly) 보이고 UTC 로 바꾸지 않는다
 * (바꾸면 모르는 시각이 전날 15:00 UTC 처럼 보인다). 그 밖의 시각은 시각이 있는 신고 — { dateOnly: false } 이고 화면은 공유 형식기(DualTime 표 칸)로
 * KST 와 UTC 를 함께 그린다. 모르면 null(화면은 "—" 만).
 */
export function reportTime(v: string | null | undefined): { dateOnly: true; kst: string; title: string } | { dateOnly: false } | null {
  if (dualParts(v) == null) return null;
  if (isKstMidnight(v)) {
    return { dateOnly: true, kst: fmtKstDateOnly(v), title: `PORT-MIS 신고 ${fmtIsoKst(v)} — 날짜만 신고했는지 자정인지 원천이 구분하지 않음` };
  }
  return { dateOnly: false };
}

/** 항구 한 칸: "이름(코드)" · 이름만 · 코드만. 모르면 "—" */
export function portText(p: PortRef | null): string {
  if (p == null) return "—";
  if (p.name && p.code) return `${p.name}(${p.code})`;
  return p.name ?? p.code ?? "—";
}

/** "전출항지 → 차항지" — 둘 다 모르면 "—" */
export function legText(c: PortCall): string {
  if (c.prev_port == null && c.next_port == null) return "—";
  return `${portText(c.prev_port)} → ${portText(c.next_port)}`;
}

/** 출항 칸이 비었을 때의 설명(title) — 출항이 없다는 것만 안다(아직 입항 중이거나, 색인이 이 기록을 마지막으로 읽은 뒤 출항했을 수 있다). */
export function noExitTitle(c: PortCall): string {
  return c.read_at
    ? `출항 신고가 색인에 없음 — 아직 입항 중이거나, 색인이 이 기록을 마지막으로 읽은 ${fmtIsoKst(c.read_at)} 뒤에 출항했을 수 있음`
    : "출항 신고가 색인에 없음";
}

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toUpperCase();
const LATIN_RE = /^[\x20-\x7E]*$/;

/**
 * 신고 선명 한 줄: differs(AIS 선명과 다름 — 경고) · no_ais_name(AIS 선명 없음 — 비교 불가) · other_script(둘 중 하나가 영문이 아님 — 표기 체계가 달라
 * 비교하지 않는다. 로마자 표기를 짐작하지 않는다).
 */
export interface ReportedNameNote { name: string; note: "differs" | "no_ais_name" | "other_script" }

/**
 * PORT-MIS 신고 선명들 중 AIS 선명과 같다고 볼 수 없는 것(공백 · 대소문자 · 전각/반각만 다른 것은 같다고 본다 — NFKC). 선명이 없는 신고는 뺀다.
 * 두 이름이 모두 영문(인쇄 가능한 ASCII)일 때만 비교한다 — 한글 "부광9호" 와 영문 AIS 선명은 다름이 아니라 비교 불가로 적는다.
 */
export function reportedNameNotes(items: readonly PortCall[], aisName: string | null | undefined): ReportedNameNote[] {
  const ais = aisName && aisName.trim() ? norm(aisName) : null;
  const out: ReportedNameNote[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const n = it.reported_name;
    if (!n || seen.has(norm(n))) continue;
    seen.add(norm(n));
    if (ais == null) out.push({ name: n, note: "no_ais_name" });
    else if (norm(n) === ais) continue;
    else if (!LATIN_RE.test(ais) || !LATIN_RE.test(norm(n))) out.push({ name: n, note: "other_script" });
    else out.push({ name: n, note: "differs" });
  }
  return out;
}

/** 창 "YYYY-MM-DD ~ YYYY-MM-DD (KST 날짜 · 입항일 기준)" — 모르면 "최근 30일" */
export function windowText(p: PortCallsInfo): string {
  return p.window_from && p.window_to ? `${p.window_from} ~ ${p.window_to} (KST 날짜 · 입항일 기준)` : `최근 ${PORT_CALL_WINDOW_DAYS}일`;
}
