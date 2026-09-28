import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";
import { Shell } from "@/components/Shell";

// 화면마다 다른 제목(R-30): 하위 경로는 "%s — Wakeline", 상황판(/)은 기본 제목
export const metadata: Metadata = {
  title: { default: "Wakeline — 실시간 항공기 · 선박 · 위험기상 상황판", template: "%s — Wakeline" },
  description: "ADS-B 항공기·AIS 선박 위치, 기상 레이더, SIGMET 을 한 지도에 겹치고 교차·진입 예측을 근거와 함께 보여 주는 상황판",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // CSP nonce(proxy.ts)는 요청마다 새로 만든다 — Next 는 요청의 CSP 헤더에서 nonce 를 읽어 자기 스크립트에 붙이므로 페이지는 요청마다 렌더해야 한다.
  // nonce 를 DOM(meta 태그)에 복제하지 않는다(R-82): 읽는 코드가 없고, CSS 속성 선택자로 읽힐 수 있는 불필요한 노출이다.
  await connection();
  return (
    <html lang="ko" suppressHydrationWarning>
      <body className="h-full overflow-hidden">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
