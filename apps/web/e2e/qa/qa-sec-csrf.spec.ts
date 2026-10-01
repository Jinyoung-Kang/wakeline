import { expect, test, type Response } from "@playwright/test";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * QA 보안 점검(계획 §3.1 CSRF · Origin) — 격리 스택(8701 · 8702)에서만. 운영자(qa-b)가 로그인한 브라우저가 같은 호스트의 다른 포트
 * (http://localhost:<임의>)에 있는 페이지를 열면, 그 페이지는 CSRF 쿠키를 읽을 수 있고(쿠키는 포트를 가리지 않는다) 운영 세션 쿠키도
 * 요청에 실린다(같은 사이트 — SameSite=Strict 로도 못 막는다). 그 페이지가 만들 수 있는 요청(폼 POST · no-cors fetch · _csrf 파라미터 ·
 * text/plain JSON · 사전 요청이 필요한 헤더)으로 운영 변경을 실행하지 못해야 한다.
 * 탐침: POST /api/v1/ops/stats/aggregate?day=<오늘> — 검사를 모두 통과해 컨트롤러에 닿으면 400 BAD_DAY(상태는 바뀌지 않는다), 막히면 403.
 * 로그인 강요: 다른 포트의 폼이 text/plain 으로 JSON 모양 본문을 보내 로그인시키지 못해야 한다(403 · 415).
 */
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8701";
if (!["8701", "8702"].includes(new URL(BASE).port)) throw new Error(`QA 는 격리 스택만: ${BASE}`);
const CREDS = process.env.QA_CREDS ?? "/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/75437490-c65b-4783-9ac0-e224c92a9bab/scratchpad/qa-creds.json";
const password = (u: string): string => JSON.parse(readFileSync(CREDS, "utf8")).users[u];

function kstToday(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

const attackPage = (target: string, day: string) => `<!doctype html><meta charset="utf-8"><title>attacker</title>
<body>
<form id="f1" method="POST" action="${target}/api/v1/ops/stats/aggregate?day=${day}" target="sink1"><input type="hidden" name="_csrf" id="tok1"></form>
<form id="f2" method="POST" action="${target}/api/v1/ops/session" enctype="text/plain" target="sink2"><input type="hidden" name='{"username":"qa-nobody","password":"not-a-password-x","x":"' value='"}'></form>
<iframe name="sink1"></iframe><iframe name="sink2"></iframe>
<pre id="out"></pre>
<script>
const out = [];
const tok = (document.cookie.match(/WAKELINE_CSRF=([^;]+)/) || [])[1] || "";
out.push("cookie-readable:" + (tok ? "yes" : "no"));
document.getElementById("tok1").value = tok;
(async () => {
  const u = "${target}/api/v1/ops/stats/aggregate?day=${day}";
  try { await fetch(u + "&_csrf=" + tok, { method: "POST", mode: "no-cors", credentials: "include" }); out.push("nocors-query:sent"); } catch (e) { out.push("nocors-query:" + e); }
  try { await fetch(u, { method: "POST", mode: "no-cors", credentials: "include", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "_csrf=" + tok }); out.push("nocors-form:sent"); } catch (e) { out.push("nocors-form:" + e); }
  try { await fetch(u, { method: "POST", mode: "no-cors", credentials: "include", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ _csrf: tok }) }); out.push("nocors-text:sent"); } catch (e) { out.push("nocors-text:" + e); }
  try { const r = await fetch(u, { method: "POST", mode: "cors", credentials: "include", headers: { "X-CSRF-Token": tok } }); out.push("cors-header:" + r.status); } catch (e) { out.push("cors-header:blocked"); }
  try { const r = await fetch("${target}/api/v1/ops/providers", { credentials: "include" }); out.push("cors-read:" + r.status); } catch (e) { out.push("cors-read:blocked"); }
  document.getElementById("f1").submit();
  document.getElementById("f2").submit();
  out.push("forms:submitted");
  document.getElementById("out").textContent = out.join("\\n");
})();
</script>`;

test("cross-port page cannot change ops state (form POST · no-cors fetch · _csrf · text/plain · custom header) nor force a login", async ({ page }) => {
  const day = kstToday();
  const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(attackPage(BASE, day)); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  try {
    // 운영자 로그인(같은 브라우저 컨텍스트 — 쿠키 공유)
    const login = await page.request.post(`${BASE}/api/v1/ops/session`, { data: { username: "qa-b", password: password("qa-b") } });
    expect(login.status()).toBe(200);
    const csrf = (await page.context().cookies(BASE)).find((c) => c.name === "WAKELINE_CSRF")?.value ?? "";
    const auditBefore = await (await page.request.get(`${BASE}/api/v1/ops/audit?limit=1`)).json();

    const seen: { url: string; method: string; status: number; code?: string; origin?: string; site?: string }[] = [];
    page.context().on("response", async (r: Response) => {
      const u = r.url();
      if (!u.startsWith(BASE + "/api/v1/ops/")) return;
      let code: string | undefined;
      try { code = (await r.json()).code; } catch { /* 불투명 응답 */ }
      const h = r.request().headers();
      seen.push({ url: u.replace(BASE, ""), method: r.request().method(), status: r.status(), code, origin: h["origin"], site: h["sec-fetch-site"] });
    });
    await page.goto(`http://localhost:${port}/`);
    await expect(page.locator("#out")).toContainText("forms:submitted", { timeout: 15_000 });
    await page.waitForTimeout(2000);
    const out = await page.locator("#out").textContent();
    test.info().annotations.push({ type: "attacker-page", description: out ?? "" }, { type: "responses", description: JSON.stringify(seen) });
    console.log("attacker page:", out);
    console.log("responses:", JSON.stringify(seen, null, 1));

    const posts = seen.filter((s) => s.method === "POST");
    expect(posts.length, "the attacker requests reached the server").toBeGreaterThanOrEqual(5);
    for (const s of posts) {
      expect(s.status, `${s.method} ${s.url} must be refused (not reach the controller)`).toBe(403);
      if (s.code !== undefined) expect(s.code).toBe("ORIGIN_NOT_ALLOWED"); // no-cors · iframe 응답은 본문을 읽을 수 없다(불투명)
    }
    expect(out).toContain("cors-header:blocked");

    // 상태가 바뀌지 않았다: 감사 기록에 새 행이 없고, 세션은 여전히 qa-b
    const auditAfter = await (await page.request.get(`${BASE}/api/v1/ops/audit?limit=1`)).json();
    expect(auditAfter.items[0]?.id, "no new audit row").toBe(auditBefore.items[0]?.id);
    const me = await (await page.request.get(`${BASE}/api/v1/ops/session`)).json();
    expect(me.username).toBe("qa-b");

    // 같은 탐침을 같은 출처로 보내면 컨트롤러에 닿는다(400 BAD_DAY) — 위의 403 이 탐침 탓이 아님을 보인다
    const same = await page.request.post(`${BASE}/api/v1/ops/stats/aggregate?day=${day}`, { headers: { "X-CSRF-Token": csrf, Origin: BASE } });
    expect(same.status()).toBe(400);
    expect((await same.json()).code).toBe("BAD_DAY");
  } finally {
    server.close();
    const c = (await page.context().cookies(BASE)).find((x) => x.name === "WAKELINE_CSRF")?.value ?? "";
    await page.request.delete(`${BASE}/api/v1/ops/session`, { headers: { "X-CSRF-Token": c, Origin: BASE } });
  }
});
