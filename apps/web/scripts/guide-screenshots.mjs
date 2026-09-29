// 설명서(/guide) 스크린샷: node scripts/guide-screenshots.mjs <기준 주소> <자격 증명 파일> [--only id,…] [--out-dir 폴더] [--quality 0–1] [--allow-fixture]
//
// 배포된 실데이터 스택(예: http://localhost:8700)에서 lib/guide-shots.json 의 스크린샷을 1440×900(배율 1)으로 찍어
// public/guide/<id>.<내용 해시>.webp 로 저장하고(브라우저가 WebP 로 못 바꾸면 PNG), lib/guide-manifest.json 을 갱신한다. 그다음 web 을 다시 빌드해야 화면에 나온다.
// - 번호 위치: 찍기 직전에 각 번호의 대상 요소(CSS 선택자)를 재서 % 로 기록한다. 화면에 없으면 기록하지 않는다(설명서는 "보이지 않음"이라고 적는다).
// - 운영 · 로그 화면은 /ops 로그인이 필요하다: 자격 증명은 인자로 받은 파일에서만 읽는다(인자 값 · 환경 변수로 받지 않는다). 끝나면 sign out.
// - 로컬 스택만 찍는다(로그인 정보를 보낸다).
// - 실데이터 확인: 찍기 전과 다 찍은 뒤(manifest 를 쓰기 전) 두 번 /api/v1/status 를 읽어, 확실히 실데이터일 때만 진행한다 — FIXTURE MODE(가짜 자료)이거나
//   수집 모드를 모르면(heartbeat 없음 · 응답 없음) 이번 결과를 버리고 멈춘다. 모든 스크린샷(상황판 밖 재생 · 통계 · 공항 · 운영 · 로그 포함)에 적용된다(--allow-fixture 로만 무시).
// - 조회 오류가 보이는 화면(오류 문구 · 요청 id)은 싣지 않는다 — 건너뛰고 이유를 보고한다.
// - 가림(계획의 masks): 설명서는 로그인 없이 누구나 본다. 운영 · 로그 화면은 운영자 이름과 운영 정보 · 브라우저가 보낸 글자가 든 열(마지막 오류 · 전환 사유 ·
//   로거 · 메시지 · 요청 id)을 회색 상자로 가려 찍고, 무엇을 가렸는지 캡처 조건에 적는다. 가릴 자리를 하나라도 찾지 못하면 그 스크린샷을 싣지 않는다.
// - 못 찍은 스크린샷은 이전 결과를 그대로 두고(있으면) 이유를 보고한다. 이번에 바뀐 결과가 더 가리키지 않는 옛 파일은 지운다.
// - 끝에 크기 보고. 종료 코드: 0 = 모두 찍음, 3 = 일부 건너뜀, 2 = 인자 오류, 1 = 그 밖의 실패.
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  anchorPoint, checkLocalBase, credentialFileWarning, ERROR_MARKS, findColumn, hashedName, maskedVariant, mergeManifest, parseArgs, parseCredentials, realDataVerdict, sizeReport, staleFiles,
} from "./guide-capture-lib.mjs";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** 이 스크린샷을 건너뛴다(이유와 함께) — 다른 스크린샷은 계속 */
class Skip extends Error {}
/** 전체를 멈춘다 */
class Fatal extends Error {}

let args;
try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }

const BASE = (() => { try { return checkLocalBase(args.baseUrl); } catch (e) { console.error(e.message); process.exit(2); } })();
const plan = JSON.parse(readFileSync(join(WEB, "lib/guide-shots.json"), "utf8"));
const planIds = plan.shots.map((s) => s.id);
if (args.only) {
  const unknown = args.only.filter((id) => !planIds.includes(id));
  if (unknown.length) { console.error(`--only: 계획에 없는 스크린샷 ${unknown.join(", ")} (있는 것: ${planIds.join(", ")})`); process.exit(2); }
}
const shots = plan.shots.filter((s) => !args.only || args.only.includes(s.id));
const VP = plan.viewport;
const OUT = args.outDir ? resolve(args.outDir) : join(WEB, "public/guide");
const MANIFEST = args.outDir ? join(OUT, "guide-manifest.json") : join(WEB, "lib/guide-manifest.json");

