"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { replayFrame } from "@/lib/endpoints/replay";
import {
  fromKstInput, REPLAY_MAX_AREA_SQDEG, REPLAY_STEPS, replayAtLabel, replayInspectorMiss, replayRange,
  replayReduce, ReplayLoader, replayZone, stepAt, toKstInput, type ReplayRange,
} from "@/lib/replay";
import { serverNowMs } from "@/lib/store";
import type { ReplayPick } from "@/components/ReplayMap";
import { ReplayList } from "@/components/ReplayList";
import { ReplayAircraftDetail, ReplaySigmetDetail } from "@/components/ReplayInspector";
import { ReplayStatusRow } from "@/components/ReplayStatus";
import { RequestIdCopy } from "@/components/logs/ErrorNote";

const ReplayMap = dynamic(() => import("@/components/ReplayMap").then((m) => m.ReplayMap), { ssr: false });
const SPEEDS = [1, 5, 10, 30, 60];

/**
 * 이력 재생(FR-23): 최근 30일(72 h 원해상도, 그 이전은 1분 요약) · 1×~60× · 그 시각 SIGMET · 레이더(있을 때만).
 * 시각은 한국 표준시(KST) 날짜·시각 입력, ±1분·±10분·±1 h 버튼, 슬라이더(72 h 경계 눈금)로 고른다(R-10). 보이는 시각은 KST 만(계약 v5 §G20) —
 * api 에는 그 순간을 UTC ISO(…Z — 저장 · 전송 형식)로 보낸다(lib/replay replayApiPath). SIGMET 원문은 발표된 그대로.
 */
