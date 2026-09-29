/** 운영 화면 보조(순수 함수·주입 가능한 호출). 비인가 ops 호출은 404 로 숨겨지므로(SecurityConfig) 401 과 함께 "세션 없음 후보"로 본다. */
import { ApiError } from "./api";
import { fmtDuration } from "./format";
import { compareInstants, parseResolvedRef, uptoOf, type Resolution, type ResolvedRef } from "./resolutions";
import { fmtKstMinute, fmtTimeTitle, kstDayOf } from "./time";

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
type Kind = "loss" | "queue" | "quarantine" | "age" | "count" | "window";
/** 예산 트림의 뜻 — 손실이 아니다(공유 필드 계약: 보존 창이 짧아질 뿐, 읽기 전에 잘렸을 때만 api 가 손실로 센다) */
const TRIM_NOT_LOSS = "손실 아님: 스트림에 남는 구간(api 가 멈췄다 돌아와 다시 읽을 수 있는 창)이 짧아질 뿐이다. 읽히기 전에 잘린 구간만 api 의 스트림 트림 손실(stream_trim_loss_events)로 센다 — 아래 보존 창 행 참고";
/**
 * [묶음, 필드, 이름, 종류, 설명] — 손실(loss)만 0 이 아니면 빨간색. 보존 창(window)은 streamWindowRow 가 따로 계산한다(예산 때문에 짧아지면 주황 — 손실 아님).
 * log_* = 시스템 로그 싱크 자기 지표(계약 v5 §C2): collector·ais 는 heartbeat/상태 해시의 log_sent · log_dropped,
 * api 는 Micrometer wakeline_log_events_total{result=sent|dropped|suppressed}. 억제(suppressed)는 손실이 아니다 — 건수는 같은 지문의
 * 다음 항목 suppressed 에 실리고, 다음 항목이 오지 않으면 창(10 s)이 닫힐 때 마지막 억제 발생이 제 항목으로 실린다(계약 v5 §G9).
 * 버림(dropped)의 원인은 보내는 쪽이 세는 그대로 적는다: collector·ais(logsink.py) = 대기열 상한 초과 · 항목 생성 실패(8 KiB 맞춤 실패 포함),
 * api(LogSink) = 대기열 상한 초과 · 항목 생성 실패 · 종료 때 남은 항목. 세 프로세스 모두 억제 중에 지문 표 상한에서 밀려난 발생(억제 수까지 — §G9).
 */
