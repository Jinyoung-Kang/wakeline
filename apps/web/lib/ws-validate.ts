/**
 * WS 서버 메시지 형태 검사(계약 v5 §E2 · ADR-020 · R-93) — schemas/ws/server.v1.json 을 손으로 옮긴 규칙. 런타임 JSON Schema 검증기는 싣지 않는다(첫 화면 번들 — NFR-04).
 * - 봉투(메시지의 필수 키·형식)가 틀리면 메시지를 통째로 버린다({kind:"invalid"}) — lib/ws.ts 가 세고, 보고하고, resync 를 요청한다.
 * - 배열 원소(항공기 · 선박 · 알림 · SIGMET · 레이더 프레임 · 격자 칸 · 삭제 목록)와 따로 버릴 수 있는 값(selected.state · route · ship_selected.state/static/
 *   destination_info · demand.hot/focus)이 틀리면 그것만 버리고(null) dropped 로 센다 — 나머지는 적용한다.
 * - 모르는 type 은 {kind:"unknown"}(무시 — 새 서버가 종류를 더해도 깨지지 않는다). 모르는 키도 무시한다.
 * - 스키마보다 너그러운 곳은 "모름" 뿐이다: 없는 키 · null 값(모름), 메시지의 v · ts · sources, 항공기 on_ground, selected.prediction/route,
 *   ships_grid 네 원소 칸(구 서버 — 선종별 수 없음). 있는데 형식이 틀리면 버린다 — 모르는 것과 틀린 것은 다르다.
 * - 통과한 원소는 같은 객체 그대로(복사하지 않는다 — 9,000 대 스냅샷도 할당 없이). 버린 것이 있을 때만 새 배열.
 * tests/ws-validate-v5.test.ts: api 가 실제 빌더로 만든 표본(tests/fixtures/ws-samples.v1.json)을 모두 받고, 스키마 위반 표본은 버리는지.
 */
import { parseDemand, type FocusDemand, type HotDemand } from "./demand";
import { parseRoute, type RouteInfo } from "./route";
import {
  isMmsi, parseDestinationInfo, parseGridCellsCounted, parseShipLite, parseShipState, parseShipStatic,
  type DestinationInfo, type ShipGridCell, type ShipLite, type ShipState, type ShipStatic,
} from "./ships";
import type { AircraftState, Alert, PredictionReason, PublicStatus, RadarFrames, SigmetCollection, SourceInfo } from "./types";

export interface WelcomeMsg { type: "welcome"; server_time: string | null }
export interface SnapshotMsg {
  type: "snapshot"; seq: number; v: number | null; ts: string | null;
  sources: { region: SourceInfo | null; global: SourceInfo | null } | null; aircraft: AircraftState[];
}
export interface DiffMsg { type: "diff"; seq: number; v: number | null; ts: string | null; upsert: AircraftState[]; remove: string[] }
export interface AlertsMsg { type: "alerts"; version: number | null; alerts: Alert[] }
export interface AlertsBatchMsg { type: "alerts_batch"; version: number | null; items: { event: string; alert: Alert }[] }
export interface SelectedMsg {
  type: "selected"; hex: string; state: AircraftState | null;
  prediction: { available: boolean; reason: PredictionReason | null } | null; route: RouteInfo | null;
}
export interface ErrorMsg { type: "error"; code: string; detail: string | null }
export interface DemandMsg { type: "demand"; hot: HotDemand | null; focus: FocusDemand | null }
export interface SigmetsMsg { type: "sigmets"; v: number | null; fetched_at: string | null; provider: string | null; collection: SigmetCollection }
export interface RadarMsg { type: "radar"; frames: RadarFrames }
export interface StatusMsg { type: "status"; status: PublicStatus }
export interface PingMsg { type: "ping" | "pong" }
export interface ShipsSnapshotMsg { type: "ships_snapshot"; sseq: number; ts: string | null; ships: ShipLite[] }
export interface ShipsDiffMsg { type: "ships_diff"; sseq: number; ts: string | null; upsert: ShipLite[]; remove: string[] }
export interface ShipsGridMsg { type: "ships_grid"; ts: string | null; cell_deg: number | null; capped: boolean; cells: ShipGridCell[] }
export interface ShipSelectedMsg {
  type: "ship_selected"; mmsi: string; state: ShipState | null; static: ShipStatic | null; destination_info: DestinationInfo | null;
}
export type ServerMsg = WelcomeMsg | SnapshotMsg | DiffMsg | AlertsMsg | AlertsBatchMsg | SelectedMsg | ErrorMsg | DemandMsg | SigmetsMsg
  | RadarMsg | StatusMsg | PingMsg | ShipsSnapshotMsg | ShipsDiffMsg | ShipsGridMsg | ShipSelectedMsg;

