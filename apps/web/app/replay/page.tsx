"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import { fmtAltGnd, fmtBool, fmtNum, fmtTime } from "@/lib/format";
import { isSummaryRow, replayRadarLabel, replayRecLabel, replaySigmetBand, SUMMARY_FLAG, type ReplayFrame } from "@/lib/replay";
import { serverNowMs } from "@/lib/store";
import type { ReplayPick } from "@/components/ReplayMap";

const ReplayMap = dynamic(() => import("@/components/ReplayMap").then((m) => m.ReplayMap), { ssr: false });
const SPEEDS = [1, 5, 10, 30, 60];
const SOURCE_LABEL: Record<string, string> = { track_point: "원해상도 기록", track_point_1m: "1분 요약(평균 위치)", none: "기록 없음" };

/** 이력 재생(FR-23): 시각 슬라이더(최근 72 h 원해상도, 그 이전은 1분 요약) · 1×~60× · 그 시각 SIGMET · 레이더(있을 때만). */
export default function ReplayPage() {
  const [range, setRange] = useState<{ min: number; max: number }>({ min: 0, max: 0 });
  const [at, setAt] = useState(0);
  const [speed, setSpeed] = useState(10);
  const [playing, setPlaying] = useState(false);
  const [bbox, setBbox] = useState("124,33,132,39");
  const [frame, setFrame] = useState<ReplayFrame | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [pick, setPick] = useState<ReplayPick>(null);
  const [showRadar, setShowRadar] = useState(true);
  const inflight = useRef(false);
  const { min, max } = range;
  // 기록 시각은 서버 시계 — 상황판에서 추정한 오프셋이 있으면 쓴다(없으면 브라우저 시계)
  useEffect(() => { const h = setTimeout(() => { const now = serverNowMs(Date.now()); setRange({ min: now - 72 * 3600_000, max: now - 60_000 }); setAt(now - 10 * 60_000); }, 0); return () => clearTimeout(h); }, []);

  const load = useCallback(async (t: number, b: string) => {
    if (inflight.current) return;
    inflight.current = true;
    const t0 = performance.now();
    try {
      const f = await apiGet<ReplayFrame>(`/api/v1/replay?at=${encodeURIComponent(new Date(t).toISOString())}&bbox=${encodeURIComponent(b)}`);
      setFrame(f); setErr(null); setLatency(Math.round(performance.now() - t0));
    } catch (e) { setErr((e as Error).message); } finally { inflight.current = false; }
  }, []);

  useEffect(() => { if (!at) return; const h = setTimeout(() => load(at, bbox), 150); return () => clearTimeout(h); }, [at, bbox, load]);
  useEffect(() => {
    if (!playing) return;
    const tick = setInterval(() => setAt((t) => Math.min(max, t + speed * 1000)), 1000);
    return () => clearInterval(tick);
  }, [playing, speed, max]);

  const ac = pick?.kind === "aircraft" && frame ? frame.aircraft.find((a) => a.hex === pick.hex) ?? null : null;
  const sg = pick?.kind === "sigmet" && frame ? frame.sigmets.find((s) => s.id === pick.id) ?? null : null;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 overflow-x-auto border-b border-line bg-bg-1 px-3 text-[11px] whitespace-nowrap">
        <span className="label">Replay</span>
        <button className="btn" onClick={() => setPlaying(!playing)} aria-pressed={playing}>{playing ? "정지" : "재생"}</button>
        <div className="flex gap-1" role="group" aria-label="재생 속도">
          {SPEEDS.map((s) => <button key={s} className="btn" aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>)}
        </div>
        <input type="range" min={min} max={max} step={10_000} value={Math.min(max, Math.max(min, at))} onChange={(e) => { setPlaying(false); setAt(Number(e.target.value)); }} className="w-80"
          aria-label="재생 시각" aria-valuetext={at ? new Date(at).toISOString() : "—"} />
        <span className="mono" data-testid="replay-at">{at ? `${new Date(at).toISOString().replace("T", " ").slice(0, 19)}Z` : "—"}</span>
        <span className="mono text-fg-2" data-testid="replay-summary">{frame ? `${frame.aircraft.length} aircraft · ${frame.sigmets.length} SIGMET · ${SOURCE_LABEL[frame.source] ?? frame.source} · ${latency ?? "—"} ms` : "—"}</span>
        <button className="btn" aria-pressed={showRadar} onClick={() => setShowRadar(!showRadar)} disabled={!frame?.radar}>레이더</button>
        <span className={frame?.radar ? "text-fg-2" : "text-fg-3"} data-testid="replay-radar">{replayRadarLabel(frame)}</span>
        {err ? <span className="text-bad">{err}</span> : null}
        <span className="ml-auto text-fg-3">항적 원해상도 72 h · 1분 요약 30일(관심 지역, 1분 평균 위치·방위 없음) · 보간 없음</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <ReplayMap frame={frame} onBbox={setBbox} onPick={setPick} showRadar={showRadar} />
        {pick ? (
          <div className="panel absolute top-3 right-3 z-10 w-[320px] text-[12px]" data-testid="replay-inspector" role="region" aria-label="재생 항목 상세">
            <div className="row">
              <span className="label">{pick.kind === "aircraft" ? "Aircraft · 기록" : "SIGMET · 그 시각"}</span>
              <button className="btn" onClick={() => setPick(null)}>닫기</button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-2 py-1">
              {pick.kind === "aircraft" ? (ac ? <>
                {isSummaryRow(ac) ? <div className="py-1 text-[11px] text-warn" data-testid="replay-summary-row">{SUMMARY_FLAG}</div> : null}
                {([
                  ["ICAO24", ac.hex], ["Callsign", ac.callsign ?? "—"], [isSummaryRow(ac) ? "고도(1분 평균)" : "고도", fmtAltGnd(ac.alt_ft, ac.on_ground)],
                  [isSummaryRow(ac) ? "지상속도(1분 평균)" : "지상속도", fmtNum(ac.gs_kt, " kt")],
                  ["방위", fmtNum(ac.track_deg, "°")], ["지상", fmtBool(ac.on_ground)], [isSummaryRow(ac) ? "기록 구간" : "기록 시각", isSummaryRow(ac) ? replayRecLabel(ac, frame!.at) : fmtTime(ac.ts)],
                  ["출처", isSummaryRow(ac) ? "1분 요약(track_point_1m)" : ac.provider ?? "—"],
                ] as [string, string][]).map(([k, v]) => <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="text-fg-3">{k}</span><span className="mono text-right">{v}</span></div>)}
              </> : <div className="py-2 text-fg-3">{pick.hex} — 이 시각(−3분 창)·이 영역에 기록 없음</div>)
                : sg ? <>
                  {([["유형", `${sg.hazard}${sg.qualifier ? ` ${sg.qualifier}` : ""}`], ["FIR", sg.fir_name ?? sg.fir_id], ["고도대", replaySigmetBand(sg)], ["유효", `${fmtTime(sg.valid_from)} – ${fmtTime(sg.valid_to)}`], ["판정", sg.excluded_reason ? `제외 (${sg.excluded_reason})` : "폴리곤·고도대·유효시간 검사"]] as [string, string][])
                    .map(([k, v]) => <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="text-fg-3">{k}</span><span className="text-right">{v}</span></div>)}
                  <pre className="mono mt-2 whitespace-pre-wrap border border-line bg-bg p-2 text-[10px] text-fg-2">{sg.raw_text}</pre>
                </> : <div className="py-2 text-fg-3">이 시각에 유효하지 않은 SIGMET</div>}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
