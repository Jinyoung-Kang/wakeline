"use client";
import { useCallback } from "react";

/** 상자가 넘치는가(세로 또는 가로 — 1 px 반올림 여유) */
export function overflows(el: Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollWidth" | "clientWidth">): boolean {
  return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
}

/**
 * 스크롤 상자를 키보드로 읽게(WCAG 2.1.1 — QA-305, axe scrollable-region-focusable): 본문은 overflow hidden 이고 내용은 안쪽 상자가 스크롤하는데, 그 상자에
 * 초점이 없어 키보드(PageDown · 화살표)로는 읽을 길이 없었다(Chromium 은 초점 없는 스크롤 상자를 스스로 Tab 정지점으로 만들지만 Safari 등은 아니다).
 * 상자가 실제로 넘칠 때만 tabIndex=0(Tab 으로 들어가 스크롤), 넘치지 않으면 -1(Tab 정지점을 늘리지 않고 프로그램 초점만 — 초점 되살리기의 자리).
 * 상자의 크기(ResizeObserver)와 내용(MutationObserver — 표가 늘어남 · 탭 바뀜)이 바뀔 때마다 한 프레임에 한 번 다시 본다.
 * 쓰는 쪽은 ref 로 달고 tabIndex 를 따로 주지 않는다(이 Hook 이 정한다). 이름(aria-label)과 role=region 은 쓰는 쪽이 단다.
 */
export function useScrollFocusable<T extends HTMLElement>(): (el: T | null) => (() => void) | undefined {
  return useCallback((el: T | null) => {
    if (!el) return undefined;
    const update = () => { el.tabIndex = overflows(el) ? 0 : -1; };
    update();
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); };
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(later) : null;
    ro?.observe(el);
    const mo = typeof MutationObserver === "function" ? new MutationObserver(later) : null;
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { ro?.disconnect(); mo?.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, []);
}
