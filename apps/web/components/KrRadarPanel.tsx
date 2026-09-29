"use client";
import { useServerData } from "@/lib/store";
import { useServerNow } from "@/lib/clock";
import { fmtKstTitle, fmtTimeKstLabel, fmtUtcTitle, isKrRadarStale, KR_RADAR_STALE_S, legendTextColor } from "@/lib/format";
import { KR_REF_WINDOW_MIN, krComposite, krPartialSummary } from "@/lib/kr-radar";

/**
 * 기상청 레이더 합성(FR-31) 범례·정합 정보. 좌표 정의는 서버가 문서 값(LCC 30/60·N38 E126·기준 격자점)으로 계산한다.
 * 시각은 한국 표준시(tm 은 기상청이 준 KST 그대로 — 원본이 KST, 수신 시각은 " KST" · 마우스를 올리면 원본 UTC).
 * 수집이 15분 넘게 멈추면(서버 meta.stale 또는 수집 경과) 최신 tm 옆에 STALE(REL-19) — 3 h 프레임 보관 동안 현재처럼 보이지 않게.
 * 합성 크기(ADR-021): 최신 프레임의 "합성 N/M곳"(헤더의 레이더 지점 수 / 기준), 부분 합성이면 경고 표시와 문장을 화면에(툴팁만이 아니라),
 * 보관 중인 프레임의 부분 합성 수, 지점 코드. 모르면 "—".
 */
export function KrRadarPanel({ onClose }: { onClose: () => void }) {
  const d = useServerData((s) => s.radarKr);
  const now = useServerNow(30_000);
  const stale = d?.available ? isKrRadarStale(d, now) : false;
  const latest = d?.frames[d.frames.length - 1];
  const comp = krComposite(latest, now);
  const ids = Array.isArray(latest?.station_ids) ? latest.station_ids : [];
  return (
    <div className="panel absolute bottom-full left-3 z-10 mb-3 w-[380px] max-w-[calc(100vw-1.5rem)] text-[11px]" data-testid="kr-radar-panel">
      <div className="row"><span className="label">기상청 레이더 합성(HSR) · 범례·정합</span><button className="btn" onClick={onClose}>닫기</button></div>
      <div className="p-2">
        {!d ? <div className="text-fg-3">…</div> : d.available ? <>
          <div className="flex flex-wrap gap-1">
            {(d.legend ?? []).map(([lo, c]) => <span key={lo} className="mono px-1" style={{ background: `rgb(${c[0]},${c[1]},${c[2]})`, color: legendTextColor(c) }}>{lo}</span>)}
            <span className="text-fg-3">dBZ 이상 (표시 최소 {d.min_dbz} dBZ · 색 구간은 표시용 선택)</span>
          </div>
          {([["최신 tm(KST)", <>{d.latest_tm ?? "—"}{stale ? <span className="badge bad ml-1" data-testid="kr-panel-stale" title={`마지막 수집 ${fmtKstTitle(d.meta?.fetched_at)} — ${KR_RADAR_STALE_S / 60}분 넘게 갱신 없음`}>STALE</span> : null}</>],
            ["수신", <span key="rx" title={fmtUtcTitle(latest?.fetched_at)}>{fmtTimeKstLabel(latest?.fetched_at)}</span>], ["에코 셀", latest ? latest.echo_cells.toLocaleString() : "—"],
            ["격자", d.grid ? `${d.grid.nx}×${d.grid.ny} · ${d.grid.res_m} m · 기준점 (${d.grid.ref.join(", ")})` : "—"],
            ["합성(최신)", <span key="cmp" title={comp.title} data-testid="kr-panel-composite" className={comp.warn ? "text-warn" : undefined}>{comp.label}{comp.warn
              ? <span className="badge warn ml-1" data-testid="kr-panel-partial" title={comp.warn}>일부 합성</span> : null}</span>],
            ["부분 합성 프레임", <span key="pf" title="보관 중인 프레임 중 부분 합성 수 / 판정이 있는 프레임 수(모름 = 지점 수를 기록하지 않은 옛 프레임)">{krPartialSummary(d.frames)}</span>],
            ["투영", d.projection ?? "—"], ["레이더", ids.length ? ids.join(", ") : "—"]] as [string, React.ReactNode][]).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-t border-line py-0.5"><span className="text-fg-3 shrink-0">{k}</span><span className="mono break-all text-right">{v}</span></div>
          ))}
          {comp.warn ? <div className="mt-1 text-warn" data-testid="kr-panel-partial-note">{comp.warn}</div> : null}
          <div className="mt-1 text-fg-3">합성 N/M곳 = 그 프레임 헤더의 레이더 지점 수 / 기준(지난 {KR_REF_WINDOW_MIN}분 저장 프레임 중 최대 — 수집기 선택값). 기상청은 합성을 일찍 올리고 지점이 보고하는 대로 채운다 — 부분 합성 프레임은 실자료라 그대로 보이고, 수집기가 기한까지 다시 받아 지점이 늘면 바꾼다.</div>
          <div className="mt-1 text-fg-3">관측 반경 안은 연한 회색, 밖은 투명. LCC 격자를 서버에서 웹 메르카토르로 최근접 재투영한 영상(≤ 250 m 격자 관습 오차).</div>
        </> : <div className="text-warn">사용 불가 — {d.note || "아직 수집되지 않음"}{d.status ? ` (HTTP ${d.status})` : ""}</div>}
        <div className="mt-1 text-fg-3">{d?.attribution ?? "기상청 API허브"}</div>
      </div>
    </div>
  );
}
