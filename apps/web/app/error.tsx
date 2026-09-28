"use client";
import { ErrorScreen } from "@/components/logs/ErrorScreen";

/** 화면 오류 경계(계약 v5 §C8): 상단 메뉴는 그대로 두고 본문 자리에 읽기 쉬운 오류 화면 + 복사 + 다시 시도 */
export default function RouteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorScreen error={error} retry={retry} component="app/error.tsx" />;
}
