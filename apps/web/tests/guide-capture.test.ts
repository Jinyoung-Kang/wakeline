/**
 * 설명서 캡처 스크립트(scripts/guide-screenshots.mjs)의 순수 부분(scripts/guide-capture-lib.mjs) — 브라우저 없이.
 * - 인자: 기준 주소(로컬 스택만) + 자격 증명 파일 경로. 자격 증명 값은 인자 · 환경 변수로 받지 않는다(프로세스 목록 · 셸 기록에 남는다).
 * - 자격 증명 파일: JSON {"username","password"} 또는 두 줄. 오류 문구에 값을 넣지 않는다. 그룹 · 다른 사용자가 읽을 수 있으면 경고.
 * - 번호 위치: 찍을 때 잰 요소 사각형 → 이미지 % (보이는 부분만, 가장자리 안쪽). 보이지 않으면 null(추정하지 않는다).
 * - 파일 이름: <id>.<sha-256 앞 10자>.<webp|png> — 페이지의 GUIDE_FILE_RE 와 같은 모양. 결과 합치기 · 고아 파일 · 크기 보고.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  anchorPoint, awaitReading, checkLocalBase, checkStack, chipCount, credentialFileWarning, Fatal, findColumn, fixtureVariant, hashedName, HOT_WAIT_MS, hotReading, hotVariant, isHotActive,
  MAP_PROBE, mapProbeInPage, maskedVariant, mergeManifest, parseArgs, parseCredentials, READ_TRIES, READINGS, realDataVerdict, selectShots, shootStable, sizeReport, Skip, STACK_UNCHECKED,
  stableRead, stackNote, stackTransition, staleFiles, statsPanelsVerdict, until, withStackNote, worldReading, worldVariant,
} from "../scripts/guide-capture-lib.mjs";
import manifestJson from "@/lib/guide-manifest.json";
import { DemandBadge } from "@/components/MapChips";
import { StatusBarView } from "@/components/StatusBar";
import { FOCUS_STATES, focusChip, HOT_STATES, hotChip } from "@/lib/demand";
import { GUIDE_FILE_RE, parseManifest, PLAN } from "@/lib/guide";
import { statusChips, type StatusInput } from "@/lib/statusbar";
import { WS_INVALID_NONE } from "@/lib/store";
import type { FeedInfo } from "@/lib/types";
import { HOT_MIN_ZOOM } from "@/lib/viewport";
import { GLOBAL_STALE_S } from "@/lib/ws-protocol";
import { byTestId, classes, findAll, parseHtml, textOf, type HNode } from "./helpers/html-tree";
import { oneLine, scriptCode } from "./helpers/script-code";

const SECRET = "correct-horse-battery";

describe("arguments", () => {
  it("base URL + credentials file path, options --only / --out-dir / --quality", () => {
    expect(parseArgs(["http://localhost:8700", "/tmp/cred.json"])).toEqual({ baseUrl: "http://localhost:8700", credFile: "/tmp/cred.json", only: null, skip: null, outDir: null, quality: 0.86, allowFixture: false });
    expect(parseArgs(["http://127.0.0.1:8700/", "c.txt", "--only", "stats,airport", "--out-dir", "/tmp/o", "--quality", "0.9"]))
      .toMatchObject({ only: ["stats", "airport"], skip: null, outDir: "/tmp/o", quality: 0.9 });
  });
  /**
   * --skip(리뷰 2026-10-01): README 내보내기 설정은 운영 · 로그를 fixture 스택 그림으로 적는다(readme-images.json fixture: true). 실데이터 스택에서 모든 그림을
   * 찍으면 운영 · 로그도 실데이터로 바뀌어 내보내기가 거절했다 — 그 둘을 빼고 찍는다(--skip ops,logs). --only 와 함께 쓰지 않는다.
   */
  it("--skip id,… leaves those shots out; --only and --skip together, or either one empty, are refused", () => {
    expect(parseArgs(["http://localhost:8700", "c.json", "--skip", "ops, logs"])).toMatchObject({ only: null, skip: ["ops", "logs"] });
    expect(() => parseArgs(["http://localhost:8700", "c.json", "--skip"])).toThrow(/--skip 뒤에/);
    expect(() => parseArgs(["http://localhost:8700", "c.json", "--only", "stats", "--skip", "ops"])).toThrow(/함께/);
  });
  it("selectShots: plan order; --only keeps, --skip drops; an id the plan does not have, or nothing left, is refused", () => {
    const ids = ["dashboard", "world", "stats", "ops", "logs"];
    expect(selectShots(ids, { only: null, skip: null })).toEqual(ids);
    expect(selectShots(ids, { only: ["logs", "world"], skip: null })).toEqual(["world", "logs"]);
    expect(selectShots(ids, { only: null, skip: ["ops", "logs"] })).toEqual(["dashboard", "world", "stats"]);
    expect(() => selectShots(ids, { only: ["world", "nosuch"], skip: null })).toThrow(/--only: 계획에 없는 스크린샷 nosuch \(있는 것: dashboard, world, stats, ops, logs\)/);
    expect(() => selectShots(ids, { only: null, skip: ["opz"] })).toThrow(/--skip: 계획에 없는 스크린샷 opz/);
    expect(() => selectShots(ids, { only: null, skip: ids })).toThrow(/찍을 스크린샷이 없음/);
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

/**
 * --allow-fixture 로 찍은 그림은 캡처 조건 맨 앞에 그 스택이 실데이터가 아니라고 적는다 — 전에는 운영자가 manifest 를 손으로 고쳐 '격리 fixture 스택' 을 붙였다.
 * README 내보내기(scripts/readme-images.mjs)는 이 표시(fixtureVariant)로 fixture 그림을 알아보고, README 캡션이 밝히지 않으면 내보내지 않는다.
 */
describe("a stack not confirmed live (--allow-fixture) is named in every capture condition", () => {
  const real = { fixture_mode: false, collector_mode_known: true };
  it("stackNote: null for a live stack; the fixture stack, or an unknown collector mode, otherwise", () => {
    expect(stackNote(200, real)).toBeNull();
    expect(stackNote(200, { ...real, fixture_mode: true })).toBe("fixture 스택(가짜 자료)");
    expect(stackNote(200, { ...real, collector_mode_known: false })).toBe("수집 모드 모름(fixture 허용으로 찍음)");
    expect(stackNote(0, null)).toBe("수집 모드 모름(fixture 허용으로 찍음)");
    expect(stackNote(503, null)).toBe("수집 모드 모름(fixture 허용으로 찍음)");
  });
  it("withStackNote puts the note first; both notes, and the hand-written labels of the committed ops/logs figures, read as fixture", () => {
    expect(withStackNote("fixture 스택(가짜 자료)", "providers 탭")).toBe("fixture 스택(가짜 자료) · providers 탭");
    expect(withStackNote(null, "providers 탭")).toBe("providers 탭");
    expect(withStackNote("fixture 스택(가짜 자료)", null)).toBe("fixture 스택(가짜 자료)");
    expect(withStackNote(null, null)).toBeNull();
    for (const note of [stackNote(200, { ...real, fixture_mode: true }), stackNote(0, null)]) expect(fixtureVariant(withStackNote(note, "providers 탭"))).toBe(true);
    const committed = (manifestJson as { shots: Record<string, { variant: string | null }> }).shots;
    expect(fixtureVariant(committed.ops?.variant)).toBe(true);
    expect(fixtureVariant(committed.logs?.variant)).toBe(true);
    expect(fixtureVariant(committed.dashboard?.variant)).toBe(false);
    expect(fixtureVariant(null)).toBe(false);
  });

  /**
   * 리뷰 2026-10-01: 이 판단이 스크립트 안에 있어 소스 글자만 시험했고, 스택 바뀜 확인을 지우거나 --allow-fixture 면 묻지 않고 돌아가게 바꿔도 통과했다.
   * 이제 checkStack(lib)이 판단하고 동작으로 시험한다 — 스크립트의 assertRealData 는 그것을 부르기만 한다(아래 코드 모양 시험).
   */
  const asking = (answers: { code: number; body: unknown }[] | Error) => {
    const calls = { n: 0 };
    const fetchStatus = async () => {
      calls.n += 1;
      if (answers instanceof Error) throw answers;
      return answers[Math.min(calls.n, answers.length) - 1];
    };
    return { calls, fetchStatus };
  };
  const fixture = { code: 200, body: { ...real, fixture_mode: true } };
  const live = { code: 200, body: real };
  it("checkStack asks /api/v1/status every time — also with --allow-fixture — and keeps the note for every capture condition", async () => {
    const a = asking([live]);
    expect(await checkStack({ fetchStatus: a.fetchStatus, allowFixture: false, state: STACK_UNCHECKED, when: "찍기 전 확인" })).toEqual({ note: null, checked: true });
    expect(a.calls.n).toBe(1);
    const b = asking([fixture]);
    expect(await checkStack({ fetchStatus: b.fetchStatus, allowFixture: true, state: STACK_UNCHECKED, when: "찍기 전 확인" })).toEqual({ note: "fixture 스택(가짜 자료)", checked: true });
    expect(b.calls.n).toBe(1); // --allow-fixture 여도 물어서 표시를 정한다
    const c = asking(new Error("ECONNREFUSED"));
    expect(await checkStack({ fetchStatus: c.fetchStatus, allowFixture: true, state: STACK_UNCHECKED, when: "찍기 전 확인" })).toEqual({ note: "수집 모드 모름(fixture 허용으로 찍음)", checked: true });
  });
  it("checkStack stops (Fatal) on a stack not confirmed live without --allow-fixture, naming when and why", async () => {
    for (const [answers, why] of [[[fixture], /FIXTURE MODE/], [[{ code: 200, body: { ...real, collector_mode_known: false } }], /모름/], [new Error("ECONNREFUSED"), /응답 없음/]] as const) {
      const a = asking(answers as never);
      const p = checkStack({ fetchStatus: a.fetchStatus, allowFixture: false, state: STACK_UNCHECKED, when: "다 찍은 뒤 확인" });
      await expect(p).rejects.toBeInstanceOf(Fatal);
      await expect(p).rejects.toThrow(why);
      await expect(p).rejects.toThrow(/^다 찍은 뒤 확인: /);
    }
  });
  it("stackTransition / checkStack: the second check must see the same stack as the first — a change between them stops", async () => {
    expect(stackTransition(null, "fixture 스택(가짜 자료)", false)).toBeNull(); // 첫 확인
    expect(stackTransition(null, null, true)).toBeNull();
    expect(stackTransition("fixture 스택(가짜 자료)", "fixture 스택(가짜 자료)", true)).toBeNull();
    expect(stackTransition(null, "fixture 스택(가짜 자료)", true)).toMatch(/스택 상태가 바뀜\(실데이터 → fixture 스택\(가짜 자료\)\)/);
    expect(stackTransition("수집 모드 모름(fixture 허용으로 찍음)", null, true)).toMatch(/바뀜\(수집 모드 모름\(fixture 허용으로 찍음\) → 실데이터\)/);
    const first = await checkStack({ fetchStatus: asking([live]).fetchStatus, allowFixture: true, state: STACK_UNCHECKED, when: "찍기 전 확인" });
    await expect(checkStack({ fetchStatus: asking([fixture]).fetchStatus, allowFixture: true, state: first, when: "다 찍은 뒤 확인" })).rejects.toThrow(/다 찍은 뒤 확인: 찍는 사이에 스택 상태가 바뀜/);
    expect(await checkStack({ fetchStatus: asking([live]).fetchStatus, allowFixture: false, state: first, when: "다 찍은 뒤 확인" })).toEqual(first);
  });
  it("the script's assertRealData only hands its status request to checkStack, and every condition is prefixed with the kept note (code without comments)", () => {
    const S = scriptCode(new URL("../scripts/guide-screenshots.mjs", import.meta.url));
    expect(oneLine(S.fn("assertRealData"))).toBe("async function assertRealData(when) { stack = await checkStack({ fetchStatus, allowFixture: args.allowFixture, state: stack, when }); }");
    expect(oneLine(S.constant("stack"))).toBe("let stack = STACK_UNCHECKED;");
    const ask = oneLine(S.constant("fetchStatus"));
    expect(ask).toContain("page.request.get(`${BASE}/api/v1/status`");
    expect(ask).not.toMatch(/allowFixture/);
    expect(S.code).toMatch(/maskedVariant\(withStackNote\(stack\.note, /);
    // 건너뜀 · 멈춤은 lib 의 같은 클래스(lib 함수가 던진 Skip 을 스크립트가 알아본다)
    expect(S.code).not.toMatch(/class (Skip|Fatal)\b/);
    expect(S.code).toMatch(/import \{[^}]*\bSkip\b[^}]*\} from "\.\/guide-capture-lib\.mjs"/);
    expect(S.code).toMatch(/import \{[^}]*\bFatal\b[^}]*\} from "\.\/guide-capture-lib\.mjs"/);
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

/** 캡처 스크립트의 코드(주석 없음 — tests/helpers/script-code) */
const SCRIPT = scriptCode(new URL("../scripts/guide-screenshots.mjs", import.meta.url));

describe("capture recipes (scripts/guide-screenshots.mjs)", () => {
  // 계획(lib/guide-shots.json)의 스크린샷마다 캡처 방법(RECIPES 의 키)이 있어야 한다 — 없으면 스크립트가 그 그림을 늘 건너뛴다(자리표시로 남는다)
  const keys = SCRIPT.recipeIds;
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
  const recipe = (id: string) => SCRIPT.recipe(id);
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
    expect(r).not.toMatch(/wait\(4000\)/);
    expect(r).toContain("data-stats-panel");
    expect(r).toContain("data-state");
    expect(r).toMatch(/statsPanelsVerdict\(/);
    expect(r).toMatch(/throw new Skip\(/);
    expect(SCRIPT.code).toMatch(/import \{[^}]*statsPanelsVerdict[^}]*\} from "\.\/guide-capture-lib\.mjs"/);
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
    const open = oneLine(SCRIPT.fn("openMap"));
    const overlays = SCRIPT.stringArray("OVERLAY_LAYERS");
    expect(overlays).toEqual(expect.arrayContaining(["layer-traffic", "layer-reception"]));
    expect(open).toMatch(/for \(const id of OVERLAY_LAYERS\) await setPressed\(id, false\);/);
    // 실시간 연결이 열린 뒤(LayerPanel 이 저장된 켜짐을 읽은 뒤) 끈다 — 그 전이면 저장값이 다시 켠다
    expect(open.indexOf("OVERLAY_LAYERS")).toBeGreaterThan(open.indexOf('getByTestId("conn")'));
  });
  it("a recipe turns on only the ships layer (set by every map recipe) or an overlay that openMap resets — traffic only in 'traffic', reception only in 'reception'", () => {
    const overlays = SCRIPT.stringArray("OVERLAY_LAYERS");
    const ids = SCRIPT.recipeIds;
    expect(ids).toEqual(expect.arrayContaining(["world", "traffic", "reception", "search", "aircraft", "hot", "ship", "port-calls", "alerts", "radar"]));
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
    expect(recipe("dashboard")).toMatch(/wait\(10000\)/);
  });
});


/**
 * README · 설명서의 두 그림(2026-10-01): 전세계 보기(world)와 관심 지역 밖 핫 리전(hot).
 * - world: 줌 5 이하(서버가 넓은 구독을 받는 줌) · 핫 리전 줌 미만. 상태 바 world 칩이 정상(전세계 피드가 있고 오래되지 않음 — data-health "ok")이고
 *   aircraft 칩이 1 이상일 때만 찍는다(관심 지역만 찍힌 '전세계' 그림을 싣지 않는다).
 * - hot: 줌 ≥ HOT_MIN_ZOOM 으로 관심 지역 밖(도쿄)을 열고 아무것도 고르지 않는다. 지도 칩이 핫 리전 '갱신'(서버 상태 active)일 때만 찍는다. active 는 수집기가
 *   그 칸의 조회에 성공해 발행했다는 서버 보고다(collector jobs/demand.py _run_hot — 받은 항공기가 0 대여도 active, api 는 마지막 성공이 max(15 s, 주기 × 3)
 *   안일 때만 active 로 보낸다). 지도의 어느 항공기가 핫 리전으로 받은 것인지는 증명하지 않는다 — 상태 바 aircraft 는 여러 피드를 합친 목록의 수다.
 * - 두 그림의 캡처 조건은 화면에서 읽은 값(칩 글자 · 항공기 수)이다 — 찍기 전후 두 번 읽어 같을 때만 싣는다(차분이 10 s 마다 와 수가 바뀔 수 있다).
 * 리뷰 2026-10-01: 판정 · 기다림 · 전후 읽기가 스크립트 안에 있어 소스 글자만 시험했고, 확인을 지우거나 기다리지 않게 바꿔도 통과했다. 이제 판정(worldReading ·
 * hotReading) · 상한 있는 기다림(until · awaitReading — 시계를 넘긴다) · 전후 읽기(stableRead · shootStable)를 lib 의 함수로 옮겨 동작으로 시험하고,
 * 화면에서 읽는 함수(mapProbeInPage — 브라우저에서 page.evaluate 로 도는 그 함수)는 화면 코드의 실제 마크업(서버 렌더)으로 시험한다.
 * 스크립트는 그것들을 부르기만 한다(맨 아래 — 주석을 뺀 코드 모양).
 */
describe("world and hot figures: what proves real data is on screen", () => {
  const zoomOf = (path: string) => Number(/^\/#([\d.]+)\//.exec(path)?.[1]);
  const shot = (id: string) => PLAN.shots.find((s) => s.id === id)!;

  it("plan: world is a zoomed-out map (≤ 5, below the hot-region zoom) in 2.2; hot is outside the interest region at ≥ HOT_MIN_ZOOM in 2.5, after the aircraft card", () => {
    expect(shot("world").section).toBe("dashboard-map");
    expect(zoomOf(shot("world").path)).toBeLessThanOrEqual(5);
    expect(zoomOf(shot("world").path)).toBeLessThan(HOT_MIN_ZOOM);
    expect(shot("hot").section).toBe("dashboard-aircraft");
    expect(zoomOf(shot("hot").path)).toBeGreaterThanOrEqual(HOT_MIN_ZOOM);
    const ids = PLAN.shots.map((s) => s.id);
    expect(ids.indexOf("hot")).toBe(ids.indexOf("aircraft") + 1);
    expect(shot("world").callouts.map((c) => c.target)).toEqual(['[data-testid="aircraft-count"]', '[data-testid="global-lag-badge"]', '[data-testid="lag-badge"]']);
    expect(shot("hot").callouts.map((c) => c.target)).toEqual(['[data-testid="demand-map-chip"]', '[data-testid="aircraft-count"]', '[data-testid="lag-badge"]']);
  });

  it("isHotActive: true only for the chip lib/demand draws when the server reports the hot region active (any interval, any radius)", () => {
    for (const state of HOT_STATES) for (const interval_s of [null, 30, 60, 120, 7.5]) for (const radius_nm of [null, 50, 250, 120.4]) {
      const chip = hotChip({ hot: { cell: "35.5:140.0:250", radius_nm, state, interval_s }, focus: null, received_at: 0 });
      expect(chip, state).not.toBeNull();
      expect(isHotActive(chip!.kind, chip!.text), `${state} ${interval_s} ${radius_nm}`).toBe(state === "active");
    }
    // 선택 항공기의 집중 추적 칩은 핫 리전이 아니다(같은 자리 · 같은 testid)
    for (const state of FOCUS_STATES) {
      const c = focusChip({ hot: null, focus: { hex: "abc123", state, interval_s: 5, since: null }, received_at: 0 }, "abc123", 0)!;
      expect(isHotActive(c.kind, c.text), state).toBe(false);
    }
    expect(isHotActive(null, "핫 리전 30초 갱신(반경 250 NM)")).toBe(false);
    expect(isHotActive("hot", null)).toBe(false);
  });

  it("chipCount reads the status bar's aircraft chip value (String(n), or — when unknown) and nothing else", () => {
    const at = Date.parse("2026-10-01T03:00:00Z");
    const value = (n: number | null) => statusChips({
      conn: "open", reconnectAttempt: 0, lastRxAt: at, nowMs: at, srvNowMs: at, feeds: { region: null, global: null }, aircraftCount: n, status: null,
      sigmetsProvider: "", sigmetsFetchedAt: null, radar: null, radarKr: null, ais: null, snapshotVersion: 1,
    }).find((c) => c.testId === "aircraft-count")!.value;
    for (const n of [0, 7, 12_345]) expect(chipCount(value(n))).toBe(n);
    expect(chipCount(value(null))).toBeNull();
    for (const bad of ["", "1,234", "12a", "-3", null]) expect(chipCount(bad), String(bad)).toBeNull();
    expect(chipCount(" 42 ")).toBe(42);
  });

  it("the capture conditions say where the map was and what the page showed — within the 120 characters the page accepts", () => {
    expect(worldVariant("/#1.6/30/60", 9876)).toBe("전세계 #1.6/30/60 · 상태 바 aircraft 9876(구독 영역 안)");
    expect(hotVariant("/#8.2/35.55/139.9", "핫 리전 30초 갱신(반경 100 NM)", 87)).toBe("도쿄 #8.2/35.55/139.9 · 지도 칩 ‘핫 리전 30초 갱신(반경 100 NM)’ · 상태 바 aircraft 87");
    const longest = maskedVariant(withStackNote("수집 모드 모름(fixture 허용으로 찍음)", hotVariant("/#8.2/35.55/139.9", "핫 리전 120초 갱신(반경 250 NM)", 99_999)), []);
    expect(longest?.length).toBeLessThanOrEqual(120);
  });

});

/** 서버 렌더한 마크업 위의 최소 document — mapProbeInPage 가 쓰는 두 선택자 모양([data-testid="…"] · .클래스)만 받는다(다른 모양이면 시험이 깨진다) */
function markupDocument(root: HNode) {
  const el = (n: HNode | null): unknown => n && {
    getAttribute: (a: string) => n.attrs[a] ?? null,
    get textContent() { return textOf(n); },
    querySelector(sel: string) {
      const m = /^\.([\w-]+)$/.exec(sel);
      if (!m) throw new Error(`시험 문서가 모르는 선택자 ${sel}`);
      return el(findAll(n, (x) => classes(x).has(m[1]))[0] ?? null);
    },
  };
  return {
    querySelector(sel: string) {
      const m = /^\[data-testid="([\w-]+)"\]$/.exec(sel);
      if (!m) throw new Error(`시험 문서가 모르는 선택자 ${sel}`);
      return el(byTestId(root, m[1]));
    },
  };
}
/** 화면 코드의 마크업에서 mapProbeInPage(MAP_PROBE) — 캡처 때 브라우저 안에서 도는 바로 그 함수 */
function probeMarkup(html: string) {
  const g = globalThis as { document?: unknown };
  const before = g.document;
  g.document = markupDocument(parseHtml(html));
  try { return mapProbeInPage(MAP_PROBE); } finally { g.document = before; }
}

describe("world and hot: the page probe and the decisions, on the screen code's real markup", () => {
  const at = Date.parse("2026-10-01T03:00:00Z");
  const feed = (lag_s: number | null, stale: boolean | null): FeedInfo => ({ provider: "adsb.lol", fetched_at: "2026-10-01T02:59:58Z", lag_s, stale, received_at: at });
  const input = (global: FeedInfo | null, aircraftCount: number | null): StatusInput => ({
    conn: "open", reconnectAttempt: 0, lastRxAt: at, nowMs: at, srvNowMs: at, feeds: { region: feed(2, false), global }, aircraftCount, status: null,
    sigmetsProvider: "", sigmetsFetchedAt: null, radar: null, radarKr: null, ais: null, snapshotVersion: 1,
  });
  const bar = (i: StatusInput) => renderToStaticMarkup(createElement(StatusBarView, { input: i, inv: WS_INVALID_NONE }));
  const hot = (state: (typeof HOT_STATES)[number], interval_s: number | null = 30) => hotChip({ hot: { cell: "35.5:140.0:250", radius_nm: 100, state, interval_s }, focus: null, received_at: 0 })!;
  const badge = (chip: ReturnType<typeof hotChip>) => renderToStaticMarkup(createElement(DemandBadge, { chip: chip!, testId: "demand-map-chip" }));
  const WORLD = "/#1.6/30/60", TOKYO = "/#8.2/35.55/139.9";

  it("world: a fresh world feed and a counted list pass with the count read from the page; no world feed, a stale one, no count or no status bar skip with the reason", () => {
    expect(worldReading(probeMarkup(bar(input(feed(3, false), 4321))), WORLD)).toEqual({ variant: "전세계 #1.6/30/60 · 상태 바 aircraft 4321(구독 영역 안)" });
    expect(worldReading(probeMarkup(bar(input(null, 4321))), WORLD)).toEqual({ skip: "상태 바 world 칩이 정상이 아님(unknown) — 전세계 피드가 없거나 오래됨" });
    expect(worldReading(probeMarkup(bar(input(feed(3, true), 4321))), WORLD).skip).toMatch(/정상이 아님\(bad\)/); // 서버 판정 오래됨
    expect(worldReading(probeMarkup(bar(input(feed(GLOBAL_STALE_S + 1, false), 4321))), WORLD).skip).toMatch(/정상이 아님\(bad\)/); // 기준 초과
    expect(worldReading(probeMarkup(bar(input(feed(3, false), 0))), WORLD)).toEqual({ skip: "상태 바 aircraft 수가 1 이상이 아님(0)" });
    expect(worldReading(probeMarkup(bar(input(feed(3, false), null))), WORLD)).toEqual({ skip: "상태 바 aircraft 수가 1 이상이 아님(—)" });
    expect(worldReading(probeMarkup("<main></main>"), WORLD).skip).toMatch(/칩 없음/);
  });

  it("hot: only the active hot-region chip with a counted list passes, quoting the chip as drawn; any other hot state, the focus chip, no chip or no count skip", () => {
    const page = (chip: ReturnType<typeof hotChip> | null, n: number | null) => probeMarkup((chip ? badge(chip) : "") + bar(input(feed(3, false), n)));
    expect(hotReading(page(hot("active"), 87), TOKYO)).toEqual({ variant: `도쿄 #8.2/35.55/139.9 · 지도 칩 ‘${hot("active").text}’ · 상태 바 aircraft 87` });
    expect(hot("active").text).toBe("핫 리전 30초 갱신(반경 100 NM)");
    for (const state of HOT_STATES.filter((x) => x !== "active")) {
      const r = hotReading(page(hot(state, null), 87), TOKYO);
      expect(r.skip, state).toBe(`지도 칩이 핫 리전 ‘갱신’이 아님 — hot ‘${hot(state, null).text}’`);
    }
    const focus = focusChip({ hot: null, focus: { hex: "abc123", state: "active", interval_s: 5, since: null }, received_at: 0 }, "abc123", 0);
    expect(hotReading(page(focus, 87), TOKYO).skip).toMatch(/핫 리전 ‘갱신’이 아님 — focus /);
    expect(hotReading(page(null, 87), TOKYO).skip).toMatch(/칩 없음/);
    expect(hotReading(page(hot("active"), 0), TOKYO)).toEqual({ skip: "상태 바 aircraft 수가 1 이상이 아님(0)" });
    expect(hotReading(page(hot("active"), null), TOKYO)).toEqual({ skip: "상태 바 aircraft 수가 1 이상이 아님(—)" });
  });
});

/** 가짜 시계 — sleep 이 시각을 그만큼 옮긴다. 10분을 넘게 기다리면 던진다(상한이 없는 기다림이 시험을 멈춰 세우지 않고 실패하게) */
const fakeClock = () => {
  let t = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    t += ms;
    if (t > 10 * 60_000) throw new Error(`가짜 시계: ${t} ms 를 기다림 — 상한이 없다`);
  };
  return { now: () => t, sleep, sleeps };
};

describe("bounded waiting (until · awaitReading) on an injected clock", () => {
  it("until retries a Skip every second until it passes; at the limit it throws the last Skip; any other error at once", async () => {
    const c = fakeClock();
    let n = 0;
    expect(await until(async () => { if (++n < 4) throw new Skip(`아직 ${n}`); return "ok"; }, 30_000, c)).toBe("ok");
    expect(c.sleeps).toEqual([1000, 1000, 1000]);
    const d = fakeClock();
    let m = 0;
    await expect(until(async () => { throw new Skip(`아직 ${++m}`); }, 5_000, d)).rejects.toThrow("아직 6");
    expect(d.now()).toBe(5_000);
    const e = fakeClock();
    await expect(until(async () => { throw new Error("페이지 닫힘"); }, 5_000, e)).rejects.toThrow("페이지 닫힘");
    expect(e.now()).toBe(0);
  });

  /** probe 가 시각 t 에 돌려줄 값을 정한다 */
  const timed = (c: ReturnType<typeof fakeClock>, at: (t: number) => unknown) => async () => at(c.now());
  const ACTIVE = { health: "ok", chip: { kind: "hot", text: "핫 리전 30초 갱신(반경 100 NM)" }, count: "87" };
  const PENDING = { ...ACTIVE, chip: { kind: "hot", text: "핫 리전 대기(반경 100 NM)" } };

  it("hot: waits up to HOT_WAIT_MS for the chip to say active, then the settle time, and returns a reader that judges the page again", async () => {
    const c = fakeClock();
    let page: unknown = null;
    const read = await awaitReading(READINGS.hot, { path: "/#8.2/35.55/139.9", clock: c, probe: timed(c, (t) => (page = t < HOT_WAIT_MS - 1_000 ? PENDING : ACTIVE)) });
    expect(c.now()).toBe(HOT_WAIT_MS - 1_000 + READINGS.hot.settleMs); // 칩이 바뀐 때 + 정착
    expect(await read()).toBe("도쿄 #8.2/35.55/139.9 · 지도 칩 ‘핫 리전 30초 갱신(반경 100 NM)’ · 상태 바 aircraft 87");
    expect(page).toBe(ACTIVE);
    const later = await awaitReading(READINGS.hot, { path: "/#8.2/35.55/139.9", clock: fakeClock(), probe: async () => ACTIVE });
    expect(await later()).toMatch(/^도쿄/);
    // 찍을 때 다시 판정한다 — 그 사이 칩이 바뀌었으면 건너뛴다
    let now = ACTIVE as typeof ACTIVE;
    const again = await awaitReading(READINGS.hot, { path: "/#8.2/35.55/139.9", clock: fakeClock(), probe: async () => now });
    now = PENDING;
    await expect(again()).rejects.toBeInstanceOf(Skip);
  });

  it("hot never active → a Skip with the last chip text once HOT_WAIT_MS has passed (no settle, no reader)", async () => {
    const c = fakeClock();
    const p = awaitReading(READINGS.hot, { path: "/#8.2/35.55/139.9", clock: c, probe: async () => PENDING });
    await expect(p).rejects.toBeInstanceOf(Skip);
    await expect(p).rejects.toThrow(/핫 리전 ‘갱신’이 아님 — hot ‘핫 리전 대기\(반경 100 NM\)’/);
    expect(c.now()).toBe(HOT_WAIT_MS);
  });

  it("world: waits up to its own limit for a healthy world chip, then settles; never healthy → Skip at the limit", async () => {
    const c = fakeClock();
    const read = await awaitReading(READINGS.world, { path: "/#1.6/30/60", clock: c, probe: timed(c, (t) => (t < 4_000 ? { ...ACTIVE, health: "unknown" } : ACTIVE)) });
    expect(c.now()).toBe(4_000 + READINGS.world.settleMs);
    expect(await read()).toBe("전세계 #1.6/30/60 · 상태 바 aircraft 87(구독 영역 안)");
    const d = fakeClock();
    await expect(awaitReading(READINGS.world, { path: "/#1.6/30/60", clock: d, probe: async () => ({ ...ACTIVE, health: "bad" }) })).rejects.toThrow(/world 칩이 정상이 아님\(bad\)/);
    expect(d.now()).toBe(READINGS.world.limitMs);
    expect(READINGS.world.decide).toBe(worldReading);
    expect(READINGS.hot.decide).toBe(hotReading);
  });

  it("the bounds come from the system: the hot wait covers the collector's slowest hot cycle, the settle time is longer than one WS diff period", () => {
    const demand = readFileSync(new URL("../../collector/wakeline_collector/jobs/demand.py", import.meta.url), "utf8");
    const levels = /^HOT_LEVELS_S = \(([\d, ]+)\)$/m.exec(demand);
    expect(levels, "collector HOT_LEVELS_S").not.toBeNull();
    const slowest = Math.max(...levels![1].split(",").map(Number));
    expect(READINGS.hot.limitMs).toBe(HOT_WAIT_MS);
    expect(HOT_WAIT_MS).toBeGreaterThanOrEqual(slowest * 1000);
    const api = readFileSync(new URL("../../api/src/main/resources/application.yml", import.meta.url), "utf8");
    const diff = /^\s*ws-diff-interval-s:\s*(\d+)\s*$/m.exec(api);
    expect(diff, "api ws-diff-interval-s").not.toBeNull();
    expect(READINGS.hot.settleMs).toBeGreaterThan(Number(diff![1]) * 1000);
  });
});

describe("before/after read around the shot (stableRead · shootStable)", () => {
  /** read 가 차례로 돌려줄 값 · 찍은 횟수를 기록하는 가짜 */
  const fake = (values: (string | Error)[]) => {
    const log: string[] = [];
    let i = 0;
    const read = async () => {
      const v = values[Math.min(i++, values.length - 1)];
      log.push(`read ${v instanceof Error ? "!" : v}`);
      if (v instanceof Error) throw v;
      return v;
    };
    let shots = 0;
    const shoot = async () => { shots += 1; log.push(`shoot ${shots}`); return { png: `png${shots}` }; };
    return { read, shoot, log };
  };
  it("stableRead: same → done; different → try again, and at the last try a Skip with both values", () => {
    expect(stableRead("a", "a", 1)).toBe(true);
    expect(stableRead("a", "b", 1)).toBe(false);
    expect(stableRead("a", "b", READ_TRIES - 1)).toBe(false);
    expect(() => stableRead("a", "b", READ_TRIES)).toThrow(Skip);
    expect(() => stableRead("a", "b", READ_TRIES)).toThrow(`찍는 동안 화면 값이 바뀜(${READ_TRIES}번 — 마지막 a → b)`);
  });
  it("no reader: one shot, no reading", async () => {
    const f = fake([]);
    expect(await shootStable(null, f.shoot)).toEqual({ shot: { png: "png1" }, reading: null });
    expect(f.log).toEqual(["shoot 1"]);
  });
  it("reads just before and just after each shot; the condition is the value read after a shot whose two reads agree", async () => {
    const f = fake(["87", "87"]);
    expect(await shootStable(f.read, f.shoot)).toEqual({ shot: { png: "png1" }, reading: "87" });
    expect(f.log).toEqual(["read 87", "shoot 1", "read 87"]);
    const g = fake(["87", "88", "88", "88"]);
    expect(await shootStable(g.read, g.shoot)).toEqual({ shot: { png: "png2" }, reading: "88" });
    expect(g.log).toEqual(["read 87", "shoot 1", "read 88", "read 88", "shoot 2", "read 88"]);
  });
  it("values that keep changing → a Skip after READ_TRIES shots; a reader that skips at the shot is not swallowed", async () => {
    const f = fake(["1", "2", "3", "4", "5", "6", "7"]);
    await expect(shootStable(f.read, f.shoot)).rejects.toThrow(`찍는 동안 화면 값이 바뀜(${READ_TRIES}번 — 마지막 5 → 6)`);
    expect(f.log.filter((l) => l.startsWith("shoot"))).toHaveLength(READ_TRIES);
    const g = fake(["87", new Skip("지도 칩이 핫 리전 ‘갱신’이 아님 — hot ‘핫 리전 대기’") as Error]);
    await expect(shootStable(g.read, g.shoot)).rejects.toBeInstanceOf(Skip);
  });
});

/**
 * 스크립트는 위 함수들을 부르기만 한다 — 주석을 뺀 코드 모양으로 본다(주석의 같은 글자로는 통과하지 않는다).
 */
describe("the capture script calls them (code without comments)", () => {
  it("world and hot open the map with ships off and the legend closed, then hand the page probe to awaitReading with their own READINGS — no search, no selection", () => {
    for (const id of ["world", "hot"] as const) {
      const r = oneLine(SCRIPT.recipe(id));
      expect(r, id).toBe(`async ${id}(shot) { await openMap(shot.path); await setPressed("layer-ships", false); await setLegend(false); return awaitReading(READINGS.${id}, { path: shot.path, probe: probeMap }); }`);
    }
    expect(oneLine(SCRIPT.constant("probeMap"))).toBe("const probeMap = () => page.evaluate(mapProbeInPage, MAP_PROBE);");
  });
  it("the capture loop shoots through shootStable with the recipe's reader; the condition is the reading (or the recipe's text), after the stack note", () => {
    const loop = oneLine(SCRIPT.statement("for (const shot of fatal ? [] : shots)"));
    expect(loop).toContain('const read = typeof got === "function" ? got : null;');
    expect(loop).toContain('const { shot: taken, reading } = await shootStable(read, async () => ({ positions: await measure(shot.callouts), png: await page.screenshot({ type: "png", mask, maskColor: MASK_COLOR }) }));');
    expect(loop).toContain("const variant = maskedVariant(withStackNote(stack.note, read ? reading : got), (shot.masks ?? []).map((m) => m.label));");
    expect(loop.split("page.screenshot(")).toHaveLength(2); // 찍기는 shootStable 에 넘긴 한 곳뿐
  });
  it("the shots to take come from selectShots (--only / --skip)", () => {
    expect(SCRIPT.code).toMatch(/selectShots\(planIds, args\)/);
  });
});
