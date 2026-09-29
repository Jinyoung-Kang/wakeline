import { fmtKst, fmtRangeTitle, fmtTimeTitle, kstCell, kstRangeParts, timeParts, type TimeIn } from "@/lib/time";

/**
 * 시각 그리기 한 곳(계약 v5 §G20 — 화면 시각은 한국 표준시만, 글자 규칙은 lib/time.ts).
 * - inline(기본): "09-29 08:41:14 KST" — date={false} 면 날짜가 자명한 자리의 "08:41:14 KST", seconds={false} 면 분까지, year · ms 로 늘린다
 * - cell: 표 칸 "09-29 08:41:14"(머리글 "(KST)" 가 시간대를 말한다 — 화면 읽기 프로그램에는 숨긴 " KST" 까지)
 * <time dateTime> 에 같은 순간의 ISO 8601 +09:00, title 에 연도 · ms 까지의 KST. 한 시각은 줄이 바뀌지 않는다(whitespace-nowrap).
 * 모르면 "—" 만(title · time 없음).
 */
export function KstTime({ v, variant = "inline", date, year, seconds, ms, className, testId }: {
  v: TimeIn; variant?: "inline" | "cell"; date?: boolean; year?: boolean; seconds?: boolean; ms?: boolean; className?: string; testId?: string;
}) {
  const cls = className ? `mono ${className}` : "mono";
  const p = timeParts(v);
  if (!p) return <span className={cls} data-testid={testId}>—</span>;
  if (variant === "cell") {
    return (
      <time dateTime={p.iso} title={fmtTimeTitle(v)} className={`${cls} whitespace-nowrap`} data-testid={testId}>
        {kstCell(v, { ms })!.text}<span className="sr-only"> KST</span>
      </time>
    );
  }
  return <time dateTime={p.iso} title={fmtTimeTitle(v)} className={`${cls} whitespace-nowrap`} data-testid={testId}>{fmtKst(v, { date, year, seconds, ms })}</time>;
}

/**
 * 구간(lib/time fmtKstRange): "09-29 07:00:00 – 09-29 11:00:00 KST"(시간대는 끝에 한 번) — 쪽마다 줄바꿈 없이, 좁은 카드에서는 " – " 에서만 줄이 바뀐다.
 * 한쪽만 알면 "… KST – —"(open 을 주면 끝이 없는 구간을 그 글자로). title 에 두 순간(연도 · ms 까지).
 */
export function KstRange({ a, b, open, seconds, className, testId }: { a: TimeIn; b: TimeIn; open?: string; seconds?: boolean; className?: string; testId?: string }) {
  const cls = className ? `mono ${className}` : "mono";
  const r = kstRangeParts(a, b, { open, seconds });
  return (
    <span className={cls} title={fmtRangeTitle(a, b)} data-testid={testId}>
      <span className="whitespace-nowrap">{r.from}</span> – <span className="whitespace-nowrap">{r.to}</span>
    </span>
  );
}
