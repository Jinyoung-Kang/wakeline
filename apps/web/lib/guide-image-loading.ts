/**
 * 설명서 스크린샷을 화면 가까이 왔을 때만 받는다(QA-1501 — components/guide/GuideImageLoader 가 부른다. React 없는 규칙).
 * 그림은 서버가 src 없이 data-guide-src 로 그린다(크기 · 대체 글 · loading=lazy 는 그대로 — 자리와 읽기는 처음부터 있다). 여기서 그림이 스크롤 영역의
 * 보이는 곳에서 GUIDE_IMAGE_AHEAD 안으로 들어올 때 src 를 넣는다.
 * 까닭: 브라우저의 loading="lazy" 는 화면 아래 1,250–2,500 px 안의 그림을 첫 그리기 전에 요청한다 — 휴대폰(412×823)에서는 첫 화면 밖의 그림 두 장
 * (297 KB)이 첫 문단보다 먼저 망을 쓴다(Lighthouse 모바일 LCP 2,910 ms — LCP 전에 시작한 요청을 모두 LCP 경로로 센다).
 * IntersectionObserver 가 없으면(옛 브라우저) 곧바로 모두 넣는다 — 그림을 잃지 않는다.
 */

/** 보이는 곳 아래 · 위로 이만큼(스크롤 영역 높이의 비율) 안에 오면 받는다 — 읽는 속도로 내리면 닿기 전에 받고, 휴대폰 첫 화면에서는 첫 그림(위 1,653 px)이 밖이다 */
export const GUIDE_IMAGE_AHEAD = "50% 0px";

function load(img: Element) {
  const src = img.getAttribute("data-guide-src");
  if (src && img.getAttribute("src") !== src) img.setAttribute("src", src);
}

/** root(스크롤 영역)의 보이는 곳 가까이 온 그림부터 src 를 넣는다. 돌려준 함수가 관찰을 끝낸다. Io = IntersectionObserver(없으면 undefined) */
export function watchGuideImages(root: Element | null, imgs: readonly Element[], Io: typeof IntersectionObserver | undefined): () => void {
  if (!imgs.length) return () => {};
  if (!Io) { imgs.forEach(load); return () => {}; }
  const io = new Io((entries) => {
    for (const e of entries) if (e.isIntersecting) { load(e.target); io.unobserve(e.target); }
  }, { root, rootMargin: GUIDE_IMAGE_AHEAD });
  imgs.forEach((i) => io.observe(i));
  return () => io.disconnect();
}
