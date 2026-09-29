/**
 * 연안 교통량(ADR-023) — 한국해양교통안전공단 실시간 해양교통정보(5분 집계)의 격자별 선박 척수를 해양수산부 해양격자 4단계 칸(0.025°)에 칠한다.
 * 개별 선박 위치가 아니다(화면 곳곳에 그렇게 적는다). 값은 api /api/v1/traffic/grid 가 검증한 것 — 여기서도 모양을 다시 본다(틀린 칸은 버린다).
 * - 상태: ok(그림) · stale(regDt 15분 초과 — 칸 없음, 마지막 기준 시각만) · disabled(키 없음 · fixture · 운영자 끔) · no_data · invalid. 모르는 수는 "—".
 * - 조회: 레이어가 켜져 있고 탭이 보일 때만, TRAFFIC_POLL_MS 마다, ETag(If-None-Match)로 — 304 · 같은 ETag 면 지도를 다시 그리지 않는다.
 * - 색: 척수 구간(표시용 선택 — 2026-09-29 확인한 범위 1–102 를 2배씩) · 한 가지 색상(주황)으로 척수가 많을수록 밝게(어두운 지도 위 순서 색).
 *   0척 칸은 회색. 밀집도 %는 공급자 값 그대로 툴팁에.
 * - 시각: 기준(regDt)은 KST 와 UTC 를 함께 적는다(공급자 원본은 KST 벽시계).
 */
import { fmtIso, fmtTimeKstLabel } from "./format";
import type { Tip } from "./tooltip";

export const TRAFFIC_LAYER_LABEL = "연안 교통량(KOMSA)";
export const TRAFFIC_LEGEND_NOTE = "격자 약 2.2×2.8 km · 5분 집계 · 선박 척수 — 개별 선박 위치 아님";
export const TRAFFIC_SOURCE_TEXT = "한국해양교통안전공단 MTIS 실시간 해양교통정보 · 해양수산부 해양격자 4단계(공공데이터포털)";
export const TRAFFIC_URL = "/api/v1/traffic/grid";
export const TRAFFIC_POLL_MS = 90_000;
export const TRAFFIC_CELL_DEG = 0.025;
const SNAP_TOL = 1e-6;
const GRID_NO = /^[A-Za-z0-9_]{1,32}$/;
/** 0척(공급자가 보고한 빈 칸) 색 — 척수 색과 구분 */
export const TRAFFIC_ZERO_COLOR = "#5b616b";
/** 척수 구간: min 이상(다음 구간 min 미만). 색은 한 가지 색상(주황) · 밝기만 오른다 — 어두운 바탕 대비 3.1:1 부터(표시용 선택) */
export const TRAFFIC_BINS: readonly { min: number; label: string; color: string }[] = [
  { min: 1, label: "1", color: "#994920" },
  { min: 2, label: "2–3", color: "#c05d20" },
  { min: 4, label: "4–7", color: "#e37725" },
  { min: 8, label: "8–15", color: "#fb9437" },
  { min: 16, label: "16–31", color: "#ffb75f" },
  { min: 32, label: "32+", color: "#ffdd97" },
];
export const TRAFFIC_FILL_OPACITY = 0.62;

export type TrafficStatus = "ok" | "stale" | "disabled" | "no_data" | "invalid";
export type TrafficDisabledReason = "no_key" | "fixture" | "operator_off";
/** [grid_no, lat_min, lon_min, 척수, 밀집도 %] */
export type TrafficCell = [string, number, number, number, number];

export interface TrafficGrid {
  available: boolean;
  status: TrafficStatus;
  disabled_reason: TrafficDisabledReason | null;
  reg_dt_kst: string | null;
  reg_dt_utc: string | null;
  fetched_at: string | null;
  age_s: number | null;
  stale_after_s: number;
  total: number | null;
  total_count: number | null;
  partial: boolean | null;
  resolved: number | null;
  unresolved: number | null;
  pending: number | null;
  not_found: number | null;
  off_grid: number | null;
  invalid_cells: number | null;
  cells: TrafficCell[];
  /** 이 브라우저가 형식이 틀려 버린 칸 수 */
  dropped: number;
}

