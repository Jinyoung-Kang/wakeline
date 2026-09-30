/**
 * 첫 화면 JS 측정 · 예산 도구(NFR-04, ADR-026)의 순수 부분(scripts/first-screen-js-lib.mjs).
 * - 바이트 단위: Next 내장 압축(gzip 수준 6 · 1 KiB 문턱)과 같은 설정으로 만든 본문 바이트.
 * - 빌드 결과 읽기: Next 의 첫 로드 목록 + '/' 의 next/dynamic + MapLibre 배포본 + 지도가 띄우는 public 워커. 형식이 다르면 0 으로 세지 않고 실패.
 * - 측정 스크립트 인자: 로컬 서버는 127.0.0.1:8790–8799 만(다른 프로젝트 포트와 겹치지 않게).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  budgetVerdict, compressorLabel, dockerExitCode, FIRST_SCREEN_JS_BUDGET, FIRST_SCREEN_PUBLIC_SCRIPTS, firstScreenFiles, formatReport, GZIP_THRESHOLD, groupOfPath, inImageArgs,
  isScriptResponse, measureFiles, parseCheckArgs, parseMeasureArgs, runCheck, servedBytes, summarize, webImageNode,
} from "../scripts/first-screen-js-lib.mjs";

const ROOT = resolve(__dirname, "..");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** 가짜 빌드 결과(.next 진단 · loadable 목록 · 청크 · public) */
function fakeBuild(opts: { stats?: unknown; loadable?: unknown; versions?: string[]; workers?: boolean } = {}): string {
  const d = mkdtempSync(join(tmpdir(), "fsjs-"));
  dirs.push(d);
  const w = (rel: string, body: string | Buffer) => { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), body); };
  w(".next/static/chunks/a.js", "a".repeat(5000));
  w(".next/static/chunks/b.js", "b");
  w(".next/static/chunks/map.js", "m".repeat(3000));
  w(".next/static/chunks/map.css", "x");
  w(".next/diagnostics/route-bundle-stats.json", JSON.stringify(opts.stats ?? [
    { route: "/logs", firstLoadChunkPaths: [".next/static/chunks/b.js"] },
    { route: "/", firstLoadChunkPaths: [".next/static/chunks/a.js", ".next/static/chunks/b.js"] },
  ]));
  w(".next/server/app/page/react-loadable-manifest.json", JSON.stringify(opts.loadable ?? { 1: { id: 1, files: ["static/chunks/map.js", "static/chunks/map.css", "static/chunks/b.js"] } }));
  for (const v of opts.versions ?? ["6.11.2"]) {
    w(`public/maplibre/${v}/maplibre-gl.mjs`, "g".repeat(2000));
    w(`public/maplibre/${v}/maplibre-gl-shared.mjs`, "s".repeat(2000));
    w(`public/maplibre/${v}/maplibre-gl-worker.mjs`, "k".repeat(10));
  }
  if (opts.workers !== false) for (const f of FIRST_SCREEN_PUBLIC_SCRIPTS) w(`public/${f}`, "w".repeat(1500));
  return d;
}

describe("bytes: the same gzip the web server sends", () => {
  it("gzip level 6 at or above 1 KiB, the raw size below (Next's compression threshold)", () => {
    const big = Buffer.from("wakeline ".repeat(500));
    expect(servedBytes(big)).toBe(gzipSync(big, { level: 6 }).length);
    expect(servedBytes(big)).toBeLessThan(big.length);
    const small = Buffer.alloc(GZIP_THRESHOLD - 1, 65);
    expect(servedBytes(small)).toBe(small.length);
  });
});

