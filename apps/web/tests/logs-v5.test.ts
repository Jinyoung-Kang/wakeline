/**
 * 계약 v5 §C7 시스템 로그 화면(/logs)과 §C2 로그 싱크 자기 지표(pipeline 탭). 순수 함수는 직접, 화면은 renderToStaticMarkup · 최소 DOM 마운트.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as opsLib from "@/lib/ops";
import { OpsPipeline } from "@/components/OpsPipeline";

describe("v5-C2 pipeline tab: log sink rows (sent · dropped · suppressed)", () => {
  const resp = {
    collector: { publish_dropped: 0, log_sent: 42, log_dropped: 3, heartbeat_age_s: 2 },
    ais: { dropped_total: 0, log_sent: 7, log_dropped: 0 },
    api: { dlq: 0, log_sent: 120, log_dropped: 0, log_suppressed: 31 },
    generated_at: "2026-09-29T01:00:00Z",
  };
  const rows = opsLib.pipelineRows(resp);
  const by = (g: string, k: string) => rows.find((r) => r.group === g && r.key === k);
  it("dropped log entries are loss rows (red when > 0); sent and suppressed are neutral counts", () => {
    expect(by("collector", "log_dropped")).toMatchObject({ value: 3, tone: "bad", text: "3" });
    expect(by("ais", "log_dropped")).toMatchObject({ value: 0, tone: "ok" });
    expect(by("api", "log_dropped")).toMatchObject({ value: 0, tone: "ok" });
    expect(by("collector", "log_sent")).toMatchObject({ value: 42, tone: "muted" });
    expect(by("ais", "log_sent")).toMatchObject({ value: 7, tone: "muted" });
    expect(by("api", "log_sent")).toMatchObject({ value: 120, tone: "muted", text: "120" });
    expect(by("api", "log_suppressed")).toMatchObject({ value: 31, tone: "muted" }); // 억제는 손실이 아니다(건수는 다음 항목에)
    expect(by("api", "log_suppressed")!.title).toMatch(/suppressed/);
    expect(opsLib.pipelineLossCount(resp)).toBe(1);
  });
  it("an api / heartbeat without the fields (older lane, stale heartbeat → null) shows —, never 0", () => {
    const old = opsLib.pipelineRows({ collector: {}, ais: { log_dropped: null }, api: {} });
    for (const [g, k] of [["collector", "log_sent"], ["collector", "log_dropped"], ["ais", "log_dropped"], ["api", "log_suppressed"]]) {
      expect(old.find((r) => r.group === g && r.key === k)).toMatchObject({ value: null, text: "—", tone: "muted" });
    }
  });
  it("the tab renders the rows with their keys", () => {
    const html = renderToStaticMarkup(createElement(OpsPipeline, { data: resp }));
    expect(html).toMatch(/data-key="log_dropped" data-tone="bad"/);
    expect(html.match(/data-key="log_sent"/g)).toHaveLength(3);
    expect(html).toContain("log_suppressed");
  });
});
