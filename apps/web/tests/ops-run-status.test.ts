/**
 * 운영 RUNS 실행 상태의 뜻(title)과 색(WEB-1 — 조사 2026-10-01): budget_exhausted 는 error 와 똑같이 보였다(요약 주황 · 최근 실행 빨강, 뜻 없음) —
 * 운영자가 예산 · 시간 창의 거절(수집기가 보내지 않음)과 고장을 가를 수 없었다.
 * - budget_exhausted: 제 뜻(공급자 오류 아님 · 수집기가 보내지 않음 · 어느 한도인지는 오류 글자)과 주황(리뷰 2026-10-01 — 처음의 회색은 하루 예산 거절로
 *   층이 다음 09:00 KST 까지 비는 경우를 늘 있는 'unchanged' 보다 조용하게 보였다). '계획된' 이라고 짐작하지 않는다(작업 이름 · 글자로 추론하지 않는다).
 * - incomplete(항만 입출항 색인 — 빈 곳으로 적은 날 · 0건 확인 대기): 수집기가 적는 상태인데 뜻이 없어 최근 실행에서 빨강(고장)으로 보였다.
 * - budget_unavailable: 예산 저장소 장애(fail closed) — 다른 뜻, 고장 색(error 와 같다).
 * - unchanged(연안 교통량 — ADR-023): 호출은 성공했으나 새 자료가 아님 — 전에는 뜻이 없어 최근 실행에서 빨강(고장)으로 보였다.
 * - 모든 뜻 글자는 KST 화면 규칙(UTC 낱말 · …Z 시각 없음 — 원문의 'Z' 는 오류 글자 칸에만).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RUN_STATUS_TITLE, runStatusClass } from "@/lib/ops";
import { utcLeaks } from "./helpers/kst-only";

const src = (p: string) => readFileSync(new URL(`../../collector/wakeline_collector/${p}`, import.meta.url), "utf8");

describe("WEB-1 budget_exhausted: its own meaning, amber — not a provider error", () => {
  const t = RUN_STATUS_TITLE.budget_exhausted;
  it("says the collector did not send the call because a budget, an hour window or a job share refused it", () => {
    expect(t).toBeDefined();
    expect(t).toContain("보내지 않았다");
    expect(t).toContain("하루 예산");
    expect(t).toContain("시간 창");
    expect(t).toContain("작업 몫");
    expect(t).toContain("공급자 오류가 아니다");
    expect(t).toContain("오류 글자");
  });
  it("does not claim the refusal was planned and does not promise a resume time the collector did not write", () => {
    expect(t).not.toMatch(/계획|planned|예정된/);
    // 재개 시각은 수집기가 적은 경우에만(portcalls_index · traffic_grid_geom 의 'resumes at') — 하루 예산 거절 글자에는 없다
    expect(t).toContain("수집기가 적은 경우에만");
    expect(src("jobs/weather.py")).toContain('f"daily budget exhausted (used={used})"');
    expect(src("jobs/traffic_grid.py")).toContain("geometry fill resumes at");
  });
  it("names the windows by their KST boundaries (09:00 KST day, top of the hour) and carries no UTC", () => {
    expect(t).toContain("09:00 KST");
    expect(t).toContain("매 정시");
    expect(utcLeaks(t)).toEqual([]);
  });
  it("is amber in both tables — not calmer than routine 'unchanged' (a day-budget refusal can leave a layer without data until 09:00 KST), not the fault red", () => {
    // 하루 예산 거절은 그 공급자를 다음 UTC 날(09:00 KST)까지 멈출 수 있다 — 수집기 글자
    expect(src("jobs/aircraft.py")).toContain('f"daily budget exhausted (used={used})"');
    expect(src("jobs/kma_radar.py")).toContain('return "budget_exhausted", f"daily budget exhausted (used={used})"');
    for (const where of ["summary", "item"] as const) {
      const c = runStatusClass("budget_exhausted", where);
      expect(c).toBe("text-warn");
      expect(c).toBe(runStatusClass("unchanged", where)); // 전(회색 text-fg-2): 늘 있는 'regDt 가 새롭지 않음' 보다 조용했다
      expect(c).not.toBe(runStatusClass("ok", where));
    }
    expect(runStatusClass("budget_exhausted", "item")).not.toBe(runStatusClass("error", "item")); // 최근 실행: 고장(빨강)과 다르다
  });
});

describe("WEB-1 budget_unavailable: the budget store is down and the collector failed closed — a fault", () => {
  const t = RUN_STATUS_TITLE.budget_unavailable;
  it("has a distinct meaning", () => {
    expect(t).toBeDefined();
    expect(t).not.toBe(RUN_STATUS_TITLE.budget_exhausted);
    expect(t).toContain("예산 저장소");
    expect(t).toContain("fail closed");
    expect(t).toContain("고장");
    expect(utcLeaks(t)).toEqual([]);
    // 수집기 글자와 같은 사실: 'budget store unavailable (fail closed)'
    expect(src("jobs/aircraft.py")).toContain('"budget store unavailable (fail closed)"');
  });
  it("keeps the fault colour — the same as error (summary amber, recent runs red)", () => {
    expect(runStatusClass("budget_unavailable", "summary")).toBe(runStatusClass("error", "summary"));
    expect(runStatusClass("budget_unavailable", "item")).toBe("text-bad");
    expect(runStatusClass("error", "item")).toBe("text-bad");
  });
});

describe("contract v5 run statuses: every non-ok status the collector records has a meaning; unchanged is not painted as a fault", () => {
  it("unchanged (coastal traffic grid, ADR-023): the call succeeded but the provider's regDt was not newer — amber, not red", () => {
    const t = RUN_STATUS_TITLE.unchanged;
    expect(t).toBeDefined();
    expect(t).toContain("regDt");
    expect(t).toContain("새 자료 아님");
    expect(t).toContain("공급자 오류가 아니다");
    expect(runStatusClass("unchanged", "item")).toBe("text-warn"); // 전: 뜻이 없어 text-bad
    expect(runStatusClass("unchanged", "summary")).toBe("text-warn");
    expect(src("jobs/traffic_grid.py")).toMatch(/status="unchanged"/);
    expect(src("jobs/traffic_grid.py")).toContain("await self._success(resp, len(snap.items))"); // 공급자 성공으로 적는다(제목이 그렇게 말한다)
    expect(t).toContain("last success 를 갱신한다");
  });
  it("incomplete (port-call index): the day was written as a hole or a zero answer is being re-checked — amber, not red; the reason is in the error text", () => {
    const t = RUN_STATUS_TITLE.incomplete;
    expect(t).toBeDefined();
    expect(t).toContain("빈 곳");
    expect(t).toContain("0건");
    expect(t).toContain("공급자 오류가 아니다");
    expect(t).toContain("오류 글자");
    expect(utcLeaks(t)).toEqual([]);
    expect(runStatusClass("incomplete", "item")).toBe("text-warn"); // 전: 뜻이 없어 text-bad
    expect(runStatusClass("incomplete", "summary")).toBe("text-warn");
    // 수집기 글자와 같은 사실
    const pc = src("jobs/portcalls_index.py");
    expect(pc).toContain("status ok · error · incomplete(빈 곳으로 적은 날 · 빈 응답 확인 대기)");
    expect(pc).toContain("recorded as not indexed (no 'none' while it lasts); retried by the tail refresh or a revisit");
    expect(pc).toContain('return self._fail_pa(u, started, "incomplete", why, got)');
  });
  it("throttled · waiting · missing · quarantined keep their meanings and amber", () => {
    expect(RUN_STATUS_TITLE.throttled).toContain("429");
    expect(RUN_STATUS_TITLE.waiting).toContain("기상청을 부르지 않음");
    expect(RUN_STATUS_TITLE.missing).toContain("저장한 프레임 없음");
    expect(RUN_STATUS_TITLE.quarantined).toContain("격리");
    for (const s of ["throttled", "waiting", "missing", "quarantined"]) expect(runStatusClass(s, "item"), s).toBe("text-warn");
  });
  it("every status the collector writes into a run record (other than ok · error) has a title, and no title carries UTC", () => {
    const jobs = ["aircraft", "weather", "kma_radar", "traffic_grid", "portcalls_index", "demand"].map((j) => src(`jobs/${j}.py`)).join("\n");
    const written = new Set<string>();
    // status="x" · status="x" if … else "y" · _Stop("x" · _fail_pa(u, started, "x" · _record(u, started, "x" · return "x", <글자>(kma_radar _outcome · _try_reserve)
    for (const m of jobs.matchAll(/status="([a-z_]+)"(?: if [^\n]* else "([a-z_]+)")?/g)) for (const v of [m[1], m[2]]) if (v) written.add(v);
    for (const m of jobs.matchAll(/_Stop\(\s*"([a-z_]+)"/g)) written.add(m[1]);
    for (const m of jobs.matchAll(/self\._(?:fail_pa|record)\(u, started, "([a-z_]+)"/g)) written.add(m[1]);
    // return "x", …  는 기상청 레이더의 실행 상태만 — kma_radar(_try_reserve) · kma_rules(outcome — 1322f6dc 에서 옮겨졌다). traffic_grid 의
    // fill_state()("filling" · "idle" · …)는 heartbeat 값이지 실행 상태가 아니다
    for (const m of [src("jobs/kma_radar.py"), src("kma_rules.py")].join("\n").matchAll(/return "([a-z_]+)", (?:f?"|None)/g)) written.add(m[1]);
    // disabled(_Stop scope "off")는 실행 기록을 남기지 않는다(portcalls_index _stopped 가 먼저 돌아간다)
    expect(src("jobs/portcalls_index.py")).toMatch(/if s\.scope == "off":\s*\n\s*await self\._set_state\(STATE_OPERATOR_OFF, now\)\s*\n\s*return IDLE_S/);
    written.delete("disabled");
    for (const s of ["ok", "error"]) written.delete(s);
    expect([...written].sort()).toEqual(["budget_exhausted", "budget_unavailable", "incomplete", "missing", "quarantined", "throttled", "unchanged", "waiting"]);
    for (const s of written) expect(RUN_STATUS_TITLE[s], s).toBeDefined();
    for (const [s, t] of Object.entries(RUN_STATUS_TITLE)) expect(utcLeaks(t), s).toEqual([]);
  });
});
