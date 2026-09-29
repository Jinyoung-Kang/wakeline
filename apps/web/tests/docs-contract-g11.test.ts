/**
 * 문서가 이 브랜치의 동작과 어긋나지 않게(리뷰 2026-09-29 — 싼 문서 검사, infra/tests ReadmeFactsTest 와 같은 취지):
 * - 변경 계약 v5 §G11: 상황판 · 재생 · 통계 · 공항도 KST(§G10 의 "UTC 그대로" 와 §B3 의 "시각(UTC)" 는 §G11 이 대신한다고 그 자리에 적는다).
 * - §G12: 운영 PIPELINE 의 스트림 보존 창 필드 계약과 판정 규칙 — 숫자 · 상태 글자는 lib/ops 에서 읽어 문서와 견준다.
 * - README: 시각 기준을 운영 · 로그만이 아니라 모든 화면으로 적는다.
 * - §G13(사용자 요청 2026-09-29 "UTC 와 KST 함께"): KST 를 먼저, UTC 를 함께 — §G11 의 "원본 UTC 는 툴팁" 규칙을 대신한다. 예시 글자는 lib/time 에서 만들어 견준다.
 * 수정 전 문서에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pipelineRows, STREAM_WINDOW_SLACK_S } from "@/lib/ops";
import { fmtDual, fmtDualCompact, dualCell, fmtUtcDayDual, utcDayHours } from "@/lib/time";

const repo = new URL("../../../", import.meta.url);
const contract = readFileSync(new URL("docs/audit/change-contract-v5.md", repo), "utf8");
const readme = readFileSync(new URL("README.md", repo), "utf8");
/** 개정 한 절의 본문: "- Gn" 줄부터 다음 "- G…" 항목 · "## " 머리 또는 파일 끝까지. 없으면 "" */
function amendment(n: number): string {
  const i = contract.search(new RegExp(`^- G${n}\\b`, "m"));
  if (i < 0) return "";
  const rest = contract.slice(i);
  const j = rest.slice(1).search(/^(- G\d|## )/m);
  return j < 0 ? rest : rest.slice(0, j + 1);
}
const g11 = amendment(11);
const g12 = amendment(12);
const g13 = amendment(13);

describe("contract v5 §G11 records the dashboard time basis", () => {
  it("§G11 exists and names every aviation screen as KST, with the parts that stay UTC", () => {
    expect(g11).not.toBe("");
    for (const s of ["상황판", "재생", "통계", "공항", "KST"]) expect(g11).toContain(s);
    expect(g11).toContain("(원문 · UTC)"); // 원문 이름표
    expect(g11).toContain("(UTC 날짜)"); // 통계 날짜
    expect(g11).toContain("`at`"); // 재생 요청은 UTC 순간
    expect(g11).toContain("선원 입력"); // 선박 ETA
  });
  it("the §G10 sentence that kept those screens in UTC and the §B3 'time (UTC)' both point to §G11", () => {
    const g10Line = contract.split("\n").find((l) => l.includes("항공 자료 화면(상황판 · 재생 · 통계 · 공항)"));
    expect(g10Line).toBeDefined();
    expect(g10Line).toContain("§G11");
    const b3Line = contract.split("\n").find((l) => l.includes("항적 점에 마우스를 올리면 시각"));
    expect(b3Line).toBeDefined();
    expect(b3Line).toContain("§G11");
  });
});

describe("contract v5 §G12 records the stream retention window field contract as the web reads it", () => {
  it("names every field and the slack from lib/ops", () => {
    expect(g12).not.toBe("");
    for (const f of ["stream_retention_s", "stream_budget_bytes", "stream_budget_trims", "stream_window_s.aircraft", "stream_window_s.ships", "stream_trim_loss_events"]) expect(g12).toContain(f);
    expect(g12).toContain(`${STREAM_WINDOW_SLACK_S / 60}분`);
    expect(g11).not.toContain("stream_window_s"); // 두 절이 섞이지 않았다(추출 확인)
  });
  it("names every state text the PIPELINE rows can show", () => {
    const base = { collector: { stream_retention_s: 9000, stream_budget_bytes: 83886080 }, ais: { stream_retention_s: 9000, stream_budget_bytes: 33554432 } };
    const states = new Set<string>();
    for (const [trims, win] of [[5, 3600], [0, 3600], [null, 3600]] as const) {
      const rows = pipelineRows({ collector: { ...base.collector, stream_budget_trims: trims }, ais: base.ais, api: { stream_window_s: { aircraft: win, ships: null } } });
      const r = rows.find((x) => x.key === "stream_window_s.aircraft")!;
      if (r.state) states.add(r.state);
    }
    expect([...states].sort()).toEqual(["예산 때문에 짧아짐", "원인 모름(예산 트림 수 모름)", "채우는 중"].sort());
    for (const s of states) expect(g12).toContain(s);
  });
});

describe("README states the time basis for every screen", () => {
  it("not only the ops and logs screens", () => {
    expect(readme).not.toContain("운영 · 로그 화면의 시각은 한국 표준시");
    const line = readme.split("\n").find((l) => l.startsWith("| 시각 |"));
    expect(line).toBeDefined();
    for (const s of ["상황판", "재생", "통계", "공항", "운영", "로그", "한국 표준시(KST", "(원문 · UTC)", "(UTC 날짜)"]) expect(line).toContain(s);
  });
});

describe("contract v5 §G13 records KST first with UTC on every screen (user request 2026-09-29)", () => {
  it("§G13 exists, names every screen, the variants as lib/time writes them and the parts that stay as they are", () => {
    expect(g13).not.toBe("");
    for (const s of ["상황판", "재생", "통계", "공항", "운영", "로그", "lib/time.ts", "components/DualTime.tsx", "(KST · UTC)", "(UTC 날짜)", "(원문 · UTC)", "+09:00"]) expect(g13).toContain(s);
    const noon = "2026-09-29T05:02:54Z", late = "2026-09-28T23:41:14Z";
    expect(g13).toContain(fmtDual(noon)); // inline
    expect(g13).toContain(fmtDualCompact(noon)); // compact
    expect(g13).toContain(fmtDual(late, { date: false })); // UTC 날짜가 다르면 UTC 쪽에 날짜
    const c = dualCell(noon)!;
    expect(g13).toContain(c.kst);
    expect(g13).toContain(c.utc);
    expect(g12).not.toContain("DualTime"); // 절이 섞이지 않았다(추출 확인)
    // 통계 시간대별 막대: 눈금 두 줄(KST 시 · UTC 시)과 설명 줄 — lib/time 이 만드는 글자 그대로
    const h0 = utcDayHours("2026-09-28")[0];
    for (const s of [`\`${h0.kst}\``, `\`${h0.utcTick}\``, h0.full, fmtUtcDayDual("2026-09-28")!]) expect(g13).toContain(s);
  });
  it("§G11's tooltip-only UTC sentence points to §G13", () => {
    const line = contract.split("\n").find((l) => l.includes("원본 UTC: 카드 · 표 · 목록 · 상태 바의 KST 시각은"));
    expect(line).toBeDefined();
    expect(line).toContain("§G13");
  });
  it("README's time row states the dual rule", () => {
    const line = readme.split("\n").find((l) => l.startsWith("| 시각 |"))!;
    expect(line).toMatch(/한국 표준시\(KST[^)]*\)를 먼저, 같은 순간의 UTC 를 함께/);
    expect(line).toContain("§G13");
    expect(line).not.toContain("KST 만)");
  });
});
