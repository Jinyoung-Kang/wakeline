"use client";
import "./globals.css";
import { ErrorScreen } from "@/components/logs/ErrorScreen";

/**
 * 루트 레이아웃까지 실패했을 때(계약 v5 §C8). 레이아웃을 대신하므로 html · body · 전역 CSS 를 스스로 갖는다(metadata 대신 <title>).
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="ko">
      <body className="h-full overflow-hidden">
        <title>오류 — Wakeline</title>
        <ErrorScreen error={error} retry={retry} component="app/global-error.tsx" />
      </body>
    </html>
  );
}
