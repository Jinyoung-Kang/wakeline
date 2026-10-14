import { test, type Page } from "@playwright/test";
import { assertIsolated, duplicates, instrument, isBlockedNoise, overflow, runAxe, saveJson, shot } from "./qa-helpers";
import { alertId, emptyExternal } from "./qa-aws-helpers";

/**
 * QA 2026-10-aws 공개 데모(A1 — WAKELINE_PUBLIC_DEMO=1, 계획 §3.3 '공개 데모 모드로 한 번 더') — 10경로 × 1440 · 768 · 375 · 320 px 첫 화면(쓰기 없음).
 * 앞선 qa-aws-sweep 과 같은 수집(콘솔 · 페이지 오류 · 실패 · 중복 요청 · 가로 넘침 · axe)에 **운영 정보 노출 검사**를 더한다:
 * 보이는 글자 · title · aria-label · 링크(href)에서 운영자 화면(/ops · /logs)을 가리키는 것, '운영 화면' · '운영 메뉴' · '로그 보기' · 수집 작업 이름 · 머리말 local.
 * /ops · /logs 는 A1 에 앞단이 없어 직접 열리므로(운영자용 화면 그 자체) 노출 검사에서 뺀다.
 * 외부 호스트는 빈 응답(qa-aws-helpers emptyExternal). 결과: $QA_EVIDENCE_DIR/demo-sweep-<폭>.json · demo-sweep-<폭>-<경로>.png
 */
const VIEWPORTS = { w1440: { width: 1440, height: 900 }, w768: { width: 768, height: 1024 }, w375: { width: 375, height: 812 }, w320: { width: 320, height: 640 } } as const;
const slug = (r: string) => (r === "/" ? "dashboard" : r.slice(1).replace(/[/[\]]/g, "-"));

/** 공개 데모에서 방문자에게 보이면 안 되는 운영자 길잡이(ADR-039 — 감추는 것 · 덧붙임 2-7) */
const LEAK = /(^|[^\w])\/(ops|logs)(\b|#|$)|운영 화면|운영 메뉴|운영 로그|로그 보기|운영 탭|kma_warning|portfolio · non-commercial · local/;

export async function leakScan(page: Page) {
  return page.evaluate((src) => {
    const re = new RegExp(src);
    const hits: { where: string; text: string }[] = [];
    const vis = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
    // 보이는 글자(줄 단위)
    for (const line of (document.body.innerText ?? "").split("\n")) if (re.test(line)) hits.push({ where: "text", text: line.trim().slice(0, 200) });
    for (const el of Array.from(document.querySelectorAll("[title],[aria-label]"))) {
      for (const a of ["title", "aria-label"]) {
        const v = el.getAttribute(a);
        if (v && re.test(v)) hits.push({ where: `${el.tagName.toLowerCase()}@${a}${vis(el) ? "" : "(hidden)"}`, text: v.slice(0, 200) });
      }
    }
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const u = new URL(a.href, location.href);
      if (u.origin === location.origin && /^\/(ops|logs)(\/|$)/.test(u.pathname)) hits.push({ where: `a[href]${vis(a) ? "" : "(hidden)"}`, text: `${u.pathname}${u.hash} "${(a.textContent ?? "").trim().slice(0, 60)}"` });
    }
    return { hits, headerLabel: document.querySelector("header .label.hidden")?.textContent ?? null, nav: Array.from(document.querySelectorAll('nav[aria-label="주 메뉴"] a')).map((a) => a.textContent) };
  }, LEAK.source);
}

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test(`demo sweep ${vpName} ${vp.width}x${vp.height}`, async ({ page, baseURL }) => {
    assertIsolated(baseURL);
    test.setTimeout(900_000);
    await page.setViewportSize(vp);
    const net = await instrument(page);
    const blocked = await emptyExternal(page);
    const id = await alertId(page);
    const ROUTES = ["/", "/m", "/replay", "/stats", "/airports/RKSI", `/alerts/${id}`, "/ops", "/logs", "/about", "/guide"];
    const results: unknown[] = [];
    for (const route of ROUTES) {
      net.reset();
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(route === "/" || route === "/replay" || route === "/m" ? 10_000 : 6_000);
      const ov = await overflow(page);
      const axe = await runAxe(page);
      await shot(page, `demo-sweep-${vpName}-${slug(route)}.png`);
      const operatorScreen = route === "/ops" || route === "/logs";
      results.push({
        route,
        title: await page.title(),
        leak: operatorScreen ? "skipped(운영자 화면 자체)" : await leakScan(page),
        consoleErrors: net.console.filter((c) => c.type === "error" && !isBlockedNoise(c.text)).map((c) => c.text),
        consoleWarnings: net.console.filter((c) => c.type === "warning" && !/GL Driver|GPU stall|WebGL/.test(c.text)).map((c) => c.text),
        pageErrors: net.pageErrors.map((e) => e.text),
        badResponses: net.bad.map((b) => `${b.status} ${b.method} ${b.url.replace(/^https?:\/\/[^/]+/, "")}`),
        failedRequests: net.failed.map((f) => `${f.error} ${f.method} ${f.url.replace(/^https?:\/\/[^/]+/, "")}`),
        duplicates: duplicates(net.requests),
        overflow: ov,
        axe: axe.map((v) => ({ id: v.id, impact: v.impact, wcag: v.tags.filter((t) => /^wcag\d/.test(t)), count: v.nodes.length, help: v.help, examples: v.nodes.slice(0, 3).map((n) => ({ target: n.target.join(" "), html: n.html })) })),
      });
      saveJson(`demo-sweep-${vpName}.json`, { viewport: vp, blockedExternal: Object.fromEntries(blocked), results });
    }
    saveJson(`demo-sweep-${vpName}.json`, { viewport: vp, blockedExternal: Object.fromEntries(blocked), results });
  });
}
