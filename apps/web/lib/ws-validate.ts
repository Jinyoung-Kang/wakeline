/**
 * WS 서버 메시지 형태 검사(계약 v5 §E2 · ADR-020 · R-93) — schemas/ws/server.v1.json 을 손으로 옮긴 규칙(아래 규칙 표가 스키마의 $defs 와 1:1).
 * 런타임 JSON Schema 검증기는 싣지 않는다(첫 화면 번들 — NFR-04). tests/ws-schema-sweep-v5 가 스키마의 잎 제약을 모두 훑어 어긋남을 잡는다.
 * - 틀린 값은 세 가지로 다룬다(모두 수를 센다 — 상태 바):
 *   1) 메시지를 버린다({kind:"invalid"} — lib/ws.ts 가 보고하고 그 종류에 맞게 다시 받는다): 적용에 꼭 필요한 값 — type · seq/sseq · 원소 배열 ·
 *      알림 version · SIGMET collection · 레이더 host/generated/past · selected hex/prediction · ship_selected mmsi · error code · status 의 모든 값.
 *   2) 원소를 버린다: 배열 원소(항공기 · 선박 · 알림 · 배치 항목 · SIGMET · 레이더 프레임 · 격자 칸 · 삭제 목록)와 따로 버릴 수 있는 묶음
 *      (selected.state/route · demand.hot/focus · ship_selected.state/static/destination_info · 스냅샷 sources.region/global · 격자 칸 선종별 수).
 *   3) 그 값만 모름(null)으로: 화면이 참고로만 쓰는 값 — welcome 의 값 전부 · 메시지의 v/ts/fetched_at/provider/computed_at/sigmets_version ·
 *      ships_grid cell_deg/capped · error title/detail.
 * - 스키마보다 너그러운 곳은 "모름" 뿐이다: 없는 키 · null 값, 모르는 키(보지 않는다), 네 원소 격자 칸(구 서버 — 선종별 수 없음).
 *   스키마보다 엄격한 곳: 격자 칸 선종별 수의 합 = 칸 선박 수(스키마로 말할 수 없는 교차 규칙 — 틀리면 선종별 수만 버린다).
 * - 모르는 type 은 {kind:"unknown"}(무시 — 새 서버가 종류를 더해도 깨지지 않는다).
 * - 통과한 원소는 같은 객체 그대로(복사하지 않는다 — 9,000 대 스냅샷도 할당 없이). 버린 것이 있을 때만 새 배열.
 * tests/ws-validate-v5.test.ts: api 가 실제 빌더로 만든 표본(tests/fixtures/ws-samples.v1.json)을 모두 받고, 스키마 위반 표본은 버리는지.
 */
