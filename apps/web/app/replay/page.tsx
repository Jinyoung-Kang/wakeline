"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import type { ReplayFrame } from "@/components/ReplayMap";

const ReplayMap = dynamic(() => import("@/components/ReplayMap").then((m) => m.ReplayMap), { ssr: false });
const SPEEDS = [1, 5, 10, 30, 60];

/** 이력 재생(FR-23): 시각 슬라이더(최근 72 h 원해상도, 그 이전은 1분 요약) · 1×~60×. */
export default function ReplayPage() {
  const [range, setRange] = useState<{ min: number; max: number }>({ min: 0, max: 0 });
  const [at, setAt] = useState(0);
  const [speed, setSpeed] = useState(10);
  const [playing, setPlaying] = useState(false);
  const [bbox, setBbox] = useState("124,33,132,39");
  const [frame, setFrame] = useState<ReplayFrame | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const inflight = useRef(false);
  const { min, max } = range;
  useEffect(() => { const h = setTimeout(() => { const now = Date.now(); setRange({ min: now - 72 * 3600_000, max: now - 60_000 }); setAt(now - 10 * 60_000); }, 0); return () => clearTimeout(h); }, []);

  const load = useCallback(async (t: number, b: string) => {
    if (inflight.current) return;
    inflight.current = true;
    const t0 = performance.now();
    try {
      const f = await apiGet<ReplayFrame>(`/api/v1/replay?at=${new Date(t).toISOString()}&bbox=${b}`);
      setFrame(f); setErr(null); setLatency(Math.round(performance.now() - t0));
    } catch (e) { setErr((e as Error).message); } finally { inflight.current = false; }
  }, []);

  useEffect(() => { if (!at) return; const h = setTimeout(() => load(at, bbox), 150); return () => clearTimeout(h); }, [at, bbox, load]);
  useEffect(() => {
    if (!playing) return;
    const tick = setInterval(() => setAt((t) => Math.min(max, t + speed * 1000)), 1000);
    return () => clearInterval(tick);
  }, [playing, speed, max]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-bg-1 px-3 text-[11px]">
        <span className="label">Replay</span>
        <button className="btn" onClick={() => setPlaying(!playing)}>{playing ? "정지" : "재생"}</button>
        {SPEEDS.map((s) => <button key={s} className="btn" aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>)}
        <input type="range" min={min} max={max} step={10_000} value={Math.min(max, Math.max(min, at))} onChange={(e) => { setPlaying(false); setAt(Number(e.target.value)); }} className="w-80" />
        <span className="mono">{new Date(at).toISOString().replace("T", " ").slice(0, 19)}Z</span>
        <span className="text-fg-3">{frame ? `${frame.aircraft.length} aircraft · ${frame.sigmets.length} SIGMET · ${frame.source} · ${latency} ms` : "—"}</span>
        {err ? <span className="text-bad">{err}</span> : null}
        <span className="ml-auto text-fg-3">항적 원해상도 72 h · 1분 요약 30일(관심 지역) · 보간 없음(기록된 위치)</span>
      </div>
      <div className="min-h-0 flex-1"><ReplayMap frame={frame} onBbox={setBbox} /></div>
    </div>
  );
}
