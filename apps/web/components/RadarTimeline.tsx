"use client";
import { useEffect, useState } from "react";
import { KrRadarPanel } from "./KrRadarPanel";
import { useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";

/** 레이더 타임라인(FR-06): 과거 2 h · 10분 간격 프레임. 소스는 사전 생성되어 전환은 불투명도만 바꾼다. */
export function RadarTimeline() {
  const radar = useServerData((d) => d.radar);
  const radarKr = useServerData((d) => d.radarKr);
  const source = useUi((s) => s.radarSource);
  const setSource = useUi((s) => s.setRadarSource);
  const rvIdx = useUi((s) => s.radarFrameIndex);
  const setRvIdx = useUi((s) => s.setRadarFrame);
  const krIdx = useUi((s) => s.krFrameIndex);
  const setKrIdx = useUi((s) => s.setKrFrame);
  const playing = useUi((s) => s.radarPlaying);
  const setPlaying = useUi((s) => s.setRadarPlaying);
  const kma = source === "kma";
  const n = kma ? radarKr?.frames.length ?? 0 : radar?.past.length ?? 0;
  const idx = kma ? krIdx : rvIdx;
  const setIdx = kma ? setKrIdx : setRvIdx;
  const cur = idx ?? Math.max(0, n - 1);
  useEffect(() => {
    if (!playing || n === 0) return;
    const t = setInterval(() => {
      const st = useUi.getState();
      const i = kma ? st.krFrameIndex : st.radarFrameIndex;
      setIdx(((i ?? n - 1) + 1) % n);
    }, 600);
    return () => clearInterval(t);
  }, [playing, n, setIdx, kma]);
  const time = kma ? undefined : radar?.past[cur]?.time;
  const krTm = kma ? radarKr?.frames[cur]?.tm : undefined;
  const krAvailable = !!radarKr?.available && (radarKr?.frames.length ?? 0) > 0;
  const [kr, setKr] = useState(false);
  return (
    <div className="relative flex h-9 shrink-0 items-center gap-3 border-t border-line bg-bg-1 px-3" data-testid="radar-timeline">
      {kr ? <KrRadarPanel onClose={() => setKr(false)} /> : null}
      <span className="label">Radar</span>
      <button className="btn" aria-pressed={!kma} onClick={() => setSource("rainviewer")} data-testid="radar-src-rv">RainViewer</button>
      <button className="btn" aria-pressed={kma} onClick={() => setSource("kma")} disabled={!krAvailable} title={krAvailable ? "기상청 합성 HSR 500 m" : radarKr?.note ?? "수집 전"} data-testid="radar-src-kma">기상청 HSR</button>
      <button className="btn" onClick={() => setPlaying(!playing)} disabled={n === 0}>{playing ? "정지" : "재생"}</button>
      <input type="range" min={0} max={Math.max(0, n - 1)} value={cur} onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }} className="w-64" disabled={n === 0} />
      <span className="mono text-[11px]">{kma ? (krTm ? `${krTm.slice(8, 10)}:${krTm.slice(10, 12)} KST` : "—") : time ? new Date(time * 1000).toISOString().slice(11, 16) + "Z" : "—"}</span>
      <span className="text-[10px] text-fg-3">{kma ? `${n} frames · 5 min · 기상청 HSR 500 m(LCC→Mercator 재투영)` : `${n} frames · 10 min · RainViewer(z≤7)`} · 최신으로: </span>
      <button className="btn" onClick={() => { setPlaying(false); setIdx(null); }} disabled={n === 0}>latest</button>
      <button className="btn ml-2" aria-pressed={kr} onClick={() => setKr(!kr)} data-testid="kr-radar-toggle">범례·정합</button>
    </div>
  );
}
