"use client";
import { useEffect, useState } from "react";
import type { TocItem } from "@/lib/guide";

const flat = (items: readonly TocItem[]): TocItem[] => items.flatMap((t) => [t, ...flat(t.children ?? [])]);

/**
 * 지금 읽는 절: 관찰 띠(화면 위쪽 22 %)에 걸린 절 중 문서 순서로 마지막 것 — 소절은 부모 절보다 뒤라 가장 안쪽 절이 된다.
 * 띠에 걸린 절이 없으면(절 사이 여백) 이전 값을 그대로 둔다.
 */
export function activeSection(order: readonly string[], visible: ReadonlySet<string>, prev: string | null): string | null {
  for (let i = order.length - 1; i >= 0; i--) if (visible.has(order[i])) return order[i];
  return prev;
}

/**
 * 설명서 목차(이 화면의 유일한 클라이언트 코드 — 목록 자체는 서버가 그린다):
 * - 넓은 화면(≥ 900 px): 왼쪽에 붙어 있는 목록(sticky). 지금 읽는 절에 aria-current="location".
 * - 좁은 화면: 위에 붙는 선택 상자 — 고르면 그 절로 옮기고 제목에 초점(키보드 · 화면 읽기 프로그램이 이어서 읽는다), 주소의 #절 도 바꾼다.
 * 절 위치는 IntersectionObserver 로만 본다(스크롤 이벤트 · 레이아웃 읽기 없음). 관찰자가 없는 환경에서는 표시만 하지 않는다.
 */
export function GuideToc({ items }: { items: readonly TocItem[] }) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const order = flat(items).map((t) => t.id);
    const els = order.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => e != null);
    if (!els.length || typeof IntersectionObserver === "undefined") return;
    const visible = new Set<string>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting) visible.add(e.target.id); else visible.delete(e.target.id); }
      setActive((prev) => activeSection(order, visible, prev));
    }, { rootMargin: "0px 0px -78% 0px" });
    for (const e of els) io.observe(e);
    return () => io.disconnect();
  }, [items]);
  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    try { window.history.replaceState(null, "", `#${id}`); } catch { /* 주소를 못 바꿔도 이동은 됐다 */ }
    el.querySelector<HTMLElement>("h2, h3")?.focus({ preventScroll: true });
    setActive(id);
  };
  const parentOf = (id: string | null) => items.find((t) => t.children?.some((c) => c.id === id))?.id ?? null;
  const link = (t: TocItem, sub: boolean) => {
    const on = active === t.id;
    const inside = !sub && parentOf(active) === t.id;
    return (
      <a href={`#${t.id}`} aria-current={on ? "location" : undefined}
        className={`flex gap-2 border-l-2 py-[3px] pr-2 ${sub ? "pl-4 text-[12px]" : "pl-2 text-[12.5px] font-semibold"} ${on ? "border-accent bg-[#1c2a3f] text-[#cfe0ff]" : inside ? "border-line-2 text-fg" : "border-transparent text-fg-2 hover:text-fg"}`}>
        <span className={`mono shrink-0 text-fg-3 ${sub ? "w-9" : "w-6"}`}>{t.n}</span><span>{t.title}</span>
      </a>
    );
  };
  return (
    <aside className="sticky top-0 z-20 self-start bg-bg min-[900px]:bg-transparent">
      <div className="flex items-center gap-2 border-b border-line py-2 min-[900px]:hidden">
        <span className="label shrink-0" aria-hidden>목차</span>
        <select aria-label="설명서 목차 — 이동할 절" className="min-w-0 flex-1" value={active ?? ""} onChange={(e) => { if (e.target.value) go(e.target.value); }}>
          <option value="">절을 고르면 그 자리로 이동</option>
          {flat(items).map((t) => <option key={t.id} value={t.id}>{t.n.includes(".") ? " " : ""}{t.n} {t.title}</option>)}
        </select>
      </div>
      <nav aria-label="설명서 목차" className="hidden max-h-[calc(100dvh-6.5rem)] overflow-y-auto py-4 min-[900px]:block">
        <div className="label mb-2 pl-2">Contents</div>
        <ol className="space-y-px">
          {items.map((t) => (
            <li key={t.id}>
              {link(t, false)}
              {t.children ? <ol className="mb-1 space-y-px">{t.children.map((c) => <li key={c.id}>{link(c, true)}</li>)}</ol> : null}
            </li>
          ))}
        </ol>
      </nav>
    </aside>
  );
}
