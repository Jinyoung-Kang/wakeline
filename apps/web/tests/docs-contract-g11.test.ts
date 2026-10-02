/**
 * 문서가 이 브랜치의 동작과 어긋나지 않게(리뷰 2026-09-29 — 싼 문서 검사, infra/tests ReadmeFactsTest 와 같은 취지):
 * - 변경 계약 v5 §G11: 상황판 · 재생 · 통계 · 공항도 KST(§G10 의 "UTC 그대로" 와 §B3 의 "시각(UTC)" 는 §G11 이 대신한다고 그 자리에 적는다).
 * - §G12: 운영 PIPELINE 의 스트림 보존 창 필드 계약과 판정 규칙 — 숫자 · 상태 글자는 lib/ops 에서 읽어 문서와 견준다.
 * - README: 시각 기준을 운영 · 로그만이 아니라 모든 화면으로 적는다.
 * - §G13(사용자 요청 2026-09-29 "UTC 와 KST 함께"): KST 를 먼저, UTC 를 함께 — §G11 의 "원본 UTC 는 툴팁" 규칙을 대신했다.
 * - §G20(사용자 결정 2026-09-30 "UTC 지우고 KST"): 화면은 KST 만 — §G13 을 대신한다. 예시 글자는 lib/time 에서 만들어 견준다. README 의 시각 줄도 §G20 을 따른다.
 * - 개정 번호가 겹치지 않는다(§G21 노선 조회 · §G22 기상청 '파일 없음' · §G23 ais 수신 진단 — 세 레인을 합칠 때 나눴다).
 * 수정 전 문서에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pipelineRows, STREAM_WINDOW_SLACK_S } from "@/lib/ops";
import { fmtKst, fmtKstMinute, fmtTimeTitle, kstCell, RAW_BULLETIN_LABEL, utcDayWindowKst } from "@/lib/time";

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
const g20 = amendment(20);

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
    for (const s of ["상황판", "재생", "통계", "공항", "운영", "로그", "한국 표준시(KST", `(${RAW_BULLETIN_LABEL})`, "day_zone"]) expect(line).toContain(s);
  });
});

describe("contract v5 §G13 (KST first with UTC — 2026-09-29) is superseded by §G20 (KST only — 2026-09-30)", () => {
  it("§G13 still exists (history) and says §G20 replaces its dual display", () => {
    expect(g13).not.toBe("");
    expect(g13.split("\n")[0]).toContain("§G20");
  });
  it("§G20 exists, names every screen, the forms as lib/time writes them, the raw exception, the KST-day aggregates and the budget window", () => {
    expect(g20).not.toBe("");
    for (const s of ["상황판", "재생", "통계", "공항", "운영", "로그", "출처", "설명서", "lib/time.ts", "components/KstTime.tsx", "DISPLAY_TZ", "(KST)", "+09:00",
      `(${RAW_BULLETIN_LABEL})`, "data-raw", "day_zone", "budget_day_zone", "V16", "stats_daily_utc_legacy", "quality_rule_count_utc_legacy", "Asia/Seoul", "03:30 KST",
      "@deprecated", "DualTime", "dualPair", "fmtDual", "OTHER_LANE_PENDING"]) expect(g20, s).toContain(s);
    // 합친 뒤(integ): 옮기는 중이던 별칭 · 다른 레인 면제는 지웠다고 적는다(남아 있다고 적지 않는다)
    expect(g20).toMatch(/세 레인을 합친 뒤\(integ\) 호출부를 `KstTime`[^\n]*[^]*별칭 · `components\/DualTime\.tsx` · [^]*를 지웠다/);
    expect(g20).toMatch(/면제[^]*도 지웠다 — 화면 · 소스 검사는 면제 없이 모든 파일에 적용/);
    expect(g20).not.toMatch(/면제는 그 레인이 합쳐지기 전까지만|합친 뒤 호출부를 [^\n]* 옮기고 별칭을 지운다\./);
    const noon = "2026-09-29T05:02:54Z";
    expect(g20).toContain(fmtKst(noon)); // inline
    expect(g20).toContain(fmtKst(noon, { date: false })); // 날짜가 자명한 자리
    expect(g20).toContain(fmtKstMinute(noon)); // 좁은 자리
    expect(g20).toContain(kstCell(noon)!.text); // 표 칸
    expect(g20).toContain(fmtTimeTitle(noon)!); // title
    expect(g20).toContain(utcDayWindowKst("2026-09-28")!); // 공급자 예산 창
    expect(g12).not.toContain("KstTime"); // 절이 섞이지 않았다(추출 확인)
  });
  it("README's time row states the KST-only rule and points to §G20; no dual wording is left", () => {
    const line = readme.split("\n").find((l) => l.startsWith("| 시각 |"))!;
    expect(line).toContain("한국 표준시(KST, +09:00 고정)만");
    expect(line).toContain("§G20");
    expect(line).not.toMatch(/UTC 를 함께|KST · UTC|원본 UTC/);
    expect(readme).not.toMatch(/KST · UTC|KST\+UTC/);
  });
});

describe("contract v5 amendment numbers are unique", () => {
  /** 리뷰(2026-09-30): 병행 레인(백엔드 — 1fe80e4)이 11차 개정으로 §G18 · §G19(정적 정보의 받은 필드)를 먼저 썼다. 이 레인의 KST 전용 규칙은 §G20 이다 — 수정 전 §G19 로 겹쳤다. */
  it("each '- Gn' item appears once, and the KST-only rule is §G20", () => {
    const nums = [...contract.matchAll(/^- G(\d+)\b/gm)].map((m) => Number(m[1]));
    expect(nums.length).toBeGreaterThan(10);
    expect(nums.filter((n, i) => nums.indexOf(n) !== i)).toEqual([]);
    expect(amendment(20)).toContain("화면의 시각은 한국 표준시(KST)만");
    expect(amendment(19)).not.toContain("화면의 시각은 한국 표준시(KST)만");
  });
  /**
   * 통합(integ 2026-09-30): 세 레인(노선 조회 · 기상청 '파일 없음' · ais 수신 진단)이 모두 13차 · §G21 로 썼다 — 합치며 13차 §G21 · 14차 §G22 · 15차 §G23 으로
   * 나눴다. 수정 전(세 절 모두 G21)에는 위 시험과 이 시험이 실패했다.
   */
  it("each 'N차 개정' heading appears once, and §G21–§G23 are the route, KMA and AIS amendments in that order", () => {
    const rounds = [...contract.matchAll(/^## G\. (\d+)차 /gm)].map((m) => Number(m[1]));
    expect(rounds.filter((n, i) => rounds.indexOf(n) !== i)).toEqual([]);
    const heading = (n: number) => contract.slice(0, contract.search(new RegExp(`^- G${n}\\b`, "m"))).split("\n").filter((l) => l.startsWith("## ")).pop() ?? "";
    expect(heading(21)).toMatch(/^## G\. 13차 개정\(2026-09-30 · 레인 route /);
    expect(amendment(21)).toContain("선택 항공기 노선의 Redis 읽기는 세션 우편함 밖에서");
    expect(heading(22)).toMatch(/^## G\. 14차 개정\(2026-09-30 · 레인 kma /);
    expect(amendment(22)).toContain("기상청 내려받기 '파일 없음' 연속");
    expect(heading(23)).toMatch(/^## G\. 15차 개정\(2026-09-30 · 레인 ais /);
    expect(amendment(23)).toContain("ais 수신 진단");
    expect(amendment(23)).toContain("keepalive 시간 초과 20 → 40 s"); // 같은 절의 개정(2026-09-30 오후 · 레인 collector) — 새 번호를 쓰지 않았다
    // 레인 collector(2026-09-30 오후): 기상청 429 · 관심 지역 '공급자 없음' — 16차 · §G24
    expect(heading(24)).toMatch(/^## G\. 16차 개정\(2026-09-30 오후 · 레인 collector /);
    expect(amendment(24)).toContain("관심 지역 '공급자 없음'은 이름 붙인 상태");
    // 레인 collector(2026-09-30 저녁): 관심 지역 순서 adsb.fi → adsb.lol — 17차 · §G25
    expect(heading(25)).toMatch(/^## G\. 17차 개정\(2026-09-30 저녁 · 레인 collector /);
    expect(amendment(25)).toContain("관심 지역 기본 순서 adsb.fi → adsb.lol");
    expect(heading(26)).toMatch(/^## G\. 17차 개정\(2026-09-30 저녁 · 레인 collector /); // 같은 개정의 두 번째 항목
    expect(amendment(26)).toContain("기상청 '파일 없음' 긴 연속은 15분마다 확인");
    // 레인 coverage(2026-09-30 저녁): 관측 수신 범위 — 18차 · §G27. 레인에서는 처음 §G26 으로 적어 collector 레인의 §G26 과 겹쳤다(리뷰 2026-09-30) —
    // 통합(integ 2026-09-30)에서 17차 §G25 · §G26 뒤에 18차 §G27 로 합쳤다.
    expect(heading(27)).toMatch(/^## G\. 18차 개정\(2026-09-30 저녁 · 레인 coverage /);
    expect(amendment(27)).toContain("관측 수신 범위 계약");
    expect(amendment(26)).not.toContain("관측 수신 범위");
    // 레인 bbox(2026-10-01): 격자 기하는 bbox 타일 먼저(ADR-023 개정) — 19차 · §G28
    expect(heading(28)).toMatch(/^## G\. 19차 개정\(2026-10-01 · 레인 bbox /);
    expect(amendment(28)).toContain("격자 기하는 bbox 타일 먼저");
    // 레인 web(CTO 리뷰 cto-2026-10, 2026-10-01): 수집기 루프 지연 · 원천 보관 실패를 /ops/pipeline 에(§G29), /ops/providers 의 error(§G30) — 20차
    expect(heading(29)).toMatch(/^## G\. 20차 개정\(2026-10-01 · CTO 리뷰 cto-2026-10 · 레인 web /);
    expect(amendment(29)).toContain("수집기 이벤트 루프 지연 · 원천 보관 실패를 `/ops/pipeline` 의 collector 묶음에");
    expect(heading(30)).toMatch(/^## G\. 20차 개정\(/); // 같은 개정의 두 번째 항목
    expect(amendment(30)).toContain("자동 전환 기록을 읽지 못함");
    // CTO 리뷰 cto-2026-10 최종 검토(2026-10-01): /ops/dlq 의 error(전부터 api 가 싣던 것 — 계약에 없었다) — 21차 · §G31
    expect(heading(31)).toMatch(/^## G\. 21차 개정\(2026-10-01 · CTO 리뷰 cto-2026-10 최종 검토 · 레인 web /);
    expect(amendment(31)).toContain("`GET /api/v1/ops/dlq` 의 `error` — DLQ 를 읽지 못함");
    expect(amendment(31)).toContain("스키마 검증 실패 메시지(DLQ)를 읽지 못함");
    // QA 2026-10 고치기(2026-10-02 · 레인 api): 시각 · 날짜 파라미터의 범위 — 22차 · §G32
    expect(heading(32)).toMatch(/^## G\. 22차 개정\(2026-10-02 · QA 2026-10 고치기 · 레인 api /);
    expect(amendment(32)).toContain("시각 · 날짜 파라미터의 범위 — 밖이면 400");
    // QA 2026-10 고치기: 항공기 검색 실시간 항목의 등록번호 — 같은 22차 · §G33
    expect(heading(33)).toMatch(/^## G\. 22차 개정\(/);
    expect(amendment(33)).toContain("`GET /api/v1/aircraft/search` 의 실시간 항목에 `registration` · `type_code`");
    // QA 2026-10 고치기: 운영 실행 목록 필터의 제어 문자 — 같은 22차 · §G34
    expect(heading(34)).toMatch(/^## G\. 22차 개정\(/);
    expect(amendment(34)).toContain("`GET /api/v1/ops/runs` 의 `job` · `provider` · `status` 에 제어 문자가 있으면 400 `BAD_FILTER`");
    // QA 2026-10 고치기: WS 클라이언트 메시지 상한은 UTF-8 바이트 — 같은 22차 · §G35
    expect(heading(35)).toMatch(/^## G\. 22차 개정\(/);
    expect(amendment(35)).toContain("WS 클라이언트 메시지 상한 4 KB = UTF-8 4,096 바이트");
    // QA 2026-10 성능 고치기(2026-10-02 · 레인 perf): 알림 이력의 순서 · 커서(QA-401) — 23차 · §G36
    expect(heading(36)).toMatch(/^## G\. 23차 개정\(2026-10-02 · QA 2026-10 성능 고치기 · 레인 perf /);
    expect(amendment(36)).toContain("`GET /api/v1/alerts/history` 의 순서는 `entered_at` 최신순 · 같은 시각은 `id` 역순");
    expect(amendment(36)).toContain("없는 id 의 `cursor`");
    expect(amendment(37)).toBe("");
  });
});