// 자격 증명은 운영 · 로그 스크린샷을 찍을 때만 읽는다 — 파일 내용 · 값을 출력하지 않는다
const needsLogin = shots.some((s) => s.path === "/ops" || s.path === "/logs");
let cred = null;
if (needsLogin) {
  try {
    const st = statSync(args.credFile);
    const warn = credentialFileWarning(st.mode);
    if (warn) console.warn(warn);
    cred = parseCredentials(readFileSync(args.credFile, "utf8"));
  } catch (e) {
    console.error(e.code === "ENOENT" ? `자격 증명 파일 없음: ${args.credFile}` : e.message);
    process.exit(2);
  }
}

mkdirSync(OUT, { recursive: true });
// --lang: 날짜 · 시각 입력칸(type=date · datetime-local)의 표시 형식은 브라우저 UI 언어를 따른다 — 문맥의 locale 만으로는 09/29/2026 · AM 으로 찍혔다
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu-rasterization", "--ignore-gpu-blocklist", "--lang=ko-KR"] });
const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1, colorScheme: "dark", locale: "ko-KR", reducedMotion: "reduce" });
const page = await ctx.newPage();
page.setDefaultTimeout(20_000);
const encoder = await ctx.newPage(); // PNG → WebP 변환 전용(about:blank)

// ---- 공통 동작 ----

/** 항공기 목록을 볼 영역(한반도 — 상황판 스크린샷의 지도 위치와 같은 곳) */
const KOREA_BBOX = "124,33,132,39";

/** 상황판을 새로 연다(path = "/#줌/위도/경도" — 해시만 다른 goto 는 같은 문서 안 이동이라 선택 상태가 남아 빈 페이지를 거친다). 실시간 연결이 열려야 찍는다 */
async function openMap(path) {
  await page.goto("about:blank");
  await page.goto(BASE + path);
  try { await page.getByTestId("conn").filter({ hasText: /open/i }).waitFor({ timeout: 30_000 }); }
  catch { throw new Skip("상황판 실시간 연결(WS open)이 30 s 안에 열리지 않음"); }
  // 실데이터 판단은 assertRealData(/api/v1/status)가 한다 — 배지는 status 메시지가 늦게 오면 아직 없어 판단에 쓰지 않는다(보이면 덧붙여 멈출 뿐)
  if (!args.allowFixture && await page.getByTestId("fixture-badge").count()) throw new Fatal("FIXTURE MODE 배지가 보임 — 가짜 자료가 설명서에 실리지 않게 멈춤");
}
/** 실데이터 스택인지 /api/v1/status 로 확인(찍기 전 · 다 찍은 뒤). 아니면 전체를 멈춘다 */
async function assertRealData(when) {
  if (args.allowFixture) return;
  let code = 0, body = null;
  try {
    const r = await page.request.get(`${BASE}/api/v1/status`, { timeout: 15_000 });
    code = r.status();
    body = await r.json().catch(() => null);
  } catch { /* 응답 없음 → code 0 */ }
  const why = realDataVerdict(code, body);
  if (why) throw new Fatal(`${when}: ${why} — 가짜 자료가 설명서에 실리지 않게 이번 결과를 버리고 멈춤(실데이터 스택에서 다시 찍거나 --allow-fixture)`);
}
async function setPressed(testId, on) {
  const b = page.getByTestId(testId);
  if ((await b.getAttribute("aria-pressed")) !== String(on)) await b.click();
}
async function setLegend(open) {
  const b = page.getByTestId("legend-toggle");
  if ((await b.getAttribute("aria-expanded")) !== String(open)) await b.click();
}
/** 한반도 지도 영역의 실시간 항공기(서버가 준 값 그대로) */
async function koreaAircraft() {
  const r = await page.request.get(`${BASE}/api/v1/aircraft?bbox=${KOREA_BBOX}`);
  if (!r.ok()) throw new Skip(`항공기 목록 조회 실패(HTTP ${r.status()})`);
  const body = await r.json();
  return (body.features ?? []).map((f) => f.properties ?? {});
}
/** 로그인(한 번) — 이미 세션이 있으면 그대로 */
let loggedIn = false;
async function login() {
  if (loggedIn) return;
  await page.goto(BASE + "/ops");
  const form = page.getByTestId("ops-login"), dash = page.getByTestId("ops-dashboard");
  await Promise.race([form.waitFor(), dash.waitFor()]).catch(() => {});
  if (await dash.count()) { loggedIn = true; return; }
  if (!cred) throw new Skip("자격 증명 없음");
  await page.locator("#ops-user").fill(cred.username);
  await page.locator("#ops-pass").fill(cred.password);
  await form.locator('button[type="submit"]').click();
  const err = page.getByTestId("ops-login-error");
  await Promise.race([dash.waitFor({ timeout: 15_000 }), err.waitFor({ timeout: 15_000 })]).catch(() => {});
  if (!(await dash.count())) throw new Skip(`로그인 실패 — ${(await err.count()) ? (await err.innerText()).trim() : "응답 없음"}`);
  loggedIn = true;
}

