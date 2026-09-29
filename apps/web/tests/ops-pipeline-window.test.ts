/**
 * /ops PIPELINE 탭의 스트림 보존 창(공유 필드 계약 — collector · ais 상태 해시의 stream_retention_s · stream_budget_bytes,
 * GET /api/v1/ops/pipeline 의 collector/ais.stream_retention_s · stream_budget_bytes 와 api.stream_window_s.{aircraft,ships}).
 * - 예산 트림(stream_budget_trims)은 손실이 아니다: 스트림에 남는 구간(api 가 멈췄다 돌아와 다시 읽을 수 있는 창)이 짧아질 뿐이고,
 *   읽기 전에 잘린 경우만 api 의 stream_trim_loss_events 가 센다. 빨간 손실 배지는 진짜 손실 지표만 센다.
 * - 보존 창 행: 창(지금 − 첫 항목 시각) vs 목표(수집기 설정). 예산 트림 > 0 이고 창 < 목표 − 10분 → warn "예산 때문에 짧아짐",
 *   트림 0 이고 창 < 목표 → muted "채우는 중", 그 밖 ok. 모르면 "—"(단위 없이).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pipelineLossCount, pipelineRows, STREAM_WINDOW_SLACK_S, type PipelineRow } from "@/lib/ops";
import { OpsPipeline } from "@/components/OpsPipeline";

const H = 3600;
/** 계약 모양의 응답. c = collector, a = ais, w = api.stream_window_s */
function resp(o: { c?: Record<string, unknown>; a?: Record<string, unknown>; w?: unknown; api?: Record<string, unknown> } = {}) {
  return {
    collector: { publish_dropped: 0, db_dropped: 0, db_pending: 0, stream_budget_trims: 0, stream_retention_s: 9000, stream_budget_bytes: 80 * 2 ** 20, heartbeat_age_s: 3, log_sent: 0, log_dropped: 0, ...o.c },
    ais: { dropped_total: 0, quarantined_total: 0, stream_budget_trims: 0, stream_retention_s: 9000, stream_budget_bytes: 16 * 2 ** 20, log_sent: 0, log_dropped: 0, ...o.a },
    api: { track_queue_dropped: 0, ship_queue_dropped: 0, receipts_force_released: 0, dlq: 0, stream_trim_loss_events: 0, last_stream_trim_loss: null, track_rows_failed: 0, ship_rows_failed: 0,
      stream_apply_errors: 0, listener_errors: 0, log_sent: 0, log_dropped: 0, log_suppressed: 0, stream_window_s: o.w === undefined ? { aircraft: 9000, ships: 9000 } : o.w, ...o.api },
    generated_at: "2026-09-29T01:00:00Z",
  };
}
const row = (r: unknown, key: string): PipelineRow => {
  const x = pipelineRows(r).find((y) => y.key === key);
  expect(x, key).toBeDefined();
  return x!;
};
const AC = "stream_window_s.aircraft", SH = "stream_window_s.ships";

