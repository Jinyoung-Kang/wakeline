"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { useUi } from "@/lib/ui-store";
import { useNow } from "@/lib/clock";
import { serverNowMs } from "@/lib/store";
import { CAT_COLORS, catSourceLabel, ceilingLabel, fmtDuration, fmtTimeKstLabel, fmtVisSm, isMetarStale, metarAgeS } from "@/lib/format";
import { ErrorNote } from "./logs/ErrorNote";

interface Wx {
  airport: { icao: string; name?: string; country?: string; elev_ft?: number };
  latest: {
    obs_time: string; raw: string; temp_c?: number; dewp_c?: number; wind_dir?: number; wind_kt?: number; vis_sm?: number; vis_raw?: string;
    ceiling_ft?: number; ceiling_state?: "measured" | "none" | "unknown" | null; flight_cat?: string | null; flight_cat_source?: string | null;
    obs_age_s?: number | null; stale?: boolean | null; wx_string?: string; taf_raw?: string; provider: string; fetched_at: string;
  } | null;
  history: { obs_time: string; flight_cat?: string }[];
}

/**
 * 공항 기상 카드(FR-22). 실링은 ceiling_state 로 "실링 없음"(구름 자료 있음·실링층 없음)과 "—"(모름)을 구분한다(GAP-16).
 * METAR 가 2 시간보다 오래되면 "오래됨" — 지도에서도 회색 고리로 그린다(GAP-14).
 * 관측·수신 시각은 한국 표준시(" KST") — METAR · TAF 원문은 발표된 그대로(안의 "…Z" 는 UTC).
 * 시정은 AWC 원문 값(vis_raw, 법정마일)에 단위 SM 을 붙이고 "6+" 는 "6 SM 이상"(DH-7) — km 로 읽히지 않게.
 */
export function AirportCard({ icao }: { icao: string }) {
  const [wx, setWx] = useState<Wx | null>(null);
  /** 마지막 오류 — ApiError 면 요청 id 까지(계약 v5 §C8) */
  const [err, setErr] = useState<unknown>(null);
  const selectAirport = useUi((s) => s.selectAirport);
  const now = useNow(30_000);
  useEffect(() => {
    let live = true;
    apiGet<Wx>(`/api/v1/airports/${encodeURIComponent(icao)}/wx`).then((x) => { if (live) { setWx(x); setErr(null); } }).catch((e: unknown) => { if (live) setErr(e); });
    return () => { live = false; };
  }, [icao]);
  const w = wx && wx.airport.icao === icao ? wx : null;
  const m = w?.latest;
  const nowMs = now ? serverNowMs(now) : 0;
  const age = m && nowMs ? metarAgeS(m, nowMs) : null;
  const stale = m && nowMs ? isMetarStale(m, nowMs) : false;
  const catColor = m?.flight_cat && !stale ? CAT_COLORS[m.flight_cat] : undefined;
  return (
    <div className="flex h-full flex-col" data-testid="airport-card">
      <div className="row"><span className="label">Airport · {icao}</span><div className="flex gap-1"><Link href={`/airports/${icao}`} className="btn">이력</Link><button className="btn" onClick={() => selectAirport(null)}>닫기</button></div></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1 text-[12px]">
        {err ? <div className="text-bad"><ErrorNote error={err} /></div> : null}
        {w ? <>
          <div className="font-semibold">{w.airport.name ?? icao}</div>
          {m ? <>
            <div className="my-1 flex flex-wrap items-center gap-2">
              <span className="badge" style={{ borderColor: catColor, color: catColor }}>{m.flight_cat ?? "—"}</span>
              <span className="text-[10px] text-fg-3">{catSourceLabel(m.flight_cat_source, m.flight_cat)}</span>
              {stale ? <span className="badge warn" data-testid="metar-stale" title="관측 후 2시간 초과 — 현재 기상으로 보지 마세요">오래됨</span> : null}
            </div>
            {([
              ["관측", `${fmtTimeKstLabel(m.obs_time)}${age != null ? ` · ${fmtDuration(age)} 전` : ""}`],
              ["바람", m.wind_dir != null ? `${m.wind_dir}° ${m.wind_kt ?? "—"} kt` : m.wind_kt != null ? `— ${m.wind_kt} kt` : "—"],
              ["시정", fmtVisSm(m.vis_raw)],
              ["실링", ceilingLabel(m.ceiling_state, m.ceiling_ft)],
              ["기온/이슬점", `${m.temp_c ?? "—"} / ${m.dewp_c ?? "—"} °C`],
              ["현상", m.wx_string ?? "—"],
              ["출처", `${m.provider ?? "—"} · 수신 ${fmtTimeKstLabel(m.fetched_at)}`],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="text-fg-3">{k}</span><span className="mono text-right" data-testid={k === "실링" ? "airport-ceiling" : undefined}>{v}</span></div>
            ))}
            <div className="mt-2 label" title="발표된 원문 그대로 — 안의 시각(…Z)은 UTC">METAR (원문 · UTC)</div>
            <pre className="mono whitespace-pre-wrap border border-line bg-bg p-2 text-[10px]">{m.raw}</pre>
            <div className="mt-2 label" title="발표된 원문 그대로 — 안의 시각(…Z)은 UTC">TAF (원문 · UTC)</div>
            <pre className="mono whitespace-pre-wrap border border-line bg-bg p-2 text-[10px]">{m.taf_raw ?? "—"}</pre>
          </> : <div className="text-fg-3">METAR 없음</div>}
        </> : null}
      </div>
    </div>
  );
}
