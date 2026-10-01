import type { NextConfig } from "next";

// 브라우저는 키를 갖지 않는다: NEXT_PUBLIC_ 변수는 하나도 쓰지 않는다(빌드 시 검사 — CI gitleaks + 아래 assert).
for (const k of Object.keys(process.env)) {
  if (k.startsWith("NEXT_PUBLIC_")) throw new Error(`NEXT_PUBLIC_ variables are not allowed (${k})`);
}

/** 설명서 스크린샷 경로 — lib/guide GUIDE_FILE_RE 와 같은 이름 모양만 */
export const GUIDE_IMAGE_SOURCE = "/guide/:file([a-z0-9]+(?:-[a-z0-9]+)*\\.[0-9a-f]{10}\\.(?:webp|png))";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  // MapLibre 배포본은 버전 폴더에 있다(scripts/copy-maplibre-worker.mjs · lib/maplibre.ts, R-02) — 내용이 바뀌면 경로가 바뀌므로 오래 캐시한다.
  // 지도 메인과 워커가 같은 공용 청크를 캐시에서 나눠 쓰고, 재방문 때 재검증 요청도 없다.
  // 설명서 스크린샷(public/guide)도 이름에 내용 해시가 있다(scripts/guide-screenshots.mjs — <id>.<sha-256 앞 10자>.webp) — 다시 찍으면 이름이 바뀐다.
  // 기본값(public, max-age=0)이면 설명서를 열 때마다 이미지마다 재검증 요청을 보낸다.
  async headers() {
    const immutable = [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }];
    return [
      { source: "/maplibre/:version/:file*", headers: immutable },
      // 해시 이름만(설명서 화면 /guide 자체나 해시 없는 파일에 붙지 않게 — "/guide/:file*" 는 /guide 페이지와도 맞는다)
      { source: GUIDE_IMAGE_SOURCE, headers: immutable },
    ];
  },
  // API·WS 는 edge(nginx)가 api 로 직접 보내므로 여기서는 프록시하지 않는다.
  // 로컬 `next dev` 로 화면만 띄울 때만 아래 rewrite 를 쓴다(스택은 compose 로 떠 있어야 함).
  // 운영 변경(쓰기)은 api 가 브라우저 Origin 을 허용 목록(WAKELINE_ALLOWED_ORIGINS)으로 검사한다 — next dev 의 주소(http://localhost:3000)를
  // 그 목록에 더하지 않으면 403 ORIGIN_NOT_ALLOWED 다(읽기는 된다). WS(/ws/v1)는 이 rewrite 를 타지 않는다.
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    const api = process.env.API_INTERNAL_URL ?? "http://localhost:8700";
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;
