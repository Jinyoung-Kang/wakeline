import type { Metadata } from "next";
import Link from "next/link";
import { ScrollRegion } from "@/components/ScrollRegion";

/**
 * 없는 경로(QA-1421): Next 기본 404 화면은 영어("This page could not be found." — 문서는 lang="ko", WCAG 3.1.2)이고 제목이 상황판과 같아(루트 기본 제목)
 * 탭 · 화면 읽기에서 없는 페이지임을 알 수 없었다(WCAG 2.4.2). 앱의 다른 오류 화면처럼 한국어로 까닭과 갈 곳을 말한다.
 * 루트 not-found 는 맞는 경로가 없는 모든 주소를 맡고 루트 레이아웃(메뉴) 안에 그린다. 응답 상태는 404 이고 Next 가 noindex 를 넣는다
 * (node_modules/next/dist/docs — file-conventions/not-found). 제목은 이 파일의 metadata(레이아웃의 "%s — Wakeline" 틀).
 */
export const metadata: Metadata = { title: "페이지를 찾을 수 없음" };

export default function NotFound() {
  return (
    <ScrollRegion label="페이지를 찾을 수 없음" main className="h-full overflow-y-auto p-4 text-[12px]">
      <h1 className="mb-2 text-[14px] font-semibold" data-testid="not-found">페이지를 찾을 수 없습니다(HTTP 404)</h1>
      <p className="mb-3 text-fg-2">주소가 틀렸거나, 없어진 화면 · 오래된 공유 링크일 수 있습니다.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li><Link className="underline" href="/">상황판으로 가기</Link></li>
        <li><Link className="underline" href="/guide">설명서에서 화면 목록 보기</Link></li>
      </ul>
    </ScrollRegion>
  );
}
