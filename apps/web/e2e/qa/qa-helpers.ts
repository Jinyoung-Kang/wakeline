/**
 * QA 2026-10 화면 · 접근성 점검 도우미(격리 스택 A 전용).
 * - instrument: 외부 호스트(localhost · 127.0.0.1 밖) 요청을 막고(지도 타일 · 레이더 타일 — 외부 호출 0), 콘솔 오류 · 경고, 페이지 오류,
 *   실패한 요청(상태 ≥ 400 · 끊김 — 막은 외부 호스트 제외), 모든 요청의 시각(중복 요청 판정용)을 모은다.
 * - runAxe: node_modules/axe-core 의 axe.min.js 를 page.evaluate 로 넣고(CSP 를 끄지 않는다 — 스크립트 태그가 아니라 DevTools 평가) WCAG 2.1 A · AA 규칙만 돌린다.
 * - loginOps: 실제 로그인 폼으로 들어간다. 비밀번호는 0600 자격 증명 파일에서 이 함수 안에서만 읽고 출력 · 기록 · 스크린샷하지 않는다.
 */
import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

export const EVIDENCE_DIR = path.resolve(__dirname, "../../../../docs/qa/2026-10/evidence/ui-a11y");
const AXE_PATH = path.resolve(__dirname, "../../node_modules/axe-core/axe.min.js");
const CREDS = process.env.QA_CREDS
  ?? "/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/75437490-c65b-4783-9ac0-e224c92a9bab/scratchpad/qa-creds.json";

/** 격리 스택(8701 · 8702)만 — 운영 스택(8700)이면 멈춘다 */
export function assertIsolated(baseURL: string | undefined) {
  const port = Number(new URL(baseURL ?? "http://x").port);
  if (port !== 8701 && port !== 8702) throw new Error(`QA 는 격리 스택만: ${baseURL}`);
}

export interface ReqRec { t: number; method: string; url: string; type: string }
export interface Net {
  requests: ReqRec[];
  bad: { t: number; status: number; method: string; url: string }[];
  failed: { t: number; method: string; url: string; error: string }[];
  blockedHosts: Map<string, number>;
  console: { t: number; type: string; text: string; url: string }[];
  pageErrors: { t: number; text: string }[];
  /** 지금까지 모은 것을 비운다(단계마다 따로 보려고) */
  reset(): void;
}

const isLocal = (u: string) => {
  try { const h = new URL(u).hostname; return h === "localhost" || h === "127.0.0.1" || h === "[::1]"; } catch { return true; }
};

export async function instrument(page: Page): Promise<Net> {
  const t0 = Date.now();
  const net: Net = {
    requests: [], bad: [], failed: [], blockedHosts: new Map(), console: [], pageErrors: [],
    reset() { this.requests.length = 0; this.bad.length = 0; this.failed.length = 0; this.console.length = 0; this.pageErrors.length = 0; },
  };
  const now = () => Date.now() - t0;
  // 외부 호스트는 모두 막는다(OpenFreeMap 스타일 · 타일, RainViewer 레이더 타일 등) — 시험 결과가 바깥 네트워크에 달리지 않게, 외부 호출 0
  await page.context().route(/^https?:\/\//, (route) => {
    const u = route.request().url();
    if (isLocal(u)) return route.continue();
    const h = new URL(u).hostname;
    net.blockedHosts.set(h, (net.blockedHosts.get(h) ?? 0) + 1);
    return route.abort("blockedbyclient");
  });
  page.on("request", (r) => { if (isLocal(r.url())) net.requests.push({ t: now(), method: r.method(), url: r.url(), type: r.resourceType() }); });
  // 응답을 받은 요청: Chromium 은 본문 없는 응답(204 · 조건부 요청의 304)을 받은 뒤에도 requestfailed(ERR_ABORTED)를 알린다 — 실패로 세지 않는다
  const answered = new WeakSet<object>();
  page.on("response", (r) => {
    answered.add(r.request());
    if (r.status() >= 400 && isLocal(r.url())) net.bad.push({ t: now(), status: r.status(), method: r.request().method(), url: r.url() });
  });
  page.on("requestfailed", (r) => {
    if (!isLocal(r.url())) return;
    // 확인함: /api/v1/radar/kr 의 304 · DELETE /api/v1/ops/session 의 204 — 페이지의 fetch 는 그 상태를 받는다(실패가 아니다)
    if (r.failure()?.errorText === "net::ERR_ABORTED" && (answered.has(r) || r.headers()["if-none-match"])) return;
    net.failed.push({ t: now(), method: r.method(), url: r.url(), error: r.failure()?.errorText ?? "?" });
  });
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") net.console.push({ t: now(), type: m.type(), text: m.text().slice(0, 500), url: m.location().url ?? "" });
  });
  page.on("pageerror", (e) => net.pageErrors.push({ t: now(), text: `${e.name}: ${e.message}`.slice(0, 500) }));
  return net;
}

