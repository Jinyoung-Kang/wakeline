import type { Metadata } from "next";
import { PublicDemoProvider } from "@/components/PublicDemo";

/** 이 경로의 문서 제목(R-30) — 화면은 클라이언트 컴포넌트라 metadata 를 레이아웃에 둔다 */
export const metadata: Metadata = { title: "운영" };

/**
 * 운영자 전용 화면: 공개 데모(ADR-039)에서도 공개 주소로는 닿지 않고(앞단 404) 운영자 터널로만 열린다 — 요청 id 의 '로그 보기' 링크 등은
 * 공개 데모가 아닐 때처럼 둔다(상단 메뉴는 이 레이아웃 바깥이라 그대로 감춘다).
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <PublicDemoProvider demo={false}>{children}</PublicDemoProvider>;
}
