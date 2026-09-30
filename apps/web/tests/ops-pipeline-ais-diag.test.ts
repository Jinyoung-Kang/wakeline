/**
 * /ops PIPELINE 탭의 ais 수신 진단(ADR-014 부록 C — keepalive 1011 원인 가리기, GET /api/v1/ops/pipeline 의 ais.*):
 * - 최근 창 최댓값: loop_lag_max_s(이벤트 루프 지연) · queue_wait_max_s(원문 대기열에 머문 시간) · ws_queue_max(websockets 수신 버퍼에 남은 프레임) ·
 *   ping_rtt_max_s(keepalive 왕복). 창(diag_window_s) · 상한(ws_queue_limit) · 시간 초과(ping_timeout_s)는 수집기가 고른 값 — 응답에서 읽어 "수집기 설정" 으로 적는다.
 * - 누적: loop_stalls_total(루프 지연 ≥ 1 s) · reconnects_quick_total(30 s 안에 다시 받은 끊김 — 수집기는 INFO 로만 남기므로 여기서 센다).
 * - 수신 버퍼가 상한을 넘으면(소켓 읽기 멈춤 — 사실) 주황. 그 밖에는 판정하지 않는다(임계값을 지어내지 않는다). 모르면 "—".
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다(행이 없었다).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pipelineLossCount, pipelineRows, type PipelineRow } from "@/lib/ops";
import { OpsPipeline } from "@/components/OpsPipeline";

const DIAG = {
  diag_window_s: 60, loop_lag_max_s: 0.03, loop_stalls_total: 0, queue_wait_max_s: 0.25, ws_queue_max: 3, ws_queue_limit: 64,
  ping_rtt_max_s: 0.31, ping_timeout_s: 20, reconnects_quick_total: 2,
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

describe("ais receive diagnostics rows", () => {
  it("recent maxima are shown in seconds / frames with the window and the chosen limits as configuration", () => {
    expect(row(resp(), "loop_lag_max_s")).toMatchObject({ value: 0.03, text: "0.03 s", detail: "최근 60 s 최대 · keepalive 시간 초과 20 s — 수집기 설정", tone: "muted" });
    expect(row(resp(), "queue_wait_max_s")).toMatchObject({ value: 0.25, text: "0.25 s", detail: "최근 60 s 최대", tone: "muted" });
    expect(row(resp(), "ws_queue_max")).toMatchObject({ value: 3, text: "3", detail: "최근 60 s 최대 · 상한 64 프레임 — 수집기 설정", tone: "muted", state: null });
    expect(row(resp(), "ping_rtt_max_s")).toMatchObject({ value: 0.31, text: "0.31 s", detail: "최근 60 s 최대 · 시간 초과 20 s — 수집기 설정", tone: "muted" });
  });
  it("a receive buffer above its limit means socket reads were paused — warn with that fact", () => {
    expect(row(resp({ ws_queue_max: 70 }), "ws_queue_max")).toMatchObject({ text: "70", tone: "warn", state: "상한 넘음 — 소켓 읽기 멈춤" });
    expect(row(resp({ ws_queue_max: 64 }), "ws_queue_max")).toMatchObject({ tone: "muted", state: null }); // 상한과 같으면 아직 읽는다(> 상한일 때 멈춤)
    expect(row(resp({ ws_queue_max: 70, ws_queue_limit: null }), "ws_queue_max")).toMatchObject({ tone: "muted", state: null, detail: "최근 60 s 최대 · 상한 — 프레임 — 수집기 설정" });
  });
  it("counts: loop stalls and quick reconnects are cumulative counts, not losses (the gaps are recorded separately)", () => {
    expect(row(resp({ loop_stalls_total: 4 }), "loop_stalls_total")).toMatchObject({ value: 4, text: "4", tone: "muted", kind: "count" });
    const q = row(resp(), "reconnects_quick_total");
    expect(q).toMatchObject({ value: 2, text: "2", tone: "muted", kind: "count" });
    expect(q.title).toContain("AIS 수신 공백");
    expect(q.title).toContain("INFO");
    expect(pipelineLossCount(resp({ reconnects_quick_total: 9, loop_stalls_total: 3, ws_queue_max: 99 }))).toBe(0);
  });
  it("unknown (null, missing, malformed, stale heartbeat) is '—' — never 0; unknown window/limits are '—' in the detail", () => {
    for (const k of ["loop_lag_max_s", "queue_wait_max_s", "ws_queue_max", "ping_rtt_max_s", "loop_stalls_total", "reconnects_quick_total"]) {
      for (const bad of [null, undefined, -1, "0.3", Number.NaN]) expect(row(resp({ [k]: bad }), k), `${k}=${String(bad)}`).toMatchObject({ value: null, text: "—", tone: "muted" });
    }
    expect(row(resp({ diag_window_s: null, ping_timeout_s: null }), "ping_rtt_max_s").detail).toBe("최근 — s 최대 · 시간 초과 — s — 수집기 설정");
  });
  it("the tab renders the rows with the field names, and the chosen numbers are labelled as configuration in the meaning column", () => {
    const html = renderToStaticMarkup(createElement(OpsPipeline, { data: resp({ ws_queue_max: 70 }) }));
    for (const k of ["loop_lag_max_s", "loop_stalls_total", "queue_wait_max_s", "ws_queue_max", "ping_rtt_max_s", "reconnects_quick_total"]) expect(html).toContain(`data-key="${k}"`);
    expect(html).toMatch(/data-key="ws_queue_max" data-tone="warn"/);
    expect(row(resp(), "loop_stalls_total").title).toContain("1 s(수집기 고른 값)");
    expect(row(resp(), "reconnects_quick_total").title).toContain("30 s(수집기 고른 값)");
  });
});
