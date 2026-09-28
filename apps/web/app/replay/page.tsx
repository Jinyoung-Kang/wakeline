"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import { fmtAltGnd, fmtBool, fmtNum, fmtTime } from "@/lib/format";
import {
  fromUtcInput, isSummaryRow, REPLAY_MAX_AREA_SQDEG, REPLAY_STEPS, replayFrameAtLabel, replayInspectorMiss, replayRadarLabel, replayRange, replayRecLabel, replayReduce, replaySigmetBand,
  ReplayLoader, replayZone, stepAt, SUMMARY_FLAG, toUtcInput, type ReplayFrame, type ReplayRange,
} from "@/lib/replay";
import { serverNowMs } from "@/lib/store";
import type { ReplayPick } from "@/components/ReplayMap";
import { ReplayList } from "@/components/ReplayList";

const ReplayMap = dynamic(() => import("@/components/ReplayMap").then((m) => m.ReplayMap), { ssr: false });
const SPEEDS = [1, 5, 10, 30, 60];
const SOURCE_LABEL: Record<string, string> = { track_point: "원해상도 기록", track_point_1m: "1분 요약(평균 위치)", none: "기록 없음" };

/**
 * 이력 재생(FR-23): 최근 30일(72 h 원해상도, 그 이전은 1분 요약) · 1×~60× · 그 시각 SIGMET · 레이더(있을 때만).
 * 시각은 UTC 날짜·시각 입력, ±1분·±10분·±1 h 버튼, 슬라이더(72 h 경계 눈금)로 고른다(R-10).
 */
