/**
 * 새로고침 단추의 이름은 한 낱말 — '새로고침'(사용자 요청 2026-09-30 "[운영] 메뉴에서 [REFRESH] 버튼 이름을 [새로고침]으로 변경" · 로그 화면의
 * '새로 고침' 도 같은 뜻이라 사용자 표기로 맞춘다). 화면(app · components)의 단추 글자에 'refresh' · '새로 고침' 이 다시 들어오지 않게 소스를 훑는다 —
 * 단추를 누르는 동작은 ops-page · resolve-ops-page · logs-page-v5 시험이 실제로 마운트해 본다. 수정 전 소스에서 실패하는 것을 먼저 확인했다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const web = new URL("../", import.meta.url).pathname;
function tsx(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(join(web, dir))) {
    const rel = join(dir, n);
    if (statSync(join(web, rel)).isDirectory()) tsx(rel, out);
    else if (n.endsWith(".tsx")) out.push(rel);
  }
  return out;
}
/** 단추 글자: `</button>` 바로 앞의 글자 조각(속성의 `=>` 에 걸리지 않게 마지막 `>` 뒤에서 — 자식이 글자뿐인 단추) */
const BUTTON_TEXT = />([^<>{}]+)<\/button>/g;
const labels = (file: string) => [...readFileSync(join(web, file), "utf8").matchAll(BUTTON_TEXT)].map((m) => m[1].trim());

describe("refresh buttons are labelled 새로고침", () => {
  const files = [...tsx("app"), ...tsx("components")];
  it("no button in the web reads refresh · 새로 고침 · reload", () => {
    const bad = files.flatMap((f) => labels(f).filter((l) => /^(refresh|reload|새로 고침)$/i.test(l)).map((l) => `${f}: ${l}`));
    expect(bad).toEqual([]);
  });
  it("the ops page, the log list and the AIS gaps tab each have a 새로고침 button", () => {
    for (const f of ["app/ops/page.tsx", "components/logs/LogsDashboard.tsx", "components/logs/AisGapsTable.tsx"]) expect(labels(f), f).toContain("새로고침");
  });
});
