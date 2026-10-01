"use client";
import Link from "next/link";
import { airportWx } from "@/lib/endpoints/weather";
import { useApiResource } from "@/lib/use-api-resource";
import { isRefusedSegment } from "@/lib/endpoints/path";
import { useUi } from "@/lib/ui-store";
import { useNow } from "@/lib/clock";
import { serverNowMs } from "@/lib/store";
import { CAT_COLORS, catSourceLabel, ceilingLabel, fmtDuration, fmtTempPair, fmtVisSm, fmtWind, isMetarStale, metarAgeS } from "@/lib/format";
import { ErrorNote } from "./logs/ErrorNote";
import { RAW_BULLETIN_LABEL, RAW_BULLETIN_TITLE } from "@/lib/time";
import { KstTime } from "./KstTime";
import { WX_UNREADABLE } from "@/lib/airport-wx";

/**
 * 공항 기상 카드(FR-22). 실링은 ceiling_state 로 "실링 없음"(구름 자료 있음·실링층 없음)과 "—"(모름)을 구분한다(GAP-16).
 * METAR 가 2 시간보다 오래되면 "오래됨" — 지도에서도 회색 고리로 그린다(GAP-14).
 * 관측·수신 시각은 KST 만(계약 v5 §G20 · lib/time, 마우스를 올리면 연도 · ms 까지) — METAR · TAF 원문은 발표된 그대로(data-raw — 안의 "…Z" 는 발표 형식).
 * 시정은 AWC 원문 값(vis_raw, 법정마일)에 단위 SM 을 붙이고 "6+" 는 "6 SM 이상"(DH-7) — km 로 읽히지 않게.
 */
export function AirportCard({ icao }: { icao: string }) {
  // 공항마다의 결과(lib/use-api-resource): 다음 공항을 불러오는 동안 앞 공항의 값 · 오류 · 요청 id 를 보이지 않는다(web-review B5).
  // 본문은 parseWx 로 검사한다(web-review B10) — 읽을 수 없으면 그리지 않고 그렇다고 말한다. 오류는 ApiError 면 요청 id 까지(계약 v5 §C8)
  const wx = useApiResource(icao, (signal) => airportWx(icao, { signal }).then((x) => x ?? Promise.reject(new Error(WX_UNREADABLE))));
  const selectAirport = useUi((s) => s.selectAirport);
  const now = useNow(30_000);
  const w = wx.data && wx.data.airport.icao === icao ? wx.data : null;
  const err = wx.error;
  const m = w?.latest;
  const nowMs = now ? serverNowMs(now) : 0;
  const age = m && nowMs ? metarAgeS(m, nowMs) : null;
  const stale = m && nowMs ? isMetarStale(m, nowMs) : false;
  const catColor = m?.flight_cat && !stale ? CAT_COLORS[m.flight_cat] : undefined;
  return (
    <div className="flex h-full flex-col" data-testid="airport-card">
      <div className="row"><span className="label">Airport · {icao}</span><div className="flex gap-1">{isRefusedSegment(icao) ? null : <Link href={`/airports/${encodeURIComponent(icao)}`} className="btn">이력</Link>}<button className="btn" onClick={() => selectAirport(null)}>닫기</button></div></div>
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
            {/* [이름, 값] — 시각은 <KstTime>(KST, 한 시각은 줄바꿈 없이, title 에 연도 · ms 까지의 KST) */}
            {([
              ["관측", <><KstTime v={m.obs_time} />{age != null ? ` · ${fmtDuration(age)} 전` : ""}</>],
              ["바람", fmtWind(m.wind_dir, m.wind_kt)],
              ["시정", fmtVisSm(m.vis_raw)],
              ["실링", ceilingLabel(m.ceiling_state, m.ceiling_ft)],
              ["기온/이슬점", fmtTempPair(m.temp_c, m.dewp_c)],
              ["현상", m.wx_string ?? "—"],
              ["출처", <>{m.provider ?? "—"} · 수신 <KstTime v={m.fetched_at} /></>],
            ] as [string, React.ReactNode][]).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="shrink-0 text-fg-3">{k}</span><span className="mono text-right" data-testid={k === "실링" ? "airport-ceiling" : undefined}>{v}</span></div>
            ))}
            <div className="mt-2 label" title={RAW_BULLETIN_TITLE}>METAR ({RAW_BULLETIN_LABEL})</div>
            <pre className="mono whitespace-pre-wrap border border-line bg-bg p-2 text-[10px]" data-raw="bulletin">{m.raw}</pre>
            <div className="mt-2 label" title={RAW_BULLETIN_TITLE}>TAF ({RAW_BULLETIN_LABEL})</div>
            <pre className="mono whitespace-pre-wrap border border-line bg-bg p-2 text-[10px]" data-raw="bulletin">{m.taf_raw ?? "—"}</pre>
          </> : <div className="text-fg-3">METAR 없음</div>}
        </> : null}
      </div>
    </div>
  );
}