/** 외부 호스트를 막은 데서 오는 콘솔 오류(타일 · 스타일 실패)인지 */
export function isBlockedNoise(text: string) {
  return /ERR_BLOCKED_BY_CLIENT|openfreemap|rainviewer|Failed to fetch|AJAXError/i.test(text);
}

/**
 * 중복 요청: 같은 method+URL 이 windowMs 안에 두 번 이상(문서 · 스크립트 등 정적 자원 제외 — API · RSC 만).
 * 주기 요청(documented poll)은 호출부가 거른다.
 */
export function duplicates(reqs: ReqRec[], windowMs = 1500) {
  const api = reqs.filter((r) => /\/api\/|_rsc=|\/ws\//.test(r.url) && r.type !== "image");
  const out: { method: string; url: string; times: number[] }[] = [];
  const by = new Map<string, number[]>();
  for (const r of api) { const k = `${r.method} ${r.url}`; by.set(k, [...(by.get(k) ?? []), r.t]); }
  for (const [k, ts] of by) {
    const close = ts.filter((t, i) => ts.some((u, j) => j !== i && Math.abs(u - t) <= windowMs));
    if (close.length > 1) { const [method, ...rest] = k.split(" "); out.push({ method, url: rest.join(" "), times: ts }); }
  }
  return out;
}

export interface AxeViolation { id: string; impact: string | null; help: string; tags: string[]; nodes: { target: string[]; html: string; failureSummary?: string }[] }

export async function runAxe(page: Page, opts: { exclude?: string[] } = {}): Promise<AxeViolation[]> {
  const has = await page.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe !== "undefined");
  if (!has) await page.evaluate(fs.readFileSync(AXE_PATH, "utf8"));
  return page.evaluate(async (exclude) => {
    const axe = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe;
    const ctx = exclude.length ? { include: [["html"]], exclude: exclude.map((s) => [s]) } : document;
    const r = await axe.run(ctx, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, tags: v.tags, nodes: v.nodes.map((n) => ({ target: n.target, html: n.html.slice(0, 300), failureSummary: n.failureSummary?.slice(0, 400) })) }));
  }, opts.exclude ?? []);
}