import { FOCUS_STATES, HOT_STATES, parseDemand, type FocusDemand, type HotDemand } from "./demand";
import { parseRoute, ROUTE_STATUSES, type RouteInfo } from "./route";
import {
  DEST_KINDS, isMmsi, parseDestinationInfo, parseGridCellsCounted, parseShipLite, parseShipState, parseShipStatic, SHIP_CATEGORIES,
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
export interface ShipsGridMsg { type: "ships_grid"; ts: string | null; cell_deg: number | null; capped: true | null; cells: ShipGridCell[] }
export interface ShipSelectedMsg {
  type: "ship_selected"; mmsi: string; state: ShipState | null; static: ShipStatic | null; destination_info: DestinationInfo | null;
}
export type ServerMsg = WelcomeMsg | SnapshotMsg | DiffMsg | AlertsMsg | AlertsBatchMsg | SelectedMsg | ErrorMsg | DemandMsg | SigmetsMsg
  | RadarMsg | StatusMsg | PingMsg | ShipsSnapshotMsg | ShipsDiffMsg | ShipsGridMsg | ShipSelectedMsg;

/** ok: 적용할 메시지(dropped = 버린 원소 · 값 수, where = 처음 버린 곳) · invalid: 메시지를 버림 · unknown: 모르는 type(무시) */
export type Validated =
  | { kind: "ok"; msg: ServerMsg; dropped: number; where: string | null }
  | { kind: "invalid"; type: string; reason: string }
  | { kind: "unknown"; type: string };

type Obj = Record<string, unknown>;
type Rule = (v: unknown) => boolean;

// ---------------------------------------------------------------- 규칙 조각(JSON Schema 키워드 하나씩)

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStr = (v: unknown): v is string => typeof v === "string";
/** number · minimum · maximum */
const num = (lo = -Infinity, hi = Infinity): Rule => (v) => isNum(v) && v >= lo && v <= hi;
/** integer · minimum · maximum(JSON 의 35000.0 은 정수 — 스키마와 같다) */
const int = (lo = -Infinity, hi = Infinity): Rule => (v) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
/** 코드포인트 수(스키마의 minLength · maxLength 단위 — JS 의 length 는 UTF-16 단위) */
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++, n++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++; // 대리 쌍 = 코드포인트 하나
    }
  }
  return n;
}
/** string · minLength · maxLength */
const str = (min = 0, max = Infinity): Rule => (v) => {
  if (typeof v !== "string") return false;
  if (min <= 1 && v.length >= min && v.length <= max) return true; // UTF-16 길이 ≥ 코드포인트 수 — 이 범위면 확실하다
  const n = codePoints(v);
  return n >= min && n <= max;
};
/** string · pattern */
const re = (r: RegExp): Rule => (v) => typeof v === "string" && r.test(v);
/** enum · const */
const oneOf = (...values: readonly unknown[]): Rule => {
  const set = new Set(values);
  return (v) => set.has(v);
};
/** array · items · minItems · maxItems */
const arrOf = (item: Rule, min = 0, max = Infinity): Rule => (v) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(item);
/** array · prefixItems(길이 고정) */
const tuple = (...items: Rule[]): Rule => (v) => Array.isArray(v) && v.length === items.length && items.every((r, i) => r(v[i]));
/** object · additionalProperties(값마다 같은 규칙) */
const mapOf = (item: Rule): Rule => (v) => isObj(v) && Object.keys(v).every((k) => v[k] == null || item(v[k]));

/**
 * object · properties · required. need 의 키는 값이 있어야 한다(웹이 적용에 쓰는 값 — 스키마의 required 중 일부). 규칙이 있는 키는 값이 있으면
 * (null 이 아니면 — null = 모름) 맞아야 한다. 모르는 키는 보지 않는다.
 */
function shape(rules: Record<string, Rule>, need: readonly string[] = []): (v: unknown) => v is Obj {
  const keys = Object.keys(rules), fns = keys.map((k) => rules[k]);
  return (v: unknown): v is Obj => {
    if (!isObj(v)) return false;
    for (const k of need) if (v[k] == null) return false;
    for (let i = 0; i < keys.length; i++) {
      const x = v[keys[i]];
      if (x != null && !fns[i](x)) return false;
    }
    return true;
  };
}

const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** 두 자리 숫자(모양은 RFC3339 가 이미 확인했다) */
const d2 = (s: string, i: number) => (s.charCodeAt(i) - 48) * 10 + s.charCodeAt(i + 1) - 48;
/**
 * format date-time(RFC 3339, 시간대 필수) + 달력에 있는 날짜 · 시각 — tools/contract_check.py(Python fromisoformat)와 같다. Date.parse 는 "9999" ·
 * 2월 30일 · 24시를 받는다(서버 시계 표본으로 쓰면 오프셋이 몇천 년 움직인다). 캡처 없는 정규식 + 자리 읽기(1만 대 스냅샷에서 Date.parse 보다 빠르다).
 */
export function isDateTime(v: unknown): v is string {
  if (typeof v !== "string" || !RFC3339.test(v)) return false;
  const y = d2(v, 0) * 100 + d2(v, 2), mo = d2(v, 5), d = d2(v, 8);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = mo === 2 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  if (d > MONTH_DAYS[mo - 1] + (leap ? 1 : 0) || d2(v, 11) > 23 || d2(v, 14) > 59 || d2(v, 17) > 59) return false;
  return v.charCodeAt(v.length - 1) === 90 /* Z */ || (d2(v, v.length - 5) <= 23 && d2(v, v.length - 2) <= 59);
}

