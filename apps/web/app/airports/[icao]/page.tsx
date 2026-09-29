"use client";
import { use, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { useNow } from "@/lib/clock";
import { serverNowMs } from "@/lib/store";
import { airportErrorText, CAT_COLORS, catSourceLabel, ceilingLabel, fmtDuration, fmtTimeKst, fmtTimeKstLabel, fmtUtcTitle, isMetarStale, metarAgeS } from "@/lib/format";
import { RequestIdOf } from "@/components/logs/ErrorNote";

interface Latest {
  obs_time: string; raw: string; provider?: string; flight_cat?: string | null; flight_cat_source?: string | null; taf_raw?: string | null;
  ceiling_ft?: number | null; ceiling_state?: string | null; vis_raw?: string | null; obs_age_s?: number | null; stale?: boolean | null;
}
interface Wx {
  airport: { icao: string; name?: string; country?: string; elev_ft?: number; lat: number; lon: number };
  latest: Latest | null;
  history: { obs_time: string; flight_cat?: string | null; wind_dir?: number | null; wind_kt?: number | null; vis_sm?: number | null; vis_raw?: string | null; ceiling_ft?: number | null; temp_c?: number | null }[];
}

/** 원문 칸의 설명 — 발표된 글자 그대로, 화면의 KST 로 바꾸지 않는다 */
const RAW_TITLE = "발표된 원문 그대로(바꾸지 않음) — 안의 시각(…Z)은 UTC, 화면의 다른 시각은 KST";

/**
 * 공항 기상 이력(FR-22). 시각은 날짜 포함 한국 표준시(KST — 사용자 요청 2026-09-29, title 에 원본 UTC). METAR · TAF 원문은 발표된 그대로(안의 "…Z" 는 UTC).
 * 시정은 원문(vis_raw, 예 "6+")을 우선 — 파싱한 숫자(6)는 "6 이상"을 잃는다.
 * 조회 실패는 한국어 안내 + 요청 id(복사 — 계약 v5 §C8).
 */
export default function AirportPage({ params }: { params: Promise<{ icao: string }> }) {
  const { icao } = use(params);
  const code = icao.toUpperCase();
  const [wx, setWx] = useState<Wx | null>(null);
  const [err, setErr] = useState<{ text: string; error: unknown } | null>(null);
  const now = useNow(30_000);
  useEffect(() => { apiGet<Wx>(`/api/v1/airports/${encodeURIComponent(code)}/wx`).then(setWx).catch((e: unknown) => setErr({ text: airportErrorText(e, code), error: e })); }, [code]);
  const m = wx?.latest;
  const nowMs = now ? serverNowMs(now) : 0;
  const age = m && nowMs ? metarAgeS(m, nowMs) : null;
  const stale = m && nowMs ? isMetarStale(m, nowMs) : false;
  const catColor = m?.flight_cat && !stale ? CAT_COLORS[m.flight_cat] : undefined;
  return (
    <div className="h-full overflow-y-auto p-4">
      <h1 className="label mb-2">Airport weather · {code}</h1>
      {err ? <div className="text-bad" role="alert">{err.text}<RequestIdOf error={err.error} /></div> : null}
      {wx ? <>
        <div className="mb-3 text-sm font-semibold">{wx.airport.name ?? code} <span className="mono text-[11px] text-fg-3">({wx.airport.lat?.toFixed(3) ?? "—"}, {wx.airport.lon?.toFixed(3) ?? "—"}) · elev {wx.airport.elev_ft ?? "—"} ft</span></div>
        {m ? <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <section className="panel p-3">
            <div className="label mb-1">METAR · <span className="mono" title={fmtUtcTitle(m.obs_time)}>{fmtTimeKstLabel(m.obs_time)}</span>{age != null ? ` · ${fmtDuration(age)} 전` : ""} · {m.provider ?? "—"}</div>
            <pre className="mono whitespace-pre-wrap text-[11px]" title={RAW_TITLE}>{m.raw}</pre>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="badge" style={{ color: catColor, borderColor: catColor }}>{m.flight_cat ?? "—"}</span>
              <span className="text-[10px] text-fg-3">{catSourceLabel(m.flight_cat_source, m.flight_cat)}</span>
              <span className="text-[10px] text-fg-3">· 실링 <span className="mono text-fg-2">{ceilingLabel(m.ceiling_state, m.ceiling_ft)}</span></span>
              {stale ? <span className="badge warn">오래됨 · 2시간 초과</span> : null}
            </div>
          </section>
          <section className="panel p-3"><div className="label mb-1" title={RAW_TITLE}>TAF (원문 · UTC)</div><pre className="mono whitespace-pre-wrap text-[11px]" title={RAW_TITLE}>{m.taf_raw ?? "—"}</pre></section>
        </div> : <div className="text-fg-3">METAR 없음</div>}
        <section className="panel mt-3 p-3"><div className="label mb-2">History (latest 24)</div>
          <table><thead><tr><th scope="col" title="관측 시각 — 한국 표준시(칸에 마우스를 올리면 원본 UTC)">obs (KST)</th><th scope="col">cat</th><th scope="col">wind</th><th scope="col">vis (sm)</th><th scope="col">ceiling (ft)</th><th scope="col">temp (°C)</th></tr></thead>
            <tbody>{wx.history.map((h) => <tr key={h.obs_time}>
              <td className="mono whitespace-nowrap" title={fmtUtcTitle(h.obs_time)}>{fmtTimeKst(h.obs_time)}</td>
              <td style={{ color: h.flight_cat ? CAT_COLORS[h.flight_cat] : undefined }}>{h.flight_cat ?? "—"}</td>
              <td className="mono">{h.wind_dir ?? "—"}° {h.wind_kt ?? "—"} kt</td>
              <td className="mono">{h.vis_raw ?? (h.vis_sm != null ? <span title="원문(vis_raw) 없음 — 파싱한 숫자라 “6+” 같은 하한 표기를 잃었을 수 있음">{h.vis_sm}*</span> : "—")}</td>
              <td className="mono">{h.ceiling_ft ?? "—"}</td>
              <td className="mono">{h.temp_c ?? "—"}</td>
            </tr>)}</tbody></table>
          <div className="mt-1 text-[10px] text-fg-3">실링 “—” = 값 없음(실링층 없음 또는 높이 모름 — 이력 행에서는 구분하지 않음). 시정은 AWC 원문(법정마일, “6+” = 6 SM 이상).
            {wx.history.some((h) => h.vis_raw == null && h.vis_sm != null) ? " * = 원문 없이 파싱한 숫자(하한 표기 “+” 를 잃었을 수 있음)." : ""}</div>
        </section>
      </> : null}
    </div>
  );
}
