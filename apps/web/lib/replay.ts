/**
 * 재생(FR-23) 데이터 형태와 표시 규칙(순수 함수). 기록된 값만 보여 준다(보간·추정 없음). 없는 값은 "—".
 * API: GET /api/v1/replay?at=&bbox= → { at, aircraft, sigmets, source, radar: {host, path, time} | null }(계약서 §2).
 * 원해상도 보관(72 h) 밖은 1분 요약(track_point_1m)에서 온다 — 행의 위치·고도·속도는 그 1분 동안 관측의 평균이고 방위·지상 여부는 없다.
 * 이런 행(provider "1m_summary")은 "기록 위치"가 아니라 "1분 평균(요약)"으로 표시한다(DH-11).
 */
import { band, fmtAltGnd, fmtDuration, fmtNum, fmtTime } from "./format";
import type { Tip } from "./tooltip";

export interface ReplayAircraft {
  hex: string;
  /** 기록 시각(track_point.ts) */
  ts?: string | null;
  lat: number;
  lon: number;
  alt_ft?: number | null;
  track_deg?: number | null;
  gs_kt?: number | null;
  on_ground?: boolean | null;
  /** 기록에 있으면(현재 track_point 에는 없음) */
  callsign?: string | null;
  provider?: string | null;
}
export interface ReplaySigmet {
  id: string;
  hazard: string;
  qualifier?: string | null;
  base_ft?: number | null;
  top_ft?: number | null;
  base_source?: string | null;
  top_source?: string | null;
  fir_id: string;
  fir_name?: string | null;
  valid_from: string;
  valid_to: string;
  raw_text: string;
  excluded_reason?: string | null;
  geometry: GeoJSON.MultiPolygon | null;
}
export interface ReplayRadar { host: string; path: string; time: number | string }
export interface ReplayFrame {
  at: string;
  aircraft: ReplayAircraft[];
  sigmets: ReplaySigmet[];
  /** 행을 실제로 준 테이블: track_point | track_point_1m | none */
  source: string;
  radar?: ReplayRadar | null;
}

/** 레이더 프레임 시각(ms). RainViewer 프레임은 epoch 초, 문자열이면 ISO. */
export function radarTimeMs(t: number | string | null | undefined): number | null {
  if (typeof t === "number" && Number.isFinite(t)) return t < 1e12 ? t * 1000 : t;
  if (typeof t === "string") { const v = Date.parse(t); return Number.isNaN(v) ? null : v; }
  return null;
}

/** 재생 화면의 레이더 상태 문구 */
export function replayRadarLabel(frame: Pick<ReplayFrame, "at" | "radar"> | null): string {
  if (!frame) return "—";
  const r = frame.radar;
  const t = radarTimeMs(r?.time);
  if (!r || t == null) return "레이더 이력 없음(RainViewer 보관 2 h 밖)";
  const d = Math.round((t - Date.parse(frame.at)) / 60000);
  return `레이더 ${fmtTime(t)} (재생 시각 ${d >= 0 ? "+" : "−"}${Math.abs(d)}분)`;
}

const bandSrc = (s: ReplaySigmet) => ({ base_source: s.base_source ?? null, top_source: s.top_source ?? null });

/** 1분 요약 행의 provider 값(api TrackRepository.replay) */
export const SUMMARY_PROVIDER = "1m_summary";
export const isSummaryRow = (a: Pick<ReplayAircraft, "provider">) => a.provider === SUMMARY_PROVIDER;
export const SUMMARY_FLAG = "1분 평균 위치·고도·속도(요약) · 방위 없음";

/** 기록 시각 표시: 원해상도는 관측 시각, 요약은 그 1분 구간(ts = 구간 시작) */
export function replayRecLabel(a: Pick<ReplayAircraft, "ts" | "provider">, at: string): string {
  if (!a.ts) return "—";
  if (isSummaryRow(a)) {
    const t0 = Date.parse(a.ts);
    return Number.isNaN(t0) ? "—" : `${fmtTime(t0)} – ${fmtTime(t0 + 60_000).slice(6)} 평균`;
  }
  const lag = (Date.parse(at) - Date.parse(a.ts)) / 1000;
  return `${fmtTime(a.ts)}${Number.isFinite(lag) ? ` (재생 시각 −${fmtDuration(lag)})` : ""}`;
}

export function replayAircraftTip(a: ReplayAircraft, at: string): Tip {
  const summary = isSummaryRow(a);
  return {
    title: a.callsign ?? a.hex,
    subtitle: a.callsign ? a.hex : undefined,
    rows: [
      ["ALT", fmtAltGnd(a.alt_ft, a.on_ground)],
      ["GS", fmtNum(a.gs_kt, " kt")],
      ["TRK", fmtNum(a.track_deg, "°")],
      ["REC", replayRecLabel(a, at)],
      ["SRC", summary ? "1분 요약" : a.provider ?? "—"],
    ],
    flags: [summary ? { text: SUMMARY_FLAG, tone: "muted" } : { text: "기록 위치 · 보간 없음", tone: "muted" }],
  };
}

export function replaySigmetTip(s: ReplaySigmet, at: string): Tip {
  const left = (Date.parse(s.valid_to) - Date.parse(at)) / 1000;
  return {
    title: `${s.hazard}${s.qualifier ? ` ${s.qualifier}` : ""}`,
    subtitle: s.fir_id,
    rows: [
      ["BAND", band(s.base_ft, s.top_ft, bandSrc(s))],
      ["VALID", `${fmtTime(s.valid_from)} – ${fmtTime(s.valid_to)}`],
      ["LEFT", Number.isFinite(left) && left > 0 ? `${fmtDuration(left)}(재생 시각 기준)` : "—"],
    ],
    flags: s.excluded_reason ? [{ text: `판정 제외: ${s.excluded_reason}`, tone: "muted" }] : [],
  };
}

export function replaySigmetBand(s: ReplaySigmet): string {
  return band(s.base_ft, s.top_ft, bandSrc(s));
}