describe("stream retention window rows (aircraft · ships)", () => {
  it("budget trims > 0 and the window more than 10 min short of the target → warn, 'shortened by the budget'", () => {
    const r = row(resp({ c: { stream_budget_trims: 5 }, w: { aircraft: 1.7 * H, ships: 9000 } }), AC);
    expect(r).toMatchObject({ group: "collector", label: "항공기 스트림 보존 창", value: 1.7 * H, text: "1.7 h", detail: "목표 2.5 h — 수집기 설정", state: "예산 때문에 짧아짐", tone: "warn" });
    expect(STREAM_WINDOW_SLACK_S).toBe(600);
    // 경계: 목표 − 10분 − 1 s 는 warn, 목표 − 10분 은 ok(짧아짐이 10분 안)
    expect(row(resp({ c: { stream_budget_trims: 1 }, w: { aircraft: 9000 - 601, ships: 9000 } }), AC).tone).toBe("warn");
    expect(row(resp({ c: { stream_budget_trims: 1 }, w: { aircraft: 9000 - 600, ships: 9000 } }), AC)).toMatchObject({ tone: "ok", state: null });
  });
  it("no budget trims and the window still below the target → muted 'filling'", () => {
    const r = row(resp({ w: { aircraft: 1800, ships: 9000 } }), AC);
    expect(r).toMatchObject({ text: "30 min", detail: "목표 2.5 h — 수집기 설정", state: "채우는 중", tone: "muted" });
  });
  it("window at or above the target → ok (with or without trims)", () => {
    expect(row(resp({ w: { aircraft: 9030, ships: 9000 } }), AC)).toMatchObject({ text: "2.5 h", tone: "ok", state: null });
    expect(row(resp({ c: { stream_budget_trims: 9 }, w: { aircraft: 9000, ships: 9000 } }), AC)).toMatchObject({ tone: "ok", state: null });
  });
  it("ships use the ais hash's target, budget and trims", () => {
    const r = row(resp({ a: { stream_budget_trims: 2, stream_retention_s: 7200 }, w: { aircraft: 9000, ships: 3600 } }), SH);
    expect(r).toMatchObject({ group: "ais", label: "선박 스트림 보존 창", text: "1.0 h", detail: "목표 2.0 h — 수집기 설정", state: "예산 때문에 짧아짐", tone: "warn" });
    expect(r.title).toContain("16 MiB");
    // 선박 쪽이 짧아도 항공기 행은 제 값으로
    expect(row(resp({ a: { stream_budget_trims: 2, stream_retention_s: 7200 }, w: { aircraft: 9000, ships: 3600 } }), AC).tone).toBe("ok");
  });
  it("unknown window (missing, null, negative, not a number, api without the field) → '—' alone, muted, no state; the target is still shown", () => {
    for (const w of [null, { aircraft: null, ships: null }, { aircraft: -5, ships: "1" }, { aircraft: "6120", ships: Number.NaN }, {}]) {
      const r = row(resp({ c: { stream_budget_trims: 5 }, w }), AC);
      expect(r, JSON.stringify(w)).toMatchObject({ value: null, text: "—", tone: "muted", state: null, detail: "목표 2.5 h — 수집기 설정" });
    }
    const old = resp();
    delete (old.api as Record<string, unknown>).stream_window_s;
    expect(row(old, SH)).toMatchObject({ text: "—", tone: "muted" });
  });
  it("unknown target → the window is shown, the target is '—', muted (no judgement)", () => {
    const r = row(resp({ c: { stream_retention_s: null, stream_budget_trims: 5 }, w: { aircraft: 1.7 * H, ships: 9000 } }), AC);
    expect(r).toMatchObject({ text: "1.7 h", detail: "목표 —", tone: "muted", state: null });
  });
  it("unknown trims → below the target the cause is not guessed; at the target it is ok", () => {
    expect(row(resp({ c: { stream_budget_trims: null }, w: { aircraft: 1.7 * H, ships: 9000 } }), AC)).toMatchObject({ tone: "muted", state: "원인 모름(예산 트림 수 모름)" });
    expect(row(resp({ c: { stream_budget_trims: null }, w: { aircraft: 9000, ships: 9000 } }), AC)).toMatchObject({ tone: "ok", state: null });
  });
  it("the meaning column names the sources and the budget as configuration choices; unknown budget is '—'", () => {
    const r = row(resp({ c: { stream_budget_trims: 5 }, w: { aircraft: 1.7 * H, ships: 9000 } }), AC);
    expect(r.title).toContain("XINFO STREAM");
    expect(r.title).toContain("80 MiB(수집기 설정 stream_budget_bytes)");
    expect(r.title).toContain("손실 아님");
    expect(row(resp({ c: { stream_budget_bytes: null } }), AC).title).toContain("바이트 예산 —(");
  });
});

describe("budget trims are not losses; the red badge counts only real loss counters", () => {
  it("trims rows are counts (muted even when > 0) and say what they cost", () => {
    const rs = pipelineRows(resp({ c: { stream_budget_trims: 5 }, a: { stream_budget_trims: 2 } }));
    for (const g of ["collector", "ais"] as const) {
      const t = rs.find((x) => x.group === g && x.key === "stream_budget_trims")!;
      expect(t.tone).toBe("muted");
      expect(t.title).toContain("손실 아님");
      expect(t.title).toContain("stream_trim_loss_events");
    }
  });
  it("badge: 0 with only trims and a shortened window; counts dlq / trim-loss events", () => {
    expect(pipelineLossCount(resp({ c: { stream_budget_trims: 5 }, a: { stream_budget_trims: 2 }, w: { aircraft: 1800, ships: 600 } }))).toBe(0);
    expect(pipelineLossCount(resp({ c: { stream_budget_trims: 5 }, api: { dlq: 1, stream_trim_loss_events: 3 } }))).toBe(2);
    expect(pipelineLossCount(null)).toBeNull();
  });
});

describe("PIPELINE tab rendering", () => {
  const html = (r: unknown) => renderToStaticMarkup(createElement(OpsPipeline, { data: r }));
  const tr = (h: string, key: string) => new RegExp(`<tr[^>]*data-key="${key.replace(".", "\\.")}"[^>]*>.*?</tr>`).exec(h)?.[0] ?? "";
  const text = (h: string) => h.replace(/<[^>]+>/g, "");
  it("warn row: amber value with target and the reason in words", () => {
    const h = html(resp({ c: { stream_budget_trims: 5 }, w: { aircraft: 1.7 * H, ships: 1800 } }));
    const ac = tr(h, AC);
    expect(ac).toContain('data-tone="warn"');
    expect(ac).toMatch(/class="[^"]*text-warn/);
    expect(text(ac)).toContain("1.7 h · 목표 2.5 h — 수집기 설정 · 예산 때문에 짧아짐");
    const sh = tr(h, SH);
    expect(sh).toContain('data-tone="muted"');
    expect(text(sh)).toContain("30 min · 목표 2.5 h — 수집기 설정 · 채우는 중");
    // 설명 줄이 주황 = 손실 아님을 말한다
    expect(text(h)).toContain("주황 = 예산 때문에 짧아진 스트림 보존 창(손실 아님)");
  });
  it("unknown window: '—' without a unit", () => {
    const h = html(resp({ w: null }));
    const cell = /<td class="mono[^"]*"[^>]*>(.*?)<\/td>/.exec(tr(h, AC))![1];
    expect(text(cell)).toBe("— · 목표 2.5 h — 수집기 설정");
    expect(text(tr(h, AC))).not.toMatch(/— (h|min)\b/);
  });
});
