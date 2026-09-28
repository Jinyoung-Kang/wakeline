// 리뷰용 전/후 화면 캡처: node scripts/ui-captures.mjs <prefix> [baseUrl] [outDir]
// 같은 지도 위치·창 크기로 찍어 비교한다(1600×1000, 배율 1). 데스크톱 + 모바일 폭(390×844) 한 장씩.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const PREFIX = process.argv[2] ?? "before";
const BASE = process.argv[3] ?? "http://localhost:8700";
const OUT = process.argv[4] ?? "../../docs/review/ui";
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"] });

async function capture(viewport, shots) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: "dark", locale: "ko-KR" });
  const page = await ctx.newPage();
  for (const [name, hash, setup] of shots) {
    await page.goto("about:blank");
    await page.goto(BASE + "/" + hash);
    await page.getByTestId("conn").filter({ hasText: /open/i }).waitFor({ timeout: 30_000 });
    if (setup) await setup(page);
    await wait(9000);
    await page.screenshot({ path: `${OUT}/${PREFIX}-${name}.png` });
    console.log("saved", `${PREFIX}-${name}`);
  }
  await ctx.close();
}
const shipsOn = async (page) => {
  const b = page.getByTestId("layer-ships");
  if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
};
await capture({ width: 1600, height: 1000 }, [
  ["korea-z6", "#5.97/34.54/128.96", null],
  ["korea-z6-ships", "#5.97/34.54/128.96", shipsOn],
  ["tokyo-bay-z10-ships", "#10.6/35.45/139.78", shipsOn],
  ["arabian-z5-ships", "#4.96/20.04/63.8", shipsOn],
]);
await capture({ width: 390, height: 844 }, [["mobile-korea", "#5.5/36.2/127.8", null]]);
await browser.close();
