/**
 * 재생(FR-23) 데이터 형태와 표시 규칙(순수 함수). 기록된 값만 보여 준다(보간·추정 없음). 없는 값은 "—".
 * API: GET /api/v1/replay?at=&bbox= → { at, aircraft, sigmets, source, radar: {host, path, time} | null }(계약서 §2).
 */
import { band, fmtAlt, fmtDuration, fmtNum, fmtTime } from "./format";
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

export function replayAircraftTip(a: ReplayAircraft, at: string): Tip {
  const lag = a.ts ? (Date.parse(at) - Date.parse(a.ts)) / 1000 : NaN;
  return {
    title: a.callsign ?? a.hex,
    subtitle: a.callsign ? a.hex : undefined,
    rows: [
      ["ALT", a.on_ground === true ? "GND" : fmtAlt(a.alt_ft)],
      ["GS", fmtNum(a.gs_kt, " kt")],
      ["TRK", fmtNum(a.track_deg, "°")],
      ["REC", a.ts ? `${fmtTime(a.ts)}${Number.isFinite(lag) ? ` (재생 시각 −${fmtDuration(lag)})` : ""}` : "—"],
      ["SRC", a.provider ?? "—"],
    ],
    flags: [{ text: "기록 위치 · 보간 없음", tone: "muted" }],
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
