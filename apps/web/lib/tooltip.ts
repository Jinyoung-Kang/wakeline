/**
 * 지도 호버 툴팁 내용(GAP-26) — 순수 함수. 항공기(호출부호·고도·속도·수신 경과), SIGMET(유형·고도대·유효), 공항(ICAO·카테고리·METAR 경과).
 * 값은 받은 데이터 그대로, 없으면 "—". DOM 은 textContent 로만 만든다(원문·호출부호 등 외부 문자열을 HTML 로 해석하지 않는다).
 */
import { band, catSourceLabel, ceilingLabel, fmtAlt, fmtDuration, fmtNum, fmtTime, isMetarStale, metarAgeS } from "./format";
import { seenAtMs, thresholds } from "./interpolate";
import { sigmetBandSource, isExpired } from "./sigmet";
import type { AircraftState, SigmetProps } from "./types";

export type Tone = "warn" | "bad" | "est" | "ok" | "muted";
export interface Tip {
  title: string;
  subtitle?: string;
  rows: [string, string][];
  flags: { text: string; tone: Tone }[];
}

/** 지도에 그려진 항공기(렌더 속성) + 메인 스레드의 원본 상태(있으면). 고도·속도는 관측값을 보여 준다. */
export function aircraftTip(
  render: { hex: string; callsign?: string | null; alt_ft?: number | null; stale?: boolean; estimated?: boolean; emergency?: boolean; age_unknown?: boolean },
  state: AircraftState | null | undefined,
  nowMs: number,
): Tip {
  const seen = seenAtMs(state?.seen_at);
  const age = seen == null || !nowMs ? null : Math.max(0, (nowMs - seen) / 1000);
  const provider = state?.provider ?? null;
  const flags: Tip["flags"] = [];
  if (render.emergency) flags.push({ text: `EMERGENCY ${state?.squawk ?? ""}`.trim(), tone: "bad" });
  if (render.stale) flags.push({ text: age != null && age > thresholds(provider).staleAfterS ? "STALE · 수신 지연" : "STALE · 위치 추정 상한", tone: "warn" });
  else if (render.estimated) flags.push({ text: "위치 추정(dead reckoning)", tone: "est" });
  if (age == null) flags.push({ text: "수신 경과 모름", tone: "muted" });
  return {
    title: state?.callsign ?? render.callsign ?? "—",
    subtitle: render.hex,
    rows: [
      ["ALT", fmtAlt(state ? state.alt_ft : render.alt_ft)],
      ["GS", fmtNum(state?.gs_kt, " kt")],
      ["TRK", fmtNum(state?.track_deg, "°")],
      ["AGE", age == null ? "—" : fmtDuration(age)],
      ["SRC", provider ?? "—"],
    ],
    flags,
  };
}

export function sigmetTip(p: SigmetProps, nowMs: number): Tip {
  const flags: Tip["flags"] = [];
  const expired = nowMs ? isExpired(p, nowMs) : false;
  if (expired) flags.push({ text: "만료됨", tone: "warn" });
  else if (p.expiring_soon) flags.push({ text: "30분 내 만료", tone: "warn" });
  if (p.inside) flags.push({ text: "안에 항공기(관측)", tone: "bad" });
  if (p.excluded_reason) flags.push({ text: `판정 제외: ${p.excluded_reason}`, tone: "muted" });
  const left = nowMs ? (Date.parse(p.valid_to) - nowMs) / 1000 : NaN;
  return {
    title: `${p.hazard}${p.qualifier ? ` ${p.qualifier}` : ""}`,
    subtitle: `${p.fir_id ?? "—"} ${p.series_id ?? ""}`.trim(),
    rows: [
      ["BAND", band(p.base_ft, p.top_ft, sigmetBandSource(p))],
      ["VALID", `${fmtTime(p.valid_from)} – ${fmtTime(p.valid_to)}`],
      ["LEFT", Number.isFinite(left) && left > 0 ? fmtDuration(left) : "—"],
    ],
    flags,
  };
}

export interface AirportProps {
  icao: string;
  name?: string | null;
  flight_cat?: string | null;
  flight_cat_source?: string | null;
  obs_time?: string | null;
  obs_age_s?: number | null;
  stale?: boolean | null;
  ceiling_state?: string | null;
  ceiling_ft?: number | null;
}

export function airportTip(p: AirportProps, nowMs: number): Tip {
  const age = metarAgeS(p, nowMs);
  const hasMetar = p.obs_time != null || age != null;
  const stale = hasMetar && isMetarStale(p, nowMs);
  const flags: Tip["flags"] = [];
  if (!hasMetar) flags.push({ text: "METAR 없음", tone: "muted" });
  else if (stale) flags.push({ text: "오래됨 · 2시간 초과", tone: "warn" });
  return {
    title: p.icao,
    subtitle: p.name ?? undefined,
    rows: [
      ["CAT", `${p.flight_cat ?? "—"}${p.flight_cat ? ` · ${catSourceLabel(p.flight_cat_source, p.flight_cat).replace("카테고리: ", "")}` : ""}`],
      ["METAR", hasMetar ? `${fmtTime(p.obs_time)} · ${age == null ? "—" : `${fmtDuration(age)} 전`}` : "—"],
      ["CEIL", hasMetar ? ceilingLabel(p.ceiling_state, p.ceiling_ft) : "—"],
    ],
    flags,
  };
}

/** Tip → DOM(텍스트 노드만). 브라우저에서만 호출한다. */
export function renderTip(tip: Tip, doc: Document = document): HTMLElement {
  const root = doc.createElement("div");
  root.className = "tip";
  const head = doc.createElement("div");
  head.className = "tip-head";
  const t = doc.createElement("span");
  t.className = "tip-title mono";
  t.textContent = tip.title;
  head.appendChild(t);
  if (tip.subtitle) {
    const s = doc.createElement("span");
    s.className = "tip-sub mono";
    s.textContent = tip.subtitle;
    head.appendChild(s);
  }
  root.appendChild(head);
  for (const [k, v] of tip.rows) {
    const r = doc.createElement("div");
    r.className = "tip-row";
    const kk = doc.createElement("span");
    kk.className = "label";
    kk.textContent = k;
    const vv = doc.createElement("span");
    vv.className = "mono";
    vv.textContent = v;
    r.append(kk, vv);
    root.appendChild(r);
  }
  if (tip.flags.length) {
    const f = doc.createElement("div");
    f.className = "tip-flags";
    for (const fl of tip.flags) {
      const b = doc.createElement("span");
      b.className = `badge ${fl.tone === "muted" ? "" : fl.tone}`.trim();
      b.textContent = fl.text;
      f.appendChild(b);
    }
    root.appendChild(f);
  }
  return root;
}
