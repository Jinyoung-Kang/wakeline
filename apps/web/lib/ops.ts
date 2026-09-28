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

/** 마지막으로 감지한 스트림 트림 손실 구간. 없거나 형식이 틀리면 null */
export function lastTrimLoss(resp: unknown): { stream: string; from: string; to: string } | null {
  const t = obj(obj(obj(resp).api).last_stream_trim_loss);
  return typeof t.stream === "string" && typeof t.from === "string" && typeof t.to === "string" ? { stream: t.stream, from: t.from, to: t.to } : null;
}
