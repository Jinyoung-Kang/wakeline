"use client";
import { useState } from "react";
import type { ReplayPick } from "./ReplayMap";
import type { ReplayFrame } from "@/lib/replay";

const MAX_AIRCRAFT = 200;

/** 재생 목록(R-40): 그 시각 프레임의 SIGMET·항공기를 버튼으로 — 지도 클릭 없이 상세(inspector)를 연다. */
export function ReplayList({ frame, onPick }: { frame: ReplayFrame | null; onPick: (p: ReplayPick) => void }) {
  const [q, setQ] = useState("");
  return (
    <div className="flex max-h-full flex-col">
      <div className="row">
        <input value={q} onChange={(e) => setQ(e.target.value.slice(0, 16))} placeholder="호출부호·hex" aria-label="재생 항공기 거르기(호출부호 또는 hex)" className="w-full" />
      </div>
      <ReplayListView frame={frame} q={q} onPick={onPick} />
    </div>
  );
}

/** 표시 부분(거르기 문자열을 인자로 — 서버 렌더 시험용) */
export function ReplayListView({ frame, q, onPick }: { frame: ReplayFrame | null; q: string; onPick: (p: ReplayPick) => void }) {
  if (!frame) return <div className="px-2 py-2 text-[11px] text-fg-3">프레임 없음</div>;
  const needle = q.trim().toLowerCase();
  const ac = frame.aircraft
    .filter((a) => !needle || a.hex.toLowerCase().includes(needle) || (a.callsign ?? "").toLowerCase().includes(needle))
    .sort((a, b) => (a.callsign ?? "~" + a.hex).localeCompare(b.callsign ?? "~" + b.hex));
  return (
    <div className="min-h-0 overflow-y-auto text-[12px]">
      <div className="label px-2 pt-1">SIGMET {frame.sigmets.length}</div>
      <ul>
        {frame.sigmets.map((s) => (
          <li key={s.id}><button className="flex w-full gap-2 px-2 py-0.5 text-left hover:bg-bg-2" data-testid="replay-list-sigmet" onClick={() => onPick({ kind: "sigmet", id: s.id })}>
            <span>{s.hazard}{s.qualifier ? ` ${s.qualifier}` : ""}</span><span className="mono text-fg-3">{s.fir_id}</span>
          </button></li>
        ))}
      </ul>
      <div className="label px-2 pt-2">Aircraft {ac.length}{needle ? ` / ${frame.aircraft.length}` : ""}</div>
      <ul>
        {ac.slice(0, MAX_AIRCRAFT).map((a) => (
          <li key={a.hex}><button className="flex w-full gap-2 px-2 py-0.5 text-left hover:bg-bg-2" data-testid="replay-list-aircraft" onClick={() => onPick({ kind: "aircraft", hex: a.hex })}>
            {/* 호출부호가 기록에 없으면 비운다(hex 로 채우지 않는다) */}
            <span className="mono w-20 shrink-0">{a.callsign ?? "—"}</span><span className="mono text-fg-3">{a.hex}</span>
          </button></li>
        ))}
        {ac.length > MAX_AIRCRAFT ? <li className="px-2 py-1 text-[11px] text-fg-3">외 {ac.length - MAX_AIRCRAFT}대 — 호출부호·hex 로 거르세요</li> : null}
      </ul>
    </div>
  );
}
