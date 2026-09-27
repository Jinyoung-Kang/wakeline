"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { fmtTime } from "@/lib/format";

interface KrRadar { available: boolean; tm_kst?: string | null; cmp?: string | null; status?: string | null; note?: string | null; image_url?: string | null; attribution: string; georeferenced: boolean; meta: { fetched_at: string | null } }

/** 기상청 레이더 합성 영상(FR-31). 격자·투영을 실응답으로 확인하기 전까지는 지도에 겹치지 않고 영상 그대로 보여 준다(정직성). */
export function KrRadarPanel({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<KrRadar | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { apiGet<KrRadar>("/api/v1/radar/kr").then(setD).catch(() => setD(null)); const t = setInterval(() => setTick((x) => x + 1), 60_000); return () => clearInterval(t); }, [tick]);
  return (
    <div className="panel absolute bottom-12 left-3 z-10 w-[360px] text-[11px]" data-testid="kr-radar-panel">
      <div className="row"><span className="label">기상청 레이더 합성(HSR)</span><button className="btn" onClick={onClose}>닫기</button></div>
      <div className="p-2">
        {!d ? <div className="text-fg-3">…</div> : d.available ? <>
          {/* eslint-disable-next-line @next/next/no-img-element -- 외부 최적화 없이 서버 영상 그대로 */}
          <img src={`${d.image_url}?t=${tick}`} alt="기상청 레이더 합성 영상" className="w-full border border-line" />
          <div className="mt-1 flex justify-between text-fg-2"><span className="mono">tm {d.tm_kst} KST · {d.cmp}</span><span className="mono">fetched {fmtTime(d.meta.fetched_at)}</span></div>
          <div className="mt-1 text-fg-3">지도 정합(격자·LCC 투영) 확인 전이라 오버레이하지 않고 영상 그대로 표시합니다.</div>
        </> : <div className="text-warn">사용 불가 — {d.note || "아직 수집되지 않음"}{d.status ? ` (HTTP ${d.status})` : ""}</div>}
        <div className="mt-1 text-fg-3">{d?.attribution ?? "기상청 API허브"}</div>
      </div>
    </div>
  );
}