const STATUSES: ReadonlySet<string> = new Set(["ok", "stale", "disabled", "no_data", "invalid"]);
const REASONS: ReadonlySet<string> = new Set(["no_key", "fixture", "operator_off"]);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length <= 64 ? v : null);
const onLattice = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v - Math.round(v / TRAFFIC_CELL_DEG) * TRAFFIC_CELL_DEG) <= SNAP_TOL;

function cellOf(c: unknown): TrafficCell | null {
  if (!Array.isArray(c) || c.length !== 5) return null;
  const [g, lat, lon, v, d] = c;
  if (typeof g !== "string" || !GRID_NO.test(g) || !onLattice(lat) || !onLattice(lon)) return null;
  if (lat < -90 || lat > 90 - TRAFFIC_CELL_DEG + SNAP_TOL || lon < -180 || lon > 180 - TRAFFIC_CELL_DEG + SNAP_TOL) return null;
  const n = count(v);
  if (n == null || typeof d !== "number" || !Number.isFinite(d) || d < 0 || d > 100) return null;
  return [g, lat, lon, n, d];
}

/** api 응답 → 화면 값. 모양이 틀리면 null(마지막 값을 둔다). 틀린 칸은 버리고 dropped 로 센다. ok 가 아니면 칸을 쓰지 않는다. */
export function parseTrafficGrid(x: unknown): TrafficGrid | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.status !== "string" || !STATUSES.has(o.status) || typeof o.available !== "boolean") return null;
  const status = o.status as TrafficStatus;
  const available = o.available && status === "ok";
  const raw = Array.isArray(o.cells) ? o.cells : [];
  const cells: TrafficCell[] = [];
  let dropped = 0;
  if (available) for (const c of raw) { const v = cellOf(c); if (v) cells.push(v); else dropped++; }
  const reason = typeof o.disabled_reason === "string" && REASONS.has(o.disabled_reason) ? (o.disabled_reason as TrafficDisabledReason) : null;
  return {
    available, status, disabled_reason: status === "disabled" ? reason : null,
    reg_dt_kst: str(o.reg_dt_kst), reg_dt_utc: str(o.reg_dt_utc), fetched_at: str(o.fetched_at), age_s: count(o.age_s),
    stale_after_s: count(o.stale_after_s) ?? 900,
    total: count(o.total), total_count: count(o.total_count), partial: typeof o.partial === "boolean" ? o.partial : null,
    resolved: count(o.resolved), unresolved: count(o.unresolved), pending: count(o.pending), not_found: count(o.not_found),
    off_grid: count(o.off_grid), invalid_cells: count(o.invalid_cells), cells, dropped,
  };
}

/** 칸 → 지도 GeoJSON(칸마다 정사각형 하나). 속성: g 격자 번호 · v 척수 · d 밀집도 %. */
export function trafficGridFeatures(cells: readonly TrafficCell[]): GeoJSON.FeatureCollection<GeoJSON.Polygon, { g: string; v: number; d: number }> {
  const s = TRAFFIC_CELL_DEG;
  return {
    type: "FeatureCollection",
    features: cells.map(([g, lat, lon, v, d], i) => ({
      type: "Feature",
      id: i,
      properties: { g, v, d },
      geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + s, lat], [lon + s, lat + s], [lon, lat + s], [lon, lat]]] },
    })),
  };
}

/** 척수 → 색(범례와 지도가 같은 표) */
export function trafficColor(v: number): string {
  let c = TRAFFIC_ZERO_COLOR;
  for (const b of TRAFFIC_BINS) if (v >= b.min) c = b.color;
  return c;
}

/** MapLibre step 식 — trafficColor 와 같은 구간 */
export function trafficColorExpr(): unknown[] {
  return ["step", ["get", "v"], TRAFFIC_ZERO_COLOR, ...TRAFFIC_BINS.flatMap((b) => [b.min, b.color])];
}

/** 기준 시각: "09-29 18:05:05 KST · 09-29 09:05:05 UTC". 모르면 "—" */
export function trafficTimeText(utc: string | null | undefined): string {
  const kst = fmtTimeKstLabel(utc);
  const iso = fmtIso(utc);
  if (kst === "—" || iso === "—") return "—";
  return `${kst} · ${iso.slice(5, 10)} ${iso.slice(11, 19)} UTC`;
}

