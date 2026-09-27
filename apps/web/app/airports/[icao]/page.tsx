"use client";
import { use, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { CAT_COLORS, fmtTime } from "@/lib/format";

interface Wx { airport: { icao: string; name?: string; country?: string; elev_ft?: number; lat: number; lon: number }; latest: Record<string, unknown> | null; history: { obs_time: string; flight_cat?: string; wind_dir?: number; wind_kt?: number; vis_sm?: number; ceiling_ft?: number; temp_c?: number }[] }

export default function AirportPage({ params }: { params: Promise<{ icao: string }> }) {
  const { icao } = use(params);
  const [wx, setWx] = useState<Wx | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { apiGet<Wx>(`/api/v1/airports/${icao.toUpperCase()}/wx`).then(setWx).catch((e) => setErr(e.message)); }, [icao]);
  const m = wx?.latest;
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="label mb-2">Airport weather · {icao.toUpperCase()}</div>
      {err ? <div className="text-bad">{err}</div> : null}
      {wx ? <>
        <div className="mb-3 text-sm font-semibold">{wx.airport.name} <span className="text-fg-3 text-[11px]">({wx.airport.lat?.toFixed(3)}, {wx.airport.lon?.toFixed(3)}) · elev {wx.airport.elev_ft ?? "—"} ft</span></div>
        {m ? <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <section className="panel p-3"><div className="label mb-1">METAR · {fmtTime(String(m.obs_time))} · {String(m.provider)}</div><pre className="mono whitespace-pre-wrap text-[11px]">{String(m.raw)}</pre>
            <div className="mt-2 flex items-center gap-2"><span className="badge" style={{ color: CAT_COLORS[String(m.flight_cat)], borderColor: CAT_COLORS[String(m.flight_cat)] }}>{String(m.flight_cat ?? "—")}</span><span className="text-[10px] text-fg-3">{m.flight_cat_source === "awc" ? "AWC 제공 카테고리" : "실링·시정으로 계산한 카테고리"}</span></div></section>
          <section className="panel p-3"><div className="label mb-1">TAF</div><pre className="mono whitespace-pre-wrap text-[11px]">{String(m.taf_raw ?? "—")}</pre></section>
        </div> : <div className="text-fg-3">METAR 없음</div>}
        <section className="panel mt-3 p-3"><div className="label mb-2">History (latest 24)</div>
          <table><thead><tr><th>obs</th><th>cat</th><th>wind</th><th>vis (sm)</th><th>ceiling</th><th>temp</th></tr></thead>
            <tbody>{wx.history.map((h) => <tr key={h.obs_time}><td className="mono">{fmtTime(h.obs_time)}</td><td style={{ color: CAT_COLORS[h.flight_cat ?? ""] }}>{h.flight_cat ?? "—"}</td><td className="mono">{h.wind_dir ?? "—"}° {h.wind_kt ?? "—"} kt</td><td className="mono">{h.vis_sm ?? "—"}</td><td className="mono">{h.ceiling_ft ?? "—"}</td><td className="mono">{h.temp_c ?? "—"}</td></tr>)}</tbody></table>
        </section>
      </> : null}
    </div>
  );
}
