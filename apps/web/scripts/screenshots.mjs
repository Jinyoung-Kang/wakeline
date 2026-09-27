// 포트폴리오 스크린샷: node scripts/screenshots.mjs [baseUrl] [outDir]
// 실데이터 스택(기본 http://localhost:8700)에서 화면별로 찍는다. 운영 화면은 SKYWX_OPS_USER/SKYWX_OPS_PASSWORD 가 있을 때만.
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
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

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

// 4. 동아시아 확장(전세계 스냅샷 병합)
await page.goto(BASE + "/#4.2/33/125"); // MapLibre hash: #zoom/lat/lon (공유 가능한 지도 위치)
await page.getByTestId("conn").filter({ hasText: /open/i }).waitFor({ timeout: 30_000 });
await wait(6000);
await shot("04-east-asia");

// 5. 전세계
await page.goto(BASE + "/#1.6/30/60");
await page.getByTestId("conn").filter({ hasText: /open/i }).waitFor({ timeout: 30_000 });
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
if (process.env.SKYWX_OPS_USER && process.env.SKYWX_OPS_PASSWORD) {
  await page.goto(BASE + "/ops");
  await page.locator('[data-testid="ops-login"] input').first().fill(process.env.SKYWX_OPS_USER);
  await page.locator('[data-testid="ops-login"] input[type="password"]').fill(process.env.SKYWX_OPS_PASSWORD);
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
