/** 운영 화면 보조(순수 함수·주입 가능한 호출). 비인가 ops 호출은 404 로 숨겨지므로(SecurityConfig) 401 과 함께 "세션 없음 후보"로 본다. */
import { ApiError } from "./api";
import { fmtDuration } from "./format";

export const OPS_SESSION_PATH = "/api/v1/ops/session";

/** 401/404 — 세션이 없을 때 ops 엔드포인트가 돌려주는 상태 */
export function isAuthMiss(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 404);
}

/**
 * ops 호출 오류가 세션 만료인지 가린다(R-12). 401/404 를 받으면 세션 확인(GET /ops/session)을 한 번 더 해서
 * 그것도 401/404 일 때만 "expired". 세션이 살아 있거나 확인할 수 없으면(네트워크) "error" — 한 엔드포인트의 404 로 로그아웃시키지 않는다.
 */
export async function classifyOpsError(e: unknown, probeSession: () => Promise<unknown>): Promise<"expired" | "error"> {
  if (!isAuthMiss(e)) return "error";
  try {
    await probeSession();
    return "error";
  } catch (p) {
    return isAuthMiss(p) ? "expired" : "error";
  }
}

/**
 * 로그아웃: 서버 호출이 실패해도 화면은 항상 로그인으로 돌아간다(done 을 반드시 부른다 — R-12).
 * 이미 만료(401/404)면 서버에 남은 세션이 없다. 그 밖의 실패는 서버 세션이 남아 있을 수 있음을 알린다(숨기지 않는다).
 */
export async function signOut(send: () => Promise<unknown>, done: (note: string | null) => void): Promise<{ ok: boolean; note: string | null }> {
  let ok = true, note: string | null = null;
  try {
    await send();
  } catch (e) {
    if (!isAuthMiss(e)) { ok = false; note = "로그아웃 요청 실패 — 서버 세션이 남아 있을 수 있습니다(최대 8 h 뒤 만료). 다시 로그인한 뒤 로그아웃하세요."; }
  } finally {
    done(note);
  }
  return { ok, note };
}

export const SESSION_EXPIRED_NOTE = "세션이 만료되었습니다 — 다시 로그인하세요.";

// ---- 파이프라인 손실 지표(R-18) — GET /api/v1/ops/pipeline ----

export type PipelineGroup = "collector" | "ais" | "api";
type Kind = "loss" | "queue" | "quarantine" | "age";
/** [묶음, 필드, 이름, 종류, 설명] — 손실(loss)만 0 이 아니면 강조한다 */
const PIPELINE_SPEC: [PipelineGroup, string, string, Kind, string][] = [
  ["collector", "publish_dropped", "스트림 발행 드롭", "loss", "Redis 스트림에 싣지 못하고 버린 수집 묶음(로컬 큐 상한) — 누적"],
  ["collector", "db_dropped", "DB 기록 드롭", "loss", "수집 기록(실행 이력 등)을 DB 에 쓰지 못하고 버린 건수 — 누적"],
  ["collector", "db_pending", "DB 기록 대기", "queue", "아직 DB 에 쓰지 않은 기록 수(지금 값) — 손실 아님"],
  ["collector", "heartbeat_age_s", "heartbeat 경과", "age", "collector 가 마지막으로 상태를 보고한 뒤 지난 시간"],
  ["ais", "dropped_total", "AIS 큐 드롭", "loss", "처리 대기열 상한으로 버린 AIS 메시지 — 누적(ais 시작 이후)"],
  ["ais", "quarantined_total", "AIS 격리", "quarantine", "품질 규칙으로 걸러낸 메시지(지도에 표시 안 함) — 누적"],
  ["api", "track_queue_dropped", "항적 저장 큐 넘침", "loss", "DB 저장 대기열 상한으로 버린 항적 행 — 누적(api 시작 이후)"],
  ["api", "ship_queue_dropped", "선박 저장 큐 넘침", "loss", "DB 저장 대기열 상한으로 버린 선박 위치 행 — 누적"],
  ["api", "receipts_force_released", "영수증 강제 해제", "loss", "DB 저장 확인 전에 ACK 한 스트림 메시지(표식 상한) — 저장되지 않았을 수 있음"],
  ["api", "dlq", "DLQ", "loss", "스키마 검증 실패로 저장하지 않은 메시지"],
  ["api", "stream_trim_loss_events", "스트림 트림 손실", "loss", "읽기 전에 스트림에서 잘려 나간 구간을 감지한 횟수"],
  ["api", "track_rows_failed", "항적 저장 거절", "loss", "DB 가 영구 오류로 거절해 재시도 없이 버린 항적 행 — 누적"],
  ["api", "ship_rows_failed", "선박 저장 거절", "loss", "DB 가 영구 오류로 거절해 재시도 없이 버린 선박 위치 행 — 누적"],
  ["api", "stream_apply_errors", "메시지 처리 오류", "loss", "처리 중 예외로 건너뛴 스트림 메시지(검증은 통과) — 누적"],
  ["api", "listener_errors", "이벤트 리스너 오류", "loss", "알림 저장·팬아웃 등 이벤트 리스너가 실패한 횟수 — 누적"],
];

