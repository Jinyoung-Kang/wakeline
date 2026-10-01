import { apiGet } from "./api";
import { isMmsi, notLiveText, parseCategory, shipCategory, type ShipCategory, type ShipLite, type ShipRow } from "./ships";

/**
 * 항공기 검색(GAP-12) 순수 로직 — GET /api/v1/aircraft/search?q= (hex·호출부호·등록번호 접두사, ≤ 20건).
 * 응답은 두 종류가 섞인다: 현재 스냅샷의 항공기(위치 있음 = 실시간), DB 의 과거 기록(hex·registration·type_code·last_seen, 위치 없음).
 * 없는 값은 null 로 두고 화면은 "—"(채우지 않는다).
 * 선박 검색(계약 v5 §B1 — GET /api/v1/ships/search): 상단 검색이 두 요청을 함께 보내고 결과를 두 묶음으로 보인다(components/AircraftSearch).
 * 두 검색 요청(searchAircraft · searchShips — web-review §3.1 의 엔드포인트 함수)도 여기 둔다: 상단 검색만 부르는 첫 로드 코드라, lib/endpoints 의 모듈로
 * 떼면 이 모듈을 두 곳이 부르게 되어 번들러가 한 덩이로 합치지 못하고 첫 화면 JS 가 약 320 B 늘었다(이 모듈의 내보내기 표).
 */
export interface SearchHit {
  hex: string;
  callsign: string | null;
  registration: string | null;
  type_code: string | null;
  alt_ft: number | null;
  /** null = 모름 */
  on_ground: boolean | null;
  lat: number | null;
  lon: number | null;
  /** 현재 스냅샷에 있어 위치를 안다 */
  live: boolean;
  last_seen: string | null;
  provider: string | null;
}

/** 서버 검사(2..10자)와 같은 규칙 + 허용 문자만. 공백은 지운다. 쓸 수 없으면 null. */
export function normalizeQuery(raw: string): string | null {
  const q = raw.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9-]{2,10}$/.test(q) ? q : null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

type Opts = { signal?: AbortSignal };

/** 항공기 검색 요청(q 는 normalizeQuery 를 거친 값 — 인코딩해 보낸다). { signal } 은 그대로 넘긴다 */
export function searchAircraft(q: string, o?: Opts): Promise<SearchHit[]> {
  return apiGet<unknown>(`/api/v1/aircraft/search?q=${encodeURIComponent(q)}`, o).then((body) => parseSearchResponse(body));
}

export function parseSearchResponse(body: unknown, max = 20): SearchHit[] {
  const items = body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const hex = str(r.hex)?.toLowerCase();
    if (!hex || !/^[0-9a-f]{6}$/.test(hex) || seen.has(hex)) continue; // 실시간 항목이 먼저 오므로 같은 hex 의 DB 항목은 버린다
    seen.add(hex);
    const lat = num(r.lat), lon = num(r.lon);
    const live = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    out.push({
      hex,
      callsign: str(r.callsign),
      registration: str(r.registration),
      type_code: str(r.type_code),
      alt_ft: num(r.alt_ft),
      on_ground: typeof r.on_ground === "boolean" ? r.on_ground : null,
      lat: live ? lat : null,
      lon: live ? lon : null,
      live,
      last_seen: str(r.last_seen) ?? str(r.seen_at),
      provider: str(r.provider),
    });
    if (out.length >= max) break;
  }
  return out;
}

// ---- 선박 검색(계약 v5 §B1 — GET /api/v1/ships/search?q=&limit=) ----

/**
 * 선박 검색 한 건. 실시간(live)이 아니면 위치·속력·관측 시각은 null — last_position_at = DB 에 저장된 마지막 위치 시각,
 * last_seen_at = 마지막 수신 기록(계약 v5 §G4 — 실시간이 아닐 때만, 실시간이면 seen_at 이 마지막 수신)
 */
export interface ShipHit {
  mmsi: string;
  name: string | null;
  call_sign: string | null;
  imo: number | null;
  ship_type: number | null;
  category: ShipCategory;
  live: boolean;
  lat: number | null;
  lon: number | null;
  sog_kn: number | null;
  seen_at: string | null;
  last_position_at: string | null;
  last_seen_at: string | null;
}

/** 선박 검색어 — api 와 같은 규칙: 앞뒤 공백 제거·대문자, 2–40자 [A-Z0-9 .-/]. 쓸 수 없으면 null(요청하지 않는다) */
export function normalizeShipQuery(raw: string): string | null {
  const q = raw.trim().toUpperCase();
  return /^[A-Z0-9 .\-/]{2,40}$/.test(q) ? q : null;
}

/** 선박 검색 결과 상한(api limit 1–20) — 화면은 10건 요청 */
export const SHIP_SEARCH_LIMIT = 10;
const isoStr = (v: unknown) => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);
const intIn = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/**
 * /ships/search 응답 → 선박 목록. MMSI 9자리가 아니면 버리고 같은 MMSI 는 앞의 것(실시간이 먼저 온다)만.
 * 실시간이 아니면 서버가 무엇을 보냈든 위치·속력·관측 시각을 쓰지 않는다(위치를 지어내지 않는다). 실시간이어도 좌표가 틀리면 위치 모름.
 * 선종 분류는 코드가 있으면 웹 표(shipCategory — api 와 같은 표로 시험), 없으면 서버가 준 분류 이름.
 */
