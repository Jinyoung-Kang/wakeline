/**
 * 재생(FR-23) 데이터 형태와 표시 규칙(순수 함수). 기록된 값만 보여 준다(보간·추정 없음). 없는 값은 "—".
 * API: GET /api/v1/replay?at=&bbox= → { at, aircraft, sigmets, source, radar: {host, path, time} | null }(계약서 §2).
 * 원해상도 보관(72 h) 밖은 1분 요약(track_point_1m)에서 온다 — 행의 위치·고도·속도는 그 1분 동안 관측의 평균이고 방위·지상 여부는 없다.
 * 이런 행(provider "1m_summary")은 "기록 위치"가 아니라 "1분 평균(요약)"으로 표시한다(DH-11).
 * 시각: 고르는 입력은 KST(datetime-local), 보이는 글자는 KST 먼저 · UTC 함께(사용자 요청 2026-09-29, lib/time), api 요청(at)은 그 순간의 UTC ISO(…Z) 그대로.
 */
import { ApiError } from "./api";
import { fmtDual, fmtDualRange, fmtUtcRangeTitle, fmtUtcTitle } from "./time";
import { band, fmtAltGndDual, fmtBool, fmtDuration, fmtGsDual, fmtNum } from "./format";
import { isoKst, KST_OFFSET_MS } from "./kst";
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

/** 재생 화면 레이더 문구의 툴팁: 그 프레임 시각의 원본 UTC. 프레임이 없으면 undefined(title 없음) */
export function replayRadarTitle(frame: Pick<ReplayFrame, "at" | "radar"> | null): string | undefined {
  const t = radarTimeMs(frame?.radar?.time);
  return t == null ? undefined : fmtUtcTitle(t);
}

/** 재생 화면의 레이더 상태 문구 */
export function replayRadarLabel(frame: Pick<ReplayFrame, "at" | "radar"> | null): string {
  if (!frame) return "—";
  const r = frame.radar;
  const t = radarTimeMs(r?.time);
  if (!r || t == null) return "레이더 이력 없음(RainViewer 보관 2 h 밖)";
  const d = Math.round((t - Date.parse(frame.at)) / 60000);
  return `레이더 ${fmtDual(t)} (재생 시각 ${d >= 0 ? "+" : "−"}${Math.abs(d)}분)`;
}

const bandSrc = (s: ReplaySigmet) => ({ base_source: s.base_source ?? null, top_source: s.top_source ?? null });

/** 1분 요약 행의 provider 값(api TrackRepository.replay) */
export const SUMMARY_PROVIDER = "1m_summary";
export const isSummaryRow = (a: Pick<ReplayAircraft, "provider">) => a.provider === SUMMARY_PROVIDER;
export const SUMMARY_FLAG = "1분 평균 위치·고도·속도(요약) · 방위 없음";

/** 기록 시각 표시(KST): 원해상도는 관측 시각, 요약은 그 1분 구간(ts = 구간 시작) */
export function replayRecLabel(a: Pick<ReplayAircraft, "ts" | "provider">, at: string): string {
  if (!a.ts) return "—";
  if (isSummaryRow(a)) {
    const t0 = Date.parse(a.ts);
    return Number.isNaN(t0) ? "—" : `${fmtDualRange(t0, t0 + 60_000)} 평균`;
  }
  const lag = (Date.parse(at) - Date.parse(a.ts)) / 1000;
  return `${fmtDual(a.ts)}${Number.isFinite(lag) ? ` (재생 시각 −${fmtDuration(lag)})` : ""}`;
}

/** 기록 시각 행의 이름 — 원해상도는 "기록 시각", 요약은 그 1분 구간이라 "기록 구간" */
export const replayRecRowName = (a: Pick<ReplayAircraft, "provider">) => (isSummaryRow(a) ? "기록 구간" : "기록 시각");

/** 기록 시각 행의 툴팁: 원본 UTC(요약은 그 1분 구간 "원본 UTC a – b"). 모르면 undefined(title 없음) */
export function replayRecTitle(a: Pick<ReplayAircraft, "ts" | "provider">): string | undefined {
  if (!a.ts) return undefined;
  if (!isSummaryRow(a)) return fmtUtcTitle(a.ts);
  const t0 = Date.parse(a.ts);
  return Number.isNaN(t0) ? undefined : fmtUtcRangeTitle(t0, t0 + 60_000);
}