const PIPELINE_SPEC: [PipelineGroup, string, string, Kind, string][] = [
  ["collector", "publish_dropped", "스트림 발행 드롭", "loss", "Redis 스트림에 싣지 못하고 버린 수집 묶음(로컬 큐 상한) — 누적"],
  ["collector", "db_dropped", "DB 기록 드롭", "loss", "수집 기록(실행 이력 등)을 DB 에 쓰지 못하고 버린 건수 — 누적"],
  ["collector", "db_pending", "DB 기록 대기", "queue", "아직 DB 에 쓰지 않은 기록 수(지금 값) — 손실 아님"],
  ["collector", "stream_budget_trims", "항공기 스트림 예산 트림", "count", `바이트 예산 때문에 항공기 스트림을 보존 목표(시간)보다 일찍 자른 발행 수 — 누적. ${TRIM_NOT_LOSS}`],
  ["collector", "stream_window_s.aircraft", "항공기 스트림 보존 창", "window", ""],
  ["collector", "log_sent", "시스템 로그 전송", "count", "시스템 로그 스트림(wakeline:logs)에 실은 WARN·ERROR 항목 — 누적"],
  ["collector", "log_dropped", "시스템 로그 버림", "loss", "wakeline:logs 에 싣지 못하고 버린 WARN·ERROR 항목 — 대기열 상한(500건 · 2 MiB) 초과 · 항목을 만들지 못함(8 KiB 에 맞추지 못함 포함) · 억제 중에 지문 표에서 밀려난 발생(억제 수까지) — 누적. 0 이 아니면 /logs 에 없는 오류가 있다(컨테이너 표준 출력에는 남음)"],
  ["collector", "heartbeat_age_s", "heartbeat 경과", "age", "collector 가 마지막으로 상태를 보고한 뒤 지난 시간"],
  ["ais", "dropped_total", "AIS 큐 드롭", "loss", "처리 대기열 상한으로 버린 AIS 메시지 — 누적(ais 시작 이후)"],
  ["ais", "quarantined_total", "AIS 격리", "quarantine", "품질 규칙으로 걸러낸 메시지(지도에 표시 안 함) — 누적"],
  ["ais", "stream_budget_trims", "선박 스트림 예산 트림", "count", `바이트 예산 때문에 선박 스트림을 보존 목표(시간)보다 일찍 자른 발행 수 — 누적. ${TRIM_NOT_LOSS}`],
  ["ais", "stream_window_s.ships", "선박 스트림 보존 창", "window", ""],
  ["ais", "log_sent", "시스템 로그 전송", "count", "시스템 로그 스트림(wakeline:logs)에 실은 WARN·ERROR 항목 — 누적"],
  ["ais", "log_dropped", "시스템 로그 버림", "loss", "wakeline:logs 에 싣지 못하고 버린 WARN·ERROR 항목 — 대기열 상한(500건 · 2 MiB) 초과 · 항목을 만들지 못함(8 KiB 에 맞추지 못함 포함) · 억제 중에 지문 표에서 밀려난 발생(억제 수까지) — 누적. 0 이 아니면 /logs 에 없는 오류가 있다(컨테이너 표준 출력에는 남음)"],
  ["api", "track_queue_dropped", "항적 저장 큐 넘침", "loss", "DB 저장 대기열 상한으로 버린 항적 행 — 누적(api 시작 이후)"],
  ["api", "ship_queue_dropped", "선박 저장 큐 넘침", "loss", "DB 저장 대기열 상한으로 버린 선박 위치 행 — 누적"],
  ["api", "receipts_force_released", "영수증 강제 해제", "loss", "DB 저장 확인 전에 ACK 한 스트림 메시지(표식 상한) — 저장되지 않았을 수 있음"],
  ["api", "dlq", "DLQ", "loss", "스키마 검증 실패로 저장하지 않은 메시지"],
  ["api", "stream_trim_loss_events", "스트림 트림 손실", "loss", "읽기 전에 스트림에서 잘려 나간 구간을 감지한 횟수"],
  ["api", "track_rows_failed", "항적 저장 거절", "loss", "DB 가 영구 오류로 거절해 재시도 없이 버린 항적 행 — 누적"],
  ["api", "ship_rows_failed", "선박 저장 거절", "loss", "DB 가 영구 오류로 거절해 재시도 없이 버린 선박 위치 행 — 누적"],
  ["api", "stream_apply_errors", "메시지 처리 오류", "loss", "처리 중 예외로 건너뛴 스트림 메시지(검증은 통과) — 누적"],
  ["api", "listener_errors", "이벤트 리스너 오류", "loss", "알림 저장·팬아웃 등 이벤트 리스너가 실패한 횟수 — 누적"],
  ["api", "log_sent", "시스템 로그 전송", "count", "wakeline_log_events_total{result=sent} — 시스템 로그 스트림에 실은 WARN·ERROR 항목(브라우저 보고 포함 — 브라우저 오류는 wakeline:logs:client, 계약 v5 §G2) — 누적"],
  ["api", "log_dropped", "시스템 로그 버림", "loss", "wakeline_log_events_total{result=dropped} — wakeline:logs · wakeline:logs:client 에 싣지 못하고 버린 항목: 대기열 상한(500건 · 2 MiB) 초과 · 항목을 만들지 못함 · 억제 중에 지문 표에서 밀려난 발생(억제 수까지) · 종료 때 보내지 못한 항목 — 누적. 0 이 아니면 /logs 에 없는 오류가 있다(컨테이너 표준 출력에는 남음)"],
  ["api", "log_suppressed", "시스템 로그 억제", "count", "wakeline_log_events_total{result=suppressed} — 같은 지문 10 s 1건 규칙으로 따로 보내지 않은 발생. 손실 아님: 건수는 같은 지문의 다음 항목 suppressed 에 실린다 — 다음 항목이 오지 않으면 창(10 s)이 닫힐 때 마지막 억제 발생을 항목으로 보낸다(계약 v5 §G9). 항목에 실릴 때 센다 — 누적"],
];

