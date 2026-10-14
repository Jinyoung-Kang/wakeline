"use client";
import { useEffect } from "react";
import { watchGuideImages } from "@/lib/guide-image-loading";

/**
 * 설명서 스크린샷 받기(QA-1501 — lib/guide-image-loading): 그림(GuideFigure — src 없이 data-guide-src)을 스크롤 영역([data-guide-scroll]) 가까이 왔을 때만
 * 받게 한다. 그리는 것은 없다. 그림 자체는 서버 컴포넌트 그대로(크기 · 대체 글 · 번호 설명은 처음부터 HTML 에 있다).
 */
export function GuideImageLoader() {
  useEffect(() => {
    const root = document.querySelector("[data-guide-scroll]");
    const imgs = Array.from(document.querySelectorAll("img[data-guide-src]"));
    return watchGuideImages(root, imgs, typeof IntersectionObserver === "undefined" ? undefined : IntersectionObserver);
  }, []);
  return null;
}
