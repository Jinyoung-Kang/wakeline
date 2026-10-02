import { creditGroups } from "@/lib/attribution";

/**
 * 하단 출처 줄(FR-20 · NFR-15 "상시 노출"). 스크롤되는 상태 바에서 분리해 모든 화면 맨 아래에 고정한다.
 * 폭이 좁으면 줄바꿈 — 잘리거나 가로 스크롤 밖으로 밀려나지 않는다. 묶음은 들어가면 한 줄로 붙어 있고, 화면보다 넓으면 출처 사이에서 접힌다
 * (출처 하나 — 링크와 그 라이선스 — 는 끊지 않는다). QA-303(QA 2026-10): 전에는 묶음마다 inline-block + whitespace-nowrap 이라 가장 긴 묶음(519 px)이
 * 375 · 320 px 화면에서 잘려 '해양수산부 해양격자 4단계' · 'OpenStreetMap contributors' 가 화면 밖이었다.
 */
export function AttributionFooter() {
  return (
    <footer className="shrink-0 border-t border-line bg-bg-1 px-3 py-[3px] text-[10px] leading-[1.5] text-fg-3" data-testid="attribution" aria-label="데이터 출처">
      <span className="label mr-2 text-[9px]">Sources</span>
      {creditGroups().map((g, gi) => (
        <span key={g.role} className="inline-block max-w-full">
          {gi > 0 ? <span aria-hidden className="mx-1.5 text-line-2">|</span> : null}
          <span className="mr-1">{g.role}</span>
          {g.items.map((c, i) => (
            <span key={c.label}>
              {i > 0 ? " · " : ""}
              <span className="whitespace-nowrap"><a href={c.href} target="_blank" rel="noopener noreferrer" className="text-fg-2 hover:text-fg">{c.label}</a>
              {c.license ? <> (<a href={c.license.href} target="_blank" rel="noopener noreferrer" className="text-fg-2 hover:text-fg">{c.license.label}</a>)</> : null}
              {c.note ? ` (${c.note})` : null}</span>
            </span>
          ))}
        </span>
      ))}
    </footer>
  );
}