// ---------------------------------------------------------------- 규칙 표(schemas/ws/server.v1.json 의 $defs)

const TIME: Rule = isDateTime;
const HEX = re(/^[0-9a-f]{6}$/), MMSI = re(/^[0-9]{9}$/);
const LAT = num(-90, 90), LON = num(-180, 180);
const VERSION = int(0);
const ANY_OBJ: Rule = isObj;

/** $defs/aircraft(스트림 스키마 aircraft_state.v1.json 과 같은 제약). estimated 는 스키마에 없다 — 있으면 참·거짓이어야 한다 */
const AIRCRAFT = shape({
  hex: HEX, callsign: str(0, 8), registration: str(0, 16), type_code: str(0, 8), category: str(0, 4), lat: LAT, lon: LON,
  alt_ft: int(-2000, 100_000), gs_kt: num(0), track_deg: num(0, 360), vrate_fpm: num(), on_ground: isBool, squawk: re(/^[0-7]{4}$/),
  seen_at: TIME, provider: oneOf("adsb_lol", "adsb_fi", "opensky", "fixture"), fetched_at: TIME, quality: oneOf(0, 1), estimated: isBool,
}, ["hex", "lat", "lon"]);
/** $defs/source(스냅샷 sources.region/global) */
const SOURCE = shape({ provider: str(1), fetched_at: TIME, lag_s: num(), stale: isBool });

/** AlertStateMachine.EventType 이름 그대로(SIGMET_ENDED 포함 — 목록에서 빼는 이벤트) */
const ALERT_EVENTS = ["ENTERED", "LEFT", "LOST", "SIGMET_ENDED", "PREDICTED", "PREDICTION_UPDATED", "PREDICTION_CLEARED"] as const;
/** $defs/alert */
const ALERT = shape({
  id: int(), kind: oneOf("OBSERVED", "PREDICTED"), hex: HEX, callsign: str(), sigmet_id: str(1), fir_id: str(1), hazard: str(1), qualifier: str(),
  entered_at: TIME, left_at: TIME, close_reason: oneOf("left", "signal_lost", "restart", "sigmet_ended", "prediction_cleared"), eta_s: int(), eta_at: TIME,
  alt_ft: int(), evidence: ANY_OBJ, estimated: isBool,
}, ["id", "kind", "hex", "sigmet_id", "fir_id", "hazard", "entered_at", "evidence", "estimated"]);
const ALERT_ITEM = shape({ event: oneOf(...ALERT_EVENTS), alert: ALERT }, ["event", "alert"]);

/** $defs/airport · route(계약 v4 §A) */
const AIRPORT = shape({
  icao: re(/^[A-Z0-9]{4}$/), iata: re(/^[A-Z0-9]{3}$/), name: str(1, 120), city: str(1, 80), country: str(1, 80), country_iso: re(/^[A-Z]{2}$/), lat: LAT, lon: LON,
}, ["icao", "name", "lat", "lon"]);
const AIRLINE_FIELDS = shape({ name: str(1, 120), icao: re(/^[A-Z0-9]{3}$/), iata: re(/^[A-Z0-9]{2}$/) });
const AIRLINE: Rule = (v) => AIRLINE_FIELDS(v) && Object.keys(v).length >= 1; // minProperties 1
const ROUTE = shape({
  status: oneOf(...ROUTE_STATUSES), callsign: str(1), airline: AIRLINE, origin: AIRPORT, destination: AIRPORT, midpoint: AIRPORT, fetched_at: TIME,
  source: oneOf("adsbdb"),
}, ["status"]);
const PREDICTION_REASONS = ["turning", "slow", "on_ground", "no_track", "stale"] as const;
const PREDICTION = shape({ available: isBool, reason: oneOf(...PREDICTION_REASONS) }, ["available"]);