// ---- 스크린샷별 준비(계획의 id 마다 — 경로는 계획의 path). 돌려주는 값 = 캡처 조건(설명서 그림 아래에 적힌다) ----

const RECIPES = {
  async dashboard(shot) {
    await openMap(shot.path);
    await setPressed("layer-ships", true);
    await setLegend(true);
    await wait(10_000); // 스냅샷 · 레이더 타일 · 선박 격자
    return `한반도 ${shot.path.slice(1)}`;
  },
  async traffic(shot) {
    // 연안 교통량(ADR-023): 레이어를 켜면 곧바로 조회한다 — 상태 줄이 '불러오는 중'을 벗어날 때까지 기다리고, 칸을 그리는 상태(기준 …)일 때만 찍는다
    await openMap(shot.path);
    await setPressed("layer-ships", false);
    await setPressed("layer-traffic", true);
    await setLegend(true);
    const status = page.getByTestId("traffic-status-text");
    await status.waitFor({ timeout: 15_000 }).catch(() => { throw new Skip("연안 교통량 상태 줄이 나오지 않음"); });
    await page.waitForFunction(() => !/^불러오는 중/.test(document.querySelector('[data-testid="traffic-status-text"]')?.textContent ?? ""), null, { timeout: 20_000 }).catch(() => {});
    const line = (await status.innerText()).trim();
    if (!line.startsWith("기준 ")) throw new Skip(`연안 교통량이 칸을 그리지 않음 — ${line.slice(0, 80)}`);
    await wait(4_000); // 칸 그리기
    return `연안 교통량 ${shot.path.slice(1)}`;
  },
  async search(shot) {
    await openMap(shot.path);
    await setPressed("layer-ships", false);
    await setLegend(false);
    // 검색어 = 지금 지도의 호출부호에서 가장 많은 앞 3자(실제 자료에서 고른다 — 없으면 찍지 않는다)
    const counts = new Map();
    for (const p of await koreaAircraft()) {
      const m = /^([A-Z]{3})\d/.exec(String(p.callsign ?? "").trim());
      if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    const q = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    if (!q) throw new Skip("지도 영역에 호출부호가 있는 항공기 없음");
    await page.locator("body").press("/");
    await page.keyboard.type(q);
    await page.getByTestId("aircraft-search-results").waitFor();
    await page.getByTestId("aircraft-search-item").first().waitFor({ timeout: 10_000 }).catch(() => {});
    await wait(1200);
    return `검색어 “${q}” — 지금 지도의 호출부호에서 가장 많은 앞 3자`;
  },
  async aircraft(shot) {
    await openMap(shot.path);
    await setPressed("layer-ships", false);
    await setLegend(false);
    const list = (await koreaAircraft()).filter((p) => p.hex && p.callsign && p.on_ground !== true && (p.alt_ft ?? 0) > 6000);
    const t = list.sort((a, b) => (b.alt_ft ?? 0) - (a.alt_ft ?? 0))[0];
    if (!t) throw new Skip("지도 영역에 비행 중인 항공기(호출부호 있음) 없음");
    await page.locator("body").press("/");
    await page.keyboard.type(String(t.hex));
    await page.getByTestId("aircraft-search-item").first().waitFor({ timeout: 10_000 }).catch(() => { throw new Skip(`검색 결과 없음(${t.hex})`); });
    await page.keyboard.press("Enter");
    await page.getByTestId("aircraft-card").waitFor();
    await wait(9_000); // 지도 이동 · 상세 · 노선 · 집중 추적 첫 보고
    return `${String(t.callsign).trim()} (${t.hex}) — 한반도 영역에서 가장 높이 나는 항공기`;
  },
  async ship(shot) {
    // 계획의 위치(부산항 부근)에 선박이 없으면 수신국이 많은 도쿄만으로 — 어디서 찍었는지 조건에 적는다
    const candidates = [[shot.path, "부산항 부근"], ["/#10.6/35.45/139.78", "도쿄만"]];
    for (const [path, label] of candidates) {
      await openMap(path);
      await setPressed("layer-ships", true);
      await setLegend(false);
      await wait(15_000);
      await page.getByTestId("tab-ship").click();
      const item = page.getByTestId("ship-list-item").first();
      await item.waitFor({ timeout: 10_000 }).catch(() => {});
      if (!(await item.count())) { console.log(`  ship: ${label} 에 선박 없음 — 다음 후보`); continue; }
      await item.click();
      await page.getByTestId("ship-card").waitFor();
      await wait(6_000); // 항적
      return `${label} ${path.slice(1)}`;
    }
    throw new Skip("후보 해역(부산항 부근 · 도쿄만)에 선박 없음");
  },
  async "port-calls"(shot) {
    // 한국 항만 입출항(ADR-022 개정): 후보 해역(부산항 부근 → 도쿄만)의 선박을 차례로 골라 입출항 결과(ok)가 나온 카드를 찍는다. 결과는 서버 색인에서 바로
    // 온다(고를 때 외부에 묻지 않는다 — 한도 없음). 해역마다 후보 8척, 상태를 기다리는 상한 15 s. 다른 상태(기록 없음 · 색인 불완전 · 꺼짐 · 호출부호 없음)는 다음 후보.
    // 두 해역 모두 없으면(aisstream 은 육상 수신국 기반 — 한반도 부근이 빌 때가 있다) GUIDE_PORT_CALLS_QUERY(선박 이름 · MMSI)로 선박 검색에서 고른다 — 조건에 적는다.
    const tried = [];
    let ships = 0; // 목록에서 골라 본 선박 수(해역에 선박이 없다는 표시는 세지 않는다)
    const waitStatus = async () => {
      const sec = page.getByTestId("port-calls");
      await sec.waitFor({ timeout: 10_000 }).catch(() => {});
      await page.waitForFunction(() => {
        const st = document.querySelector('[data-testid="port-calls"]')?.getAttribute("data-status");
        return st != null && st !== "unknown";
      }, null, { timeout: 15_000 }).catch(() => {});
      const st = (await sec.getAttribute("data-status").catch(() => null)) ?? "없음";
      tried.push(st);
      if (st === "ok") {
        await sec.scrollIntoViewIfNeeded();
        await wait(1_000);
      }
      return st === "ok";
    };
    for (const [path, label] of [[shot.path, "부산항 부근"], ["/#10.6/35.45/139.78", "도쿄만"]]) {
      for (let i = 0; i < 8; i++) {
        await openMap(path);
        await setPressed("layer-ships", true);
        await setLegend(false);
        await wait(12_000);
        await page.getByTestId("tab-ship").click();
        const item = page.getByTestId("ship-list-item").nth(i);
        await item.waitFor({ timeout: 10_000 }).catch(() => {});
        if (!(await item.count())) {
          if (i === 0) tried.push(`${label} 선박 없음`);
          break;
        }
        await item.click();
        ships += 1;
        if (await waitStatus()) return `${label} ${path.slice(1)} · 선박 목록 ${i + 1}번째(입출항 결과가 있는 첫 선박)`;
      }
    }
    const q = (process.env.GUIDE_PORT_CALLS_QUERY ?? "").trim();
    if (q) {
      await openMap(shot.path);
      await setPressed("layer-ships", true);
      await setLegend(false);
      await page.locator("body").press("/");
      await page.keyboard.type(q);
      const hit = page.getByTestId("ship-search-item").first();
      await hit.waitFor({ timeout: 10_000 }).catch(() => {});
      if (await hit.count()) {
        await hit.click();
        await page.getByTestId("ship-card").waitFor({ timeout: 10_000 }).catch(() => {});
        if (await waitStatus()) return `선박 검색 “${q}” 첫 결과 — 부산항 부근 · 도쿄만 후보 ${ships}척에 입출항 결과 없음`;
      } else tried.push(`검색 “${q}” 결과 없음`);
    }
    throw new Skip(`입출항 결과(ok)가 있는 선박을 찾지 못함 — 후보 상태 ${tried.join(", ") || "선박 없음"}`);
  },
  async alerts(shot) {
    await openMap(shot.path);
    await setPressed("layer-ships", false);
    await setLegend(false);
    await wait(8_000);
    let scope = "관심 지역";
    if (!(await page.getByTestId("alert-item").count())) {
      await page.getByTestId("alerts-scope-world").click();
      await wait(1500);
      scope = "전세계";
    }
    const first = page.getByTestId("alert-item").first();
    if (!(await first.count())) throw new Skip("알림 없음(관심 지역 · 전세계)");
    await first.getByTestId("alert-toggle").click();
    await page.getByTestId("evidence").first().waitFor();
    await wait(1500);
    return `알림 범위 ${scope}`;
  },
  async radar(shot) {
    await openMap(shot.path);
    await setPressed("layer-ships", false);
    await setLegend(false);
    await wait(6_000);
    const kma = page.getByTestId("radar-src-kma");
    const useKma = await kma.isEnabled();
    if (useKma) await kma.click();
    await page.getByTestId("kr-radar-toggle").click();
    await wait(5_000);
    return useKma ? "기상청 HSR" : "RainViewer(기상청 프레임 없음)";
  },
  async replay(shot) {
    await page.goto(BASE + shot.path);
    const sum = page.getByTestId("replay-summary");
    const loaded = await sum.filter({ hasText: /aircraft/ }).waitFor({ timeout: 25_000 }).then(() => true, () => false);
    if (!loaded) throw new Skip("재생 기록 응답 없음");
    await page.getByTestId("replay-list-toggle").click();
    await wait(3_000);
    return `지도 시각 ${(await page.getByTestId("replay-frame-at").innerText()).replace(/^지도\s*/, "").trim()}`;
  },
  async stats(shot) {
    await page.goto(BASE + shot.path);
    await page.locator("main .grid > section").first().waitFor();
    await wait(4_000);
    return null;
  },
  async airport(shot) {
    await page.goto(BASE + shot.path);
    await page.locator("main pre").first().waitFor({ timeout: 15_000 }).catch(() => { throw new Skip("RKSI METAR 없음"); });
    await wait(1_500);
    return shot.path.split("/").pop();
  },
  async ops(shot) {
    await login();
    await page.goto(BASE + shot.path);
    await page.getByTestId("ops-dashboard").waitFor();
    await page.locator('[data-testid="ops-dashboard"] table').first().waitFor({ timeout: 15_000 }).catch(() => {});
    await wait(2_000);
    return "providers 탭";
  },
  async logs(shot) {
    await login();
    await page.goto(BASE + shot.path);
    await page.getByTestId("logs-dashboard").waitFor();
    // 기본 기간(1 h)은 조용한 때 비기 쉽다 — 24 h 로 넓혀 찍는다(그 응답을 기다린다). 조건에는 실제로 눌린 기간 · 서비스를 적는다
    const period = page.getByRole("group", { name: "기간", exact: true });
    const wide = period.getByRole("button", { name: "24 h", exact: true });
    if ((await wide.count()) && (await wide.getAttribute("aria-pressed")) !== "true") {
      await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/ops/logs", { timeout: 15_000 }).catch(() => null),
        wide.click(),
      ]);
    }
    await Promise.race([page.getByTestId("log-grid").waitFor(), page.getByTestId("logs-empty").waitFor()]).catch(() => {});
    await wait(1_500);
    const picked = (await period.locator('button[aria-pressed="true"]').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    if (await page.locator('[data-testid="logs-empty"]:visible').count()) throw new Skip(`기간 ${picked.join(",") || "—"} 에 항목 없음 — 빈 목록은 싣지 않음(번호 4가 가리킬 목록이 없다)`);
    if (!(await page.locator('[data-testid="log-grid"]:visible').count())) throw new Skip("로그 목록이 나오지 않음");
    const svc = (await page.getByRole("group", { name: /^서비스/ }).locator('button[aria-pressed="true"]').allInnerTexts()).map((t) => t.trim());
    return `기간 ${picked.join(",") || "—"} · 서비스 ${svc.length ? svc.join(", ") : "전체"}`;
  },
};