const n = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-US"));
/** 수 + 단위. 모르면 "—" 만(단위를 붙이지 않는다) */
const nu = (v: number | null | undefined, unit: string) => (v == null ? "—" : `${v.toLocaleString("en-US")}${unit}`);
const pct = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)} %`;

/** 지도 툴팁(격자 한 칸) */
export function trafficGridTip(p: Record<string, unknown>, g: Pick<TrafficGrid, "reg_dt_utc"> | null): Tip | null {
  if (typeof p.g !== "string") return null;
  const v = typeof p.v === "number" ? p.v : null;
  const d = typeof p.d === "number" ? p.d : null;
  return {
    title: "연안 교통량 격자",
    subtitle: p.g,
    rows: [
      ["척수", v == null ? "—" : `${v}척`],
      ["밀집도", d == null ? "—" : pct(d)],
      ["기준", trafficTimeText(g?.reg_dt_utc)],
      ["격자", `${TRAFFIC_CELL_DEG}° 칸(약 2.2×2.8 km)`],
    ],
    flags: [{ text: "5분 집계 · 개별 선박 위치 아님", tone: "muted" }],
  };
}

export type TrafficTone = "ok" | "warn" | "bad" | "muted";
export interface TrafficStatusLine { text: string; tone: TrafficTone; detail: string | null }

const REASON_TEXT: Record<TrafficDisabledReason, string> = {
  no_key: "공공데이터포털 서비스 키 없음(수집기 설정)",
  fixture: "fixture 모드 — 외부 호출 없음",
  operator_off: "운영자가 수집을 끔",
};

/**
 * 레이어 상태 줄. g = 마지막으로 받은 값(없으면 null), error = 마지막 조회 오류(성공하면 null).
 * 오류가 있어도 마지막 값을 보이되 오류를 함께 적는다(지난 값을 조용히 지금처럼 두지 않는다).
 */
export function trafficStatusLine(g: TrafficGrid | null, error: string | null): TrafficStatusLine {
  const err = error ? ` · 조회 실패(${error}) — 마지막 값` : "";
  if (!g) return error ? { text: `조회 실패 — ${error}`, tone: "bad", detail: null } : { text: "불러오는 중…", tone: "muted", detail: null };
  switch (g.status) {
    case "disabled":
      return { text: `꺼짐 — ${g.disabled_reason ? REASON_TEXT[g.disabled_reason] : "이유 —"}${err}`, tone: "muted", detail: null };
    case "no_data":
      return { text: `자료 없음 — 수집기가 아직 싣지 않았거나 20분 넘게 멈춤${err}`, tone: "warn", detail: null };
    case "invalid":
      return { text: `받은 자료 형식 오류 — 표시 안 함${err}`, tone: "bad", detail: null };
    case "stale":
      return {
        text: `자료 멈춤 — 마지막 기준 ${trafficTimeText(g.reg_dt_utc)} · ${Math.round(g.stale_after_s / 60)}분 넘게 새 자료 없음 · 표시 안 함${err}`,
        tone: "warn", detail: null,
      };
    default: {
      const shown = g.cells.length;
      const parts = [`기준 ${trafficTimeText(g.reg_dt_utc)}`, `격자 ${n(shown)} / ${nu(g.total, "칸")} 표시`];
      if (g.pending) parts.push(`위치 확인 중 ${nu(g.pending, "칸")}`);
      const extra: string[] = [];
      if (g.not_found) extra.push(`해양격자에 없음 ${nu(g.not_found, "칸")}`);
      if (g.off_grid) extra.push(`격자 검사 실패(격리) ${nu(g.off_grid, "칸")}`);
      if ((g.invalid_cells ?? 0) + g.dropped > 0) extra.push(`형식 오류로 뺀 칸 ${n((g.invalid_cells ?? 0) + g.dropped)}`);
      const partial = g.partial ? `일부만 수신(${n(g.total)} / 공급자 ${nu(g.total_count, "칸")})` : null;
      if (partial) extra.unshift(partial);
      const detail = extra.length ? extra.join(" · ") : null;
      return { text: parts.join(" · ") + err, tone: partial || error ? "warn" : g.pending ? "muted" : "ok", detail };
    }
  }
}

// ---- 조회(ETag) -------------------------------------------------------------------------------------------------------

export interface TrafficPollState { data: TrafficGrid | null; etag: string | null; error: string | null; version: number; checkedAt: number | null }
export const TRAFFIC_POLL_NONE: TrafficPollState = { data: null, etag: null, error: null, version: 0, checkedAt: null };

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * 레이어가 켜져 있는 동안만 도는 조회기. 지도는 version 이 바뀔 때만 다시 그린다 — 304 · 같은 ETag · 같은 본문이면 version 을 올리지 않는다.
 * 숨긴 탭에서는 부르지 않는다. 동시에 두 번 부르지 않는다.
 */
export class TrafficGridPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;
  private state: TrafficPollState;

  constructor(
    private readonly publish: (s: TrafficPollState) => void,
    initial: TrafficPollState = TRAFFIC_POLL_NONE,
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
    private readonly hidden: () => boolean = () => typeof document !== "undefined" && document.hidden,
    private readonly now: () => number = () => Date.now(),
    private readonly intervalMs = TRAFFIC_POLL_MS,
  ) {
    this.state = initial;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => { if (!this.hidden()) void this.poll(); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.state.etag && this.state.data) headers["If-None-Match"] = this.state.etag;
      const res = await this.fetcher(TRAFFIC_URL, { headers, credentials: "same-origin" });
      if (res.status === 304) { this.set({ error: null, checkedAt: this.now() }, false); return; }
      if (!res.ok) { this.set({ error: `HTTP ${res.status}`, checkedAt: this.now() }, false); return; }
      const etag = res.headers.get("ETag");
      const parsed = parseTrafficGrid(await res.json());
      if (!parsed) { this.set({ error: "응답 형식 오류", checkedAt: this.now() }, false); return; }
      const same = etag != null && etag === this.state.etag;
      this.set({ data: same ? this.state.data : parsed, etag, error: null, checkedAt: this.now() }, !same);
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e), checkedAt: this.now() }, false);
    } finally {
      this.inflight = false;
    }
  }

  private set(patch: Partial<TrafficPollState>, changed: boolean): void {
    this.state = { ...this.state, ...patch, version: this.state.version + (changed ? 1 : 0) };
    this.publish(this.state);
  }
}

// ---- 지도 레이어 -------------------------------------------------------------------------------------------------------

export const TRAFFIC_SOURCE = "traffic-grid";
export const TRAFFIC_LAYERS = ["traffic-grid-fill", "traffic-grid-line"] as const;

interface LayerHost {
  addSource(id: string, spec: unknown): unknown;
  addLayer(spec: unknown, before?: string): unknown;
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
}

/**
 * GeoJSON 소스 하나(바뀔 때 setData 로 통째로 — 레이어를 다시 만들지 않는다)와 채움 · 칸 테두리(줌 8 이상) 레이어. 처음엔 숨김.
 * before: 이 레이어 아래에 끼운다(상황판은 레이더 자리 — 레이더 · SIGMET · 항공기 · 선박이 위에 그려진다).
 */
export function addTrafficGridLayers(map: LayerHost, before?: string): void {
  if (map.getSource(TRAFFIC_SOURCE)) return;
  map.addSource(TRAFFIC_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] }, tolerance: 0, buffer: 0 });
  const color = trafficColorExpr();
  map.addLayer({
    id: TRAFFIC_LAYERS[0], type: "fill", source: TRAFFIC_SOURCE, layout: { visibility: "none" },
    paint: { "fill-color": color, "fill-opacity": TRAFFIC_FILL_OPACITY, "fill-antialias": false },
  }, before);
  map.addLayer({
    id: TRAFFIC_LAYERS[1], type: "line", source: TRAFFIC_SOURCE, minzoom: 8, layout: { visibility: "none" },
    paint: { "line-color": color, "line-width": 0.6, "line-opacity": 0.9 },
  }, before);
}