/** $defs/demand 의 hot · focus(계약 v2 §A3) */
const HOT = shape({
  cell: re(/^(-?[0-9]{1,2}\.[05]):(-?[0-9]{1,3}\.[05]):(50|100|150|200|250)$/), radius_nm: int(50, 250), state: oneOf(...HOT_STATES),
  interval_s: int(1, 3600), last_success_at: TIME,
}, ["state"]);
const FOCUS = shape({ hex: HEX, state: oneOf(...FOCUS_STATES), interval_s: int(1, 3600), since: TIME, last_success_at: TIME }, ["hex", "state"]);

/** $defs/position · multipolygon · sigmet_properties · sigmets.collection.features[] */
const POSITION = tuple(LON, LAT);
const MULTIPOLYGON = shape({ type: oneOf("MultiPolygon"), coordinates: arrOf(arrOf(arrOf(POSITION, 4), 1), 1) }, ["type", "coordinates"]);
const SIGMET_PROPS = shape({
  id: str(1), fir_id: str(), fir_name: str(), issuer: str(), series_id: str(), hazard: str(), qualifier: str(), base_ft: int(0), top_ft: int(),
  base_source: oneOf("json", "assumed_surface"), top_source: oneOf("json", "raw_text", "raw_text_lower_bound", "unknown"), valid_from: TIME, valid_to: TIME,
  active: isBool, expiring_soon: isBool, move_dir: str(), move_spd: str(), chng: str(), excluded_reason: str(), raw_text: str(),
  provider: oneOf("awc_isigmet", "awc_airsigmet", "fixture"), fetched_at: TIME,
}, ["id", "fir_id", "hazard", "valid_from", "valid_to", "raw_text"]);
/** geometry null = 판정 제외(폴리곤 없음) — 키가 없으면 그릴 수 없으므로 버린다 */
const SIGMET_FEATURE: Rule = (f) => isObj(f) && f.type === "Feature" && (f.id == null || str(1)(f.id))
  && (f.geometry === null || MULTIPOLYGON(f.geometry)) && SIGMET_PROPS(f.properties);

/** $defs/radar.past[] */
const RADAR_FRAME = shape({ time: int(0), path: str() }, ["time", "path"]);

/** $defs/status.status — 화면(상태 바 · 알림 목록 · AIS 배지)이 바로 그리는 값이라 하나라도 틀리면 메시지를 버린다(이전 status 를 둔다) */
const STATUS_RULES: Record<string, Rule> = {
  server_time: TIME, snapshot_version: VERSION, fixture_mode: isBool, collector_mode_known: isBool,
  region: shape({ center: tuple(LAT, LON), radius_nm: int(1), provider: str(), aircraft: int(0), lag_s: num(), stale: isBool, fetched_at: TIME }),
  global: shape({ provider: str(), aircraft: int(0), lag_s: num(), stale: isBool, fetched_at: TIME }),
  sigmet: shape({ provider: str(), count: int(0), active: int(0), fetched_at: TIME, lag_s: num(), stale: isBool }),
  radar: shape({ provider: str(), frames: int(0), fetched_at: TIME, stale: isBool }),
  radar_kr: shape({ available: isBool, status: re(/^[1-5][0-9]{2}$/), latest_tm: re(/^[0-9]{12}$/), fetched_at: TIME, checked_at: TIME,
    stations: int(0, 48), stations_ref: int(0, 48), partial: isBool }), // ADR-021: 최신 프레임의 합성 지점 수 · 기준 · 부분 합성
  engine: shape({ index_polygons: int(0), last_cycle_ms: num(0) }),
  active_providers: mapOf(isStr),
  demand: shape({ hot_active: int(0), focus_active: int(0), adsb_fi_rps_1m: num(0) }),
  sources: shape({ ais: ANY_OBJ }),
};

/** $defs/welcome.limits(서버 설정값 — 웹은 쓰지 않는다) */
const LIMITS = shape({
  max_bbox_area: (v) => isNum(v) && v > 0, diff_interval_s: int(1), resync_interval_s: int(1), resync_world_interval_s: int(1),
  max_client_messages: int(1), client_message_window_s: int(1), hello_timeout_s: int(1),
});