export default function ReplayPage() {
  const [range, setRange] = useState<ReplayRange>({ min: 0, max: 0, fullResFrom: 0 });
  const [at, setAt] = useState(0);
  const [speed, setSpeed] = useState(10);
  const [playing, setPlaying] = useState(false);
  const [bbox, setBbox] = useState("124,33,132,39");
  const [clamped, setClamped] = useState(false);
  const [{ frame, err, latencyMs: latency }, dispatch] = useReducer(replayReduce, { frame: null, err: null, latencyMs: null });
  const [pick, setPick] = useState<ReplayPick>(null);
  const [showRadar, setShowRadar] = useState(true);
  const [showList, setShowList] = useState(false);
  const { min, max } = range;
  // 기록 시각은 서버 시계 — 상황판에서 추정한 오프셋이 있으면 쓴다(없으면 브라우저 시계)
  useEffect(() => { const h = setTimeout(() => { const now = serverNowMs(Date.now()); setRange(replayRange(now)); setAt(now - 10 * 60_000); }, 0); return () => clearTimeout(h); }, []);

  // 요청은 한 번에 하나, 보내는 중에 바뀐 시각·영역은 끝나면 바로 보낸다(R-47 — 예전에는 버려져 라벨과 지도가 어긋난 채 멈췄다)
  // 마운트마다 새 로더(개발 모드 StrictMode 의 두 번 실행에도 폐기된 로더를 쓰지 않게)
  const loader = useRef<ReplayLoader | null>(null);
  useEffect(() => {
    const l = new ReplayLoader(
      (r) => apiGet<ReplayFrame>(`/api/v1/replay?at=${encodeURIComponent(new Date(r.at).toISOString())}&bbox=${encodeURIComponent(r.bbox)}`),
      (e) => dispatch(e),
    );
    loader.current = l;
    return () => { l.dispose(); if (loader.current === l) loader.current = null; };
  }, []);
  useEffect(() => { if (!at) return; const h = setTimeout(() => loader.current?.request({ at, bbox }), 150); return () => clearTimeout(h); }, [at, bbox]);
  useEffect(() => {
    if (!playing) return;
    const tick = setInterval(() => setAt((t) => Math.min(max, t + speed * 1000)), 1000);
    return () => clearInterval(tick);
  }, [playing, speed, max]);

  const onBbox = useCallback((b: string, c: boolean) => { setBbox(b); setClamped(c); }, []);
  const shown = replayFrameAtLabel(frame, at);
  const ac = pick?.kind === "aircraft" && frame ? frame.aircraft.find((a) => a.hex === pick.hex) ?? null : null;
  const sg = pick?.kind === "sigmet" && frame ? frame.sigmets.find((s) => s.id === pick.id) ?? null : null;
  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">이력 재생</h1>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-bg-1 px-3 py-1 text-[11px] whitespace-nowrap">
        <span className="label">Replay</span>
        <button className="btn" onClick={() => setPlaying(!playing)} aria-pressed={playing}>{playing ? "정지" : "재생"}</button>
        <div className="flex gap-1" role="group" aria-label="재생 속도">
          {SPEEDS.map((s) => <button key={s} className="btn" aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>)}
        </div>
        <span className="label" aria-hidden>UTC</span><input type="datetime-local" step={60} min={max ? toUtcInput(min) : undefined} max={max ? toUtcInput(max) : undefined} value={at ? toUtcInput(at) : ""}
          onChange={(e) => { const t = fromUtcInput(e.target.value); if (t != null && max) { setPlaying(false); setAt(stepAt(t, 0, range)); } }}
          aria-label="재생 시각(UTC)" data-testid="replay-at-input" />
        <div className="flex gap-1" role="group" aria-label="재생 시각 이동">
          {REPLAY_STEPS.map(([d, l]) => <button key={l} className="btn px-1.5 normal-case!" onClick={() => { setPlaying(false); setAt((t) => stepAt(t, d, range)); }} disabled={!at}>{l}</button>)}
        </div>
        <input type="range" min={min} max={max} step={10_000} value={Math.min(max, Math.max(min, at))} onChange={(e) => { setPlaying(false); setAt(Number(e.target.value)); }} className="min-w-[200px] flex-1"
          list="replay-marks" aria-label="재생 시각" aria-valuetext={at ? `${new Date(at).toISOString()} · ${replayZone(at, range) === "full" ? "원해상도" : "1분 요약"}` : "—"} />
        <datalist id="replay-marks"><option value={range.fullResFrom} label="72 h" /></datalist>
        <span className="mono" data-testid="replay-at">{at ? `${new Date(at).toISOString().replace("T", " ").slice(0, 19)}Z` : "—"}</span>
        {at && max ? <span className={replayZone(at, range) === "full" ? "text-fg-2" : "text-warn"} data-testid="replay-zone">{replayZone(at, range) === "full" ? "원해상도 구간(72 h 안)" : "1분 요약 구간(72 h 밖)"}</span> : null}
        <span className={`mono ${shown.behind ? "text-warn" : "text-fg-2"}`} data-testid="replay-frame-at" title="지도에 그린 기록의 시각(응답 at)">지도 {shown.text}{shown.behind ? " · 불러오는 중" : ""}</span>
        <span className="mono text-fg-2" data-testid="replay-summary">{frame ? `${frame.aircraft.length} aircraft · ${frame.sigmets.length} SIGMET · ${SOURCE_LABEL[frame.source] ?? frame.source} · ${latency ?? "—"} ms` : "—"}</span>
        <button className="btn" aria-pressed={showRadar} onClick={() => setShowRadar(!showRadar)} disabled={!frame?.radar}>레이더</button>
        <button className="btn" aria-expanded={showList} aria-controls={showList ? "replay-list" : undefined} onClick={() => setShowList(!showList)} data-testid="replay-list-toggle">목록</button>
        <span className={frame?.radar ? "text-fg-2" : "text-fg-3"} data-testid="replay-radar">{replayRadarLabel(frame)}</span>
        {err ? <span className="whitespace-normal text-bad" role="alert" data-testid="replay-error">{err}</span> : null}
        {clamped ? <span className="whitespace-normal text-warn" data-testid="replay-clamped" title={`서버 조회 면적 상한 ${REPLAY_MAX_AREA_SQDEG.toLocaleString()} sq°`}>화면이 넓어 가운데 점선 상자만 조회 — 상자 밖 기록은 표시 안 함(확대하면 전체)</span> : null}
        <span className="whitespace-normal text-fg-3">항적 원해상도 72 h · 1분 요약 30일(관심 지역, 1분 평균 위치·방위 없음) · 보간 없음 · 슬라이더 눈금 = 72 h 경계</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <ReplayMap frame={frame} onBbox={onBbox} onPick={setPick} showRadar={showRadar} />
        {/* 키보드 경로(R-40): 지도 클릭 없이 그 시각의 SIGMET·항공기를 고른다 */}
        {showList ? (
          <div id="replay-list" className="panel absolute top-3 left-12 z-10 flex max-h-[calc(100%-1.5rem)] w-[260px] max-w-[calc(100%-4rem)] flex-col" role="region" aria-label="재생 항목 목록" data-testid="replay-list">
            <ReplayList frame={frame} onPick={setPick} />
          </div>
        ) : null}
        {pick ? (
          <div className="panel absolute top-3 right-3 z-10 w-[320px] max-w-[calc(100%-1.5rem)] text-[12px]" data-testid="replay-inspector" role="region" aria-label="재생 항목 상세">
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
              </> : <div className="py-2 text-fg-3" data-testid="replay-inspector-miss">{replayInspectorMiss(pick, frame, err)}</div>)
                : sg ? <>
                  {([["유형", `${sg.hazard}${sg.qualifier ? ` ${sg.qualifier}` : ""}`], ["FIR", sg.fir_name ?? sg.fir_id], ["고도대", replaySigmetBand(sg)], ["유효", `${fmtTime(sg.valid_from)} – ${fmtTime(sg.valid_to)}`], ["판정", sg.excluded_reason ? `제외 (${sg.excluded_reason})` : "폴리곤·고도대·유효시간 검사"]] as [string, string][])
                    .map(([k, v]) => <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="text-fg-3">{k}</span><span className="text-right">{v}</span></div>)}
                  <pre className="mono mt-2 whitespace-pre-wrap border border-line bg-bg p-2 text-[10px] text-fg-2">{sg.raw_text}</pre>
                </> : <div className="py-2 text-fg-3" data-testid="replay-inspector-miss">{replayInspectorMiss(pick, frame, err)}</div>}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
