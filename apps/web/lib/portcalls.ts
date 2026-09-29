/**
 * 선택 선박의 한국 항만 입출항(ADR-022) — 순수 함수(테스트 가능).
 * - 자료: 수집기가 AIS 호출부호로 해양수산부 선박운항정보(PORT-MIS, 공공데이터포털)에 물은 최근 30일(KST 날짜 · 입항일 기준) 입출항 신고.
 *   api 가 ship_selected.port_calls 로 보낸다(조회는 수집기만 — 브라우저는 외부 API 를 부르지 않는다).
 * - 서버 값도 믿지 않는다: 모르는 상태는 입출항 전체를 null(표시하지 않음 — "—"), 형식이 틀린 필드는 그 필드만 null. 문자열은 api(RouteInfo.text)와
 *   같게 제어·서식 문자 제거 · 코드포인트 길이 절단. 모르는 값은 "—"(단위도 붙이지 않는다) — 추측해 채우지 않는다.
 * - 호출부호로만 찾는다(선명으로 찾지 않는다). PORT-MIS 에 신고된 선명(reported_name)이 AIS 선명과 다르면 그렇다고 밝힌다 — 같은 선박인지는
 *   판정하지 않는다. AIS 선명은 영문(6-bit ASCII)이라 한글 등 영문이 아닌 신고 선명과는 비교하지 않고 그렇다고만 적는다(로마자 표기를 짐작하지 않는다).
 * - 신고 시각은 KST 와 UTC 를 함께(원천은 +09:00 신고 시각 — 공유 형식기 lib/time · components/DualTime, 계약 v5 §G13). 단 KST 00:00:00 은 날짜만
 *   신고한 것인지 자정인지 원천이 구분하지 않으므로(ADR-022) 날짜만 보이고 UTC 로 바꾸지 않는다(reportTime). 조회 시각(fetched_at)은 우리 시각이라
 *   늘 KST+UTC(DualTime).
 * - 조회하지 않는 상태를 '조회 중' 으로 말하지 않는다: limited(이 세션의 조회가 남용 한도에 걸림 — limited_by) · no_static(호출부호를 아직 모름).
 */
import { dualParts, fmtIsoKst, fmtKstDateOnly, isKstMidnight } from "./time";

export const PORT_CALL_STATUSES = ["ok", "none", "pending", "error", "disabled", "no_call_sign", "no_static", "limited"] as const;
export type PortCallStatus = (typeof PORT_CALL_STATUSES)[number];
export const PORT_CALL_ERROR_KINDS = ["budget", "rate_limited", "http", "provider", "response", "network", "internal", "cache"] as const;
export type PortCallErrorKind = (typeof PORT_CALL_ERROR_KINDS)[number];
export const PORT_CALL_DISABLED_REASONS = ["no_key", "fixture", "operator"] as const;
export type PortCallDisabledReason = (typeof PORT_CALL_DISABLED_REASONS)[number];
/** limited 의 이유(api DemandService): 세션 한도 · 접속 주소(IP) 한도 · 서버 상한 */
export const PORT_CALL_LIMITED_BY = ["session", "ip", "capacity"] as const;
export type PortCallLimitedBy = (typeof PORT_CALL_LIMITED_BY)[number];
/** 세션 한도(api DemandService.PORT_CALL_SESSION_MAX · PORT_CALL_SESSION_WINDOW_MS) — 새로 조회를 일으키는 선박 수 */
export const PORT_CALL_SESSION_LIMIT = { max: 6, window: "60초" } as const;
/** 접속 주소 한도(api DemandService.PORT_CALL_IP_MAX · PORT_CALL_IP_WINDOW_MS) — 같은 IP 의 모든 창을 합친 수 */
export const PORT_CALL_IP_LIMIT = { max: 60, window: "24시간" } as const;
/** 수집기 조회 창(일) — 서버가 보낸 window_days 가 이 값일 때만 받는다(스키마 const) */
export const PORT_CALL_WINDOW_DAYS = 30;
export const PORT_CALL_SOURCE = "해양수산부 선박운항정보(PORT-MIS)";
export const PORT_CALL_SOURCE_URL = "https://www.data.go.kr";
export const PORT_CALL_MAX_ITEMS = 20;
/** 수집기가 항만청 하나에서 받는 최대 건수(쪽 6 × 50 — jobs/portcalls.MAX_PAGES · providers/portmis.NUM_OF_ROWS). 넘으면 incomplete */
export const PORT_CALL_PAGE_CAP = 300;

