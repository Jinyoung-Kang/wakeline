/**
 * 설명서 2.10(상태 바)이 지금의 동작과 맞는지(검토 발견 2026-09-30): 경고만으로도 폭이 모자라면 줄이 둘째 줄로 넘어간다(잘리지 않는다) ·
 * 상세의 Esc 는 초점이 상세에 있을 때(다른 입력의 Esc 는 그 입력의 것) · 초점이 밖으로 나가면 닫힌다 · 일부 구역 AIS 공백도 길이를 센다 ·
 * 끝난 지 30분이 지난 공백은 상세에서 주의가 아니다. 수정 전 설명서에서 실패하는 것을 먼저 확인했다.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GuideManifest } from "@/lib/guide";
import { AIS_GAP_SHOW_MS } from "@/lib/ships";
import { parseHtml, textOf, findAll } from "./helpers/html-tree";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
const { GuideView } = await import("@/components/guide/GuideView");

const EMPTY: GuideManifest = { version: 1, shots: {} };
const section = () => {
  const root = parseHtml(renderToStaticMarkup(createElement(GuideView, { manifest: EMPTY, dropped: [] })));
  const s = findAll(root, (n) => n.attrs.id === "dashboard-status")[0];
  expect(s, "2.10 section").toBeTruthy();
  return textOf(s).replace(/\s+/g, " ");
};

describe("guide 2.10 describes the status bar as built", () => {
  it("one line that never scrolls sideways — and when the warnings alone do not fit, it wraps to a second line instead of clipping", () => {
    const t = section();
    expect(t).toContain("가로로 스크롤되지 않습니다");
    expect(t).toMatch(/주의 · 경고 칩만으로도 폭이 모자라면[^.]*둘째 줄로 넘어갑니다/);
  });
  it("상세 closes on Escape from inside it, on a press outside, and when focus moves elsewhere; another input's Escape stays that input's", () => {
    const t = section();
    expect(t).toContain("Esc(초점이 상세 표나 단추에 있을 때 — 초점은 단추로 돌아옵니다)");
    expect(t).toContain("초점이 밖으로 나가면(예: / 로 검색) 닫힙니다");
  });
  it("an AIS gap open in only some zones counts its duration too; an ended gap older than the row window is a record, not a warning", () => {
    const t = section();
    expect(t).toContain("AIS 공백 n/m 구역 진행 중 N");
    expect(t).toContain(`끝난 지 ${AIS_GAP_SHOW_MS / 60_000}분이 지난 공백은 주의 표시 없이 기록으로만`);
  });
});
