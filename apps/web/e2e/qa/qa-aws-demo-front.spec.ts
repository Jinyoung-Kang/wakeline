import { test, type Page, type Route } from "@playwright/test";
import { assertIsolated, instrument, saveJson, shot } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA 2026-10-aws 공개 데모(A1) — 앞단(AWS)의 두 응답을 page.route 로 흉내 내고 열린 화면이 무엇을 보이는가(탐색 · 수집 — 판정은 findings/public-demo.md).
 *  - 잠금 만료(gate — aws-deploy gate/gate.py _verify): 화면 이동(GET · Accept 에 text/html)은 401 HTML 잠금 화면, 그 밖(REST · RSC · ETag 조회)은 401
 *    {"error":"locked",…}. WS 업그레이드도 401 이라 브라우저에서는 열리지 않고 error → close 1006 — 이미 열린 WS 는 그대로다(gate 는 업그레이드 때만 본다).
 *  - 정지(18:00 뒤 — CloudFront 오류 응답): 모든 요청이 503 text/html 오프라인 안내. 열린 WS 는 서버가 내려가며 끊기고, 다시 열기는 1006.
 * WS 는 init 스크립트로 window.WebSocket 을 감싸 window.__qaWsFail 이 참이면 새 연결을 error → close(1006)로 실패시키고, 참이 되는 순간 열린 연결을 닫는다.
 * 결과: $QA_EVIDENCE_DIR/demo-front.json · demo-front-*.png
 */
const LOCK_HTML = "<!doctype html><html lang=ko><head><meta charset=utf-8><title>접근 코드 — QA 흉내</title></head><body><h1 id=qa-lock>접근 코드가 필요합니다(QA 흉내 잠금 화면)</h1></body></html>";
const OFFLINE_HTML = "<!doctype html><html lang=ko><head><meta charset=utf-8><title>운영 시간 아님 — QA 흉내</title></head><body><h1 id=qa-offline>지금은 데모 운영 시간이 아닙니다(QA 흉내)</h1></body></html>";

const out: Record<string, unknown> = {};

async function wrapWebSocket(page: Page) {
  await page.addInitScript(() => {
    const W = window as unknown as { __qaWsFail?: boolean; __qaWsLog: { t: number; ev: string; code?: number }[]; __qaWsOpen: Set<WebSocket> };
    W.__qaWsLog = [];
    W.__qaWsOpen = new Set();
    const Real = window.WebSocket;
    class QaWs extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0; url: string; protocol = ""; extensions = ""; bufferedAmount = 0; binaryType: BinaryType = "blob";
      onopen: ((e: Event) => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null; onclose: ((e: CloseEvent) => void) | null = null;
      private real: WebSocket | null = null;
      constructor(url: string | URL, protocols?: string | string[]) {
        super();
        this.url = String(url);
        W.__qaWsLog.push({ t: Date.now(), ev: "new" });
        if (W.__qaWsFail) {
          setTimeout(() => {
            this.readyState = 3;
            this.fire("error", new Event("error"));
            this.fire("close", new CloseEvent("close", { code: 1006, reason: "", wasClean: false }));
            W.__qaWsLog.push({ t: Date.now(), ev: "fail", code: 1006 });
          }, 30);
          return;
        }
        const r = new Real(url, protocols);
        this.real = r;
        W.__qaWsOpen.add(r);
        r.binaryType = this.binaryType;
        r.onopen = (e) => { this.readyState = 1; this.fire("open", e); };
        r.onmessage = (e) => this.fire("message", new MessageEvent("message", { data: e.data }));
        r.onerror = () => this.fire("error", new Event("error"));
        r.onclose = (e) => { this.readyState = 3; W.__qaWsOpen.delete(r); W.__qaWsLog.push({ t: Date.now(), ev: "close", code: e.code }); this.fire("close", new CloseEvent("close", { code: e.code, reason: e.reason, wasClean: e.wasClean })); };
      }
      private fire(type: string, e: Event) {
        const h = (this as unknown as Record<string, ((ev: Event) => void) | null>)[`on${type}`];
        if (h) h.call(this, e);
        this.dispatchEvent(e);
      }
      send(d: string) { this.real?.send(d); }
      close(code?: number, reason?: string) { this.readyState = 2; this.real?.close(code, reason); }
    }
    window.WebSocket = QaWs as unknown as typeof WebSocket;
  });
}

