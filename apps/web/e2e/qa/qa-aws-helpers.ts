/**
 * QA 2026-10-aws 브라우저 점검 도우미(격리 스택 A — 8701).
 * - emptyExternal: 외부 호스트(OpenFreeMap · RainViewer)를 page.route 로 막고 빈 응답으로 대신한다(사용자 결정 — 계획 §8 승인 질문 2).
 *   스타일 JSON 은 빈 스타일(레이어 0), 그 밖은 204. page.route 는 qa-helpers instrument 의 context.route(끊기)보다 먼저 받는다.
 *   막은 요청은 호스트별로 센다(돌려준 Map) — '실패한 요청'에는 넣지 않는다.
 * - alertId: 실제 알림 id(/api/v1/alerts/history 의 첫 항목).
 */
import type { Page } from "@playwright/test";

export async function emptyExternal(page: Page): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/]|\[::1\][:/])/, async (route) => {
    const u = new URL(route.request().url());
    counts.set(u.hostname, (counts.get(u.hostname) ?? 0) + 1);
    if (/\/styles\//.test(u.pathname)) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: 8, name: "qa-empty", sources: {}, layers: [] }) });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  return counts;
}

export async function alertId(page: Page): Promise<string> {
  const r = await page.request.get("/api/v1/alerts/history?limit=1");
  const j = (await r.json()) as { items?: { id: number | string }[] };
  return String(j.items?.[0]?.id ?? "1");
}

