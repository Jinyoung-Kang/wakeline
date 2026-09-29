/**
 * 화면 시각은 KST 만(계약 v5 §G20 — 사용자 결정 2026-09-30 "[상황판·재생·통계·공항 화면]을 포함한 필요한(해당되는) 메뉴에 시각을 UTC 지우고, KST 표시"):
 * 모든 경로가 "원문 밖에 UTC 가 없다" 검사(tests/helpers/kst-only)에 들어 있는지 — 새 화면이 생기면 여기 목록에 없어서 실패한다.
 * 원문(METAR · TAF · SIGMET 발표문 · 서버 로그 메시지 본문 · 수집기 원본 레코드)은 글자 그대로 두고 data-raw 로 표시한다 — 그 밖에서만 찾는다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다(두 시간대 표시 · "(원문 · UTC)" · "원본 UTC" 툴팁).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { htmlUtcLeaks, utcLeaks } from "./helpers/kst-only";
import { parseHtml } from "./helpers/html-tree";
import { LogDetail } from "@/components/logs/LogDetail";
import { parseLogPage } from "@/lib/logs";

const WEB = new URL("..", import.meta.url).pathname;

/** 경로(파일) → 그 화면을 그려 UTC 흔적을 찾는 시험 파일 */
const SCREENS: Record<string, string> = {
  [join("app", "page.tsx")]: "kst-dashboard.test.ts", // 상황판 — 상태 바 · 레이어 · 칩 · 타임라인 · 오른쪽 패널 모든 탭
  [join("app", "replay", "page.tsx")]: "kst-replay.test.ts",
  [join("app", "stats", "page.tsx")]: "kst-pages.test.ts",
  [join("app", "airports", "[icao]", "page.tsx")]: "kst-pages.test.ts",
  [join("app", "ops", "page.tsx")]: "ops-page.test.ts",
  [join("app", "logs", "page.tsx")]: "logs-page-v5.test.ts",
  [join("app", "about", "page.tsx")]: "kst-dashboard.test.ts",
  [join("app", "guide", "page.tsx")]: "guide-page.test.ts",
  [join("app", "error.tsx")]: "error-screens-v5.test.ts",
  [join("app", "global-error.tsx")]: "error-screens-v5.test.ts", // 같은 ErrorScreen
};

describe("every screen is in a KST-only check", () => {
  const walk = (d: string): string[] => readdirSync(join(WEB, d)).flatMap((n) => {
    const rel = join(d, n);
    return statSync(join(WEB, rel)).isDirectory() ? walk(rel) : /^(page|error|global-error)\.tsx$/.test(n) ? [rel] : [];
  });
  it("each app route (page · error boundary) maps to a test that looks for UTC leaks", () => {
    expect(walk("app").sort()).toEqual(Object.keys(SCREENS).sort());
    for (const [route, test] of Object.entries(SCREENS)) {
      const src = readFileSync(join(WEB, "tests", test), "utf8");
      expect(src, `${route} → ${test}`).toMatch(/\b(dom|html)?[uU]tcLeaks\(/);
    }
  });
});

describe("raw source text stays as issued and is the only place a …Z time may appear", () => {
  it("a server log message that carries a UTC timestamp is kept verbatim (data-raw) — the rest of the detail is KST", () => {
    const body = "retry after 2026-09-29T01:58:00Z (UTC) — upstream said 01:58Z";
    const e = parseLogPage({ items: [{
      id: "1790638875284-0", v: 1, stream: "server", ts: "2026-09-29T01:59:00.000Z", service: "api", instance: "i", level: "WARN", logger: "x", thread: "t",
      message: body, exception: { type: "java.lang.IllegalStateException", message: "at 2026-09-29T01:58:00Z", stack: "java.lang.IllegalStateException: at 01:58Z" },
      fp: "0123456789abcdef", request_id: null, context: { at: "2026-09-29T01:58:00Z" }, suppressed: 0,
    }] }).items[0];
    const html = renderToStaticMarkup(createElement(LogDetail, {
      entry: e, period: "24h", resolvedMode: "hide", onClose: () => {}, onOpen: () => {}, onFilterFp: () => {}, onFilterRid: () => {}, onCopy: () => {},
      onAuthMiss: () => {}, onResolveChanged: () => {},
    } as never));
    expect(html).toContain(body); // 메시지 본문 그대로
    expect(utcLeaks(html.replace(/<[^>]+>/g, " ")).length).toBeGreaterThan(0); // 원문 안에는 UTC 가 있다(바꾸지 않았다)
    expect(htmlUtcLeaks(parseHtml(html))).toEqual([]); // 그 밖(시각 칸 · 제목 · 단추 title)에는 없다
    expect(html).toContain("2026-09-29T10:59:00.000+09:00"); // 이 항목의 시각 칸 = KST ISO
  });
});
