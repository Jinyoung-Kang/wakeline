import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { Shell } from "@/components/Shell";

export const metadata: Metadata = {
  title: "SkyWx — 실시간 항공기 · 위험기상 상황판",
  description: "ADS-B 항공기 위치, 기상 레이더, SIGMET 을 한 지도에 겹치고 교차·진입 예측을 근거와 함께 보여 주는 상황판",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>{nonce ? <meta property="csp-nonce" content={nonce} /> : null}</head>
      <body className="h-full overflow-hidden">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