export interface PipelineRow { group: PipelineGroup; key: string; label: string; title: string; value: number | null; text: string; tone: "bad" | "ok" | "muted" }

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** 0 이상 유한수만 값 — 그 밖(null·문자열·음수)은 모름 */
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** 응답 → 표 행. 모르는 값(null·없음·형식 오류)은 "—"(0 으로 채우지 않는다) */
export function pipelineRows(resp: unknown): PipelineRow[] {
  const r = obj(resp);
  return PIPELINE_SPEC.map(([group, key, label, kind, title]) => {
    const value = count(obj(r[group])[key]);
    const text = value == null ? "—" : kind === "age" ? fmtDuration(value) : value.toLocaleString("en-US");
    const tone = kind !== "loss" || value == null ? "muted" : value > 0 ? "bad" : "ok";
    return { group, key, label, title, value, text, tone };
  });
}

/** 0 이 아닌 손실 지표 수(탭 배지). 응답이 없으면 null */
export function pipelineLossCount(resp: unknown): number | null {
  if (resp == null) return null;
  return pipelineRows(resp).filter((x) => x.tone === "bad").length;
}

/** 마지막으로 감지한 스트림 트림 손실 구간. from 은 모르면 null(api 가 null 로 보낸다 — 손실 자체는 보인다). 없거나 형식이 틀리면 null */
export function lastTrimLoss(resp: unknown): { stream: string; from: string | null; to: string } | null {
  const t = obj(obj(obj(resp).api).last_stream_trim_loss);
  const fromOk = typeof t.from === "string" || t.from === null;
  return typeof t.stream === "string" && fromOk && typeof t.to === "string" ? { stream: t.stream, from: (t.from as string | null), to: t.to } : null;
}

// ---- 설정 편집의 낙관적 잠금(R-35) ----

/** 편집 중인 값과 편집을 시작할 때 본 서버 version */
export interface SettingEdit { value: string; version: number }

/** 입력: 처음 편집하면 지금 서버 version 을 기억하고, 이미 편집 중이면 그 version 을 유지한다(새로고침이 바꾸지 않는다). */
export function editSetting(prev: SettingEdit | undefined, item: { version: number }, value: string): SettingEdit {
  return { value, version: prev?.version ?? item.version };
}

/** 저장 요청의 If-Match — 편집을 시작할 때 본 version */
export function settingIfMatch(edit: SettingEdit): string {
  return String(edit.version);
}

/** 편집하는 동안 서버 값이 바뀌었는가(다른 운영자·다른 탭) */
export function settingConflict(edit: SettingEdit | undefined, item: { version: number }): boolean {
  return edit != null && edit.version !== item.version;
}

/** 운영자가 "내 값으로 덮어쓰기"를 고른 경우: 지금 본 서버 version 으로 옮긴다 */
export function rebaseSetting(edit: SettingEdit, item: { version: number }): SettingEdit {
  return { value: edit.value, version: item.version };
}

// ---- 로그인·설정 폼(R-56) ----

/** 서버 Login 레코드(@NotBlank username · @NotBlank @Size(min=8) password)와 같은 규칙. 문제가 없으면 null */
export function validateLogin(user: string, pass: string): { field: "user" | "pass"; text: string } | null {
  if (!user.trim()) return { field: "user", text: "아이디를 입력하세요." };
  if (!pass) return { field: "pass", text: "비밀번호를 입력하세요." };
  if (pass.length < 8) return { field: "pass", text: "비밀번호는 8자 이상입니다." };
  return null;
}

