import type { NextConfig } from "next";

// 브라우저는 키를 갖지 않는다: NEXT_PUBLIC_ 변수는 하나도 쓰지 않는다(빌드 시 검사 — CI gitleaks + 아래 assert).
for (const k of Object.keys(process.env)) {
  if (k.startsWith("NEXT_PUBLIC_")) throw new Error(`NEXT_PUBLIC_ variables are not allowed (${k})`);
}

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  // API·WS 는 edge(nginx)가 api 로 직접 보내므로 여기서는 프록시하지 않는다.
  // 로컬 `next dev` 로 화면만 띄울 때만 아래 rewrite 를 쓴다(스택은 compose 로 떠 있어야 함).
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    const api = process.env.API_INTERNAL_URL ?? "http://localhost:8700";
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;
