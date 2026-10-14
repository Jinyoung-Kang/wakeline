/**
 * QA-1501: 설명서 스크린샷은 스크롤 영역의 보이는 곳 가까이(GUIDE_IMAGE_AHEAD) 올 때만 src 를 받는다 — loading="lazy" 만으로는 휴대폰 첫 화면 밖 그림이
 * 첫 그리기 전에 요청되어 첫 문단(LCP)과 망을 나눴다. IntersectionObserver 가 없으면 곧바로 모두 받는다(그림을 잃지 않는다).
 */
import { describe, expect, it } from "vitest";
import { GUIDE_IMAGE_AHEAD, watchGuideImages } from "@/lib/guide-image-loading";

class FakeImg {
  attrs = new Map<string, string>();
  constructor(src: string) { this.attrs.set("data-guide-src", src); }
  getAttribute(n: string) { return this.attrs.get(n) ?? null; }
  setAttribute(n: string, v: string) { this.attrs.set(n, v); }
}
type Entry = { isIntersecting: boolean; target: unknown };
class FakeIo {
  static last: FakeIo | null = null;
  observed = new Set<unknown>();
  disconnected = false;
  constructor(public cb: (e: Entry[]) => void, public opts: { root: unknown; rootMargin: string }) { FakeIo.last = this; }
  observe(t: unknown) { this.observed.add(t); }
  unobserve(t: unknown) { this.observed.delete(t); }
  disconnect() { this.observed.clear(); this.disconnected = true; }
}
const asEls = (a: FakeImg[]) => a as unknown as Element[];
const Io = FakeIo as unknown as typeof IntersectionObserver;

describe("guide screenshots load when near (QA-1501)", () => {
  it("no src until the picture comes near the scroll region's visible part; then only that one", () => {
    const root = {};
    const imgs = [new FakeImg("/guide/a.webp"), new FakeImg("/guide/b.webp")];
    const stop = watchGuideImages(root as unknown as Element, asEls(imgs), Io);
    const io = FakeIo.last!;
    expect(io.opts).toEqual({ root, rootMargin: GUIDE_IMAGE_AHEAD });
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([null, null]);
    io.cb([{ isIntersecting: false, target: imgs[0] }, { isIntersecting: true, target: imgs[1] }]);
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([null, "/guide/b.webp"]);
    expect([...io.observed]).toEqual([imgs[0]]); // 받은 그림은 더 보지 않는다
    stop();
    expect(io.disconnected).toBe(true);
  });
  it("without IntersectionObserver every picture gets its src at once", () => {
    const imgs = [new FakeImg("/guide/a.webp"), new FakeImg("/guide/b.webp")];
    watchGuideImages(null, asEls(imgs), undefined);
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["/guide/a.webp", "/guide/b.webp"]);
  });
  it("the look-ahead is half the scroll region — the first figure (1,653 px down a 823 px phone screen) stays out at first", () => {
    expect(GUIDE_IMAGE_AHEAD).toBe("50% 0px");
  });
});
