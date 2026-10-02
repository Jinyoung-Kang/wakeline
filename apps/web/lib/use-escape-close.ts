"use client";
import { useEffect, useRef, type RefObject } from "react";
import { pushEscape } from "./escape-stack";
import { isShown } from "./focus-rescue";

type El = RefObject<Element | null> | (() => Element | null);
const get = (r: El | undefined): Element | null => (r == null ? null : typeof r === "function" ? r() : r.current);

/**
 * 열려 있는 동안 이 패널을 Esc 로 닫는다(lib/escape-stack 의 규칙 — 겹치면 나중에 연 것부터). 초점이 패널 안에 있다가 닫히면(패널이 사라져 초점이
 * <body> 로 떨어지기 전에) 연 단추로, 그것이 보이지 않으면 fallback · 본문(<main id="main">)으로 옮긴다(QA-304 와 같은 목적 — WCAG 2.4.3). 초점이 지도 · 본문에
 * 있었으면 그대로.
 */
export function useEscapeClose(open: boolean, close: () => void, refs: { panel: El; opener?: El; fallback?: El }): void {
  const latest = useRef({ close, refs });
  useEffect(() => { latest.current = { close, refs }; });
  useEffect(() => {
    if (!open) return;
    return pushEscape({
      panel: () => get(latest.current.refs.panel),
      opener: () => get(latest.current.refs.opener),
      close: (focusInside) => {
        const { close: c, refs: r } = latest.current;
        c();
        if (!focusInside) return;
        const main = typeof document === "undefined" ? null : document.getElementById("main"); // Shell 의 <main tabindex=-1>
        const to = [get(r.opener), get(r.fallback), main].find((x) => isShown(x));
        (to as HTMLElement | undefined)?.focus();
      },
    });
  }, [open]);
}