/**
 * 조회 오류가 보이는 화면은 설명서에 싣지 않는다(정상 사용 모습처럼 보이게 두지 않는다) — 화면 코드의 오류 표시(testid)만 본다.
 * 경고성 상태(STALE · 일부 합성 · 미러 불일치 등)는 실제 상태라 막지 않는다.
 */
async function assertNoErrors() {
  for (const id of ERROR_MARKS) {
    // 보이는 것만(:visible) 모두 본다 — 첫 요소가 숨은 탭 안에 있어도 뒤의 보이는 오류를 놓치지 않게
    const vis = page.locator(`[data-testid="${id}"]:visible`);
    if (await vis.count()) throw new Skip(`화면에 조회 오류가 보임(${id}: ${(await vis.first().innerText()).trim().slice(0, 120)})`);
  }
}

/** 가림 상자 색(테마의 line-2 — 어두운 화면에서 '가린 자리'로 또렷이 보이되 튀지 않게) */
const MASK_COLOR = "#333a43";

/** 계획의 가릴 자리 → Playwright 가림 위치들. 하나라도 찾지 못하면 Skip — 가리지 못한 운영 화면을 싣지 않는다 */
async function maskLocators(shot) {
  const out = [];
  for (const m of shot.masks ?? []) {
    if (m.session_user) {
      // 로그인한 이름은 서버에 묻는다(자격 증명 파일의 이름과 다른 세션일 수 있다) — 그 글자가 통째로 보이는 모든 자리를 가린다
      const r = await page.request.get(`${BASE}/api/v1/ops/session`, { timeout: 10_000 }).catch(() => null);
      const u = r && r.ok() ? (await r.json().catch(() => null))?.username : null;
      if (typeof u !== "string" || !u.trim()) throw new Skip(`가림 "${m.label}": 로그인한 운영자 이름을 확인하지 못함`);
      const loc = page.getByText(u, { exact: true });
      if (!(await loc.count())) throw new Skip(`가림 "${m.label}": 화면에서 이름 자리를 찾지 못함`);
      out.push(loc);
      continue;
    }
    const heads = await page.locator(m.table).evaluateAll((ts) => ts.map((t) => [...t.querySelectorAll("thead th")].map((th) => th.textContent ?? "")));
    let found = 0;
    heads.forEach((h, i) => {
      const col = findColumn(h, m.header);
      if (col < 0) return;
      out.push(page.locator(m.table).nth(i).locator(`tbody > tr > td:nth-child(${col + 1})`));
      found++;
    });
    if (!found) throw new Skip(`가림 "${m.label}": ${m.table} 에서 머리글 "${m.header}" 열을 찾지 못함`);
  }
  return out;
}

