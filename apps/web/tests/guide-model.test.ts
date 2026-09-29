/**
 * 설명서(/guide) 자료 모델 — 캡처 계획(lib/guide-shots.json: 스크린샷 · 번호 설명 · 캡처 대상 선택자)과
 * 캡처 결과(lib/guide-manifest.json: scripts/guide-screenshots.mjs 가 쓴다)를 읽는 규칙.
 * - 계획은 틀리면 던진다(빌드 · 시험에서 바로 드러나게). 결과(manifest)는 항목 단위로 버리고 이유를 남긴다 — 버린 항목은 화면에서 자리표시로.
 * - 커밋된 manifest 는 버린 항목이 없어야 하고, 가리키는 파일이 public/guide 에 있어야 하며, public/guide 에 manifest 가 모르는 파일이 없어야 한다.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import planJson from "@/lib/guide-shots.json";
import manifestJson from "@/lib/guide-manifest.json";
import {
  dualTime, flattenToc, GUIDE_FILE_RE, GUIDE_TOC, kstClockToUtc, metarTimeToken, parseManifest, parsePlan, PLAN, shotView, type GuideManifest,
} from "@/lib/guide";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const hashedFile = (id: string, ext: string) => `${id}.0123456789.${ext}`;
const WEB = new URL("..", import.meta.url).pathname;

describe("capture plan (lib/guide-shots.json)", () => {
  it("parses: unique ids, sections from the table of contents in page order, callouts numbered 1..n", () => {
    const plan = parsePlan(planJson);
    const ids = plan.shots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const order = flattenToc(GUIDE_TOC).map((t) => t.id);
    const at = plan.shots.map((s) => order.indexOf(s.section));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at); // 그림 번호 = 문서 순서
    for (const s of plan.shots) {
      expect(s.callouts.map((c) => c.n)).toEqual(s.callouts.map((_, i) => i + 1));
      expect(s.alt.length).toBeGreaterThanOrEqual(20);
      expect(s.path.startsWith("/")).toBe(true);
    }
    expect(plan.viewport).toEqual({ width: 1440, height: 900 });
  });
  it("every usage section (2 · 3 · 4 · 5 · 6) has at least one screenshot", () => {
    const secOf = (id: string) => GUIDE_TOC.find((t) => t.id === id || t.children?.some((c) => c.id === id))!.id;
    const covered = new Set(PLAN.shots.map((s) => secOf(s.section)));
    for (const id of ["dashboard", "replay", "stats", "airport", "ops"]) expect(covered.has(id)).toBe(true);
  });
  it("rejects a broken plan with the reason (duplicate id · callout gap · unknown section · bad anchor)", () => {
    const dup = clone(planJson); dup.shots.push(clone(dup.shots[0]));
    expect(() => parsePlan(dup)).toThrow(/중복/);
    const gap = clone(planJson); gap.shots[0].callouts[1].n = 5;
    expect(() => parsePlan(gap)).toThrow(/번호/);
    const sec = clone(planJson); sec.shots[0].section = "nowhere";
    expect(() => parsePlan(sec)).toThrow(/section/);
    const anc = clone(planJson); anc.shots[0].callouts[0].anchor = "middle";
    expect(() => parsePlan(anc)).toThrow(/anchor/);
  });
});

const PNG_SHOT = (id: string, extra: Record<string, unknown> = {}) => ({
  file: `${id}.0123456789.webp`, format: "webp", width: 1440, height: 900, bytes: 81234, captured_at: "2026-09-29T05:22:11.000Z", variant: null,
  callouts: [{ n: 1, x: 10, y: 5.5 }], ...extra,
});

describe("capture result (lib/guide-manifest.json)", () => {
  it("keeps a valid entry and drops broken ones with reasons (file name · unknown shot · callout out of range)", () => {
    const first = PLAN.shots[0].id;
    const second = PLAN.shots[1].id;
    const { manifest, dropped } = parseManifest({
      version: 1,
      shots: {
        [first]: PNG_SHOT(first, { callouts: [{ n: 1, x: 10, y: 5.5 }, { n: 99, x: 1, y: 1 }, { n: 2, x: 140, y: 3 }] }),
        [second]: PNG_SHOT(second, { file: "../../etc/passwd" }),
        nosuch: PNG_SHOT("nosuch"),
      },
    }, PLAN);
    expect(Object.keys(manifest.shots)).toEqual([first]);
    expect(manifest.shots[first].callouts).toEqual([{ n: 1, x: 10, y: 5.5 }]);
    expect(dropped.join("\n")).toMatch(new RegExp(`${second}.*file`));
    expect(dropped.join("\n")).toMatch(/nosuch/);
    expect(dropped.join("\n")).toMatch(/99/);
    expect(dropped.join("\n")).toMatch(/140/);
  });
  it("a missing or malformed manifest is empty (every screenshot shows the placeholder)", () => {
    expect(parseManifest(null, PLAN).manifest.shots).toEqual({});
    expect(parseManifest({ version: 2, shots: {} }, PLAN).dropped[0]).toMatch(/version/);
  });
  it("shotView: missing → placeholder at the planned size; present → /guide/<file> with markers only for measured callouts", () => {
    const s = PLAN.shots[0];
    const empty: GuideManifest = { version: 1, shots: {} };
    expect(shotView(s, empty)).toEqual({ kind: "placeholder", width: 1440, height: 900 });
    const v = shotView(s, { version: 1, shots: { [s.id]: parseManifest({ version: 1, shots: { [s.id]: PNG_SHOT(s.id) } }, PLAN).manifest.shots[s.id] } });
    expect(v).toMatchObject({ kind: "image", src: `/guide/${s.id}.0123456789.webp`, width: 1440, height: 900, format: "webp", bytes: 81234, capturedAt: "2026-09-29T05:22:11.000Z" });
    expect(v.kind === "image" ? v.markers : null).toEqual([{ n: 1, x: 10, y: 5.5 }]);
  });
  it("the committed manifest is valid, every file it names exists, and public/guide holds nothing else", () => {
    const { manifest, dropped } = parseManifest(manifestJson, PLAN);
    expect(dropped).toEqual([]);
    const dir = join(WEB, "public", "guide");
    const named = Object.values(manifest.shots).map((m) => m.file);
    for (const f of named) {
      expect(existsSync(join(dir, f))).toBe(true);
      expect(statSync(join(dir, f)).size).toBe(manifest.shots[f.split(".")[0]].bytes);
    }
    const onDisk = existsSync(dir) ? readdirSync(dir).filter((f) => f !== ".DS_Store") : [];
    expect(onDisk.filter((f) => !named.includes(f))).toEqual([]); // 이름에 내용 해시가 있어 오래 캐시한다 — 고아 파일은 스크립트가 지운다
    for (const f of onDisk) expect(f).toMatch(GUIDE_FILE_RE);
  });
});

describe("dual time for examples (KST first, UTC alongside)", () => {
  it("one instant → the same wall clock in KST and UTC (+9 h), across midnight too; unknown → null", () => {
    expect(dualTime("2026-09-29T05:22:11Z")).toEqual({ kst: "2026-09-29 14:22:11", utc: "2026-09-29 05:22:11" });
    expect(dualTime("2026-09-29T20:30:00Z")).toEqual({ kst: "2026-09-30 05:30:00", utc: "2026-09-29 20:30:00" });
    expect(dualTime(null)).toBeNull();
    expect(dualTime("not a time")).toBeNull();
  });
  it("the raw-bulletin time token of an instant is its UTC day-hour-minute + Z (as published)", () => {
    expect(metarTimeToken("2026-09-29T05:00:00Z")).toBe("290500Z");
    expect(metarTimeToken("2026-09-30T23:59:00Z")).toBe("302359Z");
    expect(metarTimeToken(undefined)).toBeNull();
  });
  it("a KST clock (\"12:30 KST\") → its UTC clock, saying when the UTC date is the day before", () => {
    expect(kstClockToUtc("12:30 KST")).toBe("03:30 UTC");
    expect(kstClockToUtc("09:00")).toBe("00:00 UTC");
    expect(kstClockToUtc("08:59")).toBe("23:59 UTC(전날)");
    expect(kstClockToUtc("25:00")).toBeNull();
  });
});

describe("caching of screenshots", () => {
  it("file names carry a content hash, so hashed /guide/ files get a one-year immutable cache (like /maplibre/) — never the /guide page itself", async () => {
    const { default: cfg, GUIDE_IMAGE_SOURCE } = await import("@/next.config");
    const rules = await cfg.headers!();
    const guide = rules.find((r) => r.source === GUIDE_IMAGE_SOURCE);
    expect(guide?.headers).toEqual([{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }]);
    expect(rules.some((r) => r.source === "/maplibre/:version/:file*")).toBe(true);
    // Next 가 빌드 때 하는 그대로 정규식으로 바꿔 본다(next/dist/lib/build-custom-route)
    const { buildCustomRoute } = await import("next/dist/lib/build-custom-route" as string) as { buildCustomRoute: (t: string, r: { source: string; headers: unknown[] }) => { regex: string } };
    const re = new RegExp(buildCustomRoute("header", { source: GUIDE_IMAGE_SOURCE, headers: [] }).regex);
    const named = hashedFile("dashboard", "webp");
    expect(named).toMatch(GUIDE_FILE_RE);
    expect(re.test(`/guide/${named}`)).toBe(true);
    expect(re.test(`/guide/${hashedFile("ops", "png")}`)).toBe(true);
    for (const p of ["/guide", "/guide/", "/guide/logo.webp", "/guide/a/dashboard.0123456789.webp", "/guidex/dashboard.0123456789.webp"]) expect(re.test(p)).toBe(false);
  });
});
