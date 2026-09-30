/**
 * 설명서 캡처 스크립트(scripts/guide-screenshots.mjs)의 순수 부분(scripts/guide-capture-lib.mjs) — 브라우저 없이.
 * - 인자: 기준 주소(로컬 스택만) + 자격 증명 파일 경로. 자격 증명 값은 인자 · 환경 변수로 받지 않는다(프로세스 목록 · 셸 기록에 남는다).
 * - 자격 증명 파일: JSON {"username","password"} 또는 두 줄. 오류 문구에 값을 넣지 않는다. 그룹 · 다른 사용자가 읽을 수 있으면 경고.
 * - 번호 위치: 찍을 때 잰 요소 사각형 → 이미지 % (보이는 부분만, 가장자리 안쪽). 보이지 않으면 null(추정하지 않는다).
 * - 파일 이름: <id>.<sha-256 앞 10자>.<webp|png> — 페이지의 GUIDE_FILE_RE 와 같은 모양. 결과 합치기 · 고아 파일 · 크기 보고.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  anchorPoint, checkLocalBase, credentialFileWarning, findColumn, hashedName, maskedVariant, mergeManifest, parseArgs, parseCredentials, realDataVerdict, sizeReport, staleFiles,
  statsPanelsVerdict,
} from "../scripts/guide-capture-lib.mjs";
import { GUIDE_FILE_RE, parseManifest, PLAN } from "@/lib/guide";

const SECRET = "correct-horse-battery";

describe("arguments", () => {
  it("base URL + credentials file path, options --only / --out-dir / --quality", () => {
    expect(parseArgs(["http://localhost:8700", "/tmp/cred.json"])).toEqual({ baseUrl: "http://localhost:8700", credFile: "/tmp/cred.json", only: null, outDir: null, quality: 0.86, allowFixture: false });
    expect(parseArgs(["http://127.0.0.1:8700/", "c.txt", "--only", "stats,airport", "--out-dir", "/tmp/o", "--quality", "0.9"]))
      .toMatchObject({ only: ["stats", "airport"], outDir: "/tmp/o", quality: 0.9 });
  });
  it("refuses credentials as argument values and anything unknown; the message never echoes the value", () => {
    for (const bad of [["--password", SECRET], ["--user", "admin"], [`--password=${SECRET}`], ["--token", SECRET]]) {
      let msg = "";
      try { parseArgs(["http://localhost:8700", "c.json", ...bad]); } catch (e) { msg = (e as Error).message; }
      expect(msg).toMatch(/자격 증명은 파일/);
      expect(msg).not.toContain(SECRET);
    }
    expect(() => parseArgs(["http://localhost:8700"])).toThrow(/사용법/);
    expect(() => parseArgs(["http://localhost:8700", "c.json", "--quality", "2"])).toThrow(/quality/);
    expect(() => parseArgs(["http://localhost:8700", "c.json", "--bogus"])).toThrow(/알 수 없는/);
  });
  it("base URL must be a local stack (credentials are sent there) without userinfo", () => {
    expect(checkLocalBase("http://localhost:8700/")).toBe("http://localhost:8700");
    expect(checkLocalBase("http://127.0.0.1:8700")).toBe("http://127.0.0.1:8700");
    expect(checkLocalBase("http://[::1]:8700")).toBe("http://[::1]:8700");
    expect(checkLocalBase("http://wakeline.localhost:8700")).toBe("http://wakeline.localhost:8700");
    for (const bad of ["https://example.com", "http://10.0.0.5:8700", "ftp://localhost", "http://user:pw@localhost:8700", "localhost:8700"]) expect(() => checkLocalBase(bad)).toThrow();
  });
});

describe("real-data guard (/api/v1/status, before and after the captures)", () => {
  const real = { fixture_mode: false, collector_mode_known: true, server_time: "2026-09-29T05:22:11Z" };
  it("passes only when the stack says it collects real data", () => {
    expect(realDataVerdict(200, real)).toBeNull();
  });
  it("stops on FIXTURE MODE, an unknown collector mode, a missing or wrong field, a non-200 answer or an unreadable body", () => {
    expect(realDataVerdict(200, { ...real, fixture_mode: true })).toMatch(/FIXTURE MODE/);
    expect(realDataVerdict(200, { ...real, collector_mode_known: false })).toMatch(/모름/);
    expect(realDataVerdict(200, { collector_mode_known: true })).toMatch(/fixture_mode/);
    expect(realDataVerdict(200, { ...real, fixture_mode: "false" })).toMatch(/fixture_mode/);
    expect(realDataVerdict(503, null)).toMatch(/HTTP 503/);
    expect(realDataVerdict(0, null)).toMatch(/응답 없음/);
    expect(realDataVerdict(200, null)).toMatch(/객체가 아님/);
    expect(realDataVerdict(200, [real])).toMatch(/객체가 아님/);
  });
});

describe("masks (operator-only screens)", () => {
  it("finds a column by its exact header text (spaces normalised); a missing header is -1 so the shot fails closed", () => {
    const heads = ["시각(KST)", "수준", "서비스", "로거", "메시지(첫 줄)", "억제", "요청 id"];
    expect(findColumn(heads, "메시지(첫 줄)")).toBe(4);
    expect(findColumn(["provider", " last\n error ", "switch"], "last error")).toBe(1);
    expect(findColumn(heads, "요청")).toBe(-1); // 앞부분만 같으면 아니다
    expect(findColumn([], "로거")).toBe(-1);
  });
  it("the capture condition says what was hidden (and stays within the 120 characters the page accepts)", () => {
    expect(maskedVariant("providers 탭", ["운영자 이름", "공급자 마지막 오류"])).toBe("providers 탭 · 가림: 운영자 이름 · 공급자 마지막 오류");
    expect(maskedVariant(null, ["운영자 이름"])).toBe("가림: 운영자 이름");
    expect(maskedVariant("기간 24 h", [])).toBe("기간 24 h");
    expect(maskedVariant(null, [])).toBeNull();
    expect(() => maskedVariant("x".repeat(110), ["운영자 이름"])).toThrow(/120/);
  });
});

describe("credentials file", () => {
  it("reads JSON or two lines; trims only line endings of the password", () => {
    expect(parseCredentials(JSON.stringify({ username: "admin", password: SECRET }))).toEqual({ username: "admin", password: SECRET });
    expect(parseCredentials(`admin\n${SECRET}\n`)).toEqual({ username: "admin", password: SECRET });
    expect(parseCredentials(`admin\r\n ${SECRET} \r\n`)).toEqual({ username: "admin", password: ` ${SECRET} ` });
  });
  it("rejects malformed files without echoing any value", () => {
    for (const bad of ["", "admin", JSON.stringify({ username: "admin" }), JSON.stringify({ username: "bad user", password: SECRET }), `admin\nshort`, `{"username": "admin", "password": ${JSON.stringify(SECRET)}`]) {
      let msg = "";
      try { parseCredentials(bad); } catch (e) { msg = (e as Error).message; }
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toContain(SECRET);
      expect(msg).not.toContain("short");
    }
  });
  it("warns when group/others can read the file", () => {
    expect(credentialFileWarning(0o100600)).toBeNull();
    expect(credentialFileWarning(0o100400)).toBeNull();
    expect(credentialFileWarning(0o100644)).toMatch(/0644.*chmod 600/);
  });
});

describe("callout position", () => {
  const vp = { width: 1440, height: 900 };
  it("anchors inside the visible part of the element, as % of the image, 0.1 precision", () => {
    const r = { left: 100, top: 50, width: 200, height: 40 };
    expect(anchorPoint(r, "tl", vp)).toEqual({ x: 7.8, y: 6.9 }); // (112, 62)
    expect(anchorPoint(r, "l", vp)).toEqual({ x: 7.8, y: 7.8 }); // (112, 70)
    expect(anchorPoint(r, "r", vp)).toEqual({ x: 20, y: 7.8 }); // (288, 70)
    expect(anchorPoint(r, "c", vp)).toEqual({ x: 13.9, y: 7.8 }); // (200, 70)
    expect(anchorPoint(r, "t", vp)).toEqual({ x: 13.9, y: 6.9 }); // (200, 62)
    expect(anchorPoint(r, "br", vp)).toEqual({ x: 20, y: 8.7 }); // (288, 78)
    expect(anchorPoint({ left: 0, top: 0, width: 8, height: 8 }, "tl", vp)).toEqual({ x: 1.5, y: 1.5 }); // 가장자리 안쪽으로 당김
  });
  it("partly off screen → the visible part; hidden, empty or fully off screen → null (never guessed)", () => {
    expect(anchorPoint({ left: -100, top: 880, width: 300, height: 100 }, "tl", vp)).toEqual({ x: 1.5, y: 98.5 });
    expect(anchorPoint(null, "tl", vp)).toBeNull();
    expect(anchorPoint({ left: 10, top: 10, width: 0, height: 20 }, "tl", vp)).toBeNull();
    expect(anchorPoint({ left: 1500, top: 10, width: 50, height: 20 }, "tl", vp)).toBeNull();
    expect(anchorPoint({ left: 10, top: -50, width: 50, height: 20 }, "tl", vp)).toBeNull();
  });
});

describe("files and manifest", () => {
  it("hashed file names match the page's file pattern and change with the content", () => {
    const a = hashedName("dashboard", new Uint8Array([1, 2, 3]), "webp");
    const b = hashedName("dashboard", new Uint8Array([1, 2, 4]), "webp");
    expect(a).toMatch(GUIDE_FILE_RE);
    expect(a).not.toBe(b);
    expect(hashedName("dashboard", new Uint8Array([1, 2, 3]), "png")).toMatch(/^dashboard\.[0-9a-f]{10}\.png$/);
  });
  const entry = (id: string, hash: string) => ({ file: `${id}.${hash}.webp`, format: "webp", width: 1440, height: 900, bytes: 10, captured_at: "2026-09-29T05:22:11.000Z", variant: null, callouts: [] });
  it("merge keeps earlier shots not captured this run, replaces captured ones, drops shots no longer planned, in plan order", () => {
    const ids = PLAN.shots.map((s) => s.id);
    const prev = { version: 1, shots: { [ids[2]]: entry(ids[2], "aaaaaaaaaa"), [ids[0]]: entry(ids[0], "bbbbbbbbbb"), gone: entry("gone", "cccccccccc") } };
    const m = mergeManifest(prev, { [ids[0]]: entry(ids[0], "dddddddddd"), [ids[1]]: entry(ids[1], "eeeeeeeeee") }, ids);
    expect(Object.keys(m.shots)).toEqual([ids[0], ids[1], ids[2]]);
    expect(m.shots[ids[0]].file).toBe(`${ids[0]}.dddddddddd.webp`);
    expect(m.shots[ids[2]].file).toBe(`${ids[2]}.aaaaaaaaaa.webp`);
    expect(parseManifest(m, PLAN).dropped).toEqual([]); // 페이지가 그대로 읽는다
    expect(mergeManifest("not json", {}, ids)).toEqual({ version: 1, shots: {} });
  });
  it("stale files: only names in the capture pattern that the manifest no longer references (never other files)", () => {
    const m = { version: 1, shots: { dashboard: entry("dashboard", "dddddddddd") } };
    expect(staleFiles(["dashboard.dddddddddd.webp", "dashboard.bbbbbbbbbb.webp", "stats.aaaaaaaaaa.png", "README.md", "logo.webp", ".DS_Store"], m))
      .toEqual(["dashboard.bbbbbbbbbb.webp", "stats.aaaaaaaaaa.png"]);
  });
  it("size report: one line per shot with format, size vs PNG, visible callouts, and the total", () => {
    const text = sizeReport([
      { id: "dashboard", format: "webp", bytes: 102_400, pngBytes: 409_600, callouts: [8, 9], variant: "한반도 #6.3/36.1/127.9" },
      { id: "stats", format: "png", bytes: 51_200, pngBytes: 51_200, callouts: [5, 5], variant: null },
    ], [{ id: "ship", reason: "후보 해역에 선박 없음" }]);
    expect(text).toMatch(/dashboard\s+webp\s+100 KB\s+400 KB\s+25%\s+8\/9/);
    expect(text).toMatch(/stats\s+png\s+50 KB\s+50 KB\s+100%\s+5\/5/);
    expect(text).toMatch(/합계\s+150 KB/);
    expect(text).toContain("ship — 건너뜀: 후보 해역에 선박 없음");
  });
});

describe("capture recipes (scripts/guide-screenshots.mjs)", () => {
  // 계획(lib/guide-shots.json)의 스크린샷마다 캡처 방법(RECIPES 의 키)이 있어야 한다 — 없으면 스크립트가 그 그림을 늘 건너뛴다(자리표시로 남는다)
  const src = readFileSync(new URL("../scripts/guide-screenshots.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("const RECIPES = {"), src.indexOf("\n};\n", src.indexOf("const RECIPES = {")));
  const keys = [...body.matchAll(/^ {2}(?:async )?(?:"([a-z0-9-]+)"|([a-z0-9]+))\(shot\)/gm)].map((m) => m[1] ?? m[2]);
  it("every planned shot has a recipe and every recipe a planned shot", () => {
    expect(keys.length).toBeGreaterThan(0);
    expect([...keys].sort()).toEqual(PLAN.shots.map((s) => s.id).sort());
  });
  it("the new feature figures have slots: port calls on the ship card, the coastal traffic layer", () => {
    expect(PLAN.shots.find((s) => s.id === "port-calls")?.section).toBe("dashboard-ship");
    expect(PLAN.shots.find((s) => s.id === "traffic")?.section).toBe("dashboard-layers");
    // 해결 표시(ADR-024)는 로그 화면 그림의 번호로(운영 화면의 공급자 last error 칸은 가려 찍으므로 거기에 번호를 두지 않는다)
    const logs = PLAN.shots.find((s) => s.id === "logs")!;
    expect(logs.callouts.map((c) => c.target)).toEqual(expect.arrayContaining(['[aria-label="해결 표시"]', '[data-testid="logs-hidden-resolved"]']));
  });
});

/**
 * 2026-09-30 22:49 KST 배포 직후 캡처에서 본 두 결함(수정 전 실패를 먼저 확인했다):
 * - stats: 4 s 만 기다려, api 재시작 직후 DB 가 바쁠 때 네 패널이 받는 중인 채로(그때는 '자료 없음'으로 보였다) 찍혔다. 이제 패널마다의 data-state 가 모두
 *   loading 을 벗어날 때까지 기다리고, 오류 패널이 있으면 그 까닭과 함께 건너뛴다(자료 전 · 실패 화면이 설명서에 실리지 않게).
 * - reception: 앞 그림(traffic)이 켠 연안 교통량 레이어가 이 브라우저에 기억되어 켜진 채 해안을 덮었고, 범례의 관측 수신 절이 범례 창 아래로 밀려 번호 3
 *   ([data-testid="legend-reception"])이 기록되지 않았다. 이제 연안 교통량을 끄고, 번호를 재기 전에 그 절을 범례 창 안으로 굴린다.
 */