/** 번호 대상 요소의 화면 사각형(보이지 않으면 null) */
async function measure(callouts) {
  const rects = await page.evaluate((targets) => targets.map((sel) => {
    let el = null;
    try { el = document.querySelector(sel); } catch { return null; }
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }), callouts.map((c) => c.target));
  return callouts.flatMap((c, i) => {
    const p = anchorPoint(rects[i], c.anchor, VP);
    return p ? [{ n: c.n, x: p.x, y: p.y }] : [];
  });
}

/** PNG → WebP(브라우저 캔버스 인코더 — 새 의존성 없음). 이 브라우저가 WebP 를 못 만들면 PNG 그대로 */
async function encode(png) {
  const url = await encoder.evaluate(async ({ b64, q }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/webp", q);
  }, { b64: png.toString("base64"), q: args.quality });
  const head = "data:image/webp;base64,";
  return url.startsWith(head) ? { bytes: Buffer.from(url.slice(head.length), "base64"), format: "webp" } : { bytes: png, format: "png" };
}

// ---- 실행 ----

const captured = {};
const rows = [];
const skipped = [];
let fatal = null;
try { await assertRealData("찍기 전 확인"); } catch (e) { if (e instanceof Fatal) fatal = e; else throw e; }
for (const shot of fatal ? [] : shots) {
  const recipe = RECIPES[shot.id];
  try {
    if (!recipe) throw new Skip("이 스크립트에 캡처 방법이 없음(RECIPES)");
    console.log(`… ${shot.id}`);
    const condition = await recipe(shot);
    await assertNoErrors();
    const mask = await maskLocators(shot);
    const variant = maskedVariant(condition, (shot.masks ?? []).map((m) => m.label));
    await page.evaluate(() => document.fonts?.ready);
    const positions = await measure(shot.callouts);
    const png = await page.screenshot({ type: "png", mask, maskColor: MASK_COLOR });
    const enc = await encode(png);
    const file = hashedName(shot.id, enc.bytes, enc.format);
    writeFileSync(join(OUT, file), enc.bytes);
    captured[shot.id] = { file, format: enc.format, width: VP.width, height: VP.height, bytes: enc.bytes.length, captured_at: new Date().toISOString(), variant, callouts: positions };
    rows.push({ id: shot.id, format: enc.format, bytes: enc.bytes.length, pngBytes: png.length, callouts: [positions.length, shot.callouts.length], variant });
  } catch (e) {
    if (e instanceof Fatal) { fatal = e; break; }
    skipped.push({ id: shot.id, reason: e instanceof Skip ? e.message : `오류 — ${e.message.split("\n")[0]}` });
  }
}
// 찍는 사이에 스택이 FIXTURE 로 바뀌었어도 싣지 않는다(결과를 쓰기 전 마지막 확인)
if (!fatal && Object.keys(captured).length) {
  try { await assertRealData("다 찍은 뒤 확인"); } catch (e) { if (e instanceof Fatal) fatal = e; else throw e; }
}
if (loggedIn) {
  // 세션을 남기지 않는다
  try {
    await page.goto(BASE + "/ops");
    await page.getByRole("button", { name: "sign out" }).click({ timeout: 10_000 });
    await page.getByTestId("ops-login").waitFor({ timeout: 10_000 });
  } catch { console.warn("경고: sign out 확인 못 함 — 세션은 8 h 뒤 만료"); }
}
await browser.close();

