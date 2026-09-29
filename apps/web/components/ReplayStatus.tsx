import { fmtLatencyMs } from "@/lib/format";
import { replayAtLabel, replayFrameAtLabel, replayRadarLabel, replayRadarTitle, replayZone, type ReplayFrame, type ReplayRange } from "@/lib/replay";
import { fmtTimeTitle } from "@/lib/time";

const SOURCE_LABEL: Record<string, string> = { track_point: "원해상도 기록", track_point_1m: "1분 요약(평균 위치)", none: "기록 없음" };

/**
 * 재생 상태 줄(사용자 영상 2026-09-29 — 슬라이더 아래, 높이 고정 · 한 줄 · 넘치면 잘림, 전체는 title).
 * 순서 = 잘리면 안 되는 것부터: 재생 시각(KST, shrink-0) → "불러오는 중"(지도가 아직 다른 시각일 때만, shrink-0 — 리뷰 2026-09-29: 잘리는 글자의 꼬리에
 * 두면 휴대폰 폭에서 가장 먼저 사라졌다) → 구간(원해상도 / 1분 요약, shrink-0) → 지도 시각 · 요약 · 레이더(잘림).
 */
export function ReplayStatusRow({ at, range, frame, latencyMs }: { at: number; range: ReplayRange; frame: ReplayFrame | null; latencyMs: number | null }) {
  const shown = replayFrameAtLabel(frame, at);
  const summary = frame ? `${frame.aircraft.length} aircraft · ${frame.sigmets.length} SIGMET · ${SOURCE_LABEL[frame.source] ?? frame.source} · ${fmtLatencyMs(latencyMs)}` : "—";
  const zone = at && range.max ? replayZone(at, range) : null;
  return (
    <div className="flex h-5 items-center gap-x-3 overflow-hidden px-3 whitespace-nowrap" data-testid="replay-status">
      <span className="mono shrink-0" data-testid="replay-at" title={at ? fmtTimeTitle(at) : undefined}>{replayAtLabel(at)}</span>
      {shown.behind ? <span className="shrink-0 text-warn" data-testid="replay-loading" title={`지도는 아직 ${shown.text} 의 기록 — 재생 시각의 기록을 불러오는 중`}>불러오는 중</span> : null}
      {zone ? <span className={`shrink-0 ${zone === "full" ? "text-fg-2" : "text-warn"}`} data-testid="replay-zone">{zone === "full" ? "원해상도 구간(72 h 안)" : "1분 요약 구간(72 h 밖)"}</span> : null}
      <span className={`mono min-w-0 truncate ${shown.behind ? "text-warn" : "text-fg-2"}`} data-testid="replay-frame-at" title={`지도에 그린 기록의 시각(응답 at): ${shown.text}${frame ? ` · ${fmtTimeTitle(frame.at) ?? "—"}` : ""}`}>
        {/* 응답 시각이 재생 시각과 같으면(1 s 안) 같은 글자를 되풀이하지 않는다 — 다를 때(불러오는 중)만 그린 시각을 보인다 */}
        지도 {shown.text !== "—" && !shown.behind ? "= 재생 시각" : shown.text}
      </span>
      <span className="mono min-w-0 truncate text-fg-2" data-testid="replay-summary" title={summary}>{summary}</span>
      <span className={`min-w-0 truncate ${frame?.radar ? "text-fg-2" : "text-fg-3"}`} data-testid="replay-radar" title={[replayRadarLabel(frame), replayRadarTitle(frame)].filter(Boolean).join(" · ")}>{replayRadarLabel(frame)}</span>
    </div>
  );
}
