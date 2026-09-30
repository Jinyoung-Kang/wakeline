/** 운영 화면 보조(순수 함수·주입 가능한 호출). 비인가 ops 호출은 404 로 숨겨지므로(SecurityConfig) 401 과 함께 "세션 없음 후보"로 본다. */
import { ApiError } from "./api";
import { fmtDuration } from "./format";
import { krMissing, type KrMissingInfo } from "./kr-radar";
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
type Kind = "loss" | "queue" | "quarantine" | "age" | "count" | "window" | "diag";
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
  // 수신 진단(ADR-014 부록 C — keepalive 1011 원인 가리기): 최근 창 최댓값은 aisDiagRow 가 창 · 상한 · 시간 초과(수집기 설정)와 함께 적는다.
  // 설명의 {필드} 는 응답(수집기 상태 해시)의 고른 값으로 채운다(fillAisSettings — 웹은 숫자를 들고 있지 않다, 모르면 "—"). {필드/60} 은 분
  ["ais", "reconnects_quick_total", "짧은 재연결", "count", "받던 연결이 끊겨 열린 AIS 수신 공백(마지막 메시지 → 다시 받은 메시지)이 {reconnect_quick_window_s} s(수집기 고른 값) 안에 닫힌 끊김 수 — 누적(ais 시작 이후). 로그 수준과 상관없이 공백 길이로 센다. 공백은 그대로 기록된다(선박 패널 · 공백 목록). 회복 줄은 INFO 라 로그 화면에 오르지 않고 끊김 줄도 대개 INFO 다 — 같은 연결이 {reconnect_warn_window_s/60}분에 {reconnect_warn_count}번째부터 끊긴 것(되풀이, 수집기 고른 값)과 그 사이 데이터 없이 끝난 재연결 시도는 WARN 으로 오르지만, 공백이 창 안에 닫히면 여기에도 센다. 끊기기 전부터 조용해 공백이 이미 창을 넘음(idle 끊김 등) · 공백이 창을 넘도록 다시 받지 못함은 WARN 으로 오르고 여기에 세지 않는다. 손실 수가 아니다(공백이 손실 구간)"],
  ["ais", "ping_rtt_max_s", "keepalive 왕복", "diag", "keepalive ping 을 보내고 pong 을 받기까지(websockets latency) — 시간 초과를 넘으면 수집기가 1011 로 끊고 다시 붙는다. 이 값과 공급자 지연이 커지는데 루프 지연 · 수신 버퍼가 작으면 공급자 쪽(연결별 전달 적체)이 늦은 것이다. 시간 초과를 넘은 ping 은 왕복을 잴 수 없어 여기에 들지 않는다"],
  ["ais", "loop_lag_max_s", "이벤트 루프 지연", "diag", "수집기 이벤트 루프가 {loop_tick_s} s(수집기 고른 값) 잠든 뒤 늦게 깬 만큼 — 그동안 소켓을 읽지 못한다. ping 이 나가 있는 동안 keepalive 시간 초과보다 길게 멈추면 그 연결이 1011 로 끊길 수 있다(멈춤이 끝난 뒤 콜백 순서에 따라 끊기지 않기도 하고 구역마다 다를 수 있다)"],
  ["ais", "loop_stalls_total", "이벤트 루프 멈춤", "count", "이벤트 루프가 {loop_stall_s} s(수집기 고른 값) 이상 늦게 깬 횟수 — 누적(ais 시작 이후). {loop_warn_s} s 이상이면 수집기가 WARN 을 남긴다({loop_warn_every_s} s 에 1번까지 — 수는 모두 센다, 수집기 고른 값)"],
  ["ais", "ws_queue_max", "WS 수신 버퍼", "diag", "메시지를 꺼낸 뒤 websockets 수신 버퍼에 남은 프레임 수. 넣은 뒤 상한을 넘으면 websockets 가 소켓 읽기를 멈추고(그동안 pong 도 읽지 못한다) 줄면 다시 읽는다 — 꺼낸 뒤 남은 수라 상한 이상이면 그때 읽기가 멈춰 있었다. 한 번 읽기에 프레임이 많이 든 묶음(공급자 적체 해소 · 망이 잠깐 끊겼다 이어짐)에서도 생기므로 그 자체는 결함이 아니다 — 루프 지연이 크면 루프 멈춤 뒤, 작으면 묶음이다"],
  ["ais", "queue_wait_max_s", "원문 대기 시간", "diag", "받은 원문이 처리 대기열에 머문 시간(수신 → 파싱) — 꺼낸 원문과 지금 맨 앞에서 기다리는 원문 중 가장 긴 것(정리 태스크가 멈추면 계속 커진다). 정리 태스크가 밀리는지 본다. 이 대기열은 소켓 읽기를 막지 않는다(가득 차면 오래된 것부터 버리고 AIS 큐 드롭으로 센다)"],
  ["ais", "queue_depth_max", "원문 대기열 깊이", "diag", "원문을 넣은 직후 처리 대기열에 쌓인 건수 — 정리 태스크가 밀리면 커진다. 상한에 닿으면 가장 오래된 것부터 버리고 AIS 큐 드롭으로 센다(그 행이 손실)"],
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
  return PIPELINE_SPEC.map(([group, key, label, kind, spec]) => {
    const title = group === "ais" ? fillAisSettings(spec, obj(r.ais)) : spec;
    if (kind === "window") return streamWindowRow(r, group, key, label);
    if (kind === "diag") return aisDiagRow(r, group, key, label, title);
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

/**
 * ais 설명의 {필드} 자리에 응답의 수집기 설정값(고른 값)을 넣는다 — 숫자를 웹에 적어 두면 수집기가 바꿀 때 조용히 어긋난다. {필드/60} 은 분 단위.
 * 모르는 값(없음 · 형식 오류)은 "—".
 */
function fillAisSettings(title: string, src: Record<string, unknown>): string {
  return title.replace(/\{([a-z_]+)(\/60)?\}/g, (_m, k: string, perMin: string | undefined) => {
    const v = count(src[k]);
    return fmtSetting(v == null ? null : perMin ? v / 60 : v);
  });
}

/** 수신 버퍼가 상한 이상일 때 적는 사실(판정 아님 — 한꺼번에 받은 묶음에서도 생긴다) */
const WS_BUFFER_AT_LIMIT = "상한 도달 — 그때 소켓 읽기가 잠시 멈춤(한꺼번에 받은 묶음 또는 루프 멈춤 — 결함 아님, 루프 지연과 함께 본다)";

/** 초 값 "0.31 s"(소수 2자리 — 수집기가 싣는 자릿수). 모르면 "—" */
const fmtSecs = (v: number | null): string => (v == null ? "—" : `${v.toFixed(2)} s`);
/** 창 · 시간 초과 같은 설정 초 "60"(정수면 정수로). 모르면 "—" */
const fmtSetting = (v: number | null): string => (v == null ? "—" : String(Number.isInteger(v) ? v : Number(v.toFixed(2))));

/**
 * ais 수신 진단 행(ADR-014 부록 C): 최근 diag_window_s 초의 최댓값. 창 · 상한(ws 수신 버퍼 · 원문 대기열) · keepalive 시간 초과는 수집기가 고른 값이라
 * 응답에서 읽어 detail 에 "수집기 설정" 으로 적는다(웹이 숫자를 지어내지 않는다). 색으로 판정하지 않는다(muted — 운영자가 시간 초과 · 상한과 견준다).
 * 수신 버퍼가 상한 이상이면(꺼낸 뒤 남은 수 — websockets 는 '> 상한' 에서 멈추므로 상한과 같아도 그때 읽기가 멈춰 있었다) 그 사실만 state 에 적는다:
 * 한꺼번에 받은 묶음에서도 생기는 일이라 결함 표시(주황)가 아니다. 모르면 "—".
 */
function aisDiagRow(r: Record<string, unknown>, group: PipelineGroup, key: string, label: string, title: string): PipelineRow {
  const src = obj(r[group]);
  const value = count(src[key]);
  const win = `최근 ${fmtSetting(count(src.diag_window_s))} s 최대`;
  let detail = win, text = fmtSecs(value), state: string | null = null;
  const tone: PipelineRow["tone"] = "muted";
  if (key === "ws_queue_max") {
    const limit = count(src.ws_queue_limit);
    text = value == null ? "—" : value.toLocaleString("en-US");
    detail = `${win} · 상한 ${limit == null ? "—" : limit.toLocaleString("en-US")} 프레임 — 수집기 설정`;
    if (value != null && limit != null && value >= limit) state = WS_BUFFER_AT_LIMIT;
  } else if (key === "queue_depth_max") {
    const limit = count(src.queue_limit);
    text = value == null ? "—" : value.toLocaleString("en-US");
    detail = `${win} · 상한 ${limit == null ? "—" : limit.toLocaleString("en-US")} 건 — 수집기 설정`;
  } else if (key === "queue_wait_max_s") {
    detail = `${win}(지금 기다리는 원문 포함)`;
  } else if (key === "ping_rtt_max_s") {
    detail = `${win} · 시간 초과 ${fmtSetting(count(src.ping_timeout_s))} s — 수집기 설정`;
  } else if (key === "loop_lag_max_s") {
    detail = `${win} · keepalive 시간 초과 ${fmtSetting(count(src.ping_timeout_s))} s — 수집기 설정`;
  }
  return { group, key, label, title, value, text, tone, kind: "diag", detail, state };
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

// ---- 수집 실행 상태 · 기상청 '파일 없음' 연속(운영 로그 2026-09-30) ----

/**
 * 실행 기록 상태의 설명(title) — 수집기가 정한 것만(jobs/kma_radar.py _outcome). ok · error 등 옛 상태는 이름 그대로 읽힌다.
 * missing = 새 tm 이 목록에 있었으나 저장한 프레임이 없고 기상청 내려받기가 '파일 없음'으로 답한 주기 · quarantined = 받은 자료를 해석할 수 없어 격리만 한 주기.
 */
export const RUN_STATUS_TITLE: Readonly<Record<string, string>> = {
  missing: "새 tm 이 목록에 있었으나 저장한 프레임 없음 — 기상청 내려받기가 '파일 없음'으로 답함(호출 실패는 아니다 · 공급자 last success 를 갱신하지 않는다)",
  quarantined: "새 tm 을 받았으나 해석할 수 없어 격리 — 저장한 프레임 없음(원본은 raw 에 남는다)",
  // 기상청 429(운영 로그 2026-09-30 — jobs/kma_radar.py) · 수집기 속도 상한(jobs/aircraft.py) — 계약 v5 §G14: 공급자 오류는 'error' 만
  throttled: "속도 상한 — http 429 면 공급자가 거절해 수집기가 그 호스트를 멈췄고(쉰 초 · Retry-After 는 오류 글자), http 가 비었으면 수집기 속도 상한이 막아 보내지 않았다. 공급자 오류가 아니다(공급자 last error 에 적지 않는다)",
};

/**
 * 실행 상태 글자색: ok 초록 · missing · quarantined · throttled 주황(자료가 오지 않았지만 공급자 오류는 아니다) · 그 밖(error · budget_* …)은 전과 같이
 * 요약(summary) 주황 · 최근 실행(item) 빨강.
 */
export function runStatusClass(status: unknown, where: "summary" | "item"): string {
  const s = String(status);
  if (s === "ok") return "text-ok";
  if (s in RUN_STATUS_TITLE) return "text-warn";
  return where === "summary" ? "text-warn" : "text-bad";
}

/**
 * /ops/providers 응답을 만든 서버 시각(generated_at — 시간대가 있는 ISO 만) → ms. 없거나 틀리면 0(모름 — providerMissing 이 '확인 멈춤'을 판정하지 않는다).
 * 공급자 해시의 시각(수집기 missing_checked_at)의 나이를 브라우저 시계가 아니라 서버 기준 지금으로 잰다(계약 v5 §G22 — 브라우저 시계가 15분 넘게
 * 틀려도 상황판 칩과 같은 판정, 통합 리뷰 2026-09-30). 응답은 15 s 마다 새로 받는다 — 그 사이 지난 시간은 더하지 않는다(다음 응답이 다시 잰다).
 */
export function providersNowMs(resp: unknown): number {
  const v = obj(resp).generated_at;
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(v)) return 0;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * 공급자 해시(수집기 wakeline:provider:kma_radar — /ops/providers 가 그대로 싣는다)의 missing_* 문자열 → 기상청 내려받기 '파일 없음' 연속(lib/kr-radar
 * krMissing 과 같은 글자). 빈 값 = 닫힌 연속 · 다른 공급자 → null. 해시 값은 api 가 검증하지 않은 수집기 글자라 여기서 형식을 본다(틀리면 null).
 * nowMs = 서버 기준 지금(providersNowMs — 응답의 generated_at). 모르면 0 을 준다 — '확인 멈춤'을 판정하지 않는다(브라우저 시계로 짐작하지 않는다).
 */
export function providerMissing(p: Record<string, unknown>, nowMs: number): KrMissingInfo | null {
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  if (!str("missing_since_tm")) return null;
  const tms = /^\d{1,6}$/.test(str("missing_tms")) ? Number(str("missing_tms")) : NaN;
  return krMissing({
    since_tm: str("missing_since_tm"), last_tm: str("missing_last_tm"), tms, checked_at: str("missing_checked_at"),
    file: str("missing_file") || null, listed: str("missing_listed") ? str("missing_listed").split(",") : null,
  }, nowMs);
}