if (fatal) {
  // 이번에 쓴 파일은 결과에 넣지 않았으니 지운다(이전 결과 · 파일은 그대로)
  for (const m of Object.values(captured)) { try { unlinkSync(join(OUT, m.file)); } catch { /* 없음 */ } }
  console.error(fatal.message);
  process.exit(1);
}

let prev = null;
try { prev = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null; } catch { console.warn(`경고: 이전 결과(${MANIFEST})를 읽지 못함 — 이번 결과만 씀`); }
const manifest = mergeManifest(prev, captured, planIds);
// 원자적으로 바꾼다(쓰다 멈춰도 반쯤 쓴 manifest 가 남지 않게)
writeFileSync(`${MANIFEST}.tmp`, JSON.stringify(manifest, null, 2) + "\n");
renameSync(`${MANIFEST}.tmp`, MANIFEST);
for (const f of staleFiles(readdirSync(OUT), manifest)) unlinkSync(join(OUT, f));

console.log(`\n${sizeReport(rows, skipped)}`);
console.log(`\n저장: ${OUT}\n결과: ${MANIFEST}${args.outDir ? "" : "\n다음: web 을 다시 빌드하면(이미지는 이름에 내용 해시가 있어 1년 캐시) 설명서에 나온다."}`);
process.exitCode = skipped.length ? 3 : 0;
