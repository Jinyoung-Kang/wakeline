import { dualCell, dualPair, dualPairCompact, dualRangePair, fmtDualRange, fmtUtcRangeTitle, fmtUtcTitle, type TimeIn } from "@/lib/time";

/**
 * 시각 표시 한 곳(사용자 요청 2026-09-29 "UTC 와 KST 함께" — lib/time.ts 의 규칙을 그대로 그린다). KST 를 먼저, UTC 는 흐리게.
 * - inline(기본): "09-29 08:41:14 KST · 09-28 23:41:14 UTC" — date={false} 면 날짜가 자명한 자리의 "08:41:14 KST · …"
 * - compact: "08:41 KST · 09-28 23:41Z"(상태 바 등 좁은 줄) — seconds · date 로 늘린다
 * - cell: 첫 줄 KST · 둘째 줄 흐린 UTC(표 칸 — 머리글 "(KST · UTC)"). 화면 읽기 프로그램에는 "… KST · … UTC" 로 읽힌다(숨긴 글자)
 * <time dateTime> 에 그 순간(UTC ISO), title 에 원본 UTC ISO(ms 까지). 모르면 "—" 만(title · time 없음).
 */
export function DualTime({ v, variant = "inline", date, year, seconds, ms, className, testId }: {
  v: TimeIn; variant?: "inline" | "compact" | "cell"; date?: boolean; year?: boolean; seconds?: boolean; ms?: boolean; className?: string; testId?: string;
}) {
  const cls = className ? `mono ${className}` : "mono";
  if (variant === "cell") {
    const c = dualCell(v, { ms });
    if (!c) return <span className={cls} data-testid={testId}>—</span>;
    return (
      <span className={`${cls} inline-block leading-tight`} title={fmtUtcTitle(v)} data-testid={testId}>
        <time dateTime={c.iso} className="block">{c.kst}<span className="sr-only"> KST</span></time>
        <span className="sr-only"> · </span>
        <span className="block text-[10px] text-fg-3">{c.utc}</span>
      </span>
    );
  }
  const x = variant === "compact" ? dualPairCompact(v, { date, seconds }) : dualPair(v, { date, year, seconds, ms });
  if (!x) return <span className={cls} data-testid={testId}>—</span>;
  return (
    <span className={cls} title={fmtUtcTitle(v)} data-testid={testId}>
      <time dateTime={x.iso}>{x.kst}</time>
      <span className="text-fg-3"> · {x.utc}</span>
    </span>
  );
}

/** 구간(lib/time fmtDualRange): 양쪽을 알면 KST 구간 · 흐린 UTC 구간, 한쪽만 알면 그 글자 그대로. title 에 원본 UTC 구간 */
export function DualRange({ a, b, open, seconds, className, testId }: { a: TimeIn; b: TimeIn; open?: string; seconds?: boolean; className?: string; testId?: string }) {
  const cls = className ? `mono ${className}` : "mono";
  const x = dualRangePair(a, b, { seconds });
  return (
    <span className={cls} title={fmtUtcRangeTitle(a, b)} data-testid={testId}>
      {x ? <>{x.kst}<span className="text-fg-3"> · {x.utc}</span></> : fmtDualRange(a, b, { open, seconds })}
    </span>
  );
}
