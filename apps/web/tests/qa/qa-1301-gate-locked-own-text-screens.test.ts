/**
 * QA 2026-10-aws(docs/qa/2026-10-aws — 영역 web-code) QA-1301: 앞단 잠금 만료(401 {"error":"locked"} — AWS 데모 gate)의 안내(AWS 리뷰 D-5 —
 * lib/api gateLockedText → ApiError code ACCESS_LOCKED · 메시지 "접근 코드가 만료됨 — 새로고침하면 접근 코드를 다시 묻습니다")는 오류 메시지를 그대로
 * 보이는 화면(ErrorNote · errorLine — 통계 · 카드 · /m · 관심 탭)에만 닿는다. 서버 문구 대신 자기 문구를 만드는 화면은 status 만 보고 문구를 고르므로
 * 잠금을 모른다 — D-5 가 고치려던 "화면마다 401 (HTTP 401)만 보인다"가 그 화면들에 그대로 남았다:
 *   - /airports/[icao] (lib/format airportErrorText) → "기상 이력을 불러오지 못했습니다(HTTP 401)."
 *   - /replay (lib/replay replayErrorText) → "기록을 불러오지 못함(HTTP 401)"
 *   - /alerts/[id] (app/alerts/[id]/page.tsx:21) → "알림 근거를 받지 못함"(HTTP 상태도 까닭도 없음)
 *   - 상황판 공항 탭 목록(components/AirportList.tsx:46) → "공항 목록을 불러오지 못했습니다 — 지도에서 공항을 클릭하세요."(지도 클릭도 같은 잠금에 막힌다)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { installMiniDom, MiniElement, visibleText } from "../helpers/mini-dom";
import { apiGet, ApiError } from "@/lib/api";
import { airportErrorText } from "@/lib/format";
import { replayErrorText } from "@/lib/replay";

const dom = installMiniDom();
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
});
afterAll(() => dom.restore());
let root: Root | null = null;
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.unstubAllGlobals();
});

const LOCKED_BODY = { error: "locked", message: "접근 코드가 필요합니다", unlock: "/__gate/" };
const lockedFetch = () => async () => new Response(JSON.stringify(LOCKED_BODY), { status: 401, headers: { "Content-Type": "application/json; charset=utf-8" } });
/** 실제 전송 경로(lib/api apiGet)가 잠금 답으로 만드는 오류 */
async function lockedError(): Promise<ApiError> {
  vi.stubGlobal("fetch", lockedFetch());
  return (await apiGet("/api/v1/anything").catch((x: unknown) => x)) as ApiError;
}

const find = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => {
  if (pred(from)) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
  return null;
};
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });
async function mount(el: React.ReactElement) {
  vi.stubGlobal("self", globalThis); // next/link 의 가시성 효과
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(el); });
  await settle();
  await settle();
}

describe("QA-1301 screens with their own error wording miss the expired access-code notice", () => {
  it("control: the transport already marks the gate's answer (ACCESS_LOCKED)", async () => {
    const e = await lockedError();
    expect([e.status, e.code]).toEqual([401, "ACCESS_LOCKED"]);
  });

  it("/airports/[icao]: airportErrorText", async () => {
    const text = airportErrorText(await lockedError(), "RKSI");
    console.info(`QA-1301 airportErrorText → "${text}"`);
    expect(text).toContain("접근 코드");
  });

  it("/replay: replayErrorText", async () => {
    const text = replayErrorText(await lockedError());
    console.info(`QA-1301 replayErrorText → "${text}"`);
    expect(text).toContain("접근 코드");
  });

  it("/alerts/[id]: the evidence page", async () => {
    vi.stubGlobal("fetch", lockedFetch());
    const AlertPage = (await import("@/app/alerts/[id]/page")).default;
    await mount(createElement(AlertPage, { params: Promise.resolve({ id: "123" }) }));
    const err = find((e) => e.getAttribute?.("data-testid") === "alert-page-error");
    const text = err ? visibleText(err) : "(오류 줄 없음)";
    console.info(`QA-1301 /alerts/123 → "${text}"`);
    expect(text).toContain("접근 코드");
  });

  it("dashboard airport tab: the watched-airport list", async () => {
    vi.stubGlobal("fetch", lockedFetch());
    const { AirportList } = await import("@/components/AirportList");
    await mount(createElement(AirportList));
    const list = find((e) => e.getAttribute?.("data-testid") === "airport-list");
    const text = list ? visibleText(list) : "(목록 없음)";
    console.info(`QA-1301 airport list → "${text}"`);
    expect(text).toContain("접근 코드");
  });
});
