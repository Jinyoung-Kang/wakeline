import { expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { assertIsolated, instrument, saveJson, shot } from "./qa-helpers";
import { alertId, emptyExternal } from "./qa-aws-helpers";

/**
 * QA 2026-10-aws 공개 데모(A1) — 상태별 화면(탐색 · 수집: 결과를 JSON 으로 남기고, 결함 판정은 findings/public-demo.md 에서).
 * 1) 공개 조회 허가 3 이 모두 잡힌 동안(stats_daily 를 잠가 /stats/traffic 4개씩이 허가를 3 s 씩 잡는다 — 작은 부하) 화면들이 받는 503 + Retry-After 와 보이는 글.
 * 2) 오류 경계 화면(공개 데모 문구 · 스택 · 보고 결과) — 첫 화면 뒤 청크를 404 로 막고 화면 이동.
 * 3) 특보 수신 전 줄 · 요청 id 의 '로그 보기' 링크(공개 데모에서 없어야 한다).
 * 외부 호스트는 빈 응답. 결과: $QA_EVIDENCE_DIR/demo-states.json · demo-states-*.png
 */
const DB = process.env.WLQA_DB ?? "wlqa-a-db-1";
const out: Record<string, unknown> = {};

function lockStatsDaily(seconds: number): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("docker", ["exec", "-i", DB, "psql", "-X", "-q", "-U", "postgres", "-d", "wakeline"]);
    let buf = "";
    p.stdout.on("data", (d) => { buf += String(d); });
    p.stderr.on("data", (d) => { buf += String(d); });
    p.on("close", () => resolve(buf));
    p.stdin.write(`BEGIN; LOCK TABLE stats_daily IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(${seconds}); COMMIT;\n`);
    p.stdin.end();
  });
}

/** 허가 3 을 잡는 배경 요청(같은 IP — 분당 120 을 넘지 않게 4개씩) */
async function holdPermits(base: string, untilMs: number, day: string) {
  const codes: number[] = [];
  while (Date.now() < untilMs) {
    const rs = await Promise.all(Array.from({ length: 4 }, () => fetch(`${base}/api/v1/stats/traffic?day=${day}`).then((r) => r.status).catch(() => 0)));
    codes.push(...rs);
  }
  return codes;
}

async function visibleText(page: Page, sel: string) {
  return page.locator(sel).allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean));
}

test.describe.configure({ mode: "serial" });

test("공개 조회 허가 3 이 찬 동안 화면들의 503 안내", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(240_000);
  await emptyExternal(page);
  const net = await instrument(page);
  const id = await alertId(page);
  const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const lock = lockStatsDaily(40);
  await page.waitForTimeout(800);
  const until = Date.now() + 36_000;
  const bg = holdPermits(baseURL!, until, day);
  await page.waitForTimeout(1_500);
  const screens: Record<string, unknown> = {};
  for (const [name, route, sel] of [
    ["airport", "/airports/RKSI", "main"],
    ["alert", `/alerts/${id}`, "main"],
    ["replay", "/replay", "main"],
  ] as const) {
    net.reset();
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(name === "replay" ? 7_000 : 4_500);
    await shot(page, `demo-states-503-${name}.png`);
    screens[name] = {
      api: net.bad.filter((b) => /\/api\//.test(b.url)).map((b) => `${b.status} ${b.url.replace(/^https?:\/\/[^/]+/, "")}`),
      text: (await visibleText(page, sel)).join(" | ").slice(0, 1500),
      logsLinks: await page.locator('a[href^="/logs"]').count(),
    };
  }
  const codes = await bg;
  await lock;
  out.permits503 = { background: codes.reduce<Record<number, number>>((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {}), screens };
  saveJson("demo-states.json", out);
});

test("오류 경계 화면 — 공개 데모 문구 · 보고", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(120_000);
  await emptyExternal(page);
  await page.goto("/about", { waitUntil: "load" });
  await page.waitForTimeout(2_000);
  await page.route(/\/_next\/static\/chunks\//, (r) => r.fulfill({ status: 404, body: "" }));
  await page.getByRole("link", { name: "통계" }).click();
  const screen = page.getByTestId("error-screen");
  await expect(screen).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_500);
  await shot(page, "demo-states-error-screen.png");
  out.errorScreen = {
    text: (await screen.innerText()).slice(0, 2500),
    report: await page.getByTestId("error-report").innerText(),
    logsLinks: await page.locator('a[href^="/logs"]').count(),
  };
  saveJson("demo-states.json", out);
});

test("특보 수신 전 줄 · 요청 id 의 로그 링크(공개 데모)", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(120_000);
  await emptyExternal(page);
  await page.route(/\/api\/v1\/warnings(\?|$)/, (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ received: false, items: [], dropped: 0, source: "kma", meta: { provider: "kma", fetched_at: null, stale: false } }) }));
  await page.route(/\/api\/v1\/stats\/alerts/, (r) => r.fulfill({ status: 503, contentType: "application/problem+json", headers: { "Retry-After": "10", "X-Request-Id": "qa1460aaaabbbbccccddddeeeeffff00" },
    body: JSON.stringify({ type: "about:blank", title: "Service Unavailable", status: 503, code: "UNAVAILABLE", detail: "data store temporarily unavailable; retry later", request_id: "qa1460aaaabbbbccccddddeeeeffff00" }) }));
  await page.goto("/stats", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4_000);
  await shot(page, "demo-states-stats-503.png");
  const stats = { text: (await visibleText(page, "main")).join(" | ").slice(0, 1500), logsLinks: await page.locator('a[href^="/logs"]').count(),
    copyTitle: await page.locator('[data-testid="request-id"] button').first().getAttribute("title").catch(() => null) };
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8_000);
  // 특보 줄은 오른쪽 패널 'wx' 탭 — 넓은 화면에서 탭 줄이 넘쳐(QA-1420) 화면 밖일 수 있어 DOM 으로 누른다
  await page.getByTestId("tab-wx").evaluate((b) => (b as HTMLButtonElement).click());
  await page.getByTestId("warnings-status").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1_500);
  await shot(page, "demo-states-warnings-not-received.png");
  const warn = await page.getByTestId("warnings-status").allInnerTexts();
  out.states = { stats, warningsLine: warn };
  saveJson("demo-states.json", out);
});
