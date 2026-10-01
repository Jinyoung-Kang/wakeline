/**
 * README 그림 내보내기(scripts/readme-images.mjs · scripts/readme-images-lib.mjs) — 설명서 캡처(public/guide/<id>.<해시>.webp · lib/guide-manifest.json)를
 * docs/images/<이름>.webp(해시 없는 고정 이름)로 복사하고, 설정(lib/readme-images.json)에 없는 그림 파일은 지운다.
 * - 거절(아무것도 바꾸지 않음): manifest 에 없는 그림 · 파일이 없거나 크기가 manifest 와 다름 · WebP 가 아님 · fixture 스택 그림인데 설정 · README 대체 글이 밝히지 않음
 *   (또는 그 반대 — 실데이터로 다시 찍었는데 fixture 라고 적음) · README 가 설정에 없는 그림을 가리킴 · 설정의 그림을 README 가 쓰지 않음.
 * - 지우는 것은 docs/images 의 그림 파일(png · webp · jpg · gif · avif · svg)뿐 — 다른 파일은 두고, 지운 것을 보고한다.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureVariant } from "../scripts/guide-capture-lib.mjs";
import { exportReadmeImages, parseReadmeConfig, readmeImageRefs, staleImages } from "../scripts/readme-images-lib.mjs";

const PLAN_IDS = ["dashboard", "world", "ops"];
const bytes = (n: number, fill = 7) => Buffer.alloc(n, fill);
const entry = (id: string, hash: string, size: number, variant: string | null = null, format = "webp") => ({
  file: `${id}.${hash}.${format}`, format, width: 1440, height: 900, bytes: size, captured_at: "2026-10-01T03:00:00.000Z", variant, callouts: [],
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** 임시 저장소: <root>/apps/web/public/guide · <root>/docs/images(옛 그림 · 다른 파일) */
function repo(guideFiles: Record<string, Buffer>, docs: Record<string, Buffer | string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "readme-images-"));
  dirs.push(root);
  const web = join(root, "apps", "web");
  mkdirSync(join(web, "public", "guide"), { recursive: true });
  for (const [f, b] of Object.entries(guideFiles)) writeFileSync(join(web, "public", "guide", f), b);
  mkdirSync(join(root, "docs", "images"), { recursive: true });
  for (const [f, b] of Object.entries(docs)) writeFileSync(join(root, "docs", "images", f), b);
  return { root, web, images: join(root, "docs", "images") };
}

const CONFIG = parseReadmeConfig({ version: 1, images: [{ name: "dashboard", shot: "dashboard" }, { name: "ops", shot: "ops", fixture: true }] }, PLAN_IDS);
const MANIFEST = { version: 1, shots: { dashboard: entry("dashboard", "aaaaaaaaaa", 10), ops: entry("ops", "bbbbbbbbbb", 12, "fixture 스택(가짜 자료) · providers 탭") } };
const README = "![상황판](docs/images/dashboard.webp)\n\n| ![운영 화면 — fixture 스택(가짜 자료)](docs/images/ops.webp) 운영 |\n";
const GUIDE = { "dashboard.aaaaaaaaaa.webp": bytes(10, 1), "ops.bbbbbbbbbb.webp": bytes(12, 2) };

describe("config (lib/readme-images.json)", () => {
  it("parses names, guide shot ids and the fixture flag", () => {
    expect(CONFIG.images).toEqual([{ name: "dashboard", shot: "dashboard", fixture: false }, { name: "ops", shot: "ops", fixture: true }]);
  });
  it("rejects every problem at once: version, file-safe names, duplicates, unknown shots, a non-boolean fixture flag", () => {
    let msg = "";
    try {
      parseReadmeConfig({ version: 1, images: [
        { name: "../x", shot: "dashboard" }, { name: "a", shot: "nosuch" }, { name: "b", shot: "world" }, { name: "b", shot: "ops" }, { name: "c", shot: "world", fixture: "yes" },
      ] }, PLAN_IDS);
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/images\[0\]\.name/);
    expect(msg).toMatch(/images\[1\]\.shot.*nosuch/);
    expect(msg).toMatch(/images\[3\]\.name.*중복/);
    expect(msg).toMatch(/images\[4\]\.shot.*중복|images\[4\]\.fixture/);
    expect(msg).toMatch(/images\[4\]\.fixture/);
    expect(() => parseReadmeConfig({ version: 2, images: [] }, PLAN_IDS)).toThrow(/version/);
    expect(() => parseReadmeConfig({ version: 1, images: [] }, PLAN_IDS)).toThrow(/비어/);
  });
});

