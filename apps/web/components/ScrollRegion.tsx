"use client";
import type { HTMLAttributes, ReactNode } from "react";
import { useScrollFocusable } from "@/lib/use-scroll-focusable";

/**
 * 키보드로 스크롤할 수 있는 내용 상자(QA-305 — WCAG 2.1.1, axe scrollable-region-focusable): 이름 붙은 영역(role=region · aria-label)이고, 넘칠 때만
 * Tab 정지점이 된다(lib/use-scroll-focusable). 서버 컴포넌트(출처 · 설명서)도 이것으로 감싼다.
 * main = 화면의 본문 상자 — '본문으로 건너뛰기'(#main)로 온 초점을 이 상자로 넘긴다(components/Shell — 그래야 PageDown · 화살표가 이 상자를 스크롤한다).
 */
export function ScrollRegion({ label, main = false, children, ...rest }: { label: string; main?: boolean; children?: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, "role" | "tabIndex">) {
  const ref = useScrollFocusable<HTMLDivElement>();
  return <div {...rest} ref={ref} role="region" aria-label={label} data-main-scroll={main || undefined}>{children}</div>;
}
