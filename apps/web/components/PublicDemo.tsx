"use client";
import { createContext, useContext } from "react";

/**
 * 공개 데모(ADR-039 — lib/public-demo 를 루트 레이아웃이 서버에서 읽어 넘긴다)면 true. 공급자 밖(app/global-error.tsx — 루트 레이아웃을
 * 대신한다)은 false — 로컬과 같은 화면이다.
 */
const PublicDemoContext = createContext(false);

export function PublicDemoProvider({ demo, children }: { demo: boolean; children?: React.ReactNode }) {
  return <PublicDemoContext value={demo}>{children}</PublicDemoContext>;
}

/** 운영자 전용 화면(/ops · /logs)으로 가는 메뉴 · 링크 · 안내를 감출지 — 공개 주소에서는 앞단이 그 경로를 404 로 닫는다 */
export function usePublicDemo(): boolean {
  return useContext(PublicDemoContext);
}
