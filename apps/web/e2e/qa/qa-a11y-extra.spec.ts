import { test, type Page } from "@playwright/test";
import { assertIsolated, instrument, loginOps, overflow, saveJson, shot } from "./qa-helpers";

/**
 * QA 2026-10 §3.6 — axe 가 보지 못하는 것:
 * - 200 % 확대(1280×800 의 200 % = CSS 640×400) · 400 %(320×256 — WCAG 1.4.10 의 320 CSS px)에서 가로 넘침 · 잘린 조작(창 밖 · 스크롤 상자 밖)
 * - 라이브 영역이 화면 읽기 프로그램에 주는 글자(브라우저 접근성 트리 — 띄어쓰기 없이 붙는가)
 * - 검색으로 고른 뒤의 알림(검색 상태 라이브 영역) · lang · 영어 문구의 lang 표시
 * 결과: docs/qa/2026-10/evidence/ui-a11y/a11y-extra.json · reflow-*.png. 쓰기 없음.
 */
async function clippedControls(page: Page) {
  // 보이는 조작 요소 중 창 밖(오른쪽 · 아래 — 스크롤로 닿지 못하는 곳)에 있거나 조상 상자가 잘라 보이지 않는 것
  return page.evaluate(() => {
    const out: string[] = [];
    const iw = innerWidth, ih = innerHeight;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("a[href],button,input,select,[role=tab],[tabindex='0']"))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || el.closest("[hidden]")) continue;
      if (el.classList.contains("skip-link")) continue;
      // 가장 가까운 스크롤 가능한 조상(그 안에서 스크롤하면 닿는다)
      let p = el.parentElement, scroller: HTMLElement | null = null, clippedBy: HTMLElement | null = null;
      while (p && p !== document.body) {
        const pc = getComputedStyle(p);
        const ox = pc.overflowX, oy = pc.overflowY;
        if ((/(auto|scroll)/.test(ox) && p.scrollWidth > p.clientWidth) || (/(auto|scroll)/.test(oy) && p.scrollHeight > p.clientHeight)) { scroller = p; break; }
        if (/(hidden|clip)/.test(ox) || /(hidden|clip)/.test(oy)) {
          const pr = p.getBoundingClientRect();
          if (r.left >= pr.right - 1 || r.right <= pr.left + 1 || r.top >= pr.bottom - 1 || r.bottom <= pr.top + 1) { clippedBy = p; break; }
        }
        p = p.parentElement;
      }
      const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      const id = `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""} "${name}"`;
      if (clippedBy) { out.push(`${id} — 조상이 잘라 보이지 않음(${clippedBy.className.toString().slice(0, 50)})`); continue; }
      if (scroller) continue;
      if (r.left >= iw - 1 || r.top >= ih - 1) out.push(`${id} — 창 밖(x ${Math.round(r.left)} · y ${Math.round(r.top)}, 창 ${iw}×${ih}, 페이지 스크롤 없음)`);
      else if (r.right > iw + 1) out.push(`${id} — 오른쪽이 잘림(right ${Math.round(r.right)} > ${iw})`);
    }
    return out.slice(0, 30);
  });
}

test("reflow at 200 % / 320 px, live-region text, language", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(600_000);
  await instrument(page);
  const out: Record<string, unknown> = {};

  // ── 200 % · 400 % 확대
  const ROUTES = ["/", "/replay", "/stats", "/airports/RKSI", "/about", "/guide", "/ops"];
  for (const [label, vp] of [["zoom200-640x400", { width: 640, height: 400 }], ["reflow-320x256", { width: 320, height: 256 }]] as const) {
    await page.setViewportSize(vp);
    const r: Record<string, unknown> = {};
    for (const route of ROUTES) {
      await page.goto(route);
      await page.waitForTimeout(route === "/" ? 7000 : 3000);
      r[route] = { overflow: await overflow(page), clipped: await clippedControls(page) };
      await shot(page, `reflow-${label}-${route === "/" ? "dashboard" : route.slice(1).replace(/\//g, "-")}.png`);
    }
    out[label] = r;
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await loginOps(page, "qa-b");
  await page.waitForTimeout(2000);
  out["ops-signed-in-375"] = { overflow: await overflow(page), clipped: await clippedControls(page), tabs: await page.locator('[role="group"][aria-label="운영 탭"] button').evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return `${(b as HTMLElement).dataset.testid} x=${Math.round(r.left)}..${Math.round(r.right)}`; })) };
  await shot(page, "reflow-ops-375-tabs.png");
  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(800);
  out["ops-signed-in-320"] = { clipped: await clippedControls(page) };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "sign out" }).click();

  // ── 라이브 영역 · 검색 알림(브라우저 접근성 트리)
  await page.goto("/");
  await page.waitForTimeout(9000);
  const cdp = await page.context().newCDPSession(page);
  const liveText = async () => {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree") as { nodes: { nodeId: string; role?: { value: string }; name?: { value: string }; childIds?: string[]; properties?: { name: string; value: { value: unknown } }[] }[] };
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const texts = (n: (typeof nodes)[number]): string[] => (n.role?.value === "StaticText" ? [n.name?.value ?? ""] : (n.childIds ?? []).flatMap((c) => { const k = byId.get(c); return k ? texts(k) : []; }));
    return nodes.filter((n) => n.properties?.some((p) => p.name === "live" && p.value.value !== "off")).map((n) => ({ role: n.role?.value, text: texts(n).join("|") }));
  };
  out.liveRegionsAX = await liveText();
  // 검색으로 고른 뒤: 초점은 입력에 남는다 — 카드가 열렸다는 것을 무엇이 알리는가
  await page.keyboard.press("/");
  await page.keyboard.type("KAL");
  await page.waitForTimeout(1500);
  const statusBefore = await page.locator('[data-testid="aircraft-search"] [aria-live]').innerText();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  out.searchSelect = {
    statusBeforeSelect: statusBefore,
    statusAfterSelect: await page.locator('[data-testid="aircraft-search"] [aria-live]').innerText(),
    activeElement: await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? document.activeElement?.tagName),
    cardOpen: await page.getByTestId("aircraft-card").isVisible().catch(() => false),
    liveRegionsAfter: await liveText(),
  };

  // ── 언어: 문서 lang, 영어 제목 · 단추에 lang 표시가 있는가
  const lang: Record<string, unknown> = {};
  for (const route of ["/", "/stats", "/about", "/airports/RKSI"]) {
    await page.goto(route);
    await page.waitForTimeout(2500);
    lang[route] = await page.evaluate(() => ({
      html: document.documentElement.lang,
      h1: Array.from(document.querySelectorAll("h1,h2")).map((h) => `${h.tagName}:${(h as HTMLElement).innerText.trim().slice(0, 50)}${h.closest("[lang]") && h.closest("[lang]") !== document.documentElement ? ` [lang=${h.closest("[lang]")!.getAttribute("lang")}]` : ""}`).slice(0, 6),
      elementsWithLangEn: document.querySelectorAll("[lang^=en]").length,
    }));
  }
  out.lang = lang;
  saveJson("a11y-extra.json", out);
});