export default function ReplayPage() {
  const [range, setRange] = useState<ReplayRange>({ min: 0, max: 0, fullResFrom: 0 });
  const [at, setAt] = useState(0);
  const [speed, setSpeed] = useState(10);
  const [playing, setPlaying] = useState(false);
  const [bbox, setBbox] = useState("124,33,132,39");
  const [clamped, setClamped] = useState(false);
  const [{ frame, err, rid, latencyMs: latency }, dispatch] = useReducer(replayReduce, { frame: null, err: null, latencyMs: null, rid: null });
  const [pick, setPick] = useState<ReplayPick>(null);
  const [showRadar, setShowRadar] = useState(true);
  const [showList, setShowList] = useState(false);
  const { min, max } = range;
  // 기록 시각은 서버 시계 — 상황판에서 추정한 오프셋이 있으면 쓴다(없으면 브라우저 시계)
  useEffect(() => { const h = setTimeout(() => { const now = serverNowMs(Date.now()); setRange(replayRange(now)); setAt(now - 10 * 60_000); }, 0); return () => clearTimeout(h); }, []);

  // 요청은 탭당 한 번에 하나(ReplayLoader — 서버에서도): 입력은 debounce 뒤 마지막 값만, 사용자가 옮기면 보내는 중인 요청의 응답은 버리고
  // 그것이 끝나면 곧바로 최신 값을 보낸다. 재생(▶) 중에는 응답을 그리고 끝나면 최신 틱을 보낸다(R-47). 시각 라벨은 입력마다 바로 바뀐다.
  // signal 은 화면을 떠날 때(dispose) 브라우저가 기다림을 멈추는 데만 쓴다.
  // 마운트마다 새 로더(개발 모드 StrictMode 의 두 번 실행에도 폐기된 로더를 쓰지 않게)
  const loader = useRef<ReplayLoader | null>(null);
  const playingRef = useRef(playing);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => {
    const l = new ReplayLoader(
      (r, signal) => replayFrame(r, { signal }),
      (e) => dispatch(e),
    );
    loader.current = l;
    return () => { l.dispose(); if (loader.current === l) loader.current = null; };
  }, []);
  useEffect(() => { if (at) loader.current?.schedule({ at, bbox }, { supersede: !playingRef.current }); }, [at, bbox]);
  useEffect(() => {
    if (!playing) return;
    const tick = setInterval(() => setAt((t) => Math.min(max, t + speed * 1000)), 1000);
    return () => clearInterval(tick);
  }, [playing, speed, max]);

  const onBbox = useCallback((b: string, c: boolean) => { setBbox(b); setClamped(c); }, []);
  const ac = pick?.kind === "aircraft" && frame ? frame.aircraft.find((a) => a.hex === pick.hex) ?? null : null;
  const sg = pick?.kind === "sigmet" && frame ? frame.sigmets.find((s) => s.id === pick.id) ?? null : null;
  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">이력 재생</h1>
      {/*
        사용자 영상(2026-09-29): 슬라이더가 길이가 바뀌는 상태 글자와 한 flex-wrap 줄에 있어 끄는 동안 폭·위치가 바뀌었다.
        1행 = 길이가 바뀌지 않는 조작(단추·시각 입력)만 · 2행 = 슬라이더 혼자(폭 = 줄 폭) · 3행 = 상태 글자(ReplayStatusRow — 높이 고정 · 한 줄 · 넘치면 잘림, 전체는 title,
        "불러오는 중" 은 재생 시각 바로 뒤 — 잘리는 글자 앞)
        · 4행 = 오류·조회 영역 제한·설명(줄바꿈 허용 — 슬라이더 아래라 슬라이더를 움직이지 않는다).
      */}
      <div className="shrink-0 border-b border-line bg-bg-1 text-[11px]">
        <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1 whitespace-nowrap" data-testid="replay-controls">
          <span className="label">Replay</span>
          <button className="btn min-w-[4.5em]" onClick={() => setPlaying(!playing)} aria-pressed={playing}>{playing ? "정지" : "재생"}</button>
          <div className="flex gap-1" role="group" aria-label="재생 속도">
            {SPEEDS.map((s) => <button key={s} className="btn" aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>)}
          </div>
          <span className="label" aria-hidden title="한국 표준시(KST)로 고르고 읽는다 — 서버에는 고른 순간을 그대로 보낸다">KST</span><input type="datetime-local" step={60} min={max ? toKstInput(min) : undefined} max={max ? toKstInput(max) : undefined} value={at ? toKstInput(at) : ""}
            onChange={(e) => { const t = fromKstInput(e.target.value); if (t != null && max) { setPlaying(false); setAt(stepAt(t, 0, range)); } }}
            aria-label="재생 시각(KST)" data-testid="replay-at-input" />
          <div className="flex gap-1" role="group" aria-label="재생 시각 이동">
            {REPLAY_STEPS.map(([d, l]) => <button key={l} className="btn px-1.5 normal-case!" onClick={() => { setPlaying(false); setAt((t) => stepAt(t, d, range)); }} disabled={!at}>{l}</button>)}
          </div>
          <button className="btn" aria-pressed={showRadar} onClick={() => setShowRadar(!showRadar)} disabled={!frame?.radar}>레이더</button>
          <button className="btn" aria-expanded={showList} aria-controls={showList ? "replay-list" : undefined} onClick={() => setShowList(!showList)} data-testid="replay-list-toggle">목록</button>
        </div>
        <div className="px-3 pt-0.5" data-testid="replay-slider-row">
          <input type="range" min={min} max={max} step={10_000} value={Math.min(max, Math.max(min, at))} onChange={(e) => { setPlaying(false); setAt(Number(e.target.value)); }} className="block w-full"
            list="replay-marks" aria-label="재생 시각" aria-valuetext={at ? `${replayAtLabel(at)} · ${replayZone(at, range) === "full" ? "원해상도" : "1분 요약"}` : "—"} />
          <datalist id="replay-marks"><option value={range.fullResFrom} label="72 h" /></datalist>
        </div>
        <ReplayStatusRow at={at} range={range} frame={frame} latencyMs={latency} />
        <div className="flex flex-wrap gap-x-3 px-3 pb-1 leading-snug">
          <span className="text-fg-3">항적 원해상도 72 h · 1분 요약 30일(관심 지역, 1분 평균 위치·방위 없음) · 보간 없음 · 슬라이더 눈금 = 72 h 경계</span>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <ReplayMap frame={frame} onBbox={onBbox} onPick={setPick} showRadar={showRadar} />
        {/* 오고 가는 알림(조회 실패 · 면적 상한)은 지도 위에 띄운다 — 위 줄에 넣으면 줄이 접혀 지도 높이가 바뀌고, 바뀐 영역으로 다시 조회했다
            (E2E 2026-10-01: 503 알림이 뜨고 사라질 때마다 bbox 가 33.243 ↔ 33.234 로 흔들려 같은 시각을 새로 조회). 오른쪽 아래 출처 표시는 가리지 않는다. */}
        {err || clamped ? (
          <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex max-w-[min(560px,calc(100%-7rem))] flex-col items-start gap-1 leading-snug" data-testid="replay-notes">
            {err ? <span className="panel pointer-events-auto px-2 py-1 text-bad" role="alert" data-testid="replay-error">{err}{rid ? <RequestIdCopy id={rid} /> : null}</span> : null}
            {clamped ? <span className="panel pointer-events-auto px-2 py-1 text-warn" data-testid="replay-clamped" title={`서버 조회 면적 상한 ${REPLAY_MAX_AREA_SQDEG.toLocaleString()} sq°`}>화면이 넓어 가운데 점선 상자만 조회 — 상자 밖 기록은 표시 안 함(확대하면 전체)</span> : null}
          </div>
        ) : null}
        {/* 키보드 경로(R-40): 지도 클릭 없이 그 시각의 SIGMET·항공기를 고른다 */}
        {showList ? (
          <div id="replay-list" className="panel absolute top-3 left-12 z-10 flex max-h-[calc(100%-1.5rem)] w-[260px] max-w-[calc(100%-4rem)] flex-col overflow-hidden" role="region" aria-label="재생 항목 목록" data-testid="replay-list">
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
              {pick.kind === "aircraft" ? (ac ? <ReplayAircraftDetail ac={ac} at={frame!.at} />
                : <div className="py-2 text-fg-3" data-testid="replay-inspector-miss">{replayInspectorMiss(pick, frame, err)}</div>)
                : sg ? <ReplaySigmetDetail sg={sg} />
                : <div className="py-2 text-fg-3" data-testid="replay-inspector-miss">{replayInspectorMiss(pick, frame, err)}</div>}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
