"use client";
import { useEffect, useRef, useState } from "react";
import type { TocItem } from "@/lib/guide";

const flat = (items: readonly TocItem[]): TocItem[] => items.flatMap((t) => [t, ...flat(t.children ?? [])]);

/** 관찰 띠: 스크롤 영역 위쪽 22 % — 이 띠의 아래 끝보다 위에서 시작한 절을 '읽는 중'으로 본다 */
const BAND = 0.22;
/** 이만큼(px) 이하로 스크롤했으면 맨 위 */
const TOP_EPS = 4;
/** 목차로 옮긴 뒤 이만큼(px) 넘게 스크롤 위치가 바뀌면 사용자가 스크롤한 것 — 고른 절 고정을 푼다 */
const PIN_EPS = 2;

/**
 * 지금 읽는 절(목차의 aria-current · 좁은 화면 선택 상자 값). 이전 값에 기대지 않는다 — 같은 위치면 언제나 같은 답.
 * tops: 각 절의 위쪽 가장자리(스크롤 영역 위 기준 px, 문서 순서 · 없는 절은 null). band: 띠의 아래 끝(px).
 * - pinned(목차로 고른 절)가 있으면 그 절 — 짧은 절로 옮기면 다음 절도 띠에 들어오지만 고른 절을 가리킨다(사용자가 스크롤하면 풀린다).
 * - 맨 위(scrollTop ≤ 4 px)면 첫 절 — 머리말을 읽는 중에도 이전 절 표시가 남지 않는다.
 * - 아니면 띠 아래 끝보다 위에서 시작한 절 중 문서 순서로 마지막 것: 소절은 부모보다 뒤라 가장 안쪽 절이 되고, 절 사이 여백에서도 바로 앞 절.
 * - 그런 절이 없으면(머리말 부근) 첫 절, 잴 수 있는 절이 없으면 null.
 */
export function currentSection(order: readonly string[], tops: readonly (number | null)[], o: { scrollTop: number; band: number; pinned: string | null }): string | null {
  if (o.pinned != null && order.includes(o.pinned)) return o.pinned;
  const first = order.find((_, i) => tops[i] != null) ?? null;
  if (o.scrollTop <= TOP_EPS) return first;
  let cur: string | null = null;
  order.forEach((id, i) => { const t = tops[i]; if (t != null && t <= o.band) cur = id; });
  return cur ?? first;
}

/**
 * 설명서 목차(이 화면의 유일한 클라이언트 코드 — 목록 자체는 서버가 그린다):
 * - 넓은 화면(≥ 900 px): 왼쪽에 붙어 있는 목록(sticky). 지금 읽는 절에 aria-current="location".
 * - 좁은 화면: 위에 붙는 선택 상자 — 고르면 그 절로 옮기고 제목에 초점(키보드 · 화면 읽기 프로그램이 이어서 읽는다), 주소의 #절 도 바꾼다.
 * 절 위치: 스크롤 영역([data-guide-scroll])의 scroll 이벤트(passive)를 프레임당 한 번(requestAnimationFrame)만 처리해 절 22개의 위쪽 가장자리를 잰다.
 * IntersectionObserver 는 쓰지 않는다 — 띠에 걸린 절만 알려 줘 '절 사이 여백' · 맨 위 · 목차로 건너뛴 뒤(상태가 바뀌지 않으면 알림이 없다)에 옛 값이 남았다.
 */
export function GuideToc({ items }: { items: readonly TocItem[] }) {
  const [active, setActive] = useState<string | null>(null);
  const self = useRef<HTMLElement>(null);
  /** 목차로 고른 절과 그때의 스크롤 위치 — 사용자가 스크롤하기 전까지 그 절을 가리킨다 */
  const pin = useRef<{ id: string; top: number } | null>(null);
  const measure = useRef<() => void>(() => {});
  useEffect(() => {
    const root = self.current?.closest<HTMLElement>("[data-guide-scroll]");
    if (!root) return;
    const order = flat(items).map((t) => t.id);
    const els = order.map((id) => document.getElementById(id));
    let frame = 0;
    const update = () => {
      frame = 0;
      if (pin.current && Math.abs(root.scrollTop - pin.current.top) > PIN_EPS) pin.current = null;
      const base = root.getBoundingClientRect().top;
      const tops = els.map((e) => (e ? e.getBoundingClientRect().top - base : null));
      setActive(currentSection(order, tops, { scrollTop: root.scrollTop, band: root.clientHeight * BAND, pinned: pin.current?.id ?? null }));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    measure.current = schedule;
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      measure.current = () => {};
    };
  }, [items]);
  /** 목차로 옮긴 절을 고정한다 — 옮긴 직후의 스크롤 위치를 기억해, 이 이동이 부른 scroll 이벤트(위치가 같다)로는 풀리지 않고 사용자가 스크롤하면 풀린다 */
  const pinAt = (id: string) => {
    const root = self.current?.closest<HTMLElement>("[data-guide-scroll]");
    pin.current = root ? { id, top: root.scrollTop } : null;
    setActive(id);
    measure.current();
  };
  /** 좁은 화면 선택 상자: 그 절로 옮기고(즉시 스크롤) 제목에 초점, 주소의 #절 을 바꾼다 */
  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    try { window.history.replaceState(null, "", `#${id}`); } catch { /* 주소를 못 바꿔도 이동은 됐다 */ }
    el.querySelector<HTMLElement>("h2, h3")?.focus({ preventScroll: true });
    pinAt(id);
  };
  /** 넓은 화면 목록: 링크는 브라우저 기본 이동(#절 · 방문 기록) 그대로 — 이동이 끝난 뒤(다음 작업) 그 절을 고정한다. 새 탭 · 수정 키 클릭은 건드리지 않는다 */
  const onLink = (id: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    window.setTimeout(() => pinAt(id), 0);
  };
  const parentOf = (id: string | null) => items.find((t) => t.children?.some((c) => c.id === id))?.id ?? null;
  const link = (t: TocItem, sub: boolean) => {
    const on = active === t.id;
    const inside = !sub && parentOf(active) === t.id;
    return (
      <a href={`#${t.id}`} aria-current={on ? "location" : undefined} onClick={onLink(t.id)}
        className={`flex gap-2 border-l-2 py-[3px] pr-2 ${sub ? "pl-4 text-[12px]" : "pl-2 text-[12.5px] font-semibold"} ${on ? "border-accent bg-[#1c2a3f] text-[#cfe0ff]" : inside ? "border-line-2 text-fg" : "border-transparent text-fg-2 hover:text-fg"}`}>
        <span className={`mono shrink-0 text-fg-3 ${sub ? "w-9" : "w-6"}`}>{t.n}</span><span>{t.title}</span>
      </a>
    );
  };
  return (
    <aside ref={self} className="sticky top-0 z-20 self-start bg-bg min-[900px]:bg-transparent">
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
