/**
 * 시험용 최소 DOM(외부 의존성 없이 react-dom/client 로 컴포넌트를 마운트해 useEffect·정리 함수를 실행한다).
 * jsdom 이 아니다: React 가 한 개의 host 요소를 만들고 붙이는 데 필요한 부분과, 컴포넌트가 쓰는 전역(document.hidden·
 * visibilitychange·requestAnimationFrame·canvas 2D·Path2D)만 흉내 낸다. 레이아웃·이벤트 전파·CSS 는 없다.
 */
type Listener = (ev: unknown) => void;

class MiniNode {
  childNodes: MiniNode[] = [];
  parentNode: MiniNode | null = null;
  private listeners = new Map<string, Set<Listener>>();
  constructor(public nodeType: number, public nodeName: string, public ownerDocument: MiniDocument | null) {}
  get firstChild(): MiniNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): MiniNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): MiniNode | null { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null; }
  appendChild<T extends MiniNode>(c: T): T { c.parentNode?.removeChild(c); this.childNodes.push(c); c.parentNode = this; return c; }
  insertBefore<T extends MiniNode>(c: T, ref: MiniNode | null): T {
    if (!ref) return this.appendChild(c);
    c.parentNode?.removeChild(c);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild<T extends MiniNode>(c: T): T { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  contains(n: MiniNode | null): boolean { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(t: string, l: Listener) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t)!.add(l); }
  removeEventListener(t: string, l: Listener) { this.listeners.get(t)?.delete(l); }
  dispatch(t: string, ev: unknown = { type: t }) { for (const l of [...(this.listeners.get(t) ?? [])]) l(ev); }
  listenerCount(t: string) { return this.listeners.get(t)?.size ?? 0; }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v: string) { this.childNodes = []; if (v) this.appendChild(new MiniText(String(v), this.ownerDocument)); }
}

class MiniText extends MiniNode {
  constructor(public nodeValue: string, doc: MiniDocument | null) { super(3, "#text", doc); }
  get textContent() { return this.nodeValue; }
  set textContent(v: string) { this.nodeValue = v; }
}

export class MiniElement extends MiniNode {
  namespaceURI = "http://www.w3.org/1999/xhtml";
  attributes = new Map<string, string>();
  style: Record<string, string> & { setProperty?: (k: string, v: string) => void } = {};
  className = "";
  width = 0;
  height = 0;
  constructor(public tagName: string, doc: MiniDocument | null) {
    super(1, tagName, doc);
    this.style.setProperty = (k: string, v: string) => { this.style[k] = v; };
  }
  setAttribute(k: string, v: string) { this.attributes.set(k, String(v)); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  hasAttribute(k: string) { return this.attributes.has(k); }
  removeAttribute(k: string) { this.attributes.delete(k); }
  /** canvas 2D: 그리기 메서드는 아무것도 하지 않고, getImageData 는 빈 픽셀을 돌려준다(아이콘 SDF 를 만드는 코드가 끝까지 돈다) */
  getContext() {
    const props: Record<string, unknown> = {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    };
    return new Proxy(props, { get: (t, k: string) => (k in t ? t[k] : () => {}), set: (t, k: string, v) => { t[k] = v; return true; } });
  }
}

export class MiniDocument extends MiniNode {
  documentElement: MiniElement;
  body: MiniElement;
  hidden = false;
  activeElement: MiniElement | null = null;
  defaultView: unknown = globalThis;
  constructor() {
    super(9, "#document", null);
    this.ownerDocument = null;
    this.documentElement = new MiniElement("HTML", this);
    this.body = new MiniElement("BODY", this);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }
  createElement(tag: string) { return new MiniElement(tag.toUpperCase(), this); }
  createElementNS(_ns: string, tag: string) { return new MiniElement(tag, this); }
  createTextNode(t: string) { return new MiniText(t, this); }
  createComment(t: string) { return new MiniText(t, this); }
}

/** 전역을 설치하고 되돌리는 함수를 돌려준다(시험 파일마다 afterAll 에서 부른다). */
export function installMiniDom(): { document: MiniDocument; container: MiniElement; restore: () => void } {
  const g = globalThis as Record<string, unknown>;
  const keys = ["window", "document", "HTMLIFrameElement", "HTMLElement", "Path2D", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT", "navigator"] as const;
  const saved = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  const doc = new MiniDocument();
  const def = (k: string, v: unknown) => Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  def("document", doc);
  def("window", g);
  def("HTMLIFrameElement", class {});
  def("HTMLElement", MiniElement);
  def("Path2D", class { constructor(public d: string) {} });
  let raf = 0;
  const rafs = new Map<number, ReturnType<typeof setTimeout>>();
  def("requestAnimationFrame", (cb: (t: number) => void) => { const id = ++raf; rafs.set(id, setTimeout(() => { rafs.delete(id); cb(Date.now()); }, 16)); return id; });
  def("cancelAnimationFrame", (id: number) => { const t = rafs.get(id); if (t) clearTimeout(t); rafs.delete(id); });
  def("IS_REACT_ACT_ENVIRONMENT", true);
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  return {
    document: doc,
    container,
    restore: () => {
      for (const [k, d] of saved) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
    },
  };
}