describe("README references and stale files", () => {
  it("finds every docs/images reference with its alt text (images) or none (plain links)", () => {
    const refs = readmeImageRefs("![a b](docs/images/x.webp) and [link](docs/images/y.png)\n| ![](docs/images/z.webp) |");
    expect(refs.map((r) => [r.file, r.alt])).toEqual([["x.webp", "a b"], ["y.png", null], ["z.webp", ""]]);
  });
  it("stale files are image files the export does not write — never other files", () => {
    expect(staleImages(["dashboard.webp", "01-dashboard-korea.png", "a.JPG", "b.svg", ".gitkeep", "notes.md", "ops.webp"], ["dashboard.webp", "ops.webp"]))
      .toEqual(["01-dashboard-korea.png", "a.JPG", "b.svg"]);
  });
});

describe("export", () => {
  it("copies each figure to docs/images/<name>.webp, removes image files the config does not list, keeps other files, and reports both", () => {
    const r = repo(GUIDE, { "01-dashboard-korea.png": bytes(5), "dashboard.webp": bytes(3, 9), "keep.txt": "x" });
    const out = exportReadmeImages({ root: r.root, web: r.web, config: CONFIG, manifest: MANIFEST, readme: README });
    expect(out.problems).toEqual([]);
    expect(out.copied.map((c) => [c.name, c.from, c.to, c.fixture])).toEqual([
      ["dashboard", "apps/web/public/guide/dashboard.aaaaaaaaaa.webp", "docs/images/dashboard.webp", false],
      ["ops", "apps/web/public/guide/ops.bbbbbbbbbb.webp", "docs/images/ops.webp", true],
    ]);
    expect(out.removed).toEqual([{ file: "docs/images/01-dashboard-korea.png", bytes: 5 }]);
    expect(readFileSync(join(r.images, "dashboard.webp"))).toEqual(GUIDE["dashboard.aaaaaaaaaa.webp"]);
    expect(readFileSync(join(r.images, "ops.webp"))).toEqual(GUIDE["ops.bbbbbbbbbb.webp"]);
    expect(readdirSync(r.images).sort()).toEqual(["dashboard.webp", "keep.txt", "ops.webp"]);
  });
  it("--dry-run reports the same plan and changes nothing", () => {
    const r = repo(GUIDE, { "old.png": bytes(5) });
    const out = exportReadmeImages({ root: r.root, web: r.web, config: CONFIG, manifest: MANIFEST, readme: README, dryRun: true });
    expect(out.problems).toEqual([]);
    expect(out.copied).toHaveLength(2);
    expect(out.removed).toEqual([{ file: "docs/images/old.png", bytes: 5 }]);
    expect(readdirSync(r.images)).toEqual(["old.png"]);
  });

  /** 거절이면 docs/images 를 하나도 바꾸지 않는다 */
  const refused = (over: { manifest?: unknown; readme?: string; guide?: Record<string, Buffer>; config?: ReturnType<typeof parseReadmeConfig> }) => {
    const r = repo(over.guide ?? GUIDE, { "old.png": bytes(5) });
    const out = exportReadmeImages({ root: r.root, web: r.web, config: over.config ?? CONFIG, manifest: over.manifest ?? MANIFEST, readme: over.readme ?? README });
    expect(readdirSync(r.images)).toEqual(["old.png"]);
    expect(out.copied).toEqual([]);
    expect(out.removed).toEqual([]);
    return out.problems.join("\n");
  };
  it("refuses a figure missing from the manifest (not captured, or skipped) and a manifest that is not version 1", () => {
    expect(refused({ manifest: { version: 1, shots: { ops: MANIFEST.shots.ops } } })).toMatch(/dashboard: .*manifest.*없음/);
    expect(refused({ manifest: { version: 2, shots: MANIFEST.shots } })).toMatch(/manifest/);
  });
  it("refuses a manifest file that is absent, whose size differs from the manifest, or that is not WebP", () => {
    expect(refused({ guide: { "ops.bbbbbbbbbb.webp": bytes(12) } })).toMatch(/dashboard: .*dashboard\.aaaaaaaaaa\.webp 없음/);
    expect(refused({ guide: { ...GUIDE, "dashboard.aaaaaaaaaa.webp": bytes(11) } })).toMatch(/dashboard: .*11 B.*10 B/);
    const png = { version: 1, shots: { ...MANIFEST.shots, dashboard: entry("dashboard", "aaaaaaaaaa", 10, null, "png") } };
    expect(refused({ manifest: png, guide: { ...GUIDE, "dashboard.aaaaaaaaaa.png": bytes(10) } })).toMatch(/dashboard: .*WebP 가 아님/);
    const traversal = { version: 1, shots: { ...MANIFEST.shots, dashboard: { ...MANIFEST.shots.dashboard, file: "../../../etc/passwd" } } };
    expect(refused({ manifest: traversal })).toMatch(/dashboard: .*파일 이름/);
  });
  it("refuses a fixture-stack figure the config or the README alt text does not name — and a fixture label on a figure re-shot live", () => {
    const fixtureDash = { version: 1, shots: { ...MANIFEST.shots, dashboard: entry("dashboard", "aaaaaaaaaa", 10, "격리 fixture 스택 · 한반도") } };
    expect(refused({ manifest: fixtureDash })).toMatch(/dashboard: .*fixture 스택 그림.*fixture: true/);
    expect(refused({ readme: README.replace("운영 화면 — fixture 스택(가짜 자료)", "운영 화면") })).toMatch(/ops: .*대체 글.*fixture/);
    const liveOps = { version: 1, shots: { ...MANIFEST.shots, ops: entry("ops", "bbbbbbbbbb", 12, "providers 탭") } };
    expect(refused({ manifest: liveOps })).toMatch(/ops: .*fixture 가 아님/);
  });
  it("refuses a README that points at an image the config does not export, or leaves a configured image unused", () => {
    expect(refused({ readme: `${README}\n![old](docs/images/05-world.png)\n` })).toMatch(/README.*05-world\.png.*설정에 없음/);
    expect(refused({ readme: "![운영 — fixture 스택](docs/images/ops.webp)\n" })).toMatch(/dashboard: .*README 가 쓰지 않음/);
  });
});

