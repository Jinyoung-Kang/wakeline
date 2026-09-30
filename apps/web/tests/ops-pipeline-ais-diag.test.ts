/**
 * /ops PIPELINE 탭의 ais 수신 진단(ADR-014 부록 C — keepalive 1011 원인 가리기, GET /api/v1/ops/pipeline 의 ais.*):
 * - 최근 창 최댓값: loop_lag_max_s(이벤트 루프 지연) · queue_wait_max_s(원문 대기열에 머문 시간 — 지금 기다리는 맨 앞 원문 포함) ·
 *   queue_depth_max(원문 대기열 깊이) · ws_queue_max(websockets 수신 버퍼에 남은 프레임) · ping_rtt_max_s(keepalive 왕복).
 * - 누적: loop_stalls_total · reconnects_quick_total(끊겨 열린 공백이 회복 창 안에 닫힌 끊김 — 로그 수준과 상관없이 공백 길이로 센다: 회복 줄은 INFO,
 *   되풀이(창 안 N번째부터) 끊김 줄 · 데이터 없이 끝난 재연결 시도는 WARN 이어도 공백이 창 안에 닫히면 센다 — 리뷰 2026-09-30).
 * - 숫자로 된 수집기 설정(창 · 상한 · 시간 초과 · 회복 창 · 되풀이 WARN 기준 · 루프 틱 · 멈춤 · WARN 문턱)은 모두 응답에서 읽는다 — 웹이 들고 있지 않다.
 *   모르면 "—".
 * - 수신 버퍼가 상한 이상이면(꺼낸 뒤 남은 수라 상한과 같아도 그때 읽기가 멈춰 있었다) 그 사실만 적는다 — 한꺼번에 받은 묶음에서도 생기는 일이라
 *   결함 표시(주황)를 하지 않는다. 그 밖에도 판정하지 않는다(임계값을 지어내지 않는다).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다(상한과 같은 값을 '아직 읽는다' 로 봄 · 주황 · 설명의 숫자 고정 · 깊이 행 없음).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pipelineLossCount, pipelineRows, type PipelineRow } from "@/lib/ops";
import { OpsPipeline } from "@/components/OpsPipeline";

const DIAG = {
  diag_window_s: 60, loop_lag_max_s: 0.03, loop_stalls_total: 0, queue_wait_max_s: 0.25, queue_depth_max: 12, queue_limit: 20000,
  ws_queue_max: 3, ws_queue_limit: 64, ping_rtt_max_s: 0.31, ping_timeout_s: 20, reconnects_quick_total: 2,
  reconnect_quick_window_s: 30, reconnect_warn_count: 3, reconnect_warn_window_s: 1800,
  loop_tick_s: 0.5, loop_stall_s: 1, loop_warn_s: 5, loop_warn_every_s: 60,
};
function resp(a: Record<string, unknown> = {}) {
  return {
    collector: {},
    ais: { dropped_total: 0, quarantined_total: 0, stream_budget_trims: 0, stream_retention_s: 9000, stream_budget_bytes: 16 * 2 ** 20, log_sent: 0, log_dropped: 0, ...DIAG, ...a },
    api: {},
    generated_at: "2026-09-30T00:00:00Z",
  };
}
const row = (r: unknown, key: string): PipelineRow => {
  const x = pipelineRows(r).find((y) => y.group === "ais" && y.key === key);
  expect(x, key).toBeDefined();
  return x!;
};
const BUFFER_STATE = "상한 도달 — 그때 소켓 읽기가 잠시 멈춤(한꺼번에 받은 묶음 또는 루프 멈춤 — 결함 아님, 루프 지연과 함께 본다)";

describe("ais receive diagnostics rows", () => {
  it("recent maxima are shown in seconds / frames / messages with the window and the chosen limits as configuration", () => {
    expect(row(resp(), "loop_lag_max_s")).toMatchObject({ value: 0.03, text: "0.03 s", detail: "최근 60 s 최대 · keepalive 시간 초과 20 s — 수집기 설정", tone: "muted" });
    expect(row(resp(), "queue_wait_max_s")).toMatchObject({ value: 0.25, text: "0.25 s", detail: "최근 60 s 최대(지금 기다리는 원문 포함)", tone: "muted" });
    expect(row(resp(), "queue_depth_max")).toMatchObject({ value: 12, text: "12", detail: "최근 60 s 최대 · 상한 20,000 건 — 수집기 설정", tone: "muted", kind: "diag" });
    expect(row(resp(), "ws_queue_max")).toMatchObject({ value: 3, text: "3", detail: "최근 60 s 최대 · 상한 64 프레임 — 수집기 설정", tone: "muted", state: null });
    expect(row(resp(), "ping_rtt_max_s")).toMatchObject({ value: 0.31, text: "0.31 s", detail: "최근 60 s 최대 · 시간 초과 20 s — 수집기 설정", tone: "muted" });
  });
  it("a receive buffer at or above its limit states that reads were paused — informational, not a defect (bursts do it too)", () => {
    // 꺼낸 뒤 남은 수: 상한과 같으면 꺼내기 전에는 상한 + 1 — websockets 는 '> 상한' 에서 읽기를 멈추므로 이미 멈춰 있었다
    expect(row(resp({ ws_queue_max: 64 }), "ws_queue_max")).toMatchObject({ tone: "muted", state: BUFFER_STATE });
    expect(row(resp({ ws_queue_max: 575 }), "ws_queue_max")).toMatchObject({ text: "575", tone: "muted", state: BUFFER_STATE });
    expect(row(resp({ ws_queue_max: 63 }), "ws_queue_max")).toMatchObject({ tone: "muted", state: null });
    expect(row(resp({ ws_queue_max: 70, ws_queue_limit: null }), "ws_queue_max")).toMatchObject({ tone: "muted", state: null, detail: "최근 60 s 최대 · 상한 — 프레임 — 수집기 설정" });
  });
  it("counts: loop stalls and quick reconnects are cumulative counts, not losses (the gaps are recorded separately)", () => {
    expect(row(resp({ loop_stalls_total: 4 }), "loop_stalls_total")).toMatchObject({ value: 4, text: "4", tone: "muted", kind: "count" });
    const q = row(resp(), "reconnects_quick_total");
    expect(q).toMatchObject({ value: 2, text: "2", tone: "muted", kind: "count" });
    expect(q.title).toContain("AIS 수신 공백");
    expect(q.title).toContain("INFO");
    expect(q.title).toContain("마지막 메시지");
    expect(pipelineLossCount(resp({ reconnects_quick_total: 9, loop_stalls_total: 3, ws_queue_max: 99, queue_depth_max: 20000 }))).toBe(0);
  });
  it("unknown (null, missing, malformed, stale heartbeat) is '—' — never 0; unknown window/limits are '—' in the detail", () => {
    for (const k of ["loop_lag_max_s", "queue_wait_max_s", "queue_depth_max", "ws_queue_max", "ping_rtt_max_s", "loop_stalls_total", "reconnects_quick_total"]) {
      for (const bad of [null, undefined, -1, "0.3", Number.NaN]) expect(row(resp({ [k]: bad }), k), `${k}=${String(bad)}`).toMatchObject({ value: null, text: "—", tone: "muted" });
    }
    expect(row(resp({ diag_window_s: null, ping_timeout_s: null }), "ping_rtt_max_s").detail).toBe("최근 — s 최대 · 시간 초과 — s — 수집기 설정");
    expect(row(resp({ queue_limit: null }), "queue_depth_max").detail).toBe("최근 60 s 최대 · 상한 — 건 — 수집기 설정");
  });
  it("the chosen numbers in the explanations come from the response (labelled as the collector's choice) — none is hard-coded", () => {
    const quick = row(resp(), "reconnects_quick_total").title;
    expect(quick).toContain("30 s(수집기 고른 값)");
    expect(quick).toContain("30분에 3번째부터"); // 수집기는 N번째 '부터' WARN 한다(reconnect.py n >= repeat_warn_count)
    // 되풀이 끊김은 끊김 줄이 WARN 이어도 공백이 창 안에 닫히면 센다 — 'INFO 로만' 이라고 하지 않는다(리뷰 2026-09-30)
    expect(quick).not.toContain("INFO 로만");
    expect(quick).toContain("로그 수준과 상관없이 공백 길이로 센다");
    const quick2 = row(resp({ reconnect_quick_window_s: 45, reconnect_warn_window_s: 3600, reconnect_warn_count: 5 }), "reconnects_quick_total").title;
    expect(quick2).toContain("45 s(수집기 고른 값)");
    expect(quick2).toContain("60분에 5번째부터");
    expect(quick2).not.toContain("30 s");
    const stalls = row(resp({ loop_stall_s: 2, loop_warn_s: 8, loop_warn_every_s: 120 }), "loop_stalls_total").title;
    expect(stalls).toContain("2 s(수집기 고른 값)");
    expect(stalls).toContain("8 s 이상");
    expect(stalls).toContain("120 s 에 1번까지");
    expect(row(resp({ loop_tick_s: 0.25 }), "loop_lag_max_s").title).toContain("0.25 s(수집기 고른 값)");
    const unknown = row(resp({ reconnect_quick_window_s: null, reconnect_warn_count: undefined, reconnect_warn_window_s: "30" }), "reconnects_quick_total").title;
    expect(unknown).toContain("— s(수집기 고른 값)");
    expect(unknown).toContain("—분에 —번째");
    // 설명에 숫자를 직접 적지 않는다(자리 표시만) — 회귀 막기
    for (const k of ["reconnects_quick_total", "loop_stalls_total", "loop_lag_max_s"]) {
      expect(row(resp({ reconnect_quick_window_s: 7, reconnect_warn_window_s: 420, reconnect_warn_count: 9, loop_tick_s: 7, loop_stall_s: 7, loop_warn_s: 7, loop_warn_every_s: 7 }), k).title).not.toMatch(/\b(30|0\.5|5) s|분에 3번째|분당/);
    }
  });
  it("the loop-lag explanation says a stall longer than the timeout can (not always) end in 1011", () => {
    const t = row(resp(), "loop_lag_max_s").title;
    expect(t).toContain("끊길 수 있다");
    expect(t).not.toContain("두 구역이 함께)");
  });
  it("the tab renders the rows with the field names; the buffer fact is not coloured as a warning", () => {
    const html = renderToStaticMarkup(createElement(OpsPipeline, { data: resp({ ws_queue_max: 70 }) }));
    for (const k of ["loop_lag_max_s", "loop_stalls_total", "queue_wait_max_s", "queue_depth_max", "ws_queue_max", "ping_rtt_max_s", "reconnects_quick_total"]) expect(html).toContain(`data-key="${k}"`);
    expect(html).toMatch(/data-key="ws_queue_max" data-tone="muted"/);
    expect(html).toContain("상한 도달 — 그때 소켓 읽기가 잠시 멈춤");
  });
  it("the log_dropped rows name the log sinks' own limits — pinned to logsink.py and LogSink.java so a changed limit fails here (review 2026-09-30)", () => {
    // 이 두 행(수집기 · ais — logsink.py, api — LogSink)의 숫자는 응답에 없어 글자로 적는다. 보내는 쪽 상수와 같은지 여기서 본다(글자만 남아 틀리지 않게)
    const py = readFileSync(new URL("../../collector/wakeline_collector/logsink.py", import.meta.url), "utf8");
    const java = readFileSync(new URL("../../api/src/main/java/dev/wakeline/logs/LogSink.java", import.meta.url), "utf8");
    expect(py).toMatch(/^QUEUE_MAX = 500$/m);
    expect(py).toMatch(/^QUEUE_MAX_BYTES = 2 \* 1024 \* 1024$/m);
    expect(py).toMatch(/^ENTRY_MAX_BYTES = 8 \* 1024$/m);
    expect(java).toMatch(/static final int QUEUE_MAX = 500;/);
    expect(java).toMatch(/static final long QUEUE_MAX_BYTES = 2L \* 1024 \* 1024;/);
    const rows = pipelineRows(resp());
    for (const g of ["collector", "ais"] as const) {
      const t = rows.find((r) => r.group === g && r.key === "log_dropped")!.title;
      expect(t).toContain("대기열 상한(500건 · 2 MiB)");
      expect(t).toContain("8 KiB 에 맞추지 못함");
    }
    expect(rows.find((r) => r.group === "api" && r.key === "log_dropped")!.title).toContain("대기열 상한(500건 · 2 MiB)");
  });
});
