import { DualTime } from "@/components/DualTime";
import type { GuideShot, ShotView } from "@/lib/guide";

/**
 * 스크린샷 한 장 + 번호 설명.
 * - 번호는 이미지에 굽지 않고 HTML 로 겹친다: 위치는 캡처 스크립트가 찍을 때 그 요소의 위치를 잰 값(%) — 이미지가 줄어도 같은 자리.
 *   번호 글자는 장식(aria-hidden)이고, 같은 번호의 설명 목록이 내용이다(대체 글 + 목록으로 이미지 없이도 읽힌다).
 * - 결과가 없으면 자리표시("스크린샷 준비 중") + 그 화면의 설명 — 깨진 이미지를 보이지 않는다.
 * - 이미지: 명시 width · height(비율 예약), loading="lazy", decoding="async". 원본 크기 링크.
 * - 모양은 globals.css 의 .g-* (번호 칸 .g-num 등) — 그림 11장 · 번호 50여 개에 같은 긴 클래스 글자를 싣지 않는다.
 */
export function GuideFigure({ shot, view, no }: { shot: GuideShot; view: ShotView; no: number }) {
  const capId = `fig-${shot.id}-title`;
  return (
    <figure className="my-4 border border-line bg-bg-1" data-guide-shot={shot.id} aria-labelledby={capId}>
      <div className="g-fig-head">
        <span id={capId} className="text-[12.5px] font-semibold"><span className="label mr-2 text-accent">그림 {no}</span>{shot.title}</span>
        {view.kind === "image" ? <a href={view.src} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[11px] text-fg-2 underline decoration-line-2 underline-offset-2 hover:text-fg">원본 크기로 열기({view.width}×{view.height})</a> : null}
      </div>
      <div className="relative overflow-hidden">
        {view.kind === "image" ? (
          <>
            {/* next/image 를 쓰지 않는다: 이미지 최적화가 꺼져 있고(next.config images.unoptimized) 클라이언트 컴포넌트라 이 정적 화면에 스크립트만 늘린다 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={view.src} alt={shot.alt} width={view.width} height={view.height} loading="lazy" decoding="async" className="block h-auto w-full" />
            {view.markers.map((m) => (
              <span key={m.n} aria-hidden="true" data-callout-marker={m.n} style={{ left: `${m.x}%`, top: `${m.y}%` }} className="g-num g-mark">{m.n}</span>
            ))}
          </>
        ) : (
          // 자리표시는 낮게(이미지 비율로 잡지 않는다): 스크린샷은 다시 빌드할 때만 들어오므로 보는 중에 자리가 바뀌지 않고, 빈 큰 상자 11개가 글을 밀어내지 않게
          <div role="img" aria-label={`${shot.alt} — 스크린샷 준비 중`} data-guide-placeholder=""
            className="grid-bg g-ph">
            <span className="badge warn">스크린샷 준비 중</span>
            <span className="max-w-[560px] text-[12px] leading-relaxed text-fg-2">{shot.alt}</span>
            <span className="mono text-[10px] text-fg-3">찍을 크기 {view.width}×{view.height} · 번호 설명은 아래</span>
          </div>
        )}
      </div>
      <figcaption className="g-cap">
        {view.kind === "image"
          ? <>캡처 <DualTime v={view.capturedAt} year className="text-fg-2" /> · {view.format === "webp" ? "WebP" : "PNG"} · {view.width}×{view.height} · {Math.max(1, Math.round(view.bytes / 1024))} KB{view.variant ? <> · 조건: <span className="text-fg-2">{view.variant}</span></> : null}</>
          : <>이 자리에는 배포된 서비스에서 찍은 화면이 들어갑니다(캡처 스크립트). 아래 번호 설명은 지금도 그대로 쓸 수 있습니다.</>}
      </figcaption>
      <ol className="g-callouts" aria-label={`그림 ${no} 번호 설명`}>
        {shot.callouts.map((c) => {
          const seen = view.kind !== "image" || view.markers.some((m) => m.n === c.n);
          return (
            <li key={c.n} data-callout-item={c.n}>
              <span aria-hidden="true" className="g-num">{c.n}</span>
              <span><b>{c.label}</b> <span className="text-fg-2">— {c.text}</span>
                {seen ? null : <span className="text-fg-3"> (이 스크린샷에는 보이지 않음 — 찍을 때 화면에 없었음)</span>}</span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
