import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 오류 경계(app/error.tsx · app/global-error.tsx)는 오류가 없어도 `/` 첫 로드에 청크로 받는다(PERF §8 — 둘이 각각 복사본을 싣는다).
 * 그래서 이 두 파일에서 닿는 모듈에 로그 화면용 lib/logs(해석 · 필터 · 20 KB 소스)가 끼면 안 된다.
 */
const ROOT = resolve(__dirname, "..");
function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? resolve(ROOT, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null; // 패키지
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) if (existsSync(base + ext) && !base.endsWith("/") && (ext || /\.(ts|tsx)$/.test(base))) return base + ext;
  return null;
}
function graph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [resolve(ROOT, entry)];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^"']*["']([^"']+)["']/gm)) {
      const r = resolveImport(f, m[1]);
      if (r && !r.endsWith(".css")) stack.push(r);
    }
  }
  return seen;
}

describe("error boundary chunks", () => {
  for (const entry of ["app/error.tsx", "app/global-error.tsx"]) {
    it(`${entry} does not pull lib/logs into the first load`, () => {
      const files = [...graph(entry)].map((f) => f.slice(ROOT.length + 1));
      expect(files).toContain("components/logs/ErrorScreen.tsx");
      expect(files).not.toContain("lib/logs.ts");
      // 복사 머리 줄의 KST 는 의존성 없는 lib/kst 로 — 표시 규칙 전체(lib/format)를 싣지 않는다
      expect(files).toContain("lib/kst.ts");
      expect(files).not.toContain("lib/format.ts");
    });
  }
});
