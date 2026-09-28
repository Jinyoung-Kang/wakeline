"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { aircraftStates, useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { useServerNow } from "@/lib/clock";
import { band, fmtAltDual, fmtAltGndDual, fmtDuration, fmtTime, hazardColor } from "@/lib/format";
import { isExpired, isPending, sigmetBandSource } from "@/lib/sigmet";
import { aircraftPos, panIfOutside } from "@/lib/focus";
import { AltStack } from "./UnitStack";

/**
 * SIGMET 상세: 고도대는 발표값·가정·원문 출처를 구분해 표시(하한 미발표(SFC 가정) / 상한 미발표(무제한 가정)). 값이 없으면 "—".
 * 발효 전(valid_from > 지금)이면 "발효 전"과 남은 시간 — 엔진은 발효 전 경보로 판정하지 않는다(DH-8).
 */
export function SigmetCard({ id }: { id: string }) {
  const f = useServerData((d) => d.sigmets?.features.find((x) => x.properties.id === id) ?? null);
  const [inside, setInside] = useState<{ id: string; hexes: string[] | null } | null>(null);
  const selectSigmet = useUi((s) => s.selectSigmet);
  const now = useServerNow(30_000);
  useEffect(() => {
    let live = true;
    apiGet<{ aircraft_inside?: string[] }>(`/api/v1/sigmets/${encodeURIComponent(id)}`)
      .then((x) => { if (live) setInside({ id, hexes: Array.isArray(x.aircraft_inside) ? x.aircraft_inside : null }); })
      .catch(() => { if (live) setInside({ id, hexes: null }); }); // 모름 — 0 대로 단정하지 않는다
    return () => { live = false; };
  }, [id]);
  if (!f) return <div className="p-3 text-[11px] text-fg-3">경보를 찾을 수 없습니다(만료되었거나 목록에서 빠짐).</div>;
  const p = f.properties;
  const hexes = inside && inside.id === id ? inside.hexes : null;
  const expired = now ? isExpired(p, now) : false;
  const pending = now ? isPending(p, now) : false;
  const startsIn = pending ? (Date.parse(p.valid_from) - now) / 1000 : null;
  const rows: [string, React.ReactNode][] = [
    ["FIR", p.fir_name ?? p.fir_id ?? "—"],
    ["고도대", band(p.base_ft, p.top_ft, sigmetBandSource(p))],
    ["유효", <span key="v" className="mono">{fmtTime(p.valid_from)} – {fmtTime(p.valid_to)}</span>],
    ["이동", p.move_dir || p.move_spd ? `${p.move_dir ?? "—"}${p.move_spd ? ` ${p.move_spd}` : ""}` : "—"],
    ["변화", p.chng ?? "—"],
    ["출처", <span key="s">{p.provider ?? "—"} · <span className="mono">{fmtTime(p.fetched_at)}</span></span>],
    ["판정", p.excluded_reason ? `제외 (${p.excluded_reason})` : pending ? "발효 전 — 발효 시각부터 폴리곤·고도대 검사" : "폴리곤·고도대·유효시간 검사"],
  ];
  return (
    <div className="flex h-full flex-col" data-testid="sigmet-card">
      <div className="row"><span className="label">SIGMET</span><button className="btn" onClick={() => selectSigmet(null)}>닫기</button></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1 text-[12px]">
        <div className="mb-1 flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5" style={{ background: hazardColor(p.hazard) }} />
          <span className="font-semibold">{p.hazard}{p.qualifier ? ` ${p.qualifier}` : ""}</span>
          <span className="mono text-fg-3">{p.fir_id} {p.series_id}</span>
          {expired ? <span className="badge warn" data-testid="sigmet-expired">만료됨</span> : null}
          {pending ? <span className="badge" data-testid="sigmet-pending" title={`발효 ${fmtTime(p.valid_from)}`}>발효 전 · {fmtDuration(startsIn)} 뒤</span> : null}
        </div>
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="text-fg-3">{k}</span><span className="text-right">{v}</span></div>
        ))}
        <div className="mt-2 label">Aircraft inside ({hexes == null ? "—" : hexes.length})</div>
        {hexes ? <InsideAircraftList sigmetId={id} hexes={hexes} /> : null}
        <div className="mt-2 label">Raw</div>
        <pre className="mono whitespace-pre-wrap border border-line bg-bg p-2 text-[10px] text-fg-2">{p.raw_text}</pre>
      </div>
    </div>
  );
}

/**
 * SIGMET 안 항공기(R-59): 서버가 준 hex 마다 이 SIGMET 의 관측 알림(콜사인·관측 고도) → 없으면 실시간 항공기 사본 → 없으면 "—".
 * 다른 SIGMET 알림의 값이나 예측(추정) 고도는 쓰지 않는다. hex 는 소문자 그대로. 누르면 선택(집중 추적 시작)하고 화면 밖이면 지도를 옮긴다.
 */
export function InsideAircraftList({ sigmetId, hexes }: { sigmetId: string; hexes: string[] }) {
  const alerts = useServerData((d) => d.alerts);
  const select = useUi((s) => s.select);
  const byHex = new Map([...alerts.values()].filter((a) => a.sigmet_id === sigmetId && a.kind === "OBSERVED").map((a) => [a.hex, a]));
  return (
    <ul className="py-1 text-[12px]" data-testid="sigmet-inside">
      {hexes.map((h) => {
        const a = byHex.get(h);
        const st = aircraftStates.get(h);
        const callsign = a?.callsign ?? st?.callsign ?? null;
        const alt = a ? fmtAltDual(a.alt_ft) : st ? fmtAltGndDual(st.alt_ft, st.on_ground) : "—";
        const src = a ? "관측 알림" : st ? "실시간" : null;
        return (
          <li key={h} className="border-b border-line">
            <button className="btn flex w-full items-center gap-2 border-0 bg-transparent px-1 py-0.5 text-left normal-case!" data-hex={h}
              title="선택하면 집중 추적(외부 공급자 조회)이 시작됩니다"
              aria-label={`${callsign ?? "호출부호 모름"}, ${h}, 고도 ${alt}${src ? `, ${src}` : ""}`}
              onClick={() => { select(h); panIfOutside(aircraftPos(h, a)); }}>
              <span className="mono w-20 shrink-0">{callsign ?? "—"}</span>
              <span className="mono w-16 shrink-0 text-fg-3">{h}</span>
              <span className="w-24 shrink-0">{a ? <AltStack ft={a.alt_ft} align="start" /> : st ? <AltStack ft={st.alt_ft} onGround={st.on_ground} align="start" /> : <span className="mono">—</span>}</span>
              <span className="text-[10px] text-fg-3">{src ?? ""}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