/** 로그인 실패 → 한국어 안내(서버 영문 detail 을 그대로 보이지 않는다) */
export function loginErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "서버에 연결할 수 없습니다(네트워크) — 연결을 확인한 뒤 다시 시도하세요.";
  switch (e.status) {
    case 400: return "입력 형식이 올바르지 않습니다 — 아이디를 입력하고 비밀번호는 8자 이상이어야 합니다.";
    case 401: return "아이디 또는 비밀번호가 올바르지 않습니다(5회 실패 시 15분 잠금).";
    case 403: return "요청이 거부되었습니다(보안 토큰) — 페이지를 새로 고친 뒤 다시 시도하세요.";
    case 429: return e.retryAfterS != null ? `로그인 시도가 너무 많습니다 — ${e.retryAfterS}초 뒤 다시 시도하세요.` : "로그인 시도가 너무 많습니다 — 잠시 뒤 다시 시도하세요.";
    case 503: return "서버를 일시적으로 사용할 수 없습니다 — 잠시 뒤 다시 시도하세요.";
    default: return e.status >= 500 ? `서버 오류(HTTP ${e.status}) — 잠시 뒤 다시 시도하세요.` : `로그인하지 못했습니다(HTTP ${e.status}).`;
  }
}

/** 설정 키별 입력 규칙 — api SettingsService.validate 와 같게(서버가 다시 검사한다) */
export type SettingSpec =
  | { kind: "int"; min: number; max: number; unit: string }
  | { kind: "bool" }
  | { kind: "text"; pattern?: RegExp; hint: string; check?: (v: string) => string | null };

const PROVIDERS = /^(adsb_lol|adsb_fi|opensky)(,(adsb_lol|adsb_fi|opensky))*$/;
const LAT_LON = /^\s*-?\d{1,3}(\.\d{1,8})?\s*,\s*-?\d{1,3}(\.\d{1,8})?\s*$/;
const SETTING_SPECS: Record<string, SettingSpec> = {
  region_poll_s: { kind: "int", min: 5, max: 120, unit: "초" },
  global_poll_s: { kind: "int", min: 60, max: 3600, unit: "초" },
  sigmet_poll_s: { kind: "int", min: 60, max: 3600, unit: "초" },
  radar_poll_s: { kind: "int", min: 30, max: 3600, unit: "초" },
  metar_poll_s: { kind: "int", min: 300, max: 7200, unit: "초" },
  region_radius_nm: { kind: "int", min: 50, max: 500, unit: "NM" },
  global_enabled: { kind: "bool" },
  aircraft_providers: { kind: "text", pattern: PROVIDERS, hint: "adsb_lol · adsb_fi · opensky 를 쉼표로(예: adsb_lol,adsb_fi)" },
  region_center: {
    kind: "text", pattern: LAT_LON, hint: "위도,경도(예: 36.5,127.8) · |위도| ≤ 85",
    check: (v) => { const [la, lo] = v.split(",").map((x) => Number(x.trim())); return Math.abs(la) > 85 || Math.abs(lo) > 180 ? "위도는 ±85, 경도는 ±180 안이어야 합니다." : null; },
  },
  ais_bboxes: { kind: "text", hint: "lat1,lon1,lat2,lon2(여러 상자 ;, 구역 |) · 비우면 .env AIS_BBOXES — 서버가 검사" },
};

export function settingSpec(key: string): SettingSpec | null {
  return SETTING_SPECS[key] ?? null;
}

/** 입력 문자열 → 보낼 값. 규칙을 모르는 키는 문자열 그대로(서버가 검사) */
export function parseSetting(key: string, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const spec = settingSpec(key);
  if (!spec) return { ok: true, value: raw };
  if (spec.kind === "bool") return raw === "true" || raw === "false" ? { ok: true, value: raw === "true" } : { ok: false, error: "켜기/끄기만 가능합니다." };
  if (spec.kind === "int") {
    const t = raw.trim();
    if (!/^-?\d+$/.test(t)) return { ok: false, error: `정수를 입력하세요(${spec.min}–${spec.max} ${spec.unit}).` };
    const n = Number(t);
    return n < spec.min || n > spec.max ? { ok: false, error: `${spec.min}–${spec.max} ${spec.unit} 사이여야 합니다.` } : { ok: true, value: n };
  }
  if (spec.pattern && !spec.pattern.test(raw)) return { ok: false, error: `형식: ${spec.hint}` };
  const bad = spec.check?.(raw) ?? null;
  return bad ? { ok: false, error: bad } : { ok: true, value: raw };
}