/** ok: 적용할 메시지(dropped = 버린 원소 수, where = 처음 버린 곳) · invalid: 봉투가 틀림(버림) · unknown: 모르는 type(무시) */
export type Validated =
  | { kind: "ok"; msg: ServerMsg; dropped: number; where: string | null }
  | { kind: "invalid"; type: string; reason: string }
  | { kind: "unknown"; type: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStr = (v: unknown): v is string => typeof v === "string";
const numIn = (lo: number, hi: number) => (v: unknown) => isNum(v) && v >= lo && v <= hi;
const strMax = (max: number) => (v: unknown) => isStr(v) && v.length <= max;
/** 시각 문자열(ISO-8601) — Date 가 읽을 수 있어야 한다 */
const isTime = (v: unknown) => isStr(v) && v.length <= 40 && !Number.isNaN(Date.parse(v));
/** 없음(undefined · null) = 모름 → 통과, 있으면 검사 */
const opt = (v: unknown, ok: (x: unknown) => boolean) => v == null || ok(v);
const HEX_RE = /^[0-9a-f]{6}$/;
const SQUAWK_RE = /^[0-7]{4}$/;
const isHex = (v: unknown): v is string => isStr(v) && HEX_RE.test(v);
const lat = numIn(-90, 90), lon = numIn(-180, 180);
const nonNegInt = (v: unknown): v is number => isInt(v) && (v as number) >= 0;
const posInt = (v: unknown): v is number => isInt(v) && (v as number) >= 1;
const s4 = strMax(4), s8 = strMax(8), s16 = strMax(16), s32 = strMax(32), s64 = strMax(64);
const alt = numIn(-2000, 100_000), gs = numIn(0, 2000), deg360 = numIn(0, 360), quality = numIn(0, 2);
const seenAt = (v: unknown) => isTime(v) || isNum(v); // 숫자 = epoch 초(호환 — lib/interpolate seenAtMs)

/** 봉투 오류 — validateServerMessage 가 잡아 {kind:"invalid"} 로 */
class Bad extends Error {}
function need(ok: boolean, what: string): void { if (!ok) throw new Bad(what); }

/** 버린 원소 세기(처음 버린 곳만 기억 — 상태 표시의 "마지막 사유") */
class Drops {
  n = 0;
  where: string | null = null;
  drop(where: string, n = 1) { if (n > 0) { this.n += n; this.where ??= where; } }
}

/** 배열에서 ok 인 원소만. 모두 통과하면 같은 배열(복사 없음) */
function keep<T>(arr: unknown[], ok: (x: unknown) => boolean, d: Drops, where: string): T[] {
  let out: unknown[] | null = null;
  for (let i = 0; i < arr.length; i++) {
    if (ok(arr[i])) { out?.push(arr[i]); continue; }
    out ??= arr.slice(0, i);
    d.drop(`${where}[${i}]`);
  }
  return (out ?? arr) as T[];
}

/** parse 가 null 을 돌려주는 원소는 버린다(parse 결과 — 새 객체) */
function parsed<T>(arr: unknown[], parse: (x: unknown) => T | null, d: Drops, where: string): T[] {
  const out: T[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = parse(arr[i]);
    if (v != null) out.push(v); else d.drop(`${where}[${i}]`);
  }
  return out;
}

function arr(m: Obj, k: string): unknown[] {
  const v = m[k];
  need(Array.isArray(v), `${k} is not an array`);
  return v as unknown[];
}

/** 항공기 하나(WsMessages.encode — LITE · WORLD · FULL). 모르는 값은 키가 없거나 null. */
export function isAircraft(a: unknown): a is AircraftState {
  if (!isObj(a) || !isHex(a.hex) || !lat(a.lat) || !lon(a.lon)) return false;
  return opt(a.callsign, s16) && opt(a.registration, s16) && opt(a.type_code, s8) && opt(a.category, s4)
    && opt(a.alt_ft, alt) && opt(a.gs_kt, gs) && opt(a.track_deg, deg360) && opt(a.vrate_fpm, isNum) && opt(a.on_ground, isBool)
    && opt(a.squawk, (v) => isStr(v) && SQUAWK_RE.test(v)) && opt(a.seen_at, seenAt) && opt(a.provider, s32) && opt(a.fetched_at, isTime)
    && opt(a.quality, quality) && opt(a.estimated, isBool);
}

const ALERT_KINDS: ReadonlySet<unknown> = new Set(["OBSERVED", "PREDICTED"]);
/** AlertStateMachine.EventType 이름 그대로(SIGMET_ENDED 포함 — 목록에서 빼는 이벤트) */
const ALERT_EVENTS: ReadonlySet<unknown> = new Set(["ENTERED", "LEFT", "LOST", "SIGMET_ENDED", "PREDICTED", "PREDICTION_UPDATED", "PREDICTION_CLEARED"]);
export function isAlert(a: unknown): a is Alert {
  if (!isObj(a) || !isInt(a.id) || !ALERT_KINDS.has(a.kind) || !isHex(a.hex)) return false;
  return isStr(a.sigmet_id) && isStr(a.fir_id) && isStr(a.hazard) && isTime(a.entered_at) && isObj(a.evidence) && isBool(a.estimated)
    && opt(a.callsign, s16) && opt(a.qualifier, s32) && opt(a.left_at, isTime) && opt(a.close_reason, s32) && opt(a.eta_s, isNum)
    && opt(a.eta_at, isTime) && opt(a.alt_ft, isNum);
}

const PREDICTION_REASONS: ReadonlySet<unknown> = new Set(["turning", "slow", "on_ground", "no_track", "stale"]);

function isPosition(p: unknown): boolean {
  return Array.isArray(p) && p.length >= 2 && lon(p[0]) && lat(p[1]);
}
/** GeoJSON MultiPolygon: 폴리곤 ≥ 1, 고리 ≥ 1, 고리마다 좌표 ≥ 4 */
function isMultiPolygon(g: unknown): boolean {
  if (!isObj(g) || g.type !== "MultiPolygon" || !Array.isArray(g.coordinates) || g.coordinates.length === 0) return false;
  return g.coordinates.every((poly) => Array.isArray(poly) && poly.length > 0
    && poly.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(isPosition)));
}
/** SIGMET Feature(SigmetGeoJson) — 화면이 쓰는 값만 형식을 본다. geometry null = 판정 제외(폴리곤 없음) */
function isSigmetFeature(f: unknown): boolean {
  if (!isObj(f) || f.type !== "Feature" || !(f.geometry === null || isMultiPolygon(f.geometry))) return false;
  const p = f.properties;
  if (!isObj(p) || !isStr(p.id) || !p.id || !isStr(p.fir_id) || !isStr(p.hazard) || !isTime(p.valid_from) || !isTime(p.valid_to) || !isStr(p.raw_text)) return false;
  return opt(p.series_id, isStr) && opt(p.fir_name, isStr) && opt(p.qualifier, isStr) && opt(p.provider, isStr) && opt(p.fetched_at, isTime)
    && opt(p.base_ft, isNum) && opt(p.top_ft, isNum) && opt(p.active, isBool) && opt(p.expiring_soon, isBool)
    && opt(p.base_source, isStr) && opt(p.top_source, isStr) && opt(p.excluded_reason, isStr);
}