/** 재생 상세(inspector) 행 — 고도·지상속도는 두 단위(계약 v5 §A2). 요약 행은 "1분 평균"이라고 이름에 밝힌다(DH-11) */
export function replayAircraftRows(a: ReplayAircraft, at: string): [string, string][] {
  const summary = isSummaryRow(a);
  return [
    ["ICAO24", a.hex],
    ["Callsign", a.callsign ?? "—"],
    [summary ? "고도(1분 평균)" : "고도", fmtAltGndDual(a.alt_ft, a.on_ground)],
    [summary ? "지상속도(1분 평균)" : "지상속도", fmtGsDual(a.gs_kt)],
    ["방위", fmtNum(a.track_deg, "°")],
    ["지상", fmtBool(a.on_ground)],
    [replayRecRowName(a), summary ? replayRecLabel(a, at) : fmtDual(a.ts)],
    ["출처", summary ? "1분 요약(track_point_1m)" : a.provider ?? "—"],
  ];
}

export function replayAircraftTip(a: ReplayAircraft, at: string): Tip {
  const summary = isSummaryRow(a);
  return {
    title: a.callsign ?? a.hex,
    subtitle: a.callsign ? a.hex : undefined,
    rows: [
      ["ALT", fmtAltGndDual(a.alt_ft, a.on_ground)],
      ["GS", fmtGsDual(a.gs_kt)],
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
      ["VALID", fmtDualRange(s.valid_from, s.valid_to, { seconds: false })],
      ["LEFT", Number.isFinite(left) && left > 0 ? `${fmtDuration(left)}(재생 시각 기준)` : "—"],
    ],
    flags: s.excluded_reason ? [{ text: `판정 제외: ${s.excluded_reason}`, tone: "muted" }] : [],
  };
}

