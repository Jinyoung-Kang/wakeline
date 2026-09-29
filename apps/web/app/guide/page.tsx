import type { Metadata } from "next";
import { GuideView } from "@/components/guide/GuideView";
import { MANIFEST, MANIFEST_DROPPED } from "@/lib/guide";

export const metadata: Metadata = { title: "설명서", description: "Wakeline 서비스 설명과 화면별 사용 방법 — 스크린샷 · 번호 설명 · 시각 표기 · 표시 규칙 · 키보드 단축키" };

/**
 * 설명서(사용자 요청 2026-09-29): 서비스 설명 + 사용 방법. 서버 컴포넌트 — 데이터 요청 없이 그린다(스크린샷 목록은 빌드에 들어간 lib/guide-manifest.json).
 * 스크린샷은 배포 뒤 scripts/guide-screenshots.mjs 가 찍어 public/guide 와 manifest 를 갱신한다. 없으면 자리표시.
 * 정적 렌더가 아니다: 루트 레이아웃이 요청마다 CSP nonce 를 읽어(connection()) 모든 화면이 동적(ƒ) · no-store 다 — CSP 를 약하게 하지 않는다.
 * 그래서 크기가 요청마다의 비용이다: 되풀이되는 모양은 globals.css 의 .g-* 로 두고 요소에 긴 유틸리티 글자를 싣지 않는다(HTML 과 RSC 페이로드에 두 번씩 실린다).
 */
export default function GuidePage() {
  return <GuideView manifest={MANIFEST} dropped={MANIFEST_DROPPED} />;
}
