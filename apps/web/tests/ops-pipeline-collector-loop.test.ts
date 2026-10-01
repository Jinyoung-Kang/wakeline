/**
 * /ops PIPELINE 탭의 collector 묶음 — 수집기 heartbeat 의 이벤트 루프 지연(collector-review D0)과 원천 보관 실패(F6), GET /api/v1/ops/pipeline 의 collector.*:
 * - loop_lag_max_s(최근 diag_window_s 초의 최댓값 — 진단, 판정 없음) · loop_stalls_total(지연 ≥ loop_stall_s 표본 수, 누적 — 손실 아님).
 *   ais 루프 행과 같은 말 · 같은 규칙: 표본 간격 · 창 · 멈춤 기준 · WARN 문턱과 간격은 수집기가 고른 값이라 응답에서 읽는다(웹이 숫자를 들고 있지 않다, 모르면 "—").
 *   수집기는 최댓값을 소수 3자리로 싣는다(수십 ms 를 본다 — docs/PERF.md §12) — 그 자릿수 그대로 보인다. keepalive 는 ais 수신 연결의 것이라 collector 행에 없다.
 * - raw_unsaved(원천 보관에 쓰지 못한 응답 본문 — 손실: 그 원본을 다시 볼 수 없다) · raw_purge_failed(지우거나 읽지 못한 파일 · 디렉터리 — 손실 아님, 누계).
 * 모르는 값(null · 없음 · 형식 오류 · heartbeat 오래됨 — api 가 null)은 "—"(0 으로 채우지 않는다).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다(collector 묶음에 이 행들이 없었다).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pipelineLossCount, pipelineRows, type PipelineRow } from "@/lib/ops";
import { OpsPipeline } from "@/components/OpsPipeline";

const LOOP = {
  loop_lag_max_s: 0.021, loop_stalls_total: 2, loop_tick_s: 0.1, diag_window_s: 60, loop_stall_s: 1, loop_warn_s: 5, loop_warn_every_s: 60,
  raw_unsaved: 0, raw_purge_failed: 0,
};
function resp(c: Record<string, unknown> = {}) {
  return {
    collector: { publish_dropped: 0, db_dropped: 0, db_pending: 0, stream_budget_trims: 0, stream_retention_s: 9000, stream_budget_bytes: 80 * 2 ** 20,
      heartbeat_age_s: 3.2, log_sent: 0, log_dropped: 0, ...LOOP, ...c },
    // ais 의 같은 이름 필드는 다른 값 — collector 행이 ais 값을 읽지 않는지 본다
    ais: { loop_lag_max_s: 0.5, loop_stalls_total: 9, loop_tick_s: 0.5, diag_window_s: 30, loop_stall_s: 2, loop_warn_s: 8, loop_warn_every_s: 120, ping_timeout_s: 40 },
    api: {},
    generated_at: "2026-10-01T00:00:00Z",
  };
}
const row = (r: unknown, key: string, group: "collector" | "ais" = "collector"): PipelineRow => {
  const x = pipelineRows(r).find((y) => y.group === group && y.key === key);
  expect(x, `${group}.${key}`).toBeDefined();
  return x!;
};

describe("collector event-loop lag rows (D0)", () => {
  it("the recent maximum is shown in seconds at the collector's precision, with the window from the response — no keepalive (that is the ais connection's)", () => {
    expect(row(resp(), "loop_lag_max_s")).toMatchObject({ value: 0.021, text: "0.021 s", detail: "최근 60 s 최대", tone: "muted", kind: "diag", state: null });
    expect(row(resp({ diag_window_s: 90 }), "loop_lag_max_s").detail).toBe("최근 90 s 최대");
    expect(row(resp(), "loop_lag_max_s").detail).not.toContain("keepalive");
    // ais 행은 그대로(ais 의 창 · keepalive 시간 초과 · 소수 2자리)
    expect(row(resp(), "loop_lag_max_s", "ais")).toMatchObject({ text: "0.50 s", detail: "최근 30 s 최대 · keepalive 시간 초과 40 s — 수집기 설정" });
  });
  it("a large lag is not coloured — a diagnostic, not a loss (no threshold is invented)", () => {
    expect(row(resp({ loop_lag_max_s: 7.25 }), "loop_lag_max_s")).toMatchObject({ text: "7.250 s", tone: "muted" });
    expect(row(resp({ loop_stalls_total: 40 }), "loop_stalls_total")).toMatchObject({ value: 40, text: "40", tone: "muted", kind: "count" });
    expect(pipelineLossCount(resp({ loop_lag_max_s: 7.25, loop_stalls_total: 40 }))).toBe(0);
  });
  it("the explanations use the ais rows' words and the collector's own chosen numbers from the response", () => {
    const lag = row(resp(), "loop_lag_max_s").title;
    expect(lag).toContain("수집기 이벤트 루프가 0.1 s(수집기 고른 값) 잠든 뒤 늦게 깬 만큼");
    expect(lag).toContain("작업 · 타이머 · 스트림 발행");
    expect(lag).not.toContain("1011");
    const stalls = row(resp(), "loop_stalls_total").title;
    expect(stalls).toContain("이벤트 루프가 1 s(수집기 고른 값) 이상 늦게 깬 횟수 — 누적(collector 시작 이후)");
    expect(stalls).toContain("5 s 이상이면 수집기가 WARN 을 남긴다(60 s 에 1번까지 — 수는 모두 센다, 수집기 고른 값)");
    const other = resp({ loop_tick_s: 0.25, loop_stall_s: 2, loop_warn_s: 8, loop_warn_every_s: 120 });
    expect(row(other, "loop_lag_max_s").title).toContain("0.25 s(수집기 고른 값)");
    expect(row(other, "loop_stalls_total").title).toContain("2 s(수집기 고른 값) 이상");
    expect(row(other, "loop_stalls_total").title).toContain("8 s 이상이면");
    expect(row(other, "loop_stalls_total").title).toContain("120 s 에 1번까지");
    // 설명에 숫자를 직접 적지 않는다(자리 표시만) — 회귀 막기. ais 의 값(0.5 · 2 · 8 · 120)도 읽지 않는다
    const seven = resp({ loop_tick_s: 7, loop_stall_s: 7, loop_warn_s: 7, loop_warn_every_s: 7, diag_window_s: 7 });
    for (const k of ["loop_lag_max_s", "loop_stalls_total"]) {
      const r = row(seven, k);
      expect(`${r.title} ${r.detail ?? ""}`, k).not.toMatch(/\b(60|0\.1|0\.5|1|2|5|8|30|120) s\b/);
    }
  });
  it("unknown chosen values are '—' in the explanation and the window", () => {
    const r = resp({ loop_tick_s: null, loop_stall_s: undefined, loop_warn_s: "5", loop_warn_every_s: -1, diag_window_s: null });
    expect(row(r, "loop_lag_max_s").title).toContain("— s(수집기 고른 값) 잠든 뒤");
    expect(row(r, "loop_lag_max_s").detail).toBe("최근 — s 최대");
    expect(row(r, "loop_stalls_total").title).toContain("— s(수집기 고른 값) 이상");
    expect(row(r, "loop_stalls_total").title).toContain("— s 이상이면 수집기가 WARN 을 남긴다(— s 에 1번까지");
  });
});

describe("collector raw-archive failure rows (F6)", () => {
  it("raw_unsaved is a loss: red when > 0, green at 0, and it counts towards the tab's red badge", () => {
    expect(row(resp(), "raw_unsaved")).toMatchObject({ value: 0, text: "0", tone: "ok", kind: "loss" });
    expect(row(resp({ raw_unsaved: 1234 }), "raw_unsaved")).toMatchObject({ value: 1234, text: "1,234", tone: "bad", kind: "loss" });
    expect(pipelineLossCount(resp({ raw_unsaved: 3 }))).toBe(1);
    const t = row(resp(), "raw_unsaved").title;
    expect(t).toContain("원천 보관");
    expect(t).toContain("수집 · 발행은 계속");
    expect(t).toContain("'unsaved:…'");
    expect(t).toContain("가득 찼거나 읽기 전용");
    expect(t).toContain("누적(collector 시작 이후)");
  });
  it("raw_purge_failed is a count, not a loss: never coloured, not in the badge, and it says why", () => {
    expect(row(resp(), "raw_purge_failed")).toMatchObject({ value: 0, text: "0", tone: "muted", kind: "count" });
    expect(row(resp({ raw_purge_failed: 17 }), "raw_purge_failed")).toMatchObject({ value: 17, text: "17", tone: "muted", kind: "count" });
    expect(pipelineLossCount(resp({ raw_purge_failed: 17 }))).toBe(0);
    const t = row(resp(), "raw_purge_failed").title;
    expect(t).toContain("손실 아님");
    expect(t).toContain("누적(collector 시작 이후)");
  });
  it("the WARN spacing named in both explanations is raw_store.py's own WARN_EVERY_S (not in the response — pinned to the source)", () => {
    const py = readFileSync(new URL("../../collector/wakeline_collector/raw_store.py", import.meta.url), "utf8");
    expect(py).toMatch(/^WARN_EVERY_S = 60\.0\b/m);
    for (const k of ["raw_unsaved", "raw_purge_failed"]) expect(row(resp(), k).title, k).toContain("분에 한 번까지");
  });
});

describe("collector rows: unknown is '—', never 0", () => {
  it("null, missing, malformed or negative (api sends null for a stale heartbeat) → '—' and muted", () => {
    for (const k of ["loop_lag_max_s", "loop_stalls_total", "raw_unsaved", "raw_purge_failed"]) {
      for (const bad of [null, undefined, -1, "0.3", Number.NaN]) {
        expect(row(resp({ [k]: bad }), k), `${k}=${String(bad)}`).toMatchObject({ value: null, text: "—", tone: "muted" });
      }
    }
    expect(pipelineLossCount(resp({ raw_unsaved: null }))).toBe(0);
  });
  it("an api that predates these fields (keys absent) shows '—' rows, not zeros", () => {
    const old = { collector: { publish_dropped: 0, heartbeat_age_s: 4 }, ais: {}, api: {} };
    for (const k of ["loop_lag_max_s", "loop_stalls_total", "raw_unsaved", "raw_purge_failed"]) expect(row(old, k).text, k).toBe("—");
  });
});

describe("the pipeline tab renders the collector rows in the collector group", () => {
  it("rows carry their field names; a lost raw body is painted as a loss; the lag and purge failures are not coloured", () => {
    const html = renderToStaticMarkup(createElement(OpsPipeline, { data: resp({ raw_unsaved: 2, raw_purge_failed: 5, loop_lag_max_s: 3.5 }) }));
    const keys = [...html.matchAll(/<tr data-key="([^"]+)" data-tone="([^"]+)"><td>collector\(수집\)<\/td>/g)].map((m) => [m[1], m[2]]);
    expect(keys).toEqual(expect.arrayContaining([["raw_unsaved", "bad"], ["raw_purge_failed", "muted"], ["loop_lag_max_s", "muted"], ["loop_stalls_total", "muted"]]));
    expect(html).toContain("3.500 s");
    // collector 묶음 안의 순서: 손실 · 대기열 · 원천 보관 → 스트림 → 루프 → 로그 → heartbeat 경과
    const order = keys.map(([k]) => k);
    expect(order.indexOf("db_pending")).toBeLessThan(order.indexOf("raw_unsaved"));
    expect(order.indexOf("raw_purge_failed")).toBeLessThan(order.indexOf("stream_budget_trims"));
    expect(order.indexOf("loop_stalls_total")).toBeLessThan(order.indexOf("log_sent"));
    expect(order.at(-1)).toBe("heartbeat_age_s");
  });
});
