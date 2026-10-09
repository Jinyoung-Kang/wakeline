"use client";
import { MobileAlerts } from "@/components/MobileAlerts";

/**
 * 모바일 알림 화면(SPEC F8 · 계약 v5 §G52): 지도 · MapLibre · WS 를 싣지 않는다 — 휴대폰에서 지도 화면의 성능 한계(PERF §15.6)를 피한다.
 * 열린 알림(REST 15 s, 보이는 동안) · 관심 대상(이 브라우저의 목록 — ADR-037). 줄을 누르면 근거 화면(/alerts/{id}).
 */
export default function MobilePage() {
  return <MobileAlerts />;
}
