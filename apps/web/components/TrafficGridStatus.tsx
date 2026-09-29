"use client";
import { useServerData } from "@/lib/store";
import { TRAFFIC_LAYER_LABEL, TRAFFIC_SOURCE_TEXT, trafficStatusLine } from "@/lib/traffic-grid";

const TONE = { ok: "text-fg-2", warn: "text-warn", bad: "text-bad", muted: "text-fg-3" } as const;

/**
 * 연안 교통량 레이어 상태 줄(ADR-023) — 켜져 있을 때 레이어 버튼 아래에. 기준 시각(KST · UTC), 표시한 칸 / 전체, 격자 위치를 확인 중인 칸,
 * 꺼짐 · 자료 없음 · 멈춤의 이유를 글로 적는다(지도에 칸이 없는 까닭이 화면에 보이게). 값은 lib/traffic-grid 의 trafficStatusLine.
 */
export function TrafficGridStatus() {
  const s = useServerData((d) => d.trafficGrid);
  const line = trafficStatusLine(s.data, s.error);
  return (
    <div className="pointer-events-auto panel max-w-full px-2 py-1 text-[11px] leading-snug sm:max-w-[440px]" role="status" aria-live="polite"
      data-testid="traffic-status" title={`${TRAFFIC_SOURCE_TEXT} — 격자별 선박 척수(개별 선박 위치 아님)`}>
      <span className="label mr-1.5 text-[9px]">{TRAFFIC_LAYER_LABEL}</span>
      <span className={TONE[line.tone]} data-testid="traffic-status-text">{line.text}</span>
      {line.detail ? <div className="text-fg-3" data-testid="traffic-status-detail">{line.detail}</div> : null}
    </div>
  );
}