/** $defs/ship_lite · ship_state · ship_static(스트림 스키마 ship_state/ship_static.v1.json 과 같은 제약). 선박 시각은 소수 9자리까지 */
const SHIP_TIME: Rule = (v) => isDateTime(v) && !/\.\d{10}/.test(v);
const SHIP_KINEMATICS = {
  mmsi: MMSI, lat: LAT, lon: LON, sog_kn: num(0, 102.2), cog_deg: (v: unknown) => isNum(v) && v >= 0 && v < 360, heading_deg: int(0, 359),
  nav_status: int(0, 15), position_source: oneOf("epfs", "manual", "estimated", "inoperative", "gnss"), seen_at: SHIP_TIME,
};
const SHIP_LITE = shape({ ...SHIP_KINEMATICS, ship_type: int(1, 99), name: str(1, 20) }, ["mmsi", "lat", "lon"]);
const SHIP_STATE = shape({
  ...SHIP_KINEMATICS, rot: int(-127, 127), provider: oneOf("aisstream", "fixture"),
  msg_type: oneOf("PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"), class: oneOf("A", "B"),
});
const DIM = int(0, 511);
const SHIP_STATIC = shape({
  mmsi: MMSI, name: str(1, 20), call_sign: str(1, 7), imo: int(1_000_000, 1_073_741_823), ship_type: int(1, 99), dim_a: DIM, dim_b: DIM, dim_c: DIM, dim_d: DIM,
  draught_m: (v) => isNum(v) && v > 0 && v <= 25.5, destination: str(1, 20), eta_month: int(1, 12), eta_day: int(1, 31), eta_hour: int(0, 23),
  eta_minute: int(0, 59), updated_at: SHIP_TIME, provider: oneOf("aisstream", "fixture"),
});
const DEST_PLACE = shape({ text: str(1), locode: re(/^[A-Z]{2} ?[A-Z0-9]{3}$/), name: str(), country: str(), subdivision: str(), ambiguous: isBool }, ["text"]);
const DEST_INFO = shape({ raw: str(1), kind: oneOf(...DEST_KINDS), from: DEST_PLACE, to: DEST_PLACE, places: arrOf(DEST_PLACE) }, ["raw", "kind"]);
/** $defs/ship_grid_cell 의 앞 네 원소(다섯째 — 선종별 수 — 는 lib/ships 가 보고 틀리면 그것만 버린다). 네 원소 칸 = 구 서버 */
const GRID_CELL: Rule = (c) => Array.isArray(c) && (c.length === 4 || c.length === 5) && LAT(c[0]) && LON(c[1]) && int(1)(c[2]) && oneOf(...SHIP_CATEGORIES)(c[3]);

// ---------------------------------------------------------------- 검사 도구

/** 메시지를 버리는 오류 — validateServerMessage 가 잡아 {kind:"invalid"} 로 */
class Bad extends Error {}
function need(ok: boolean, what: string): void { if (!ok) throw new Bad(what); }

/** 버린 원소 · 값 세기(처음 버린 곳만 기억 — 상태 표시의 "마지막 사유") */
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

/** 규칙을 통과하고 parse 가 값을 돌려준 원소만(parse 결과 — 새 객체) */
function parsed<T>(arr: unknown[], ok: Rule, parse: (x: unknown) => T | null, d: Drops, where: string): T[] {
  const out: T[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = ok(arr[i]) ? parse(arr[i]) : null;
    if (v != null) out.push(v); else d.drop(`${where}[${i}]`);
  }
  return out;
}

function arr(m: Obj, k: string): unknown[] {
  const v = m[k];
  need(Array.isArray(v), `${k} is not an array`);
  return v as unknown[];
}

/** 메시지를 버리는 선택 키: 없으면(모름) null, 있으면 맞아야 한다 */
function optKey<T>(m: Obj, k: string, ok: Rule): T | null {
  const v = m[k];
  if (v == null) return null;
  need(ok(v), `${k} has a wrong form`);
  return v as T;
}

