import { KstTime } from "./KstTime";
import type { TimeIn } from "@/lib/time";

/**
 * @deprecated 계약 v5 §G19 — components/KstTime 을 쓴다. 다른 레인(대시보드 UX: StatusBar · AlertPanel · AircraftCard)이 합쳐질 때까지 이름만 남긴
 * KST 전용 별칭이다(UTC 를 그리지 않는다). variant "compact" = 좁은 자리(날짜 없음 · 분까지 — seconds · date 로 늘린다), "cell" = 표 칸.
 */
export function DualTime({ v, variant = "inline", date, year, seconds, ms, className, testId }: {
  v: TimeIn; variant?: "inline" | "compact" | "cell"; date?: boolean; year?: boolean; seconds?: boolean; ms?: boolean; className?: string; testId?: string;
}) {
  if (variant === "compact") return <KstTime v={v} date={date ?? false} seconds={seconds ?? false} className={className} testId={testId} />;
  return <KstTime v={v} variant={variant} date={date} year={year} seconds={seconds} ms={ms} className={className} testId={testId} />;
}
