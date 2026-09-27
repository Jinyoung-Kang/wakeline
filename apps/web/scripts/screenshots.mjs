// 포트폴리오 스크린샷: node scripts/screenshots.mjs [baseUrl] [outDir]
// 실데이터 스택(기본 http://localhost:8700)에서 화면별로 찍는다. 운영 화면은 WAKELINE_OPS_USER/WAKELINE_OPS_PASSWORD 가 있을 때만.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:8700";
const OUT = process.argv[3] ?? "../../docs/images";
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: "dark", locale: "ko-KR" });
const page = await ctx.newPage();
const errors = [];
// 로그인 전 운영 화면의 세션 확인은 설계상 404(비인가 = 없는 자원) — 그 밖의 4xx/5xx 만 오류로 센다
const EXPECTED = (status, path) => status === 404 && path === "/api/v1/ops/session";
page.on("response", (r) => {
  const path = r.url().replace(BASE, "");
  if (r.status() >= 400 && !EXPECTED(r.status(), path)) errors.push(`${r.status()} ${path}`);
});
page.on("console", (m) => { if (m.type() === "error" && !/status of 404/.test(m.text())) errors.push(m.text()); });

// 해시만 다른 주소로 goto 하면 같은 문서 안 이동이라 선택 상태가 남는다 — 빈 페이지를 거쳐 새로 연다
async function openMap(hash) {
  await page.goto("about:blank");
  await page.goto(BASE + "/" + hash);
  await page.getByTestId("conn").filter({ hasText: /open/i }).waitFor({ timeout: 30_000 });
}

async function shot(name, fn) {
  if (fn) await fn();
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("saved", name);
}

// 1. 상황판(한반도) — 기상청 HSR 레이더 + SIGMET + 알림
await page.goto(BASE + "/");
await page.getByTestId("conn").filter({ hasText: /open/i }).waitFor({ timeout: 30_000 });
await wait(8000);
if (await page.getByTestId("radar-src-kma").isEnabled()) await page.getByTestId("radar-src-kma").click();
await wait(4000);
await shot("01-dashboard-korea");

// 2. 근거 카드 — 첫 관측 알림 펼치기
const first = page.locator('[data-testid="alert-item"][data-kind="OBSERVED"]').first();
if (await first.count()) {
  await first.locator("button").first().click();
  await wait(2500);
  await shot("02-alert-evidence");
}

// 3. 항공기 상세 + 항적 + 예측 궤적
await page.getByRole("button", { name: "aircraft" }).click();
await wait(2000);
await shot("03-aircraft-detail");

// 3b. 상단 검색(키보드: "/" → 입력 → 결과 목록) — 첫 결과를 Enter 로 선택하면 지도가 그 항공기로 이동
await page.locator("body").press("/");
await page.keyboard.type(process.env.WAKELINE_SEARCH ?? "KAL");
await page.getByTestId("aircraft-search-item").first().waitFor({ timeout: 10_000 }).catch(() => {});
await wait(800);
await shot("03b-search");
await page.keyboard.press("Enter");
await wait(3500);
await shot("03c-search-selected");

// 4. 동아시아 확장(전세계 스냅샷 병합) — 넓은 지도를 보이려고 범례를 접는다(이 브라우저 컨텍스트에만 기억)
if ((await page.getByTestId("legend-toggle").getAttribute("aria-expanded")) === "true") await page.getByTestId("legend-toggle").click();
await openMap("#4.2/33/125");
await wait(6000);
await shot("04-east-asia");

// 4b. 선택 항공기 집중 추적 — 관심 지역 밖(도쿄) 확대 → 핫 리전 → 검색으로 한 대 선택 → 5 s 관측 누적
await openMap("#8.2/35.55/139.9");
await wait(40_000); // 핫 리전 첫 조회(30 s 주기)
await shot("04b-hot-region-tokyo");
// 핫 리전이 adsb.fi 로 본 비행 중 항공기 하나를 고른다(OpenSky 로만 보이는 항공기는 adsb.fi 가 '찾지 못함' 일 수 있다)
const ac = await (await page.request.get(BASE + "/api/v1/aircraft?bbox=139.2,35.1,140.6,36.1")).json();
const target = (ac.features ?? []).map((f) => f.properties)
  .filter((p) => p.provider === "adsb_fi" && !p.on_ground && (p.alt_ft ?? 0) > 6000 && p.callsign)
  .sort((a, b) => (b.alt_ft ?? 0) - (a.alt_ft ?? 0))[0];
console.log("focus target", target ? `${target.callsign} ${target.hex} FL${Math.round((target.alt_ft ?? 0) / 100)}` : "none");
await page.locator("body").press("/");
await page.keyboard.type(process.env.WAKELINE_FOCUS_SEARCH ?? target?.hex ?? "JAL");
await page.getByTestId("aircraft-search-item").first().waitFor({ timeout: 10_000 }).catch(() => {});
await page.keyboard.press("Enter");
await wait(65_000); // 집중 추적 5 s × 약 12회
await shot("04c-focus-tracking");

// 4d. 선박 — 도쿄만 확대(선종 색·선수방위 회전) → 선박 탭 목록에서 한 척 선택(카드·항적)
await openMap("#10.6/35.45/139.78");
if ((await page.getByTestId("layer-ships").getAttribute("aria-pressed")) !== "true") await page.getByTestId("layer-ships").click();
await wait(15_000);
await shot("04d-ships-tokyo-bay");
await page.getByTestId("tab-ship").click();
await page.getByTestId("ship-list-item").first().waitFor({ timeout: 15_000 }).catch(() => {});
const shipItem = page.getByTestId("ship-list-item").first();
if (await shipItem.count()) {
  await shipItem.click();
  await wait(5000);
  await shot("04e-ship-card");
}

// 4f. 선박 격자(축소) + 수신 범위 경계(운영 설정)
await openMap("#1.7/20/150");
await wait(12_000);
await shot("04f-ships-grid-coverage");
if ((await page.getByTestId("layer-ships").getAttribute("aria-pressed")) === "true") await page.getByTestId("layer-ships").click();

// 5. 전세계
await openMap("#1.6/30/60");
await wait(7000);
await shot("05-world");

// 6. 재생
await page.goto(BASE + "/replay");
await wait(7000);
await shot("06-replay");

// 7. 통계
await page.goto(BASE + "/stats");
await wait(3000);
await shot("07-stats");

// 8. 공항 기상
await page.goto(BASE + "/airports/RKSI");
await wait(3000);
await shot("08-airport-rksi");

// 9. 운영 화면
if (process.env.WAKELINE_OPS_USER && process.env.WAKELINE_OPS_PASSWORD) {
  await page.goto(BASE + "/ops");
  await page.locator('[data-testid="ops-login"] input').first().fill(process.env.WAKELINE_OPS_USER);
  await page.locator('[data-testid="ops-login"] input[type="password"]').fill(process.env.WAKELINE_OPS_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByTestId("ops-dashboard").waitFor();
  await wait(2500);
  await shot("09-ops-providers");
  await page.getByRole("button", { name: "runs" }).click();
  await wait(1500);
  await shot("10-ops-runs");
  await page.getByRole("button", { name: "sign out" }).click();
}

// 10. 출처·한계
await page.goto(BASE + "/about");
await wait(1500);
await shot("11-about");

await browser.close();
if (errors.length) { console.log("console errors:", errors.slice(0, 10)); process.exitCode = 1; }