async function gateLocked(route: Route) {
  const req = route.request();
  const html = req.method() === "GET" && (req.headers()["accept"] ?? "").includes("text/html");
  if (html) return route.fulfill({ status: 401, contentType: "text/html; charset=utf-8", body: LOCK_HTML });
  return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "locked", message: "접근 코드가 필요합니다", unlock: "/__gate/" }) });
}

async function offline(route: Route) {
  return route.fulfill({ status: 503, contentType: "text/html", body: OFFLINE_HTML });
}

async function snapshot(page: Page, name: string) {
  await shot(page, `demo-front-${name}.png`);
  return page.evaluate(() => {
    const t = (sel: string) => Array.from(document.querySelectorAll(sel)).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean);
    const W = window as unknown as { __qaWsLog?: { ev: string; code?: number }[] };
    return {
      url: location.pathname,
      title: document.title,
      h1: t("h1").slice(0, 3),
      statusbar: t('[data-testid="statusbar-row"]').slice(0, 6),
      alertsBanner: t('[data-testid="alerts-stale"], [data-testid="conn"]').slice(0, 4),
      errorNotes: t('[data-testid="error-note"]').slice(0, 6),
      alertsText: t('[role="alert"]').slice(0, 6),
      lockedHits: (document.body.innerText.match(/접근 코드[^\n]{0,60}/g) ?? []).slice(0, 6),
      http: (document.body.innerText.match(/[^\n]{0,40}HTTP (401|503)[^\n]{0,40}/g) ?? []).slice(0, 8),
      ws: (W.__qaWsLog ?? []).reduce<Record<string, number>>((m, e) => ({ ...m, [`${e.ev}${e.code ?? ""}`]: (m[`${e.ev}${e.code ?? ""}`] ?? 0) + 1 }), {}),
    };
  });
}

test.describe.configure({ mode: "serial" });

for (const kind of ["locked", "offline"] as const) {
  test(`앞단 ${kind} — 상황판 · 화면 이동`, async ({ page, baseURL }) => {
    assertIsolated(baseURL);
    test.setTimeout(240_000);
    await emptyExternal(page);
    await wrapWebSocket(page);
    const net = await instrument(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8_000);
    const before = await snapshot(page, `${kind}-0-before`);
    // 앞단이 바뀐다: 같은 출처의 모든 요청(문서 · RSC · REST · 정적 파일)
    net.reset();
    await page.route((u) => u.origin === new URL(baseURL!).origin, kind === "locked" ? gateLocked : offline);
    // 잠금: 열린 WS 는 그대로(gate 는 업그레이드 때만) — 새 연결만 실패. 정지: 열린 WS 도 끊긴다
    await page.evaluate((k) => {
      const W = window as unknown as { __qaWsFail: boolean; __qaWsOpen: Set<WebSocket> };
      W.__qaWsFail = true;
      if (k === "offline") for (const s of W.__qaWsOpen) s.close(4000, "qa offline");
    }, kind);
    await page.waitForTimeout(75_000); // 15 s · 30 s · 60 s 주기 조회가 한 번 이상 돌게
    const after = await snapshot(page, `${kind}-1-after75s`);
    const apiAfter = net.bad.filter((b) => /\/api\//.test(b.url)).map((b) => `${b.status} ${b.url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*/, "")}`);
    // 상단 메뉴로 화면 이동(클라이언트 이동 — RSC 요청이 앞단 응답을 받는다)
    net.reset();
    await page.getByRole("link", { name: "통계" }).click();
    await page.waitForTimeout(6_000);
    const nav = await snapshot(page, `${kind}-2-nav-stats`);
    const navReqs = net.requests.filter((r) => !/\/_next\/static\//.test(r.url)).map((r) => `${r.method} ${r.type} ${r.url.replace(/^https?:\/\/[^/]+/, "")}`).slice(0, 12);
    out[kind] = { before, after, apiAfter: [...new Set(apiAfter)], nav, navReqs, pageErrors: net.pageErrors.map((e) => e.text).slice(0, 5) };
    saveJson("demo-front.json", out);
  });
}