describe("bytes depend on the zlib build — the unit is the web image's Node (ADR-026)", () => {
  // 같은 파일도 zlib 구현마다 gzip 결과가 조금 다르다(측정: macOS 시스템 zlib 1.2.12 가 웹 이미지 Node 의 내장 zlib 보다 0.44 % 작게 만든다).
  // 그래서 모든 표에 압축기를 적고, 예산은 웹 이미지(Dockerfile 의 고정 node 이미지)의 Node 로 잰 값으로 읽는다.
  it("every report names the compressor that produced its bytes (Node · zlib · platform/arch)", () => {
    expect(compressorLabel({ version: "v24.21.0", versions: { zlib: "1.3.2.1-motley-8002e91" }, platform: "linux", arch: "arm64" }))
      .toBe("Node v24.21.0 · zlib 1.3.2.1-motley-8002e91 · linux/arm64");
    expect(compressorLabel()).toContain(`zlib ${process.versions.zlib}`);
  });
  it("the reference compressor is the Node of the web image's final stage, pinned by digest in the Dockerfile", () => {
    const real = webImageNode(readFileSync(join(ROOT, "Dockerfile"), "utf8"));
    expect(real).toMatch(/^node:[\w.-]+@sha256:[0-9a-f]{64}$/);
    const pin = (tag: string) => `node:${tag}@sha256:${"a".repeat(64)}`;
    expect(webImageNode(`FROM ${pin("24-alpine")} AS deps\nRUN x\nFROM ${pin("24-alpine")} AS build\n# FROM nope\nFROM ${pin("24-slim")}\nCMD ["node"]\n`)).toBe(pin("24-slim"));
    expect(() => webImageNode("FROM node:24-alpine\n")).toThrow(/다이제스트/); // 태그만 — 판이 옮겨 갈 수 있다
    expect(() => webImageNode(`FROM ${pin("24-alpine")} AS b\nFROM nginx@sha256:${"b".repeat(64)}\n`)).toThrow(/node/);
    expect(() => webImageNode("RUN true\n")).toThrow(/FROM/);
  });
  it("--in-image runs the same check inside that image: read-only, no network, the web dir mounted read-only", () => {
    const img = `node:24-alpine@sha256:${"c".repeat(64)}`;
    expect(inImageArgs("/repo/apps/web", img)).toEqual([
      "run", "--rm", "--network", "none", "--read-only", "-v", "/repo/apps/web:/w:ro", "-w", "/w", "-e", `FIRST_JS_IMAGE=${img}`,
      "--entrypoint", "node", img, "scripts/check-first-screen-js.mjs",
    ]);
    expect(parseCheckArgs([])).toEqual({ inImage: false, image: null });
    expect(parseCheckArgs(["--in-image"])).toEqual({ inImage: true, image: null });
    expect(parseCheckArgs(["--in-image", "--image", "wakeline-web:local"])).toEqual({ inImage: true, image: "wakeline-web:local" });
    for (const bad of [["--image"], ["--image", "x"], ["--what"], ["extra"]]) expect(() => parseCheckArgs(bad)).toThrow(/사용법/);
  });
  it("docker's own failures (cannot pull or start: 125–127, a signal) are a failed check, never a pass", () => {
    expect(dockerExitCode(0, null)).toBe(0);
    expect(dockerExitCode(1, null)).toBe(1);
    expect(dockerExitCode(2, null)).toBe(2);
    for (const s of [125, 126, 127, 3]) expect(dockerExitCode(s, null)).toBe(2);
    expect(dockerExitCode(null, "SIGKILL")).toBe(2);
  });
});

