import type { Metadata } from "next";

/** 이 경로의 문서 제목(R-30) — 화면은 클라이언트 컴포넌트라 metadata 를 레이아웃에 둔다 */
export const metadata: Metadata = { title: "공항 기상 이력" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