/**
 * 표 한 줄. value = 원 값(모르면 null), text = 값 칸 글자. detail · state 는 보존 창 행만: detail = 목표("목표 2.5 h — 수집기 설정"),
 * state = 상태를 말로("예산 때문에 짧아짐" · "채우는 중" · 원인 모름) — 없으면 null.
 */
export interface PipelineRow {
  group: PipelineGroup; key: string; label: string; title: string; value: number | null; text: string; tone: "bad" | "warn" | "ok" | "muted";
  kind: Kind; detail?: string; state?: string | null;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** 0 이상 유한수만 값 — 그 밖(null·문자열·음수)은 모름 */
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** 응답 → 표 행. 모르는 값(null·없음·형식 오류)은 "—"(0 으로 채우지 않는다) */
export function pipelineRows(resp: unknown): PipelineRow[] {
  const r = obj(resp);
  return PIPELINE_SPEC.map(([group, key, label, kind, title]) => {
    if (kind === "window") return streamWindowRow(r, group, key, label);
    const value = count(obj(r[group])[key]);
    const text = value == null ? "—" : kind === "age" ? fmtDuration(value) : value.toLocaleString("en-US");
    const tone = kind !== "loss" || value == null ? "muted" : value > 0 ? "bad" : "ok";
    return { group, key, label, title, value, text, tone, kind };
  });
}

/** 탭의 빨간 배지: 0 이 아닌 손실(loss) 지표 수 — 예산 트림 · 짧아진 보존 창은 손실이 아니라 세지 않는다. 응답이 없으면 null */
export function pipelineLossCount(resp: unknown): number | null {
  if (resp == null) return null;
  return pipelineRows(resp).filter((x) => x.kind === "loss" && x.value != null && x.value > 0).length;
}

// ---- 스트림 보존 창(공유 필드 계약: collector · ais 의 stream_retention_s · stream_budget_bytes, api 의 stream_window_s) ----

/** 창이 목표보다 이만큼(10분) 넘게 짧을 때만 "예산 때문에 짧아짐" — 시간 트림(XADD MINID ~)은 대략이라 조금 짧은 것은 정상 */
export const STREAM_WINDOW_SLACK_S = 600;

/** 시간 길이: 1 h 미만은 "30 min", 그 이상은 "1.7 h"(소수 1자리). 모르면 "—" */
function fmtSpan(s: number | null): string {
  if (s == null) return "—";
  return s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}
/** 바이트 예산 "80 MiB"(2^20 단위, 정수가 아니면 소수 1자리). 모르면 "—" */
function fmtMiB(b: number | null): string {
  if (b == null) return "—";
  const m = b / 2 ** 20;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} MiB`;
}

/**
 * 보존 창 행. 창 = api.stream_window_s.{aircraft|ships}(api 가 30 s 스트림 지표와 함께 XINFO STREAM 첫 항목 id 로 잰 "지금 − 첫 항목 시각", 잰 값),
 * 목표 = 그 스트림을 쓰는 프로세스(collector · ais) 상태 해시의 stream_retention_s(수집기 설정 — 고른 값), 바이트 예산 = stream_budget_bytes(설정).
 * tone: 예산 트림 > 0 이고 창 < 목표 − 10분 → warn "예산 때문에 짧아짐" · 트림 0 이고 창 < 목표 → muted "채우는 중" · 그 밖 ok.
 * 창을 모르면 "—"(단위 없이, muted), 목표를 모르면 판정하지 않는다(muted), 트림 수를 모르는데 짧으면 원인을 말하지 않는다.
 */
function streamWindowRow(r: Record<string, unknown>, group: PipelineGroup, key: string, label: string): PipelineRow {
  const stream = key.endsWith(".ships") ? "ships" : "aircraft";
  const src = obj(r[group]);
  const win = count(obj(obj(r.api).stream_window_s)[stream]);
  const target = count(src.stream_retention_s);
  const trims = count(src.stream_budget_trims);
  const budget = count(src.stream_budget_bytes);
  const detail = `목표 ${fmtSpan(target)}${target == null ? "" : " — 수집기 설정"}`;
  let tone: PipelineRow["tone"] = "muted";
  let state: string | null = null;
  if (win != null && target != null) {
    if (win >= target) tone = "ok";
    else if (trims == null) state = "원인 모름(예산 트림 수 모름)";
    else if (trims > 0) {
      if (win < target - STREAM_WINDOW_SLACK_S) { tone = "warn"; state = "예산 때문에 짧아짐"; } else tone = "ok";
    } else state = "채우는 중";
  }
  const name = stream === "ships" ? "선박" : "항공기";
  const title = `${name} 스트림(wakeline:${stream})에 지금 남아 있는 구간 = 지금 − 첫 항목 시각(api 가 30 s 마다 XINFO STREAM 첫 항목 id 로 잰 값) — `
    + `api 가 멈췄다 돌아와 다시 읽을 수 있는 창. 목표 = ${group} 의 stream_retention_s(시간 트림 — 수집기 설정), `
    + `바이트 예산 ${fmtMiB(budget)}(수집기 설정 stream_budget_bytes)이 먼저 차면 목표보다 짧아진다. 손실 아님 — 읽히기 전에 잘린 구간만 api 스트림 트림 손실로 센다. `
    + `주황 = 예산 트림이 있고 목표보다 ${STREAM_WINDOW_SLACK_S / 60}분 넘게 짧음 · 채우는 중 = 트림 없이 아직 목표만큼 쌓이지 않음(기동 직후 등)`;
  return { group, key, label, title, value: win, text: fmtSpan(win), tone, kind: "window", detail, state };
}

/** 마지막으로 감지한 스트림 트림 손실 구간. from 은 모르면 null(api 가 null 로 보낸다 — 손실 자체는 보인다). 없거나 형식이 틀리면 null */
export function lastTrimLoss(resp: unknown): { stream: string; from: string | null; to: string } | null {
  const t = obj(obj(obj(resp).api).last_stream_trim_loss);
  const fromOk = typeof t.from === "string" || t.from === null;
  return typeof t.stream === "string" && fromOk && typeof t.to === "string" ? { stream: t.stream, from: (t.from as string | null), to: t.to } : null;
}

// ---- 탭(엔드포인트)마다 응답 순서 ----

/**
 * 한 탭(엔드포인트)의 요청 순서 — 어떤 응답(성공 · 실패)을 화면에 반영할지 정한다.
 * - begin(barrier): 떠나는 요청에 번호를 매긴다. barrier = 기준 요청(쓰기 뒤 다시 읽기 · 해결 표시 토글 · refresh 단추): 그 전에 떠난 요청의 응답은
 *   이제 버린다 — 먼저 오든 늦게 오든 쓰기 전 값 · 다른 해결 표시의 요약이 화면에 오지 않는다.
 * - settle(my): 응답이 오면 부른다. 반영할 응답 = 기준 요청 이후에 떠났고 이미 반영한 응답보다 새것. 새로고침 주기보다 느린 응답도
 *   (더 새 응답이 아직 오지 않았으면) 반영한다 — 느려진 api 의 실패가 "다음 요청이 떠났다"는 이유로 조용히 사라지지 않게.
 * - busy: 떠 있는 요청이 있는가 — 주기 새로고침은 그 탭을 건너뛴다(느려진 api 에 요청을 쌓지 않는다. 기준 요청은 늘 보낸다).
 */
export class RequestOrder {
  private sent = 0;
  private applied = 0;
  private floor = 0;
  private open = 0;
  begin(barrier: boolean): number {
    const my = ++this.sent;
    if (barrier) this.floor = my;
    this.open++;
    return my;
  }
  settle(my: number): boolean {
    this.open = Math.max(0, this.open - 1);
    if (my < this.floor || my <= this.applied) return false;
    this.applied = my;
    return true;
  }
  get busy(): boolean { return this.open > 0; }
}

// ---- 공급자 마지막 오류의 해결(ADR-024 — /ops/providers 의 last_error_resolution · last_error_resolved) ----

/**
 * 공급자 표의 LAST ERROR 칸이 쓰는 사실. resolution = 그 공급자의 유효한 provider_error 해결(api 가 준 그대로, 형식이 틀리면 null),
 * resolved = api 가 "이 오류는 그 해결의 upto 이하" 라고 했고 해결을 읽을 수 있을 때만 true(모르는 것을 해결로 치지 않는다),
 * recurred = 해결이 있고 지금 오류의 시각(last_error_at)이 그 upto 뒤라고 받은 값으로 확인될 때(재발),
 * undecided = 해결은 있지만 해결됨도 재발도 확인되지 않음 — api 는 last_error_at 이 없거나 형식이 틀려도 last_error_resolved=false 를 준다(계약 §G14):
 * 그때 "다시 남"이라고 하지 않는다(시각을 모르는 오류의 재발을 지어내지 않는다).
 * upto = 해결 처리로 보낼 그 오류의 시각(last_error_at 그대로) — 시각으로 읽을 수 없으면 null(해결 처리 불가).
 */
export interface ProviderLastError { hasError: boolean; upto: string | null; resolution: ResolvedRef | null; resolved: boolean; recurred: boolean; undecided: boolean }

export function providerLastError(p: Record<string, unknown>): ProviderLastError {
  const hasError = typeof p.last_error === "string" && p.last_error.trim() !== "";
  const resolution = parseResolvedRef(p.last_error_resolution);
  const resolved = p.last_error_resolved === true && resolution != null;
  const upto = uptoOf(p.last_error_at);
  const open = hasError && !resolved && resolution != null;
  const recurred = open && (compareInstants(upto, resolution.upto) ?? 0) > 0;
  return { hasError, upto, resolution, resolved, recurred, undecided: open && !recurred };
}

/**
 * 201 을 받은 provider_error 해결을 공급자 행에 붙인다(낙관적 표시 — 201 뒤에만). 덮는지(upto ≥ last_error_at)는 받은 값으로 따지고,
 * 시각을 모르면 덮지 않는다. 다시 불러온 응답이 정한다.
 */
export function withProviderResolutions<P extends { providers: Record<string, unknown>[] }>(prov: P, created: readonly Resolution[]): P {
  const by = new Map(created.filter((r) => r.kind === "provider_error").map((r) => [r.key, r]));
  return {
    ...prov,
    providers: prov.providers.map((x) => {
      const r = by.get(String(x.name));
      if (!r) return x;
      const c = compareInstants(x.last_error_at, r.upto);
      return { ...x, last_error_resolution: { id: r.id, upto: r.upto, resolved_by: r.resolved_by }, last_error_resolved: c != null && c <= 0 };
    }),
  };
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

/**
 * 격리 수의 '부분' 날짜(리뷰 2026-09-30 — V16 · 계약 v5 §G20): api 의 counted_since(V16 이 격리 수를 KST 날짜로 세기 시작한 순간, UTC ISO)가 든 KST 날짜의
 * 수는 그 순간 뒤 실행만 든 부분 값이다 — 하루치(00:00–24:00 KST)처럼 보이지 않게 그 날짜와 붙일 글자를 돌려준다. 값이 없거나 읽을 수 없으면 null(표시 없음).
 */
export function qualityPartialDay(since: unknown): { day: string; text: string; title: string } | null {
  if (typeof since !== "string" || since === "") return null;
  const day = kstDayOf(since);
  const title = fmtTimeTitle(since);
  if (!day || !title) return null;
  return {
    day,
    text: `부분 · ${fmtKstMinute(since)} 부터`,
    title: `부분 값 — 격리 수를 KST 날짜로 세기 시작한 ${title} 뒤에 시작한 실행만 들었다(V16). 그 앞의 실행은 V16 전 보관 표(quality_rule_count_utc_legacy — 운영자 psql)에 있다`,
  };
}
