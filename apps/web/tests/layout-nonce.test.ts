/**
 * R-82: 요청별 CSP nonce 를 DOM(meta)에 복제하지 않는다. Next 가 CSP 헤더에서 nonce 를 읽어 자기 스크립트에 붙이려면
 * 페이지가 동적으로 렌더돼야 하므로 레이아웃은 계속 요청을 기다린다(connection()).
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const rec = vi.hoisted(() => ({ connection: 0 }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-nonce": "Tm9uY2VWYWx1ZTEyMw==" }) }));
vi.mock("next/server", () => ({ connection: async () => { rec.connection++; } }));
vi.mock("@/components/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => createElement("main", null, children) }));

describe("root layout (R-82)", () => {
  it("does not expose the per-request nonce in a meta tag, and still renders per request", async () => {
    const { default: RootLayout } = await import("@/app/layout");
    const html = renderToStaticMarkup((await RootLayout({ children: "page" })) as ReactElement);
    expect(html).not.toContain("csp-nonce");
    expect(html).not.toContain("Tm9uY2VWYWx1ZTEyMw==");
    expect(html).toContain("<main>page</main>");
    expect(rec.connection).toBe(1);
  });
});