/** 참고 값 · 따로 버릴 수 있는 묶음: 없으면 null, 맞으면 그 값, 틀리면 버리고 센다(null — 모름으로) */
function part<T>(m: Obj, k: string, ok: Rule, d: Drops, where = k): T | null {
  const v = m[k];
  if (v == null) return null;
  if (ok(v)) return v as T;
  d.drop(where);
  return null;
}

/** 항공기 하나(WsMessages.encode — LITE · WORLD · FULL). 모르는 값은 키가 없거나 null. */
export function isAircraft(a: unknown): a is AircraftState { return AIRCRAFT(a); }
export function isAlert(a: unknown): a is Alert { return ALERT(a); }

/** 17종(schemas/ws/server.v1.json 의 type) — 빠진 종류가 있으면 아래 표가 형 검사에서 걸린다 */
type ServerType = ServerMsg["type"];

const VALIDATORS: Record<ServerType, (m: Obj, d: Drops) => ServerMsg> = {
  // 웹은 server_time(시계 표본)만 쓴다 — 틀린 값은 세고 버리지만 핸드셰이크는 버리지 않는다(구독이 끊기지 않게)
  welcome: (m, d) => {
    part(m, "session_id", str(1), d);
    part(m, "snapshot_version", VERSION, d);
    part(m, "limits", LIMITS, d);
    return { type: "welcome", server_time: part<string>(m, "server_time", TIME, d) };
  },
  snapshot: (m, d) => {
    need(m.seq === 1, "seq is not 1");
    let sources: SnapshotMsg["sources"] = null;
    if (m.sources != null) {
      if (!isObj(m.sources)) d.drop("sources");
      else sources = { region: part<SourceInfo>(m.sources, "region", SOURCE, d, "sources.region"), global: part<SourceInfo>(m.sources, "global", SOURCE, d, "sources.global") };
    }
    part(m, "sigmets_version", VERSION, d);
    return {
      type: "snapshot", seq: 1, v: part<number>(m, "v", VERSION, d), ts: part<string>(m, "ts", TIME, d), sources,
      aircraft: keep<AircraftState>(arr(m, "aircraft"), AIRCRAFT, d, "aircraft"),
    };
  },
  diff: (m, d) => {
    need(int(2)(m.seq), "seq is not an integer ≥ 2");
    return {
      type: "diff", seq: m.seq as number, v: part<number>(m, "v", VERSION, d), ts: part<string>(m, "ts", TIME, d),
      upsert: keep<AircraftState>(arr(m, "upsert"), AIRCRAFT, d, "upsert"),
      remove: keep<string>(arr(m, "remove"), HEX, d, "remove"),
    };
  },
  alerts: (m, d) => ({
    type: "alerts", version: optKey<number>(m, "version", VERSION), alerts: keep<Alert>(arr(m, "alerts"), ALERT, d, "alerts"),
  }),
  alerts_batch: (m, d) => ({
    type: "alerts_batch", version: optKey<number>(m, "version", int(1)),
    items: keep<{ event: string; alert: Alert }>(arr(m, "items"), ALERT_ITEM, d, "items"),
  }),
  selected: (m, d) => {
    need(HEX(m.hex), "hex is not 6 lowercase hex digits");
    const state = part<AircraftState>(m, "state", AIRCRAFT, d); // 틀린 상태는 버린다(카드는 상태 없음으로)
    const p = optKey<Obj>(m, "prediction", PREDICTION);
    const r = part<Obj>(m, "route", ROUTE, d);
    return {
      type: "selected", hex: m.hex as string, state, route: r ? parseRoute(r) : null,
      prediction: p ? { available: p.available === true, reason: (p.reason as PredictionReason | undefined) ?? null } : null,
    };
  },
  error: (m, d) => {
    need(re(/^[A-Z][A-Z_]*$/)(m.code), "code is not an upper-case code");
    part(m, "title", isStr, d);
    return { type: "error", code: m.code as string, detail: part<string>(m, "detail", isStr, d) };
  },
  demand: (m, d) => {
    const r = parseDemand({ hot: part(m, "hot", HOT, d), focus: part(m, "focus", FOCUS, d) }, 0);
    return { type: "demand", hot: r.hot, focus: r.focus };
  },
  sigmets: (m, d) => {
    const c = m.collection;
    need(isObj(c) && (c.type == null || c.type === "FeatureCollection"), "collection is not a FeatureCollection");
    const coll = c as Obj;
    const features = keep<unknown>(arr(coll, "features"), SIGMET_FEATURE, d, "collection.features");
    part(m, "computed_at", TIME, d);
    return {
      type: "sigmets", v: part<number>(m, "v", VERSION, d), fetched_at: part<string>(m, "fetched_at", TIME, d), provider: part<string>(m, "provider", str(1), d),
      collection: (features === coll.features ? coll : { ...coll, features }) as unknown as SigmetCollection,
    };
  },
  radar: (m, d) => {
    need(isStr(m.host), "host is not a string");
    need(int(0)(m.generated), "generated is not a non-negative integer");
    const past = keep<RadarFrames["past"][number]>(arr(m, "past"), RADAR_FRAME, d, "past");
    const fetched = part<string>(m, "fetched_at", TIME, d), provider = part<string>(m, "provider", str(1), d);
    return {
      type: "radar",
      frames: { host: m.host as string, generated: m.generated as number, past, ...(fetched ? { fetched_at: fetched } : {}), ...(provider ? { provider } : {}) },
    };
  },
  status: (m) => {
    const st = m.status;
    need(isObj(st), "status is not an object");
    for (const k in STATUS_RULES) {
      const v = (st as Obj)[k];
      need(v == null || STATUS_RULES[k](v), `status.${k} has a wrong form`);
    }
    return { type: "status", status: st as unknown as PublicStatus };
  },
  ping: () => ({ type: "ping" }),
  pong: () => ({ type: "pong" }),
  ships_snapshot: (m, d) => {
    need(m.sseq === 1, "sseq is not 1");
    return { type: "ships_snapshot", sseq: 1, ts: part<string>(m, "ts", TIME, d), ships: parsed(arr(m, "ships"), SHIP_LITE, parseShipLite, d, "ships") };
  },
  ships_diff: (m, d) => {
    need(int(2)(m.sseq), "sseq is not an integer ≥ 2");
    return {
      type: "ships_diff", sseq: m.sseq as number, ts: part<string>(m, "ts", TIME, d),
      upsert: parsed(arr(m, "upsert"), SHIP_LITE, parseShipLite, d, "upsert"), remove: keep<string>(arr(m, "remove"), MMSI, d, "remove"),
    };
  },
  ships_grid: (m, d) => {
    const g = parseGridCellsCounted(keep<unknown>(arr(m, "cells"), GRID_CELL, d, "cells"));
    d.drop("cells", g.dropped); // 칸은 두고 선종별 수만 버린 것
    return {
      type: "ships_grid", ts: part<string>(m, "ts", TIME, d), cell_deg: part<number>(m, "cell_deg", oneOf(5, 2, 0.5), d),
      capped: part<true>(m, "capped", oneOf(true), d), // 선박 수 때문에 격자가 됐을 때만 true 로 온다(없으면 아님)
      cells: g.cells,
    };
  },
  ship_selected: (m, d) => {
    need(isMmsi(m.mmsi), "mmsi is not 9 digits");
    const mmsi = m.mmsi as string;
    // 안쪽 mmsi 가 없으면 메시지의 것, 다르면 버린다(다른 선박의 값을 이 선박으로 보이지 않는다)
    const one = <T extends { mmsi: string }>(k: string, ok: Rule, parse: (o: unknown) => T | null): T | null => {
      const v = m[k];
      if (v == null) return null;
      const r = isObj(v) && ok(v) ? parse({ mmsi, ...v }) : null;
      if (r && r.mmsi === mmsi) return r;
      d.drop(k);
      return null;
    };
    const dest = part<Obj>(m, "destination_info", DEST_INFO, d);
    return {
      type: "ship_selected", mmsi, state: one("state", SHIP_STATE, parseShipState), static: one("static", SHIP_STATIC, parseShipStatic),
      destination_info: dest ? parseDestinationInfo(dest) : null,
    };
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
