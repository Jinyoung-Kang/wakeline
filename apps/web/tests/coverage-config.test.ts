/**
 * R-34: 커버리지는 시험이 불러온 파일만이 아니라 소스 전체를 센다(불러오지 않은 파일은 0 % 로 들어간다) — 숫자가 정직해야 한다.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../vitest.config";

const root = new URL("..", import.meta.url).pathname;
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(relative(root, p));
  }
  return out;
}
/** 글롭을 정규식으로(** · * · {a,b} 만) */
function globRe(g: string): RegExp {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "{") { const end = g.indexOf("}", i); re += `(${g.slice(i + 1, end).split(",").join("|")})`; i = end; }
    else re += c.replace(/[.+?^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

describe("coverage counts every source file (R-34)", () => {
  it("coverage.include lists the app, component, lib, worker and proxy sources so untested files count as 0 %", () => {
    const cov = (config as { test?: { coverage?: { include?: string[]; provider?: string } } }).test?.coverage;
    expect(cov?.provider).toBe("v8");
    const include = (cov?.include ?? []).map(globRe);
    const sources = [...walk(join(root, "app")), ...walk(join(root, "components")), ...walk(join(root, "lib")), "public/interpolate.worker.js", "proxy.ts"]
      .filter((f) => /\.(ts|tsx|js)$/.test(f) && !f.endsWith(".d.ts"));
    const missed = sources.filter((f) => !include.some((r) => r.test(f)));
    expect(missed).toEqual([]);
    expect(sources).toContain("components/MapView.tsx");
  });
});
