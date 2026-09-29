/**
 * 시험용 최소 HTML 트리(renderToStaticMarkup 결과 전용 — 잘 짜인 마크업만 받는다). 요소의 부모·자식 관계를 보는 시험(레이아웃 구조)에 쓴다.
 * 브라우저 파서가 아니다: 주석·CDATA·스크립트 본문은 없다고 본다(React 서버 렌더는 만들지 않는다). 글자는 "#text" 노드로 순서대로 둔다.
 */
export interface HNode { tag: string; attrs: Record<string, string>; children: HNode[]; parent: HNode | null; text: string }

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function parseHtml(html: string): HNode {
  const root: HNode = { tag: "#root", attrs: {}, children: [], parent: null, text: "" };
  let cur = root;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[5] != null) { cur.children.push({ tag: "#text", attrs: {}, children: [], parent: cur, text: unescape(m[5]) }); continue; }
    const [, close, tag, rawAttrs, selfClose] = m;
    if (close) { if (cur.parent) cur = cur.parent; continue; }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)) attrs[a[1]] = unescape(a[2] ?? "");
    const node: HNode = { tag: tag.toLowerCase(), attrs, children: [], parent: cur, text: "" };
    cur.children.push(node);
    if (!selfClose && !VOID.has(node.tag)) cur = node;
  }
  return root;
}

/** 요소만(글자 노드 제외) */
export const elements = (n: HNode) => n.children.filter((c) => c.tag !== "#text");
export function findAll(n: HNode, pred: (x: HNode) => boolean, out: HNode[] = []): HNode[] {
  for (const c of elements(n)) { if (pred(c)) out.push(c); findAll(c, pred, out); }
  return out;
}
export const byTestId = (n: HNode, id: string) => findAll(n, (x) => x.attrs["data-testid"] === id)[0] ?? null;
/** 요소 아래 글자 전체(문서 순서) */
export function textOf(n: HNode): string {
  return n.tag === "#text" ? n.text : n.children.map(textOf).join("");
}
export const classes = (n: HNode) => new Set((n.attrs.class ?? "").split(/\s+/).filter(Boolean));
/** 조상(가까운 것부터) */
export function ancestors(n: HNode): HNode[] {
  const out: HNode[] = [];
  for (let p = n.parent; p; p = p.parent) out.push(p);
  return out;
}
