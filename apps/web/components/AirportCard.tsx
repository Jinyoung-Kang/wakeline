"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { useUi } from "@/lib/ui-store";
import { CAT_COLORS, fmtTime } from "@/lib/format";

interface Wx {
  airport: { icao: string; name?: string; country?: string; elev_ft?: number };
  latest: { obs_time: string; raw: string; temp_c?: number; dewp_c?: number; wind_dir?: number; wind_kt?: number; vis_sm?: number; vis_raw?: string; ceiling_ft?: number; flight_cat?: string; flight_cat_source?: string; wx_string?: string; taf_raw?: string; provider: string; fetched_at: string } | null;
  history: { obs_time: string; flight_cat?: string }[];
}

export function AirportCard({ icao }: { icao: string }) {
  const [wx, setWx] = useState<Wx | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const selectAirport = useUi((s) => s.selectAirport);
  useEffect(() => { apiGet<Wx>(`/api/v1/airports/${icao}/wx`).then(setWx).catch((e) => setErr(e.message)); }, [icao]);
  const m = wx?.latest;
  return (
    <div className="flex h-full flex-col" data-testid="airport-card">
      <div className="row"><span className="label">Airport · {icao}</span><div className="flex gap-1"><Link href={`/airports/${icao}`} className="btn">이력</Link><button className="btn" onClick={() => selectAirport(null)}>닫기</button></div></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1 text-[12px]">
        {err ? <div className="text-bad">{err}</div> : null}
        {wx ? <>
          <div className="font-semibold">{wx.airport.name ?? icao}</div>
          {m ? <>
            <div className="my-1 flex items-center gap-2">
              <span className="badge" style={{ borderColor: CAT_COLORS[m.flight_cat ?? ""] ?? undefined, color: CAT_COLORS[m.flight_cat ?? ""] ?? undefined }}>{m.flight_cat ?? "—"}</span>
              <span className="text-[10px] text-fg-3">{m.flight_cat_source === "awc" ? "카테고리: AWC 제공" : "카테고리: 실링·시정으로 계산"}</span>
            </div>
            {[["관측", fmtTime(m.obs_time)], ["바람", m.wind_dir != null ? `${m.wind_dir}° ${m.wind_kt ?? "—"} kt` : "—"], ["시정", m.vis_raw ?? "—"], ["실링", m.ceiling_ft != null ? `${m.ceiling_ft} ft` : "없음"],
              ["기온/이슬점", `${m.temp_c ?? "—"} / ${m.dewp_c ?? "—"} °C`], ["현상", m.wx_string ?? "—"], ["출처", `${m.provider} · ${fmtTime(m.fetched_at)}`]].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="text-fg-3">{k}</span><span className="text-right">{v}</span></div>
            ))}
            <div className="mt-2 label">METAR</div>
            <pre className="mono whitespace-pre-wrap border border-line bg-bg p-2 text-[10px]">{m.raw}</pre>
            <div className="mt-2 label">TAF</div>
            <pre className="mono whitespace-pre-wrap border border-line bg-bg p-2 text-[10px]">{m.taf_raw ?? "—"}</pre>
          </> : <div className="text-fg-3">METAR 없음</div>}
        </> : null}
      </div>
    </div>
  );
}