describe("capture recipes: stats waits for every panel; reception turns the coastal traffic layer off and brings the legend section into view", () => {
  const src = readFileSync(new URL("../scripts/guide-screenshots.mjs", import.meta.url), "utf8");
  const recipe = (id: string) => {
    const i = src.search(new RegExp(`^ {2}async (?:"${id}"|${id})\\(shot\\) \\{`, "m"));
    expect(i, id).toBeGreaterThan(0);
    return src.slice(i, src.indexOf("\n  },\n", i));
  };
  it("statsPanelsVerdict: waits while any panel is loading, skips with the panel and its reason on error or a missing panel, else shoots", () => {
    const p = (id: string, state: string, text = "") => ({ id, state, text });
    expect(statsPanelsVerdict([p("fir", "ready"), p("hazard", "loading"), p("traffic", "ready"), p("alerts", "empty")])).toEqual({ wait: true, skip: null });
    expect(statsPanelsVerdict([p("fir", "ready"), p("hazard", "empty"), p("traffic", "ready"), p("alerts", "empty")])).toEqual({ wait: false, skip: null });
    const err = statsPanelsVerdict([p("fir", "ready"), p("hazard", "empty"), p("traffic", "ready"), p("alerts", "error", "조회 실패 — stats unavailable(HTTP 503)\n다시 시도")]);
    expect(err.wait).toBe(false);
    expect(err.skip).toContain("alerts");
    expect(err.skip).toContain("조회 실패 — stats unavailable(HTTP 503)");
    // 오류가 받는 중보다 먼저 — 하나라도 실패했으면 기다리지 않고 건너뛴다
    expect(statsPanelsVerdict([p("fir", "loading"), p("hazard", "error", "조회 실패"), p("traffic", "ready"), p("alerts", "empty")]).skip).toContain("hazard");
    // 네 패널이 다 있지 않으면(화면이 바뀜 · 다른 판) 찍지 않는다 — 모양을 추정하지 않는다
    expect(statsPanelsVerdict([p("fir", "ready")]).skip).toMatch(/패널 1개/);
    expect(statsPanelsVerdict([p("fir", "ready"), p("hazard", "odd"), p("traffic", "ready"), p("alerts", "empty")]).skip).toMatch(/hazard.*odd/);
  });
  it("stats: waits on the panels' data-state (not a fixed 4 s) and skips with the reason when a panel failed", () => {
    const r = recipe("stats");
    expect(r).not.toMatch(/wait\(4_000\)/);
    expect(r).toContain("data-stats-panel");
    expect(r).toContain("data-state");
    expect(r).toMatch(/statsPanelsVerdict\(/);
    expect(r).toMatch(/throw new Skip\(/);
    expect(src).toMatch(/import \{[^}]*statsPanelsVerdict[^}]*\} from "\.\/guide-capture-lib\.mjs"/);
  });
  it("reception: the coastal traffic layer is off (openMap) and the legend's reception section is scrolled into view before the callouts are measured", () => {
    const r = recipe("reception");
    expect(r.indexOf("await openMap(")).toBeGreaterThanOrEqual(0);
    expect(r.indexOf("await openMap(")).toBeLessThan(r.indexOf('setPressed("layer-reception", true)'));
    expect(r).not.toMatch(/setPressed\("layer-traffic", true\)/);
    const scroll = r.search(/getByTestId\("legend-reception"\)\.scrollIntoViewIfNeeded\(/);
    expect(scroll).toBeGreaterThan(0);
    expect(scroll).toBeLessThan(r.lastIndexOf("return ")); // 번호는 레시피가 돌아온 뒤에 잰다(measure) — 그 전에 굴린다
  });
  /**
   * 리뷰 2026-10-01: 레이어 켜짐은 이 브라우저에 기억되고(lib/prefs LAYERS_KEY — LayerPanel 이 열 때 읽는다) 캡처는 한 문맥으로 모두 찍는다. reception 이 켠 관측
   * 수신 칸이 뒤의 port-calls · alerts · radar 에, traffic 이 켠 연안 교통량이 search · aircraft · ship 에 남았다. 이제 openMap 이 겹쳐 그리는 레이어를 모두 끄고
   * 시작한다 — 레시피 하나를 고치는 대신. 수정 전 실패.
   */
  it("openMap turns every overlay layer off once the map is open, so a layer an earlier shot turned on is not carried into the next shot", () => {
    const at = src.indexOf("async function openMap(");
    expect(at).toBeGreaterThan(0);
    const open = src.slice(at, src.indexOf("\n}\n", at));
    const list = /const OVERLAY_LAYERS = \[([^\]]*)\]/.exec(src);
    expect(list, "OVERLAY_LAYERS").not.toBeNull();
    const overlays = [...list![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(overlays).toEqual(expect.arrayContaining(["layer-traffic", "layer-reception"]));
    expect(open).toMatch(/for \(const id of OVERLAY_LAYERS\) await setPressed\(id, false\)/);
    // 실시간 연결이 열린 뒤(LayerPanel 이 저장된 켜짐을 읽은 뒤) 끈다 — 그 전이면 저장값이 다시 켠다
    expect(open.indexOf("OVERLAY_LAYERS")).toBeGreaterThan(open.indexOf('getByTestId("conn")'));
  });
  it("a recipe turns on only the ships layer (set by every map recipe) or an overlay that openMap resets — traffic only in 'traffic', reception only in 'reception'", () => {
    const list = /const OVERLAY_LAYERS = \[([^\]]*)\]/.exec(src);
    const overlays = [...(list?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const ids = [...src.matchAll(/^ {2}async (?:"([\w-]+)"|(\w+))\(shot\) \{/gm)].map((m) => m[1] ?? m[2]);
    expect(ids).toEqual(expect.arrayContaining(["traffic", "reception", "search", "aircraft", "ship", "port-calls", "alerts", "radar"]));
    for (const id of ids) {
      const r = recipe(id);
      const on = [...r.matchAll(/setPressed\("([\w-]+)", true\)/g)].map((m) => m[1]);
      for (const layer of on) expect(layer === "layer-ships" || overlays.includes(layer), `${id} turns ${layer} on`).toBe(true);
      if (r.includes("openMap(")) expect(r, `${id} sets the ships layer explicitly`).toMatch(/setPressed\("layer-ships", (true|false)\)/);
      expect(on.includes("layer-traffic"), `${id}: traffic`).toBe(id === "traffic");
      expect(on.includes("layer-reception"), `${id}: reception`).toBe(id === "reception");
    }
  });
  it("the other recipes are unchanged in what they wait for (traffic still turns its own layer on)", () => {
    expect(recipe("traffic")).toMatch(/setPressed\("layer-traffic", true\)/);
    expect(recipe("dashboard")).toMatch(/wait\(10_000\)/);
  });
});