/** 가로 넘침: 문서 폭이 창보다 넓은가 + 창 밖으로 나간 보이는 요소(오른쪽 끝 기준) */
export async function overflow(page: Page) {
  return page.evaluate(() => {
    const iw = window.innerWidth;
    const doc = document.documentElement.scrollWidth;
    const out: { sel: string; right: number; w: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      if (r.right > iw + 1 && r.left < iw) {
        // 스크롤 상자 안에서 넘친 것은 그 상자가 잘라 보이므로 빼고, 잘리지 않고 창 밖으로 나간 것만
        let p = el.parentElement, clipped = false;
        while (p && p !== document.body) {
          const pc = getComputedStyle(p);
          if (/(auto|scroll|hidden|clip)/.test(pc.overflowX) && p.getBoundingClientRect().right <= iw + 1) { clipped = true; break; }
          p = p.parentElement;
        }
        if (!clipped) out.push({ sel: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (el.dataset.testid ? `[data-testid=${el.dataset.testid}]` : "") + (el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/).slice(0, 3).join(".")}` : ""), right: Math.round(r.right), w: Math.round(r.width) });
      }
    }
    return { innerWidth: iw, scrollWidth: doc, overflow: doc > iw, offenders: out.slice(0, 15) };
  });
}

export function saveJson(name: string, data: unknown) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, name), JSON.stringify(data, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v), 2) + "\n");
}

export async function shot(page: Page, name: string, fullPage = false) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, name), fullPage });
}

/**
 * 실제 로그인 폼으로 운영자 로그인. 비밀번호는 자격 증명 파일에서 읽어 입력칸에만 넣는다(출력 · 기록하지 않음).
 * 로그인 중에는 스크린샷을 찍지 않는다(입력칸은 type=password 라 가려지지만 그래도).
 */
export async function loginOps(page: Page, user: "qa-a" | "qa-b" = "qa-b") {
  const pw: string = JSON.parse(fs.readFileSync(CREDS, "utf8")).users[user];
  await page.goto("/ops");
  await expect(page.getByTestId("ops-login")).toBeVisible({ timeout: 20_000 });
  await page.locator("#ops-user").fill(user);
  await page.locator("#ops-pass").fill(pw);
  await page.locator('[data-testid="ops-login"] button[type="submit"]').click();
  await expect(page.getByTestId("ops-dashboard")).toBeVisible({ timeout: 20_000 });
}

/** 지금 초점의 요약(태그 · 이름 · 보이는 테두리 여부) */
export async function focusInfo(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { tag: "body", name: "", visible: false, outline: "", testid: "", inViewport: false };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    const outline = `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`;
    const visible = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
    const inViewport = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && r.width > 0;
    return { tag: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ""), name, visible, outline, testid: el.dataset.testid ?? "", inViewport };
  });
}

/**
 * 운영 API 를 계약 모양의 값으로 대신 준다(재현 시험용 — 자격 증명 없이 결정적으로). 기존 e2e/ops-screens.spec.ts 와 같은 방식.
 * bodies 의 열쇠 = 경로(pathname). 없는 GET 은 404(문제 응답), GET 이 아닌 요청도 404.
 */
export async function mockOpsApi(page: Page, bodies: Record<string, unknown>) {
  const now = Date.now();
  const { opsProviders, opsPipeline } = await import("../rest-inject");
  const base: Record<string, unknown> = {
    "/api/v1/ops/session": { role: "OPS", username: "qa-mock" },
    "/api/v1/ops/providers": opsProviders(now),
    "/api/v1/ops/runs": { items: [], summary_24h: [], hidden_resolved_errors: 0, generated_at: new Date(now).toISOString() },
    "/api/v1/ops/quality": { rule_counts: [], recent: [], day_zone: "Asia/Seoul" },
    "/api/v1/ops/settings": { items: [] },
    "/api/v1/ops/audit": { items: [], next_cursor: null },
    "/api/v1/ops/dlq": { items: [] },
    "/api/v1/ops/pipeline": opsPipeline(now),
    "/api/v1/ops/logs": { items: [], next_cursor: null, scanned: 0, scan_truncated: false, invalid: 0, hidden_resolved: 0, resolution_state: "ok" },
    "/api/v1/ops/logs/groups": { groups: [], scanned: 0, scan_truncated: false, invalid: 0, hidden_resolved: 0, resolution_state: "ok" },
    ...bodies,
  };
  await page.route(/\/api\/v1\/ops\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET" || !(path in base)) {
      await route.fulfill({ status: 404, contentType: "application/problem+json", body: JSON.stringify({ status: 404, detail: "not mocked" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(base[path]) });
  });
}

/** 외부 호스트를 막는다(지도 · 레이더 타일 — 외부 호출 0) */
export async function blockExternal(page: Page) {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort("blockedbyclient"));
}
