/**
 * 지도 위 출처 표기(FR-20)를 작게 — 사용자 요청 2026-09-29 "지도 오른쪽 아래 source 정보 박스가 작은 화면에서 지도를 가린다".
 * - MapLibre compact 출처(ⓘ 단추 = <summary>, 누르거나 Enter/Space 로 펼치고 접는다)를 쓴다. 상황판 · 재생 지도가 같은 함수를 쓴다.
 * - 지도 폭이 ATTRIB_EXPANDED_MIN_PX 보다 좁으면 접힌 채로 시작하고, 넓으면 펼친 채로 시작한다. 넓다가 좁아지는 순간(창 크기 변경) 접는다.
 *   사용자가 펼치거나 접은 것은 그 지도 동안만 — 기억하지 않는다(저장소를 쓰지 않는다). 지도를 끌면 MapLibre 가 접는다(compact 동작).
 * - 출처 전체는 모든 화면 하단의 SOURCES 줄(AttributionFooter)에 늘 보인다(NFR-15 상시 노출) — 지도 위 표기를 접어도 출처가 사라지지 않는다.
 * - 키보드(R-30): ⓘ 단추는 Tab 으로 닿는다. 안의 링크는 Tab 순서에서 뺀다 — 같은 링크가 SOURCES 줄에 있다.
 *   MapLibre 6 은 출처 HTML 을 정화(DOM.sanitize)하면서 tabindex 를 지우고(허용 목록에 없음) 스타일이 붙이는 배경지도 링크도 따로 만든다 —
 *   그래서 문자열의 tabindex=-1 은 남지 않았다. 그려진 뒤의 링크에 걸고, MapLibre 가 다시 그리면(스타일 소스 도착 등) 다시 건다.
 */
import type { ControlPosition, IControl, Map as MlMap } from "maplibre-gl";

/** 이 폭(px, 지도 컨테이너) 이상이면 펼친 채로 시작한다 — 노트북(≤ 1512 px 창)의 상황판(창 − 380 px 패널) · 재생 지도는 접힌 채로 */
export const ATTRIB_EXPANDED_MIN_PX = 1600;
export const ATTRIB_TOGGLE_LABEL = "지도 출처 표기 펼치기·접기(전체 출처는 화면 아래 SOURCES 줄)";

/** MapLibre AttributionControl 의 쓰는 부분(생성 옵션 · IControl) */
interface InnerControl { onAdd(map: MlMap): HTMLElement; onRemove(): void }
type InnerCtor = new (opts: { compact?: boolean; customAttribution?: string }) => InnerControl;
/** 내용이 바뀔 때 부를 함수를 건다 — 돌려준 함수로 뗀다(시험은 대역을 넘긴다) */
export type ObserveFn = (el: HTMLElement, onChange: () => void) => () => void;

const observeChildren: ObserveFn = (el, onChange) => {
  if (typeof MutationObserver === "undefined") return () => {};
  const o = new MutationObserver(onChange);
  o.observe(el, { childList: true, subtree: true }); // 속성 변화는 보지 않는다 — tabindex 를 걸 때 다시 부르지 않게
  return () => o.disconnect();
};

/** 접는다(MapLibre _updateCompactMinimize 와 같은 상태: compact 이고 compact-show · open 없음) */
export function collapseAttribution(el: HTMLElement): void {
  if (!el.classList.contains("maplibregl-compact")) return;
  el.classList.remove("maplibregl-compact-show");
  el.removeAttribute("open");
}

/** 그려진 출처 링크를 Tab 순서에서 뺀다(R-30) */
export function unfocusAttributionLinks(el: HTMLElement): void {
  for (const a of Array.from(el.querySelectorAll("a"))) a.setAttribute("tabindex", "-1");
}

/** MapLibre 출처 컨트롤을 감싼 IControl — 시작 상태 · 좁아질 때 접기 · 링크 tabindex · ⓘ 이름을 맡는다 */
export class CompactAttribution implements IControl {
  private map: MlMap | null = null;
  private stop: (() => void) | null = null;
  private onResize: (() => void) | null = null;

  constructor(private readonly inner: InnerControl, private readonly observe: ObserveFn = observeChildren, private readonly expandedMinPx = ATTRIB_EXPANDED_MIN_PX) {}

  onAdd(map: MlMap): HTMLElement {
    const el = this.inner.onAdd(map);
    this.map = map;
    const toggle = el.querySelector("summary");
    toggle?.setAttribute("aria-label", ATTRIB_TOGGLE_LABEL);
    toggle?.setAttribute("title", ATTRIB_TOGGLE_LABEL);
    unfocusAttributionLinks(el);
    this.stop = this.observe(el, () => unfocusAttributionLinks(el));
    const wideNow = () => map.getContainer().clientWidth >= this.expandedMinPx;
    let wide = wideNow();
    if (!wide) collapseAttribution(el);
    this.onResize = () => { const w = wideNow(); if (wide && !w) collapseAttribution(el); wide = w; };
    map.on("resize", this.onResize);
    return el;
  }

  onRemove(): void {
    if (this.map && this.onResize) this.map.off("resize", this.onResize);
    this.stop?.();
    this.stop = null;
    this.onResize = null;
    this.map = null;
    this.inner.onRemove();
  }

  getDefaultPosition(): ControlPosition { return "bottom-right"; }
}

/** 상황판 · 재생 지도의 출처 컨트롤. ml = 그 지도를 만든 MapLibre 모듈(상황판은 public 배포본, 재생은 번들본) */
export function mapAttributionControl(ml: { AttributionControl: unknown }, html: string, observe?: ObserveFn): CompactAttribution {
  const Ctor = ml.AttributionControl as InnerCtor;
  return new CompactAttribution(new Ctor({ compact: true, customAttribution: html }), observe);
}