export interface PortRef { code: string | null; name: string | null }
export interface PortCallReport { kind: string | null; at: string | null; type: string | null }
export interface PortCall {
  port_authority_code: string | null;
  port_authority: string | null;
  entry_at: string | null;
  exit_at: string | null;
  reports: PortCallReport[];
  purpose: string | null;
  prev_port: PortRef | null;
  next_port: PortRef | null;
  dest_port: PortRef | null;
  reported_name: string | null;
  kind: string | null;
  nationality: string | null;
}
export interface PortCallsInfo {
  status: PortCallStatus;
  call_sign: string | null;
  fetched_at: string | null;
  window_from: string | null;
  window_to: string | null;
  items: PortCall[];
  truncated: boolean;
  incomplete: boolean;
  error_kind: PortCallErrorKind | null;
  error_code: string | null;
  disabled_reason: PortCallDisabledReason | null;
  limited_by: PortCallLimitedBy | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const CONTROL_FORMAT_RE = /[\p{Cc}\p{Cf}]/gu;
const TEXT_MAX = 80;
const PA_CODE_RE = /^[0-9]{3}$/;
const PORT_CODE_RE = /^[A-Z0-9]{2,10}$/;
const CALL_SIGN_RE = /^[A-Z0-9]{3,7}$/;
const ERROR_CODE_RE = /^[A-Za-z0-9_]{1,16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

/** 문자열: 제어·서식 문자 제거 → 앞뒤 공백 제거 → max 글자(코드포인트)로 절단(api RouteInfo.text 와 같은 규칙). 빈 값·문자열이 아니면 null */
function text(v: unknown, max = TEXT_MAX): string | null {
  if (typeof v !== "string") return null;
  let t = v.replace(CONTROL_FORMAT_RE, "").trim();
  const cps = Array.from(t);
  if (cps.length > max) t = cps.slice(0, max).join("").trim();
  return t.length ? t : null;
}
const code = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);
const time = (v: unknown): string | null => (typeof v === "string" && v.length <= 40 && TIME_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | null => (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : null);

function parsePort(v: unknown): PortRef | null {
  if (!isObj(v)) return null;
  const p = { code: code(v.code, PORT_CODE_RE), name: text(v.name) };
  return p.code == null && p.name == null ? null : p;
}

function parseItem(v: unknown): PortCall | null {
  if (!isObj(v)) return null;
  const reports: PortCallReport[] = [];
  if (Array.isArray(v.reports)) {
    for (const r of v.reports.slice(0, 8)) {
      if (!isObj(r)) continue;
      const rep = { kind: text(r.kind), at: time(r.at), type: text(r.type) };
      if (rep.kind != null || rep.at != null || rep.type != null) reports.push(rep);
    }
  }
  return {
    port_authority_code: code(v.port_authority_code, PA_CODE_RE), port_authority: text(v.port_authority),
    entry_at: time(v.entry_at), exit_at: time(v.exit_at), reports, purpose: text(v.purpose),
    prev_port: parsePort(v.prev_port), next_port: parsePort(v.next_port), dest_port: parsePort(v.dest_port),
    reported_name: text(v.reported_name), kind: text(v.kind), nationality: text(v.nationality),
  };
}

/**
 * ship_selected.port_calls → 값. 모르는 상태·다른 조회 창(window_days ≠ 30)이면 null(표시하지 않음). ok 인데 읽을 항목이 없으면 null
 * ('기록 없음' 으로 바꾸지 않는다).
 */
export function parsePortCalls(v: unknown): PortCallsInfo | null {
  if (!isObj(v)) return null;
  const status = oneOf(v.status, PORT_CALL_STATUSES);
  if (status == null || v.window_days !== PORT_CALL_WINDOW_DAYS) return null;
  const items = status === "ok" && Array.isArray(v.items)
    ? v.items.slice(0, PORT_CALL_MAX_ITEMS).map(parseItem).filter((x): x is PortCall => x != null) : [];
  if (status === "ok" && items.length === 0) return null;
  const limited_by = status === "limited" ? oneOf(v.limited_by, PORT_CALL_LIMITED_BY) : null;
  if (status === "limited" && limited_by == null) return null; // 이유를 모르는 한도 — 지어내지 않는다
  return {
    status,
    call_sign: code(v.call_sign, CALL_SIGN_RE),
    fetched_at: time(v.fetched_at),
    window_from: typeof v.window_from === "string" && DATE_RE.test(v.window_from) ? v.window_from : null,
    window_to: typeof v.window_to === "string" && DATE_RE.test(v.window_to) ? v.window_to : null,
    items,
    truncated: v.truncated === true,
    incomplete: v.incomplete === true,
    error_kind: status === "error" ? oneOf(v.error_kind, PORT_CALL_ERROR_KINDS) : null,
    error_code: status === "error" ? code(v.error_code, ERROR_CODE_RE) : null,
    disabled_reason: status === "disabled" ? oneOf(v.disabled_reason, PORT_CALL_DISABLED_REASONS) : null,
    limited_by,
  };
}

// ---------------------------------------------------------------- 표시 문구

export const PORT_CALL_TITLE = "한국 항만 입출항 (해양수산부 PORT-MIS · 최근 30일)";
export const PORT_CALL_NONE_TEXT = "최근 30일 한국 항만 입출항 기록 없음(호출부호 기준)";
/** none 인데 incomplete: 쪽 상한까지 받은 기록에 이 호출부호가 없었을 뿐 — 남은 기록은 보지 못했다('기록 없음' 이 아니다) */
export const PORT_CALL_NONE_INCOMPLETE_TEXT =
  `받은 기록 안에는 이 호출부호의 입출항 없음 — 일부 항만청 기록이 조회 상한(항만청당 ${PORT_CALL_PAGE_CAP}건)을 넘어 다 받지 못해 '기록 없음' 으로 판정하지 않음`;
export const PORT_CALL_NO_CALL_SIGN_TEXT = "AIS 정적 정보에 호출부호 없음 또는 조회 형식 밖(영문·숫자 3–7자) — 조회 불가";
export const PORT_CALL_NO_STATIC_TEXT = "호출부호 모름 — AIS 정적 정보(호출부호)를 아직 받지 못함 · 받으면 조회";
export const PORT_CALL_PENDING_TEXT = "조회 중 — PORT-MIS 항만청 10곳에 차례로 묻는 중";
export const PORT_CALL_LIMITED_TEXT: Record<PortCallLimitedBy, string> = {
  session: `조회 한도 — 이 화면에서 새 선박 조회는 ${PORT_CALL_SESSION_LIMIT.window}에 ${PORT_CALL_SESSION_LIMIT.max}척까지 · 지금 조회하지 않음(한도가 풀리면 자동 조회)`,
  ip: `조회 한도 — 같은 접속 주소(IP)에서 새 선박 조회는 ${PORT_CALL_IP_LIMIT.window}에 ${PORT_CALL_IP_LIMIT.max}척까지 · 지금 조회하지 않음(이미 조회된 선박은 그대로 보임)`,
  capacity: "조회 대기 — 서버의 동시 조회 상한이 참 · 지금 조회하지 않음(자리가 나면 자동 조회)",
};
export const PORT_CALL_CAVEAT =
  "AIS 호출부호로만 찾습니다 — 선박이 보낸 호출부호가 틀리거나 같은 호출부호를 쓰는 다른 선박이 있으면 다른 선박의 신고일 수 있습니다. 입출항 시각은 PORT-MIS 신고 시각입니다 — 00:00(KST)으로 온 신고는 날짜만 신고했는지 자정인지 원천이 구분하지 않아 날짜만 보이고 UTC 로 바꾸지 않습니다.";
export const PORT_CALL_DISABLED_TEXT: Record<PortCallDisabledReason, string> = {
  no_key: "공공데이터포털 키 없음 — 조회하지 않음",
  fixture: "fixture 모드 — 외부 조회 없음",
  operator: "운영자가 조회를 껐음(운영 설정)",
};
export const PORT_CALL_ERROR_TEXT: Record<PortCallErrorKind, string> = {
  budget: "하루 호출 예산 소진(UTC 자정 = 09:00 KST 에 다시 셈)",
  rate_limited: "호출 속도 상한 대기 초과",
  http: "PORT-MIS HTTP 오류",
  provider: "PORT-MIS 오류 응답(resultCode)",
  response: "응답 형식이 확인한 구조와 다름",
  network: "연결 실패·시간 초과",
  internal: "수집기 내부 오류",
  cache: "api 가 캐시를 읽지 못함",
};

/** 실패 원문의 자리 — 공개 화면에는 종류·코드만 싣는다(예산 수치 등 내부 사유를 내보내지 않는다) */
export const PORT_CALL_ERROR_WHERE = "원문 사유는 운영 화면의 공급자 portmis 상태·시스템 로그에만 있습니다";

/** 상태 한 줄(ok 가 아닐 때). ok 면 null. */
export function portCallStatusText(p: PortCallsInfo): string | null {
  switch (p.status) {
    case "ok": return null;
    case "none": return p.incomplete ? PORT_CALL_NONE_INCOMPLETE_TEXT : PORT_CALL_NONE_TEXT;
    case "pending": return PORT_CALL_PENDING_TEXT;
    case "no_call_sign": return PORT_CALL_NO_CALL_SIGN_TEXT;
    case "no_static": return PORT_CALL_NO_STATIC_TEXT;
    case "limited": return p.limited_by ? PORT_CALL_LIMITED_TEXT[p.limited_by] : "조회 한도 — 지금 조회하지 않음";
    case "disabled": return p.disabled_reason ? PORT_CALL_DISABLED_TEXT[p.disabled_reason] : "조회 꺼짐";
    case "error": {
      const kind = p.error_kind ? PORT_CALL_ERROR_TEXT[p.error_kind] : "원인 모름";
      return `조회 실패 — ${kind}${p.error_code ? ` (${p.error_code})` : ""} · 선택해 두면 5분 뒤 다시 조회`;
    }
  }
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

/**
 * 입항·출항 칸: 시각이 하나로 정해졌으면 그 시각(single). 아니면 그 종류의 신고(total 건) 중 시각 있는 신고의 서로 다른 시각(reports):
 * - 둘 이상이면 모두 — "신고 n건 · 시각 다름"(고르지 않는다).
 * - 하나뿐이고 시각 없는 같은 종류의 신고가 더 있으면 그 하나 — "신고 n건 중 시각 있는 1건"(시각 없는 신고가 다른 시각일 수 있어 정하지 않는다).
 * 그 밖(신고 없음 · 시각 없음 · 한 건뿐인데 서버가 정하지 않음)은 reports 가 비고 "—".
 */
export function callTimes(c: PortCall, kind: "입항" | "출항"): { single: string | null; reports: string[]; total: number } {
  const single = kind === "입항" ? c.entry_at : c.exit_at;
  if (single) return { single, reports: [], total: 0 };
  const same = c.reports.filter((r) => r.kind === kind);
  const ats = [...new Set(same.filter((r) => r.at != null).map((r) => r.at as string))];
  const show = ats.length > 1 || (ats.length === 1 && same.length > 1);
  return { single: null, reports: show ? ats : [], total: show ? same.length : 0 };
}

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toUpperCase();
const ASCII_RE = /^[\x20-\x7E]*$/;

/**
 * 신고 선명 한 줄: differs(AIS 선명과 다름 — 경고) · no_ais_name(AIS 선명 없음 — 비교 불가) · other_script(AIS 선명은 영문인데 신고 선명은
 * 영문이 아님 — 표기 체계가 달라 비교하지 않는다. 로마자 표기를 짐작하지 않는다).
 */
export interface ReportedNameNote { name: string; note: "differs" | "no_ais_name" | "other_script" }

/**
 * PORT-MIS 신고 선명들 중 AIS 선명과 같다고 볼 수 없는 것(공백 · 대소문자 · 전각/반각만 다른 것은 같다고 본다 — NFKC). 선명이 없는 신고는 뺀다.
 * AIS 선명은 영문(6-bit ASCII)이다 — 신고 선명이 영문이 아니면(예: 한글 "부광9호") 다름이 아니라 비교 불가로 적는다.
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
    else if (ASCII_RE.test(ais) && !ASCII_RE.test(norm(n))) out.push({ name: n, note: "other_script" });
    else out.push({ name: n, note: "differs" });
  }
  return out;
}

/** 조회 창 "YYYY-MM-DD ~ YYYY-MM-DD (KST 날짜)" — 모르면 "최근 30일" */
export function windowText(p: PortCallsInfo): string {
  return p.window_from && p.window_to ? `${p.window_from} ~ ${p.window_to} (KST 날짜 · 입항일 기준)` : `최근 ${PORT_CALL_WINDOW_DAYS}일`;
}
