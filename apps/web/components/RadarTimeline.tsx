"use client";
import { useEffect } from "react";
import { useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";

/** 레이더 타임라인(FR-06): 과거 2 h · 10분 간격 프레임. 소스는 사전 생성되어 전환은 불투명도만 바꾼다. */
export function RadarTimeline() {
  const radar = useServerData((d) => d.radar);
  const idx = useUi((s) => s.radarFrameIndex);
  const setIdx = useUi((s) => s.setRadarFrame);
  const playing = useUi((s) => s.radarPlaying);
  const setPlaying = useUi((s) => s.setRadarPlaying);
  const n = radar?.past.length ?? 0;
  const cur = idx ?? Math.max(0, n - 1);
  useEffect(() => {
    if (!playing || n === 0) return;
    const t = setInterval(() => setIdx(((useUi.getState().radarFrameIndex ?? n - 1) + 1) % n), 600);
    return () => clearInterval(t);
  }, [playing, n, setIdx]);
  const time = radar?.past[cur]?.time;
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-t border-line bg-bg-1 px-3" data-testid="radar-timeline">
      <span className="label">Radar</span>
      <button className="btn" onClick={() => setPlaying(!playing)} disabled={n === 0}>{playing ? "정지" : "재생"}</button>
      <input type="range" min={0} max={Math.max(0, n - 1)} value={cur} onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }} className="w-64" disabled={n === 0} />
      <span className="mono text-[11px]">{time ? new Date(time * 1000).toISOString().slice(11, 16) + "Z" : "—"}</span>
      <span className="text-[10px] text-fg-3">{n} frames · 10 min · RainViewer(z≤7) · 최신으로: </span>
      <button className="btn" onClick={() => { setPlaying(false); setIdx(null); }} disabled={n === 0}>latest</button>
    </div>
  );
}
