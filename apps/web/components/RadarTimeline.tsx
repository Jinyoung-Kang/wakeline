"use client";
import { useEffect, useState } from "react";
import { KrRadarPanel } from "./KrRadarPanel";
import { fmtTime } from "@/lib/format";
import { useServerData } from "@/lib/store";
import type { KrRadar } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

/**
 * 기상청을 골랐는데 쓸 수 있는 프레임이 없을 때(R-11) — 지도에 레이더가 없는 이유를 타임라인에 쓴다.
 * 서버가 준 note 와 마지막 수집 시각(meta.fetched_at)만 붙인다(모르면 붙이지 않는다).
 */
function krUnavailableText(d: KrRadar | null): string {
  if (!d) return "기상청 레이더 없음 — 상태 수신 전";
  const last = fmtTime(d.meta?.fetched_at);
  return `기상청 레이더 없음${d.note ? ` — ${d.note}` : ""}${last !== "—" ? ` · 마지막 수집 ${last}` : ""}`;
}

/**
 * 레이더 타임라인(FR-06): 과거 2 h · 10분 간격 프레임. 지도는 현재 프레임만 받아 그리고(PERF-12), 재생 중에만 다음 프레임을 미리 받는다.
 * RainViewer 는 커버리지 밖을 회색으로 가려 "에코 없음"과 구분한다(GAP-15).
 */
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
  // 프레임 시각: RainViewer 는 UTC, 기상청 tm 은 KST(YYYYMMDDHHMM) — 날짜가 바뀌는 자정 부근도 알 수 있게 월-일 포함
  const label = kma
    ? (krTm && /^\d{12}$/.test(krTm) ? `${krTm.slice(4, 6)}-${krTm.slice(6, 8)} ${krTm.slice(8, 10)}:${krTm.slice(10, 12)} KST` : "—")
    : time ? `${new Date(time * 1000).toISOString().slice(5, 16).replace("T", " ")}Z` : "—";
  const [kr, setKr] = useState(false);
  return (
    <div className="relative flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-bg-1 px-3 py-1" data-testid="radar-timeline">
      {kr ? <KrRadarPanel onClose={() => setKr(false)} /> : null}
      <span className="label">Radar</span>
      <button className="btn" aria-pressed={!kma} onClick={() => setSource("rainviewer")} data-testid="radar-src-rv">RainViewer</button>
      <button className="btn" aria-pressed={kma} onClick={() => setSource("kma")} disabled={!krAvailable} title={krAvailable ? "기상청 합성 HSR 500 m" : radarKr?.note ?? "수집 전"} data-testid="radar-src-kma">기상청 HSR</button>
      {/* '재생' 은 상단 메뉴(이력 재생 화면)의 이름이다 — 레이더 애니메이션은 다른 말로(R-60) */}
      <button className="btn" onClick={() => setPlaying(!playing)} disabled={n === 0} aria-pressed={playing} data-testid="radar-play"
        aria-label={playing ? "레이더 애니메이션 정지" : "레이더 애니메이션 재생"}>{playing ? "정지" : "애니메이션 ▶"}</button>
      <input type="range" min={0} max={Math.max(0, n - 1)} value={cur} onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }} className="w-40 min-[900px]:w-64" disabled={n === 0}
        aria-label="레이더 프레임" aria-valuetext={label} />
      <span className="mono text-[11px]" data-testid="radar-frame-time">{label}</span>
      {kma && !krAvailable
        ? <span className="text-[10px] text-warn" data-testid="radar-kr-unavailable">{krUnavailableText(radarKr)}</span>
        : <span className="text-[10px] text-fg-3">{kma ? `${n} frames · 5 min · 기상청 HSR 500 m(LCC→Mercator 재투영)` : `${n} frames · 10 min · RainViewer(z≤7) · 커버리지 밖 회색`}</span>}
      <button className="btn" onClick={() => { setPlaying(false); setIdx(null); }} disabled={n === 0} title="최신 프레임으로">latest</button>
      <button className="btn ml-2" aria-pressed={kr} onClick={() => setKr(!kr)} data-testid="kr-radar-toggle">범례·정합</button>
    </div>
  );
}
