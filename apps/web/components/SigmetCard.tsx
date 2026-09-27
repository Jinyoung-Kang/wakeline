"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { band, fmtTime, hazardColor } from "@/lib/format";

export function SigmetCard({ id }: { id: string }) {
  const sigmets = useServerData((d) => d.sigmets);
  const f = sigmets?.features.find((x) => x.properties.id === id);
  const [inside, setInside] = useState<string[]>([]);
  const selectSigmet = useUi((s) => s.selectSigmet);
  const select = useUi((s) => s.select);
  useEffect(() => {
    apiGet<{ aircraft_inside: string[] }>(`/api/v1/sigmets/${encodeURIComponent(id)}`).then((x) => setInside(x.aircraft_inside)).catch(() => setInside([]));
  }, [id]);
  if (!f) return <div className="p-3 text-[11px] text-fg-3">경보를 찾을 수 없습니다.</div>;
  const p = f.properties;
  return (
    <div className="flex h-full flex-col" data-testid="sigmet-card">
      <div className="row"><span className="label">SIGMET</span><button className="btn" onClick={() => selectSigmet(null)}>닫기</button></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1 text-[12px]">
        <div className="mb-1 flex items-center gap-2"><span className="inline-block h-2.5 w-2.5" style={{ background: hazardColor(p.hazard) }} /><span className="font-semibold">{p.hazard}{p.qualifier ? ` ${p.qualifier}` : ""}</span><span className="text-fg-3">{p.fir_id} {p.series_id}</span></div>
        {[["FIR", p.fir_name ?? p.fir_id], ["고도대", band(p.base_ft, p.top_ft)], ["유효", `${fmtTime(p.valid_from)} – ${fmtTime(p.valid_to)}`],
          ["이동", `${p.move_dir ?? "—"} ${p.move_spd ?? ""}`], ["변화", p.chng ?? "—"], ["출처", `${p.provider} · ${fmtTime(p.fetched_at)}`],
          ["판정", p.excluded_reason ? `제외 (${p.excluded_reason})` : "폴리곤·고도대·유효시간 검사"]].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="text-fg-3">{k}</span><span className="text-right">{v}</span></div>
        ))}
        <div className="mt-2 label">Aircraft inside ({inside.length})</div>
        <div className="flex flex-wrap gap-1 py-1">{inside.map((h) => <button key={h} className="btn mono" onClick={() => select(h)}>{h}</button>)}</div>
        <div className="mt-2 label">Raw</div>
        <pre className="mono whitespace-pre-wrap border border-line bg-bg p-2 text-[10px] text-fg-2">{p.raw_text}</pre>
      </div>
    </div>
  );
}
