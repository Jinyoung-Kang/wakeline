import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** next/link 의 props 를 모은다 — 정적 렌더에는 prefetch 가 보이지 않는다 */
const links: { href: string; prefetch?: boolean | null }[] = [];
vi.mock("next/link", () => ({
  default: (p: { href: string; prefetch?: boolean | null; children?: ReactNode }) => {
    links.push({ href: p.href, prefetch: p.prefetch });
    return createElement("a", { href: p.href }, p.children);
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));

describe("주 메뉴 링크는 미리 가져오지 않는다", () => {
  /**
   * 모든 화면이 요청 때 그리는 동적 경로(ƒ)라, 미리 가져오기는 화면을 열 때마다 메뉴 수(7)만큼 서버 렌더를 부르고
   * edge 의 IP당 양동이(perip 10 r/s — /api/ 와 같이 쓴다)를 먼저 써 버린다. E2E 에서 그 뒤 /api 호출이 429 를 받았다.
   */
  it("every Link in the shell has prefetch={false}", async () => {
    const { Shell } = await import("@/components/Shell");
    renderToStaticMarkup(createElement(Shell, null, createElement("p", null, "x")));
    expect(links.map((l) => l.href)).toEqual(expect.arrayContaining(["/", "/replay", "/stats", "/ops", "/logs", "/about", "/guide"]));
    expect(links.filter((l) => l.prefetch !== false)).toEqual([]);
  });
});
