import type { Metadata } from "next";
import { GuideView } from "@/components/guide/GuideView";
import { MANIFEST, MANIFEST_DROPPED } from "@/lib/guide";

export const metadata: Metadata = { title: "설명서", description: "Wakeline 서비스 설명과 화면별 사용 방법 — 스크린샷 · 번호 설명 · 시각 표기 · 표시 규칙 · 키보드 단축키" };

/**
 * 설명서(사용자 요청 2026-09-29): 서비스 설명 + 사용 방법. 서버 컴포넌트 — 데이터 요청 없이 그린다(스크린샷 목록은 빌드에 들어간 lib/guide-manifest.json).
 * 스크린샷은 배포 뒤 scripts/guide-screenshots.mjs 가 찍어 public/guide 와 manifest 를 갱신한다. 없으면 자리표시.
 */
export default function GuidePage() {
  return <GuideView manifest={MANIFEST} dropped={MANIFEST_DROPPED} />;
}
