import { DASHBOARD_PARTS } from "@/components/DashboardParts";

/**
 * 나중에 받는 상황판 조각(components/DashboardParts — ADR-026)을 모두 미리 받는다. 조각의 **내용**을 보는 시험(탭 내용 · 검색 결과 표 ·
 * 범례·정합)이 진행 표시가 아니라 내용을 그리게 한다 — 미리 받지 않으면 첫 그리기는 '불러오는 중' 자리만 그려 내용 검사가 헛돈다.
 * 받는 동안 · 실패의 모양은 tests/lazy-part.test.ts 가 따로 본다.
 */
export async function preloadDashboardParts(): Promise<void> {
  await Promise.all(DASHBOARD_PARTS.map((p) => p.preload()));
}