/**
 * 커밋된 README · 설정 · 설명서 계획이 서로 맞는가(내보내기 전에도 — README 는 내보내기가 만들 고정 이름을 가리킨다).
 * 2026-10-01: README 가 2026-09-28 에 찍은 PNG 10장(§G20 전 — UTC 표시 · 옛 상태 바)을 가리켰고, 7장은 아무도 가리키지 않았다.
 */
describe("the committed README, config and guide plan agree", () => {
  const WEB = new URL("..", import.meta.url).pathname;
  const ROOT = join(WEB, "..", "..");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const plan = JSON.parse(readFileSync(join(WEB, "lib", "guide-shots.json"), "utf8")) as { shots: { id: string }[] };
  const planIds = plan.shots.map((s) => s.id);
  const config = parseReadmeConfig(JSON.parse(readFileSync(join(WEB, "lib", "readme-images.json"), "utf8")), planIds); // 모든 항목이 설명서 그림 id 를 가리킨다
  const manifest = JSON.parse(readFileSync(join(WEB, "lib", "guide-manifest.json"), "utf8")) as { shots: Record<string, { variant: string | null }> };
  const refs = readmeImageRefs(readme);
  const names = config.images.map((i) => `${i.name}.webp`);

  it("every docs/images reference in the README is an image the config exports, and every configured image is used", () => {
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.map((r) => r.file).filter((f) => !names.includes(f))).toEqual([]);
    expect(names.filter((n) => !refs.some((r) => r.file === n))).toEqual([]);
    for (const r of refs) expect(r.alt, r.file).not.toBeNull(); // 그림 문법으로만(대체 글이 있다)
    for (const r of refs) expect(r.alt!.trim().length, r.file).toBeGreaterThan(0);
  });
  it("the hero is the dashboard figure", () => {
    expect(refs[0].file).toBe(`${config.images.find((i) => i.shot === "dashboard")!.name}.webp`);
  });
  it("fixture-stack figures say so in their README alt text, and the flag agrees with the capture condition of the committed capture", () => {
    for (const img of config.images) {
      for (const r of refs.filter((x) => x.file === `${img.name}.webp`)) expect(/fixture/i.test(r.alt ?? ""), img.name).toBe(img.fixture);
      const m = manifest.shots[img.shot];
      if (m) expect(fixtureVariant(m.variant), img.shot).toBe(img.fixture);
    }
    expect(config.images.filter((i) => i.fixture).map((i) => i.shot).sort()).toEqual(["logs", "ops"]);
  });
  it("docs/images holds no image the export would not write (the 2026-09-28 PNGs are gone)", () => {
    const dir = join(ROOT, "docs", "images");
    const files = existsSync(dir) ? readdirSync(dir) : [];
    expect(staleImages(files, names)).toEqual([]);
  });
  it("the README states the guide's figure count from the plan and how to re-shoot and export", () => {
    expect(readme).toContain(`그림 ${planIds.length}개`);
    expect(readme).toMatch(/node scripts\/guide-screenshots\.mjs http:\/\/localhost:8700/);
    expect(readme).toMatch(/--only ops,logs --allow-fixture/);
    expect(readme).toMatch(/make readme-images/);
    expect(readme).not.toMatch(/11개 그림|2026-09-28\)/);
  });
  /**
   * 리뷰 2026-10-01: 1번 명령이 실데이터 스택에서 운영 · 로그까지 찍으라고 적어, 그대로 따르면 설정(fixture: true)과 어긋나 내보내기가 늘 거절했다.
   * 실데이터 스택 명령은 설정이 fixture 로 적은 그림을 빼고(--skip), fixture 스택 명령은 바로 그 그림만(--only … --allow-fixture) 찍는다.
   */
  it("the re-shoot commands agree with the config: the live-stack run skips exactly the fixture figures, the fixture-stack run takes exactly them", () => {
    const fixtureShots = config.images.filter((i) => i.fixture).map((i) => i.shot).join(",");
    const cmds = [...readme.matchAll(/^node scripts\/guide-screenshots\.mjs (\S+) <자격 증명 파일>([^#\n]*)/gm)].map((m) => ({ base: m[1], opts: m[2].trim() }));
    expect(cmds).toEqual([
      { base: "http://localhost:8700", opts: `--skip ${fixtureShots}` },
      { base: "http://localhost:8701", opts: `--only ${fixtureShots} --allow-fixture` },
    ]);
  });
  /**
   * 리뷰 2026-10-01: "지금(2026-10-01)은 14개가 찍혀 있고(실데이터 스택 12개 …)" 는 그림을 찍어 커밋하면 곧 틀리는데 시험이 없었다. 날짜에 묶인 상태 문장을 두지 않고,
   * 찍힌 수를 적는다면 커밋된 결과(lib/guide-manifest.json)와 맞아야 한다.
   */
  it("a captured count the README states matches the committed manifest; no date-bound status sentence", () => {
    const captured = Object.values(manifest.shots);
    for (const m of readme.matchAll(/(\d+)개가 찍혀/g)) expect(Number(m[1]), m[0]).toBe(captured.length);
    for (const m of readme.matchAll(/실데이터 스택 (\d+)개/g)) expect(Number(m[1]), m[0]).toBe(captured.filter((c) => !fixtureVariant(c.variant)).length);
    expect(readme).not.toMatch(/지금\(\d{4}-\d{2}-\d{2}\)/);
  });
});
