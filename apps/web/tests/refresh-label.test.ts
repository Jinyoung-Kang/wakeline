/**
 * 새로고침 단추의 이름은 한 낱말 — '새로고침'(사용자 요청 2026-09-30 "[운영] 메뉴에서 [REFRESH] 버튼 이름을 [새로고침]으로 변경" · 로그 화면의
 * '새로 고침' 도 같은 뜻이라 사용자 표기로 맞춘다). 화면(app · components)의 단추 글자에 'refresh' · 'reload' · '새로 고침' 이 다시 들어오지 않게 소스를 훑는다 —
 * 단추를 누르는 동작은 ops-page · resolve-ops-page · logs-page-v5 시험이 실제로 마운트해 본다. 수정 전 소스에서 실패하는 것을 먼저 확인했다.
 * 통합 리뷰(2026-09-30): 뒤에 합친 레인 js 가 '페이지 새로 고침' 단추와 '페이지를 새로 고치세요' 안내를 들여왔는데 단추 글자 전체만 보던 검사가 놓쳤다 —
 * 이제 단추 글자 안의 낱말도 보고, 화면 소스(app · components · lib — 안내 글 · 오류 글 · 주석)에서 띄어 쓴 '새로 고침 · 새로 고치-'를 모두 막는다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const web = new URL("../", import.meta.url).pathname;
function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const n of readdirSync(join(web, dir))) {
    const rel = join(dir, n);
    if (statSync(join(web, rel)).isDirectory()) walk(rel, exts, out);
    else if (exts.some((e) => n.endsWith(e))) out.push(rel);
  }
  return out;
}
/** 단추 글자: `</button>` 바로 앞의 글자 조각(속성의 `=>` 에 걸리지 않게 마지막 `>` 뒤에서 — 자식이 글자뿐인 단추) */
const BUTTON_TEXT = />([^<>{}]+)<\/button>/g;
const labels = (file: string) => [...readFileSync(join(web, file), "utf8").matchAll(BUTTON_TEXT)].map((m) => m[1].trim());
/** 띄어 쓴 새로고침(명사 '새로 고침' · 동사 '새로 고치다/고친/고치세요') */
const SPACED = /새로\s+고[침치친]/;

describe("refresh buttons are labelled 새로고침", () => {
  const files = [...walk("app", [".tsx"]), ...walk("components", [".tsx"])];
  it("no button in the web reads or contains refresh · reload · 새로 고침", () => {
    const bad = files.flatMap((f) => labels(f).filter((l) => /\b(refresh|reload)\b/i.test(l) || SPACED.test(l)).map((l) => `${f}: ${l}`));
    expect(bad).toEqual([]);
  });
  it("no screen source spells it apart — '새로 고침' · '새로 고치-' (button labels, advice, error text, comments)", () => {
    const src = [...walk("app", [".ts", ".tsx"]), ...walk("components", [".ts", ".tsx"]), ...walk("lib", [".ts", ".tsx"])];
    const bad = src.flatMap((f) => readFileSync(join(web, f), "utf8").split("\n").flatMap((line, i) => (SPACED.test(line) ? [`${f}:${i + 1}: ${line.trim().slice(0, 80)}`] : [])));
    expect(bad).toEqual([]);
  });
  it("the ops page, the log list and the AIS gaps tab each have a 새로고침 button; the lazy part's reload reads 페이지 새로고침", () => {
    for (const f of ["app/ops/page.tsx", "components/logs/LogsDashboard.tsx", "components/logs/AisGapsTable.tsx"]) expect(labels(f), f).toContain("새로고침");
    expect(labels("components/LazyPart.tsx")).toContain("페이지 새로고침");
  });
});