function isRadarFrame(f: unknown): boolean {
  return isObj(f) && isNum(f.time) && isStr(f.path);
}

/** 봉투의 선택 키: 없으면(모름) null, 있으면 ok 여야 한다 */
function optKey<T>(m: Obj, k: string, ok: (v: unknown) => boolean): T | null {
  const v = m[k];
  if (v == null) return null;
  need(ok(v), `${k} has a wrong type`);
  return v as T;
}

function source(v: unknown, k: string): SourceInfo | null {
  if (v == null) return null;
  need(isObj(v), `sources.${k} is not an object`);
  return v as SourceInfo;
}

/** 17종(schemas/ws/server.v1.json 의 type) — 빠진 종류가 있으면 아래 표가 형 검사에서 걸린다 */
type ServerType = ServerMsg["type"];

const VALIDATORS: Record<ServerType, (m: Obj, d: Drops) => ServerMsg> = {
  welcome: (m) => {
    optKey(m, "session_id", s64);
    optKey(m, "snapshot_version", nonNegInt);
    optKey(m, "limits", isObj);
    return { type: "welcome", server_time: optKey<string>(m, "server_time", isTime) };
  },
  snapshot: (m, d) => {
    need(posInt(m.seq), "seq is not a positive integer");
    const src = optKey<Obj>(m, "sources", isObj);
    optKey(m, "sigmets_version", nonNegInt);
    return {
      type: "snapshot", seq: m.seq as number, v: optKey<number>(m, "v", nonNegInt), ts: optKey<string>(m, "ts", isTime),
      sources: src ? { region: source(src.region, "region"), global: source(src.global, "global") } : null,
      aircraft: keep<AircraftState>(arr(m, "aircraft"), isAircraft, d, "aircraft"),
    };
  },
  diff: (m, d) => {
    need(posInt(m.seq), "seq is not a positive integer");
    return {
      type: "diff", seq: m.seq as number, v: optKey<number>(m, "v", nonNegInt), ts: optKey<string>(m, "ts", isTime),
      upsert: keep<AircraftState>(arr(m, "upsert"), isAircraft, d, "upsert"),
      remove: keep<string>(arr(m, "remove"), isHex, d, "remove"),
    };
  },
  alerts: (m, d) => ({
    type: "alerts", version: optKey<number>(m, "version", nonNegInt), alerts: keep<Alert>(arr(m, "alerts"), isAlert, d, "alerts"),
  }),
  alerts_batch: (m, d) => ({
    type: "alerts_batch", version: optKey<number>(m, "version", nonNegInt),
    items: keep<{ event: string; alert: Alert }>(arr(m, "items"), (it) => isObj(it) && ALERT_EVENTS.has(it.event) && isAlert(it.alert), d, "items"),
  }),
  selected: (m, d) => {
    need(isHex(m.hex), "hex is not 6 lowercase hex digits");
    let state: AircraftState | null = null;
    if (m.state != null) {
      if (isAircraft(m.state)) state = m.state;
      else d.drop("state"); // 틀린 상태는 버린다(카드는 상태 없음으로)
    }
    const p = optKey<Obj>(m, "prediction", (v) => isObj(v) && isBool(v.available) && opt(v.reason, isStr));
    let route: RouteInfo | null = null;
    if (m.route != null) {
      route = parseRoute(m.route);
      if (!route) d.drop("route");
    }
    return {
      type: "selected", hex: m.hex as string, state, route,
      prediction: p ? { available: p.available === true, reason: PREDICTION_REASONS.has(p.reason) ? (p.reason as PredictionReason) : null } : null,
    };
  },
  error: (m) => {
    need(isStr(m.code), "code is not a string");
    return { type: "error", code: m.code as string, detail: optKey<string>(m, "detail", isStr) };
  },
  demand: (m, d) => {
    const r = parseDemand(m, 0);
    if (m.hot != null && !r.hot) d.drop("hot");
    if (m.focus != null && !r.focus) d.drop("focus");
    return { type: "demand", hot: r.hot, focus: r.focus };
  },
  sigmets: (m, d) => {
    const c = m.collection;
    need(isObj(c) && (c.type === undefined || c.type === "FeatureCollection"), "collection is not a FeatureCollection");
    const coll = c as Obj;
    const features = keep<unknown>(arr(coll, "features"), isSigmetFeature, d, "collection.features");
    optKey(m, "computed_at", isTime);
    return {
      type: "sigmets", v: optKey<number>(m, "v", nonNegInt), fetched_at: optKey<string>(m, "fetched_at", isTime), provider: optKey<string>(m, "provider", isStr),
      collection: (features === coll.features ? coll : { ...coll, features }) as unknown as SigmetCollection,
    };
  },
  radar: (m, d) => {
    need(isStr(m.host), "host is not a string");
    need(isNum(m.generated), "generated is not a number");
    const past = keep<RadarFrames["past"][number]>(arr(m, "past"), isRadarFrame, d, "past");
    const fetched = optKey<string>(m, "fetched_at", isTime), provider = optKey<string>(m, "provider", isStr);
    return {
      type: "radar",
      frames: { host: m.host as string, generated: m.generated as number, past, ...(fetched ? { fetched_at: fetched } : {}), ...(provider ? { provider } : {}) },
    };
  },
  status: (m) => {
    const st = m.status;
    need(isObj(st), "status is not an object");
    const s = st as Obj;
    optKey(s, "server_time", isTime);
    optKey(s, "snapshot_version", nonNegInt);
    optKey(s, "fixture_mode", isBool);
    for (const k of ["sigmet", "radar", "engine", "demand", "sources", "radar_kr", "active_providers"]) optKey(s, k, isObj);
    optKey(s, "global", isObj);
    // 화면이 바로 그리는 값(상태 바 · 알림 목록 문구) — 틀린 형식이 화면 예외로 번지지 않게
    const region = optKey<Obj>(s, "region", isObj);
    if (region) {
      optKey(region, "center", (c) => Array.isArray(c) && c.length === 2 && lat(c[0]) && lon(c[1]));
      optKey(region, "radius_nm", isNum);
    }
    const sig = s.sigmet as Obj | undefined, eng = s.engine as Obj | undefined;
    if (sig) optKey(sig, "active", nonNegInt);
    if (eng) { optKey(eng, "index_polygons", nonNegInt); optKey(eng, "last_cycle_ms", isNum); }
    return { type: "status", status: s as unknown as PublicStatus };
  },
  ping: () => ({ type: "ping" }),
  pong: () => ({ type: "pong" }),
  ships_snapshot: (m, d) => {
    need(posInt(m.sseq), "sseq is not a positive integer");
    return { type: "ships_snapshot", sseq: m.sseq as number, ts: optKey<string>(m, "ts", isTime), ships: parsed(arr(m, "ships"), parseShipLite, d, "ships") };
  },
  ships_diff: (m, d) => {
    need(posInt(m.sseq), "sseq is not a positive integer");
    return {
      type: "ships_diff", sseq: m.sseq as number, ts: optKey<string>(m, "ts", isTime),
      upsert: parsed(arr(m, "upsert"), parseShipLite, d, "upsert"), remove: keep<string>(arr(m, "remove"), isMmsi, d, "remove"),
    };
  },
  ships_grid: (m, d) => {
    const g = parseGridCellsCounted(arr(m, "cells"));
    d.drop("cells", g.dropped);
    return {
      type: "ships_grid", ts: optKey<string>(m, "ts", isTime), cell_deg: optKey<number>(m, "cell_deg", (v) => isNum(v) && v > 0),
      capped: optKey<boolean>(m, "capped", isBool) === true, cells: g.cells,
    };
  },
  ship_selected: (m, d) => {
    need(isMmsi(m.mmsi), "mmsi is not 9 digits");
    const mmsi = m.mmsi as string;
    // 안쪽 mmsi 가 없으면 메시지의 것, 다르면 버린다(다른 선박의 값을 이 선박으로 보이지 않는다)
    const one = <T extends { mmsi: string }>(k: string, parse: (o: unknown) => T | null): T | null => {
      const v = m[k];
      if (v == null) return null;
      const r = isObj(v) ? parse({ mmsi, ...v }) : null;
      if (r && r.mmsi === mmsi) return r;
      d.drop(k);
      return null;
    };
    let dest: DestinationInfo | null = null;
    if (m.destination_info != null) {
      dest = parseDestinationInfo(m.destination_info);
      if (!dest) d.drop("destination_info");
    }
    return { type: "ship_selected", mmsi, state: one("state", parseShipState), static: one("static", parseShipStatic), destination_info: dest };
  },
};

/** 서버 메시지 하나(JSON.parse 결과)를 검사한다. 형식 오류는 결과로 돌려준다 — 예외는 검증기 자신의 결함뿐(lib/ws.ts 가 처리 예외로 잡는다). */
export function validateServerMessage(raw: unknown): Validated {
  if (!isObj(raw)) return { kind: "invalid", type: "?", reason: "not a JSON object" };
  const type = raw.type;
  if (!isStr(type)) return { kind: "invalid", type: "?", reason: "type is missing" };
  const v = (VALIDATORS as Partial<Record<string, (m: Obj, d: Drops) => ServerMsg>>)[type];
  if (!v || !Object.prototype.hasOwnProperty.call(VALIDATORS, type)) return { kind: "unknown", type: type.slice(0, 40) };
  const d = new Drops();
  try {
    return { kind: "ok", msg: v(raw, d), dropped: d.n, where: d.where && `${type}.${d.where}` };
  } catch (e) {
    if (e instanceof Bad) return { kind: "invalid", type, reason: e.message };
    throw e;
  }
}
