/**
 * 설명서 메뉴(사용자 요청 2026-09-29 "[출처/한계] 메뉴 옆에 [설명서] 메뉴") — 주 메뉴에서 '출처·한계' 바로 뒤에 온다.
 * 다른 주 메뉴처럼 미리 가져오기를 끈다(tests/shell-prefetch.test.ts — 동적 경로 · edge 의 IP당 양동이).
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const links: { href: string; prefetch?: boolean | null; label: string }[] = [];
const textOf = (n: ReactNode): string => (typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(textOf).join("") : "");
vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean | null; children?: ReactNode }) => {
    links.push({ href, prefetch, label: textOf(children) });
    return createElement("a", { href, ...rest }, children);
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/guide", useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));

describe("main menu: 설명서 comes right after 출처·한계", () => {
  it("nav order ends with 출처·한계 → 설명서 (/guide), no prefetch, marked current on /guide", async () => {
    const { Shell } = await import("@/components/Shell");
    const html = renderToStaticMarkup(createElement(Shell, null, createElement("p", null, "x")));
    // 첫 링크는 로고(WAKELINE → /) — 메뉴만 본다
    const nav = links.slice(1).map((l) => l.label);
    expect(nav[0]).toBe("상황판");
    const about = nav.indexOf("출처·한계");
    expect(about).toBeGreaterThanOrEqual(0);
    expect(nav[about + 1]).toBe("설명서");
    expect(links.find((l) => l.label === "설명서")).toMatchObject({ href: "/guide", prefetch: false });
    // 현재 화면 표시(aria-current) — 설명서 화면에서 설명서 메뉴만
    expect(html).toMatch(/<a href="\/guide"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/guide"/);
  });
});