describe("first-screen files from the build output", () => {
  it("Next first-load chunks of '/', the page's next/dynamic chunks (JS only, no duplicates), every MapLibre file and the map's public worker", () => {
    const files = firstScreenFiles(fakeBuild());
    expect(files.map((f) => [f.group, f.file])).toEqual([
      ["entry", "/_next/static/chunks/a.js"],
      ["entry", "/_next/static/chunks/b.js"],
      ["dynamic", "/_next/static/chunks/map.js"],
      ["maplibre", "/maplibre/6.11.2/maplibre-gl-shared.mjs"],
      ["maplibre", "/maplibre/6.11.2/maplibre-gl-worker.mjs"],
      ["maplibre", "/maplibre/6.11.2/maplibre-gl.mjs"],
      ["public", "/interpolate.worker.js"],
    ]);
    const rows = measureFiles(files);
    const s = summarize(rows);
    expect(s.count).toBe(7);
    expect(s.body).toBe(rows.reduce((n, r) => n + r.body, 0));
    expect(s.groups.maplibre.count).toBe(3);
    expect(rows.find((r) => r.file.endsWith("b.js"))).toMatchObject({ raw: 1, body: 1 }); // 문턱 미만은 압축하지 않는다
    expect(rows[0].body).toBeGreaterThanOrEqual(rows[rows.length - 1].body); // 큰 것부터
    const report = formatReport(rows, "t");
    expect(report).toContain("합계");
    expect(report).toContain(`(${s.body} B)`);
  });
  it("fails loudly instead of counting zero when the build output is missing or its format changed", () => {
    expect(() => firstScreenFiles(mkdtempSync(join(tmpdir(), "fsjs-empty-")))).toThrow(/npm run build/);
    expect(() => firstScreenFiles(fakeBuild({ stats: [{ route: "/logs", firstLoadChunkPaths: [] }] }))).toThrow(/'\/' 의 firstLoadChunkPaths/);
    expect(() => firstScreenFiles(fakeBuild({ stats: [{ route: "/", firstLoadChunkPaths: ["static/chunks/a.js"] }] }))).toThrow(/예상하지 못한 첫 로드 경로/);
    expect(() => firstScreenFiles(fakeBuild({ stats: [{ route: "/", firstLoadChunkPaths: [".next/static/chunks/gone.js"] }] }))).toThrow(/파일이 없습니다/);
    expect(() => firstScreenFiles(fakeBuild({ versions: ["6.11.1", "6.11.2"] }))).toThrow(/버전 폴더가 2개/);
    expect(() => firstScreenFiles(fakeBuild({ versions: [] }))).toThrow(/버전 폴더가 0개/);
    expect(() => firstScreenFiles(fakeBuild({ workers: false }))).toThrow(/interpolate\.worker\.js/);
  });
  it("the public worker list is exactly what the map component starts (new Worker)", () => {
    const src = readFileSync(join(ROOT, "components/MapView.tsx"), "utf8");
    const started = [...src.matchAll(/new Worker\(\s*["'`]\/([^"'`]+)["'`]/g)].map((m) => m[1]).sort();
    expect(started).toEqual([...FIRST_SCREEN_PUBLIC_SCRIPTS].sort());
  });
});

describe("budget verdict", () => {
  it("passes at or under the budget, explains the overrun otherwise, and refuses a broken budget", () => {
    expect(budgetVerdict(100, 100)).toBeNull();
    expect(budgetVerdict(101, 100)).toMatch(/1 B 넘었습니다/);
    expect(() => budgetVerdict(1, 0)).toThrow(/예산이 올바르지 않습니다/);
    expect(() => budgetVerdict(1, Number.NaN)).toThrow();
  });
});

describe("browser measurement helpers", () => {
  it("counts script requests and JS responses (a module worker arrives as 'other' with a JS type)", () => {
    expect(isScriptResponse("script", null)).toBe(true);
    expect(isScriptResponse("other", "application/javascript; charset=utf-8")).toBe(true);
    expect(isScriptResponse("other", "text/javascript")).toBe(true);
    expect(isScriptResponse("fetch", "application/json")).toBe(false);
    expect(isScriptResponse("stylesheet", "text/css")).toBe(false);
    expect(groupOfPath("/maplibre/6.11.2/maplibre-gl.mjs")).toBe("maplibre");
    expect(groupOfPath("/_next/static/chunks/a.js")).toBe("next");
    expect(groupOfPath("/interpolate.worker.js")).toBe("public");
  });
  it("arguments: a base URL or a local server on 127.0.0.1:8790–8799, never both", () => {
    expect(parseMeasureArgs(["http://localhost:8700/"])).toEqual({ baseUrl: "http://localhost:8700", serve: null, settleMs: 3000, json: null, budget: null });
    expect(parseMeasureArgs(["--serve", "8790", "--json", "o.json", "--budget", "123", "--settle", "1000"]))
      .toEqual({ baseUrl: "http://127.0.0.1:8790", serve: 8790, settleMs: 1000, json: "o.json", budget: 123 });
    for (const bad of [[], ["--serve", "8080"], ["--serve", "8800"], ["http://localhost:8700", "--serve", "8790"], ["ftp://x"], ["not a url"], ["--budget", "-1", "http://x"], ["--what"], ["http://a", "http://b"]]) {
      expect(() => parseMeasureArgs(bad)).toThrow(/사용법/);
    }
  });
});

describe("first-screen JS budget guard (ADR-026)", () => {
  it("the budget is one number, the same in the guard, PERF §10 and ADR-026 (a chosen value — its evidence is written next to it)", () => {
    expect(Number.isInteger(FIRST_SCREEN_JS_BUDGET)).toBe(true);
    const n = FIRST_SCREEN_JS_BUDGET.toLocaleString("en-US");
    const perf = readFileSync(join(ROOT, "../../docs/PERF.md"), "utf8");
    const adr = readFileSync(join(ROOT, "../../docs/adr/ADR-026-first-screen-js-budget.md"), "utf8");
    expect(perf).toContain(`예산 ${n} B`);
    expect(adr).toContain(`${n} B`);
    // 바닥(MapLibre + Next · React 실행 코드)보다 커야 의미가 있다 — 바닥 아래 예산은 지도를 버리라는 뜻이다
    expect(FIRST_SCREEN_JS_BUDGET).toBeGreaterThan(436_883);
  });
  it("check: 0 under the budget, 1 over it (with the overrun), 2 when the build output cannot be read — never a silent pass", () => {
    const dir = fakeBuild();
    const total = summarize(measureFiles(firstScreenFiles(dir))).body;
    const ok = runCheck(dir, total);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("남은 여유 0 B");
    const over = runCheck(dir, total - 1);
    expect(over.code).toBe(1);
    expect(over.err).toMatch(/1 B 넘었습니다/);
    expect(over.out).toContain("합계"); // 넘었을 때도 무엇이 실렸는지 표를 보인다
    // 압축기를 적는다: 웹 이미지 안이면 그 이미지(예산의 기준), 아니면 이 호스트의 Node(기준과 다를 수 있다고 말한다)
    expect(ok.out).toContain(`압축기: ${compressorLabel()}`);
    expect(ok.out).toMatch(/이 호스트의 Node — 예산의 기준은 웹 이미지의 Node.*--in-image/);
    const inImage = runCheck(dir, total, { image: "node:24-alpine@sha256:abc", reference: "node:24-alpine@sha256:abc" });
    expect(inImage.out).toContain("웹 이미지 node:24-alpine@sha256:abc 의 Node — 예산의 기준");
    // --image 로 다른 이미지를 고르면 기준이라고 말하지 않는다(같은 Node 판인지는 이 도구가 모른다)
    const other = runCheck(dir, total, { image: "wakeline-web:local", reference: "node:24-alpine@sha256:abc" });
    expect(other.out).toContain("지정한 이미지 wakeline-web:local 의 Node — 예산의 기준은 Dockerfile 의 node:24-alpine@sha256:abc");
    const broken = runCheck(mkdtempSync(join(tmpdir(), "fsjs-none-")), total);
    expect(broken.code).toBe(2);
    expect(broken.err).toMatch(/계산하지 못했습니다/);
  });
  it("npm exposes both tools, and the CI web job runs the check after the production build, unconditionally", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:first-js"]).toBe("node scripts/check-first-screen-js.mjs");
    expect(pkg.scripts["measure:first-js"]).toBe("node scripts/measure-first-screen-js.mjs");
    // .github/workflows/ci.yml 의 web job(2칸 들여쓴 job 이름 ~ 다음 job) — 단계는 6칸 들여쓴 '- '
    const ci = readFileSync(join(ROOT, "../../.github/workflows/ci.yml"), "utf8");
    const web = /^ {2}web:\s*$([\s\S]*?)(?=^ {2}[A-Za-z0-9_-]+:\s*$)/m.exec(ci)?.[1] ?? "";
    const steps = web.split(/^ {6}- /m).slice(1);
    const build = steps.findIndex((s) => s.includes("npm run build"));
    const check = steps.flatMap((s, i) => (s.includes("npm run check:first-js") ? [i] : []));
    // 예산의 단위(웹 이미지의 Node 가 만든 gzip)로 잰다 — 러너의 Node(setup-node)는 zlib 판이 다를 수 있다
    expect(steps[check[0]]).toMatch(/npm run check:first-js -- --in-image\b/);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(check).toHaveLength(1);
    expect(check[0]).toBeGreaterThan(build); // 운영 빌드(.next · public/maplibre) 뒤
    expect(steps[check[0]]).not.toMatch(/continue-on-error|^\s*if:/m); // 조건 없이 늘 돌고, 실패하면 job 이 실패한다
  });
});
