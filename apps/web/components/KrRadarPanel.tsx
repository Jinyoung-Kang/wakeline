"use client";
import { useServerData } from "@/lib/store";
import { fmtTime } from "@/lib/format";

/** 기상청 레이더 합성(FR-31) 범례·정합 정보. 좌표 정의는 서버가 문서 값(LCC 30/60·N38 E126·기준 격자점)으로 계산한다. */
export function KrRadarPanel({ onClose }: { onClose: () => void }) {
  const d = useServerData((s) => s.radarKr);
  const latest = d?.frames[d.frames.length - 1];
  return (
    <div className="panel absolute bottom-12 left-3 z-10 w-[380px] text-[11px]" data-testid="kr-radar-panel">
      <div className="row"><span className="label">기상청 레이더 합성(HSR) · 범례·정합</span><button className="btn" onClick={onClose}>닫기</button></div>
      <div className="p-2">
        {!d ? <div className="text-fg-3">…</div> : d.available ? <>
          <div className="flex flex-wrap gap-1">
            {(d.legend ?? []).map(([lo, c]) => <span key={lo} className="mono px-1" style={{ background: `rgb(${c[0]},${c[1]},${c[2]})`, color: "#000" }}>{lo}</span>)}
            <span className="text-fg-3">dBZ 이상 (표시 최소 {d.min_dbz} dBZ · 색 구간은 표시용 선택)</span>
          </div>
          {[["최신 tm(KST)", d.latest_tm ?? "—"], ["수신", fmtTime(latest?.fetched_at)], ["에코 셀", latest ? latest.echo_cells.toLocaleString() : "—"],
            ["격자", d.grid ? `${d.grid.nx}×${d.grid.ny} · ${d.grid.res_m} m · 기준점 (${d.grid.ref.join(", ")})` : "—"],
            ["투영", d.projection ?? "—"], ["레이더", d.stations ?? "—"]].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-t border-line py-0.5"><span className="text-fg-3 shrink-0">{k}</span><span className="mono break-all text-right">{v}</span></div>
          ))}
          <div className="mt-1 text-fg-3">관측 반경 안은 연한 회색, 밖은 투명. LCC 격자를 서버에서 웹 메르카토르로 최근접 재투영한 영상(≤ 250 m 격자 관습 오차).</div>
        </> : <div className="text-warn">사용 불가 — {d.note || "아직 수집되지 않음"}{d.status ? ` (HTTP ${d.status})` : ""}</div>}
        <div className="mt-1 text-fg-3">{d?.attribution ?? "기상청 API허브"}</div>
      </div>
    </div>
  );
}