export function parseShipSearchResponse(body: unknown, max = 20): ShipHit[] {
  const items = body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];
  const out: ShipHit[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    if (!isMmsi(r.mmsi) || seen.has(r.mmsi)) continue;
    seen.add(r.mmsi);
    const live = r.live === true;
    const lat = live ? num(r.lat) : null, lon = live ? num(r.lon) : null;
    const pos = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    const shipType = intIn(r.ship_type, 0, 255);
    const sog = live ? num(r.sog_kn) : null;
    out.push({
      mmsi: r.mmsi,
      name: str(r.name)?.slice(0, 32) ?? null,
      call_sign: str(r.call_sign)?.slice(0, 16) ?? null,
      imo: intIn(r.imo, 1_000_000, 1_073_741_823),
      ship_type: shipType,
      category: shipType != null ? shipCategory(shipType) : parseCategory(r.category),
      live,
      lat: pos ? lat : null,
      lon: pos ? lon : null,
      sog_kn: sog != null && sog >= 0 && sog <= 102.2 ? sog : null,
      seen_at: live ? isoStr(r.seen_at) : null,
      last_position_at: isoStr(r.last_position_at),
      last_seen_at: live ? null : isoStr(r.last_seen_at),
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 선박 검색 요청(q 는 normalizeShipQuery 를 거친 값 — 인코딩해 보낸다, 화면 상한 SHIP_SEARCH_LIMIT). dbUnavailable = 선박 DB 없이 실시간 목록에서만 찾았다.
 * { signal } 은 그대로 넘긴다
 */
export function searchShips(q: string, o?: Opts): Promise<{ hits: ShipHit[]; dbUnavailable: boolean }> {
  return apiGet<unknown>(`/api/v1/ships/search?q=${encodeURIComponent(q)}&limit=${SHIP_SEARCH_LIMIT}`, o)
    .then((body) => ({ hits: parseShipSearchResponse(body), dbUnavailable: shipSearchDbUnavailable(body) }));
}

/** 선박 검색이 DB 없이 답했다(api meta.db_unavailable) — 실시간 목록에서만 찾았고 실시간이 아닌 선박·마지막 저장 시각은 빠졌다 */
export function shipSearchDbUnavailable(body: unknown): boolean {
  const meta = body && typeof body === "object" ? (body as { meta?: unknown }).meta : null;
  return !!meta && typeof meta === "object" && (meta as { db_unavailable?: unknown }).db_unavailable === true;
}
export const SHIP_SEARCH_DB_NOTE = "선박 DB 일시 사용 불가 — 실시간 목록에서만 찾았습니다(실시간이 아닌 선박·마지막 저장 시각은 빠짐)";

/** 검색 결과 → 표 한 줄(항해 상태는 검색 응답에 없다 — 지도 목록 사본에 있으면 그 값, 없으면 모름) */
export function shipRowFromHit(h: ShipHit, listed: Pick<ShipLite, "nav_status"> | null | undefined): ShipRow {
  return {
    mmsi: h.mmsi, name: h.name, category: h.category, sog_kn: h.sog_kn, nav_status: h.live ? listed?.nav_status ?? null : null, live: h.live, seen_at: h.seen_at,
    last_position_at: h.last_position_at, last_seen_at: h.last_seen_at,
  };
}

/**
 * 선박을 고른 뒤 할 일(계약 v5 §B3): 실시간이고 위치를 알면(검색 결과 → 지도 목록 사본) 지도를 옮긴다. 실시간이 아니면 카드만 —
 * "실시간 아님 · 마지막 수신 hh:mm · 마지막 저장 hh:mm"(§G4) 을 알리고 옮기지 않는다(마지막 저장 위치를 지금 위치처럼 쓰지 않는다).
 */
export function shipChoice(h: ShipHit, listed: { lat: number; lon: number } | null | undefined, nowMs: number): { fly: [number, number] | null; message: string } {
  const name = h.name ?? `MMSI ${h.mmsi}`;
  if (!h.live) return { fly: null, message: `${name} 선택 — ${notLiveText({ lastSeenAt: h.last_seen_at, lastPositionAt: h.last_position_at }, nowMs)} · 카드만(지도에 위치를 그리지 않음)` };
  const pos: [number, number] | null = h.lat != null && h.lon != null ? [h.lon, h.lat] : listed ? [listed.lon, listed.lat] : null;
  return pos ? { fly: pos, message: `${name} 선택 — 지도 이동` } : { fly: null, message: `${name} 선택 — 현재 위치 모름(지도 이동 안 함)` };
}

/** 목록 키보드 이동: -1 = 선택 없음. 끝에서 처음으로 돈다. */
export function moveActive(cur: number, delta: 1 | -1, n: number): number {
  if (n <= 0) return -1;
  if (cur < 0) return delta > 0 ? 0 : n - 1;
  return (cur + delta + n) % n;
}

/** 입력 중인 요소에서는 "/" 단축키를 가로채지 않는다 */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof el !== "object") return false;
  const e = el as { tagName?: string; isContentEditable?: boolean };
  const tag = (e.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.isContentEditable === true;
}
