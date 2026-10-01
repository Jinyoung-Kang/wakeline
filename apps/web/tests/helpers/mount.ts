/**
 * 최소 DOM(./mini-dom)에 실제 react-dom/client 로 마운트하는 공통 도구 — 시험 파일마다 다시 적던 find · propsOf · settle · click 을 한 곳에.
 * - React 는 installMiniDom() 뒤에 불러야 한다(react-dom 이 불러올 때 DOM 전역을 본다) — load() 를 beforeAll 에서 부른다.
 * - strict: <StrictMode> 로 감싸 마운트한다. next dev(next.config reactStrictMode: true)처럼 효과가 마운트 → 정리 → 마운트로 두 번 돈다.
 * - 최소 DOM 에는 이벤트 전파가 없다: 처리기는 React 가 요소에 붙인 props 로 직접 부른다(propsOf · click).
 *
 *   const dom = installMiniDom();
 *   const m = mounter(dom);
 *   beforeAll(() => m.load());
 *   afterAll(() => dom.restore());
 *   afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });
 */
import { MiniElement, type installMiniDom } from "./mini-dom";

type Dom = ReturnType<typeof installMiniDom>;
type Handlers = Record<string, (...a: unknown[]) => unknown>;

/** 조건에 맞는 첫 요소(문서 순서, from 자신 포함) */
export function find(pred: (e: MiniElement) => boolean, from: MiniElement): MiniElement | null {
  if (pred(from)) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
  return null;
}
/** 조건에 맞는 모든 요소(문서 순서) */
export function findAll(pred: (e: MiniElement) => boolean, from: MiniElement, out: MiniElement[] = []): MiniElement[] {
  if (pred(from)) out.push(from);
  for (const c of from.childNodes) if (c instanceof MiniElement) findAll(pred, c, out);
  return out;
}
/** React 가 host 요소에 붙여 둔 props(이벤트 처리기 등) */
export function propsOf(e: MiniElement): Handlers {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  if (!k) throw new Error(`mount: <${e.tagName}> has no React props`);
  return (e as unknown as Record<string, Handlers>)[k];
}

export function mounter(dom: Dom) {
  let R: typeof import("react") | null = null;
  let createRoot: typeof import("react-dom/client").createRoot | null = null;
  let root: import("react-dom/client").Root | null = null;
  const react = () => { if (!R) throw new Error("mount: call load() in beforeAll first"); return R; };
  const act = (fn: () => unknown) => react().act(async () => { await fn(); });
  const settle = (ms = 30) => act(() => new Promise((r) => setTimeout(r, ms)));
  const inside = (from?: MiniElement) => from ?? dom.container;
  return {
    async load() { R = await import("react"); ({ createRoot } = await import("react-dom/client")); },
    get React() { return react(); },
    /** 처음이면 root 를 만들고, 아니면 같은 root 에 다시 그린다(props 바꾸기) */
    async render(el: import("react").ReactElement, opts: { strict?: boolean } = {}) {
      const r = react();
      root ??= createRoot!(dom.container as never);
      const node = opts.strict ? r.createElement(r.StrictMode, null, el) : el;
      await act(() => root!.render(node));
    },
    async unmount() {
      if (!root) return;
      const r = root;
      root = null;
      await act(() => r.unmount());
    },
    act,
    settle,
    find: (pred: (e: MiniElement) => boolean, from?: MiniElement) => find(pred, inside(from)),
    findAll: (pred: (e: MiniElement) => boolean, from?: MiniElement) => findAll(pred, inside(from)),
    byTestId: (id: string, from?: MiniElement) => find((e) => e.getAttribute?.("data-testid") === id, inside(from)),
    allByTestId: (id: string, from?: MiniElement) => findAll((e) => e.getAttribute?.("data-testid") === id, inside(from)),
    button: (text: string, from?: MiniElement) => find((e) => e.tagName === "BUTTON" && e.textContent.trim() === text, inside(from)),
    /** onClick 을 부르고(돌려준 약속까지 기다림) 한 번 가라앉힌다 */
    async click(e: MiniElement | null) {
      if (!e) throw new Error("mount: click(null)");
      await act(() => propsOf(e).onClick?.({ preventDefault() {}, stopPropagation() {} }));
      await settle();
    },
  };
}
