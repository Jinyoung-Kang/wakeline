/**
 * 재생(FR-23) 데이터 형태와 표시 규칙(순수 함수). 기록된 값만 보여 준다(보간·추정 없음). 없는 값은 "—".
 * API: GET /api/v1/replay?at=&bbox= → { at, aircraft, sigmets, source, radar: {host, path, time} | null }(계약서 §2).
 * 원해상도 보관(72 h) 밖은 1분 요약(track_point_1m)에서 온다 — 행의 위치·고도·속도는 그 1분 동안 관측의 평균이고 방위·지상 여부는 없다.
 * 이런 행(provider "1m_summary")은 "기록 위치"가 아니라 "1분 평균(요약)"으로 표시한다(DH-11).
 */
import { ApiError } from "./api";
import { band, fmtAltGnd, fmtDuration, fmtNum, fmtTime } from "./format";
import type { Tip } from "./tooltip";
import type { Bbox } from "./viewport";

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

// ---- 요청 영역·오류(R-05) ----

/** api 의 bbox 면적 상한(application.yml wakeline.max-bbox-area-sqdeg). 넘으면 422 BBOX_TOO_LARGE */
export const REPLAY_MAX_AREA_SQDEG = 2500;

/**
 * 재생 조회 영역. 화면([w,s,e,n], 날짜변경선 처리 뒤)이 면적 상한을 넘으면 화면 비율 그대로 줄여 지도 가운데에 둔다(화면 밖으로는 나가지 않게 민다).
 * clamped=true 면 화면에 조회 상자를 그리고 "상자 밖은 조회하지 않음"을 밝힌다 — 상자 밖이 비어 있다고 말하지 않는다.
 */
export function replayQueryBbox(view: Bbox, center: [number, number], maxArea = REPLAY_MAX_AREA_SQDEG): { bbox: Bbox; clamped: boolean } {
  const [w, s, e, n] = view;
  const width = e - w, height = n - s;
  if (!(width > 0 && height > 0) || width * height <= maxArea) return { bbox: view, clamped: false };
  const k = Math.sqrt((maxArea * (1 - 1e-6)) / (width * height)); // 부동소수 오차로 상한을 넘지 않게 아주 조금 안쪽
  const bw = width * k, bh = height * k;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : (lo + hi) / 2));
  const cx = clamp(center[0], w + bw / 2, e - bw / 2), cy = clamp(center[1], s + bh / 2, n - bh / 2);
  return { bbox: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], clamped: true };
}

/** 요청 문자열(소수 3자리). 안쪽으로 반올림해 반올림 때문에 면적이 상한을 넘지 않게 한다. */
export function fmtReplayBbox(b: Bbox): string {
  const up = (v: number) => Math.ceil(Math.round(v * 1e6) / 1e3) / 1000;
  const down = (v: number) => Math.floor(Math.round(v * 1e6) / 1e3) / 1000;
  return [up(b[0]), up(b[1]), down(b[2]), down(b[3])].map((v) => v.toFixed(3)).join(",");
}

/** 재생 화면 상태: 지도에 그리는 프레임 · 오류 문구 · 마지막 응답 시간 */
export interface ReplayView { frame: ReplayFrame | null; err: string | null; latencyMs: number | null }
export type ReplayEvent = { type: "loaded"; frame: ReplayFrame; latencyMs: number } | { type: "failed"; error: unknown };

/** 요청이 실패하면 이전 프레임을 지운다 — 새 시각 라벨 아래 이전 시각·영역의 항공기를 남기지 않는다(R-05). */
export function replayReduce(_s: ReplayView, e: ReplayEvent): ReplayView {
  if (e.type === "loaded") return { frame: e.frame, err: null, latencyMs: e.latencyMs };
  return { frame: null, err: replayErrorText(e.error), latencyMs: null };
}

/** 재생 요청 오류 → 한국어 안내(서버 영문 detail 을 그대로 보이지 않는다) */
export function replayErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 422) return "요청 영역이 너무 넓음 — 지도를 확대하세요";
    if (e.status === 400) return "잘못된 요청(시각은 최근 31일 안) — 기록을 불러오지 못함";
    if (e.status === 429) return "요청이 많아 잠시 제한됨 — 잠시 뒤 다시";
    if (e.status >= 500) return `서버 오류(HTTP ${e.status}) — 기록을 불러오지 못함`;
    return `기록을 불러오지 못함(HTTP ${e.status})`;
  }
  return "서버에 연결할 수 없음 — 기록을 불러오지 못함";
}

/** 지도에 그린 프레임의 시각(응답 at) 표시. 요청 시각과 다르면 아직 새 프레임이 오지 않은 것 */
export function replayFrameAtLabel(frame: Pick<ReplayFrame, "at"> | null, wantAtMs: number): { text: string; behind: boolean } {
  if (!frame) return { text: "—", behind: false };
  const t = Date.parse(frame.at);
  if (Number.isNaN(t)) return { text: "—", behind: false };
  return { text: `${new Date(t).toISOString().replace("T", " ").slice(0, 19)}Z`, behind: Math.abs(t - wantAtMs) >= 1000 };
}