/** 재생 상세(카드)의 고도대 — 숫자 경계에 m 를 괄호로(계약 v5 §A3). 툴팁은 replaySigmetTip(그대로) */
export function replaySigmetBand(s: ReplaySigmet): string {
  return band(s.base_ft, s.top_ft, bandSrc(s), { metric: true });
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

/** 재생 화면 상태: 지도에 그리는 프레임 · 오류 문구 · 마지막 응답 시간 · 실패한 요청의 요청 id(계약 v5 §C8 — 서버가 준 것만, 없으면 null) */
export interface ReplayView { frame: ReplayFrame | null; err: string | null; latencyMs: number | null; rid?: string | null }
export type ReplayEvent = { type: "loaded"; frame: ReplayFrame; latencyMs: number } | { type: "failed"; error: unknown };

/** 요청이 실패하면 이전 프레임을 지운다 — 새 시각 라벨 아래 이전 시각·영역의 항공기를 남기지 않는다(R-05). */
export function replayReduce(_s: ReplayView, e: ReplayEvent): ReplayView {
  if (e.type === "loaded") return { frame: e.frame, err: null, latencyMs: e.latencyMs, rid: null };
  return { frame: null, err: replayErrorText(e.error), latencyMs: null, rid: e.error instanceof ApiError ? e.error.requestId : null };
}

/**
 * 상세(inspector)에서 고른 항목이 지금 프레임에 없을 때의 문구(R-05 후속). "기록 없음 · 유효하지 않음"은 응답이 말해 준 사실일 때만 —
 * 프레임이 없으면(요청 실패·아직 응답 전) 그 시각의 기록을 모른다. 실패 뒤에 "기록 없음"이라고 쓰면 사실이 아닌 값을 보이는 것이다.
 */
export function replayInspectorMiss(pick: { kind: "aircraft"; hex: string } | { kind: "sigmet"; id: string }, frame: ReplayFrame | null, err: string | null): string {
  const who = pick.kind === "aircraft" ? pick.hex : "이 SIGMET";
  if (!frame) return err ? `${who} — 이 시각 기록을 불러오지 못해 알 수 없음(${err})` : `${who} — 이 시각 기록을 불러오는 중`;
  return pick.kind === "aircraft" ? `${pick.hex} — 이 시각(−3분 창)·이 영역에 기록 없음` : "이 시각에 유효하지 않은 SIGMET";
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

/** 재생 시각 표시(KST 먼저, UTC 함께 — 날짜 포함) "YYYY-MM-DD HH:MM:SS KST · HH:MM:SS UTC" — 30일을 오가므로 연도까지(UTC 날짜가 다르면 UTC 쪽에도). 모르면(0 · 형식 오류) "—" */
export function replayAtLabel(ms: number | string | null | undefined): string {
  return ms ? fmtDual(ms, { year: true }) : "—";
}

/** 지도에 그린 프레임의 시각(응답 at — UTC ISO)을 KST · UTC 로. 요청 시각과 다르면(1 s 이상) 아직 새 프레임이 오지 않은 것 */
export function replayFrameAtLabel(frame: Pick<ReplayFrame, "at"> | null, wantAtMs: number): { text: string; behind: boolean } {
  if (!frame) return { text: "—", behind: false };
  const t = Date.parse(frame.at);
  if (Number.isNaN(t)) return { text: "—", behind: false };
  return { text: replayAtLabel(t), behind: Math.abs(t - wantAtMs) >= 1000 };
}

/** 재생 api 경로 — at 은 고른 KST 시각의 순간을 UTC ISO(…Z)로 보낸다(api 계약은 UTC) */
export function replayApiPath(r: { at: number; bbox: string }): string {
  return `/api/v1/replay?at=${encodeURIComponent(new Date(r.at).toISOString())}&bbox=${encodeURIComponent(r.bbox)}`;
}

// ---- 재생 시각 고르기(R-10) ----

/** 원해상도(track_point) 보관 — 그 이전은 1분 요약(track_point_1m) */
export const REPLAY_FULL_RES_MS = 72 * 3600_000;
/** 1분 요약 보관(ADR-007, 30일). api 는 31일까지 받지만 30일보다 오래된 요약은 지워져 있다 */
export const REPLAY_SUMMARY_MS = 30 * 86400_000;

export interface ReplayRange { min: number; max: number; fullResFrom: number }

/** 고를 수 있는 구간: 30일 전 ~ 1분 전(서버 기준 지금). fullResFrom 이후만 원해상도 */
export function replayRange(nowMs: number): ReplayRange {
  return { min: nowMs - REPLAY_SUMMARY_MS, max: nowMs - 60_000, fullResFrom: nowMs - REPLAY_FULL_RES_MS };
}

/** 그 시각의 기록 종류(서버가 실제로 준 테이블은 응답 source 로 따로 보인다) */
export function replayZone(at: number, r: ReplayRange): "full" | "summary" {
  return at >= r.fullResFrom ? "full" : "summary";
}

export function stepAt(at: number, deltaMs: number, r: Pick<ReplayRange, "min" | "max">): number {
  return Math.min(r.max, Math.max(r.min, at + deltaMs));
}

/** datetime-local 값(한국 표준시로 쓴다) "YYYY-MM-DDTHH:MM" — 순간 ms 를 KST 벽시계로. 모르면 "" */
export function toKstInput(ms: number): string {
  const s = Number.isFinite(ms) ? isoKst(ms) : null;
  return s == null ? "" : s.slice(0, 16);
}

/**
 * "YYYY-MM-DDTHH:MM[:SS]" 를 한국 표준시(+09:00 고정)로 읽어 순간(epoch ms)으로. 없는 날짜(2월 30일 · 평년 2월 29일 등)·24시·형식 오류는 null.
 * 벽시계 값을 UTC 로 만든 뒤 9 h 를 빼므로 자정 · 달 · 해가 바뀌는 곳도 날짜가 어긋나지 않는다(브라우저 시간대와 무관).
 */
export function fromKstInput(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map((x) => (x == null ? 0 : Number(x)));
  const wall = Date.UTC(y, mo - 1, d, h, mi, se);
  const back = new Date(wall);
  const ok = back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d && back.getUTCHours() === h && back.getUTCMinutes() === mi && back.getUTCSeconds() === se;
  return ok ? wall - KST_OFFSET_MS : null;
}

/** 시각 이동 버튼 [ms, 라벨] */
export const REPLAY_STEPS: [number, string][] = [[-3600_000, "−1h"], [-600_000, "−10m"], [-60_000, "−1m"], [60_000, "+1m"], [600_000, "+10m"], [3600_000, "+1h"]];

// ---- 요청 순서(R-47) · 끌기(사용자 영상 2026-09-29) ----

export interface ReplayReq { at: number; bbox: string }
/** 슬라이더를 끄는 동안 입력이 멈춘 뒤 이만큼 지나야 보낸다 — 입력마다 요청을 만들지 않는다(시각 라벨은 입력마다 바로 바뀐다) */
export const REPLAY_DEBOUNCE_MS = 150;
export interface ReplayRequestOpts {
  /**
   * true(사용자가 옮김): 보내는 중인 다른 요청을 취소(AbortController)하고 바로 보낸다 — 그 응답은 이미 낡았다.
   * false(재생 ▶): 취소하지 않고 끝나면 가장 최근 것을 보낸다 — 응답이 틱 간격보다 느려도 프레임이 계속 온다(R-47).
   */
  supersede?: boolean;
}
type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * 재생 요청은 한 번에 하나만 보낸다(보내는 중인 요청은 늘 최대 1개).
 * - schedule(): debounce(REPLAY_DEBOUNCE_MS) 뒤 마지막 값 하나만 request() 로 — 끄는 동안 요청이 입력 수만큼 쌓이지 않는다.
 * - request(supersede): 보내는 중인 요청을 취소하고 바로 보낸다. 취소한 요청의 응답·실패는 반영하지 않는다(지도를 비우지 않는다).
 * - request(기본): 보내는 중이면 가장 최근 것 하나만 기억했다가(중간 것은 건너뜀) 응답이 오면 바로 보낸다(R-47) — 결국 마지막으로 원한 (at, bbox) 가 그려진다.
 * 받은 프레임은 도착 순서대로 반영하고(라벨과 다르면 화면이 "불러오는 중"으로 표시, R-05), 이미 새 요청이 기다리는 실패는 반영하지 않는다(곧 새 응답이 온다).
 * 기다리는 요청이 실패한 것과 같으면 다시 보내지 않고 실패를 알린다 — 새 응답이 오지 않으므로. 보내는 중인 것과 같은 요청은 취소하지도 다시 보내지도 않는다.
 */
export class ReplayLoader {
  private inflight: { r: ReplayReq; ctl: AbortController } | null = null;
  private queued: ReplayReq | null = null;
  private timer: unknown = null;
  private disposed = false;

  constructor(
    private readonly fetchFrame: (r: ReplayReq, signal: AbortSignal) => Promise<ReplayFrame>,
    private readonly onEvent: (e: ReplayEvent, r: ReplayReq) => void,
    private readonly clock: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    private readonly timers: Timers = defaultTimers,
    private readonly debounceMs = REPLAY_DEBOUNCE_MS,
  ) {}

  /** 입력(슬라이더·재생 틱 등) — 마지막 값만 debounce 뒤에 보낸다 */
  schedule(r: ReplayReq, opts: ReplayRequestOpts = {}): void {
    if (this.disposed) return;
    if (this.timer != null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => { this.timer = null; this.request(r, opts); }, this.debounceMs);
  }

  request(r: ReplayReq, opts: ReplayRequestOpts = {}): void {
    if (this.disposed) return;
    const cur = this.inflight;
    if (cur) {
      if (sameReq(cur.r, r)) { this.queued = null; return; } // 이미 그것을 받는 중
      if (!opts.supersede) { this.queued = r; return; }
      this.inflight = null;
      this.queued = null;
      cur.ctl.abort(); // 낡은 요청 — 응답을 기다리지 않는다
    }
    void this.run(r);
  }

  /** 화면을 떠나면 더 보내지도 반영하지도 않는다(기다리는 debounce · 보내는 중인 요청도 취소) */
  dispose(): void {
    this.disposed = true;
    this.queued = null;
    if (this.timer != null) { this.timers.clear(this.timer); this.timer = null; }
    const cur = this.inflight;
    this.inflight = null;
    cur?.ctl.abort();
  }

  private async run(r: ReplayReq): Promise<void> {
    const me = { r, ctl: new AbortController() };
    this.inflight = me;
    const t0 = this.clock();
    try {
      const frame = await this.fetchFrame(r, me.ctl.signal);
      if (this.inflight === me && !this.disposed) this.onEvent({ type: "loaded", frame, latencyMs: Math.round(this.clock() - t0) }, r);
    } catch (error) {
      // 취소된(대신한) 요청은 알리지 않는다. 기다리는 요청이 방금 실패한 것과 같으면(T1 → T2 → T1) 새 응답이 오지 않는다 — 실패를 알린다(R-47)
      if (this.inflight === me && !this.disposed && (!this.queued || sameReq(this.queued, r))) this.onEvent({ type: "failed", error }, r);
    } finally {
      if (this.inflight === me) {
        this.inflight = null;
        const next = this.queued;
        this.queued = null;
        if (next && !this.disposed && !sameReq(next, r)) void this.run(next);
      }
    }
  }
}

const sameReq = (a: ReplayReq, b: ReplayReq) => a.at === b.at && a.bbox === b.bbox;
