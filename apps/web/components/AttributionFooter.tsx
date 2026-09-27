import { creditGroups } from "@/lib/attribution";

/**
 * 하단 출처 줄(FR-20 · NFR-15 "상시 노출"). 스크롤되는 상태 바에서 분리해 모든 화면 맨 아래에 고정한다.
 * 폭이 좁으면 줄바꿈 — 잘리거나 가로 스크롤 밖으로 밀려나지 않는다.
 */
export function AttributionFooter() {
  return (
    <footer className="shrink-0 border-t border-line bg-bg-1 px-3 py-[3px] text-[10px] leading-[1.5] text-fg-3" data-testid="attribution" aria-label="데이터 출처">
      <span className="label mr-2 text-[9px]">Sources</span>
      {creditGroups().map((g, gi) => (
        <span key={g.role} className="inline-block whitespace-nowrap">
          {gi > 0 ? <span aria-hidden className="mx-1.5 text-line-2">|</span> : null}
          <span className="mr-1">{g.role}</span>
          {g.items.map((c, i) => (
            <span key={c.label}>
              {i > 0 ? " · " : ""}
              <a href={c.href} target="_blank" rel="noopener noreferrer" className="text-fg-2 hover:text-fg">{c.label}</a>
              {c.license ? <> (<a href={c.license.href} target="_blank" rel="noopener noreferrer" className="text-fg-2 hover:text-fg">{c.license.label}</a>)</> : null}
            </span>
          ))}
        </span>
      ))}
    </footer>
  );
}
