import { NextResponse, type NextRequest } from "next/server";

/**
 * 요청마다 CSP nonce 를 발급한다(6.2절 web 층). 외부 스크립트 없음(MapLibre 는 번들). 타일·글꼴·레이더만 허용 목록.
 * style-src 의 'unsafe-inline' 은 SSR 인라인 style 속성(React·MapLibre)을 위한 것이며 script 에는 적용되지 않는다.
 */
export function proxy(req: NextRequest) {
  const nonce = btoa(crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + String.fromCharCode(b), ""));
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tiles.openfreemap.org https://tilecache.rainviewer.com",
    "connect-src 'self' https://tiles.openfreemap.org https://tilecache.rainviewer.com",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = { matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|health).*)" }] };
