/**
 * README 그림 내보내기(scripts/readme-images.mjs · scripts/readme-images-lib.mjs) — 설명서 캡처(public/guide/<id>.<해시>.webp · lib/guide-manifest.json)를
 * docs/images/<이름>.webp(해시 없는 고정 이름)로 복사하고, 설정(lib/readme-images.json)에 없는 그림 파일은 지운다.
 * - 거절(아무것도 바꾸지 않음): manifest 에 없는 그림 · 파일이 없거나 크기가 manifest 와 다름 · WebP 가 아님 · fixture 스택 그림인데 설정 · README 대체 글이 밝히지 않음
 *   (또는 그 반대 — 실데이터로 다시 찍었는데 fixture 라고 적음) · README 가 설정에 없는 그림을 가리킴 · 설정의 그림을 README 가 쓰지 않음.
 * - 지우는 것은 docs/images 의 그림 파일(png · webp · jpg · gif · avif · svg)뿐 — 다른 파일은 두고, 지운 것을 보고한다.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
