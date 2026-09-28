"use client";
import { useServerData } from "@/lib/store";
import { useServerNow } from "@/lib/clock";
import { fmtIso, fmtTime, isKrRadarStale, KR_RADAR_STALE_S, legendTextColor } from "@/lib/format";

/**
 * 기상청 레이더 합성(FR-31) 범례·정합 정보. 좌표 정의는 서버가 문서 값(LCC 30/60·N38 E126·기준 격자점)으로 계산한다.
 * 수집이 15분 넘게 멈추면(서버 meta.stale 또는 수집 경과) 최신 tm 옆에 STALE(REL-19) — 3 h 프레임 보관 동안 현재처럼 보이지 않게.
 */
export function KrRadarPanel({ onClose }: { onClose: () => void }) {
  const d = useServerData((s) => s.radarKr);
  const now = useServerNow(30_000);
  const stale = d?.available ? isKrRadarStale(d, now) : false;
  const latest = d?.frames[d.frames.length - 1];
  return (
    <div className="panel absolute bottom-full left-3 z-10 mb-3 w-[380px] max-w-[calc(100vw-1.5rem)] text-[11px]" data-testid="kr-radar-panel">
      <div className="row"><span className="label">기상청 레이더 합성(HSR) · 범례·정합</span><button className="btn" onClick={onClose}>닫기</button></div>
      <div className="p-2">
        {!d ? <div className="text-fg-3">…</div> : d.available ? <>
          <div className="flex flex-wrap gap-1">
            {(d.legend ?? []).map(([lo, c]) => <span key={lo} className="mono px-1" style={{ background: `rgb(${c[0]},${c[1]},${c[2]})`, color: legendTextColor(c) }}>{lo}</span>)}
            <span className="text-fg-3">dBZ 이상 (표시 최소 {d.min_dbz} dBZ · 색 구간은 표시용 선택)</span>
          </div>
          {([["최신 tm(KST)", <>{d.latest_tm ?? "—"}{stale ? <span className="badge bad ml-1" data-testid="kr-panel-stale" title={`마지막 수집 ${fmtIso(d.meta?.fetched_at)} — ${KR_RADAR_STALE_S / 60}분 넘게 갱신 없음`}>STALE</span> : null}</>],
            ["수신", fmtTime(latest?.fetched_at)], ["에코 셀", latest ? latest.echo_cells.toLocaleString() : "—"],
            ["격자", d.grid ? `${d.grid.nx}×${d.grid.ny} · ${d.grid.res_m} m · 기준점 (${d.grid.ref.join(", ")})` : "—"],
            ["투영", d.projection ?? "—"], ["레이더", d.stations ?? "—"]] as [string, React.ReactNode][]).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-t border-line py-0.5"><span className="text-fg-3 shrink-0">{k}</span><span className="mono break-all text-right">{v}</span></div>
          ))}
          <div className="mt-1 text-fg-3">관측 반경 안은 연한 회색, 밖은 투명. LCC 격자를 서버에서 웹 메르카토르로 최근접 재투영한 영상(≤ 250 m 격자 관습 오차).</div>
        </> : <div className="text-warn">사용 불가 — {d.note || "아직 수집되지 않음"}{d.status ? ` (HTTP ${d.status})` : ""}</div>}
        <div className="mt-1 text-fg-3">{d?.attribution ?? "기상청 API허브"}</div>
      </div>
    </div>
  );
}
