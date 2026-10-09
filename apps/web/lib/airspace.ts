/**
 * 공역 레이어(계약 v5 §G47 · ADR-034 · SPEC F1) — api GET /api/v1/airspace(켜진 차수 하나 — 국토교통부 공역정보 지도자료, AIP 차수 기준)를 지도에 그린다.
 * 레이어를 켤 때만 받는 조각이다(ADR-026 — components/AirspaceLayer).
 * - 자료: 국토교통부 저작물 — 출처 · 기준 차수를 상태 줄과 툴팁에 늘 적는다. AIRAC 최신 여부는 확인하지 않는다(그렇다고 적는다).
 * - 종류: api 의 category(폴더에서 정한 코드). 기본으로 보이는 것은 판정에 쓰는 통제 공역(금지 · 원전 · 안보 · 제한)과 위험구역 — 나머지는 상태 칸의 단추로 켠다
 *   (이 브라우저에만 저장 — wakeline.airspaceTypes). 모르는 종류(other)도 그린다(회색).
 * - 고도: 정규화 값 + 기준(해면 · FL · 지면 기준 · 지면 · 무제한 · 모름)과 원문 — 기준을 숨기지 않는다. 지면 기준 한계는 '지형 높이를 더해야 해면 고도'라 적는다.
 * - 색 · 선 모양은 표시용 선택값(잰 값 아님). SIGMET(위험기상) · 연안 교통량 · 관측 수신 범위와 겹쳐 보이게 채움은 옅게.
 */
import type * as GeoJSON from "geojson";
import { AIRSPACE_FILL_LAYER, AIRSPACE_LINE_LAYER } from "./airspace-meta";
import { EtagPoller, POLL_NONE, watchVisible, type Fetcher, type PollState, type WatchVisible } from "./etag-poller";
import { fmtKstMinute } from "./time";
import type { Tip } from "./tooltip";

export const AIRSPACE_URL = "/api/v1/airspace";
/** 조회 주기(선택값): 차수는 운영자가 가져올 때만 바뀐다(api 가 60 s 마다 확인) */
export const AIRSPACE_POLL_MS = 600_000;
export const AIRSPACE_VISIBLE_MIN_GAP_MS = 60_000;
export const AIRSPACE_SOURCE = "airspace";
export const AIRSPACE_LABEL_LAYER = "airspace-label";
export const AIRSPACE_LAYERS = [AIRSPACE_FILL_LAYER, AIRSPACE_LINE_LAYER, AIRSPACE_LABEL_LAYER] as const;
/** 이름표(식별자)를 보이는 줌 — 그보다 멀면 글이 겹친다(선택값) */
export const AIRSPACE_LABEL_MINZOOM = 8;
export const AIRSPACE_PREFS_KEY = "wakeline.airspaceTypes";

export type AirspaceBasis = "MSL" | "FL" | "AGL" | "SFC" | "UNL" | "UNKNOWN";
export interface AirspaceLimit { ft: number | null; basis: AirspaceBasis; raw: string }
export interface AirspaceProps {
  id: number; category: string; type_ko: string; ident?: string; name: string; label: string; class_code?: string; kind: "polygon" | "line";
  lower: AirspaceLimit; upper: AirspaceLimit;
}
export interface AirspaceEdition { id: number; label: string; documentName: string | null; importedAt: string }
export interface Airspace {
  edition: AirspaceEdition | null;
  source: string;
  features: GeoJSON.Feature<GeoJSON.Geometry, AirspaceProps>[];
  /** 모양이 틀려 뺀 도형 수 */
  dropped: number;
}

/** 종류 → 화면 이름 · 색 · 점선 · 기본 켜짐 · 순서(단추 줄). 모르는 종류는 OTHER_STYLE */
export interface CategoryStyle { label: string; color: string; dash: boolean; on: boolean }
export const CATEGORY_STYLES: Readonly<Record<string, CategoryStyle>> = {
  prohibited: { label: "비행금지", color: "#e5484d", dash: false, on: true },
  nuclear: { label: "원전 임시금지", color: "#f76b15", dash: false, on: true },
  security: { label: "안보 임시금지", color: "#f76b15", dash: true, on: true },
  restricted: { label: "비행제한", color: "#ffc53d", dash: false, on: true },
  danger: { label: "위험구역", color: "#d6409f", dash: true, on: true },
  alert: { label: "경계구역", color: "#ab4aba", dash: true, on: false },
  moa: { label: "군작전", color: "#8e4ec6", dash: true, on: false },
  training: { label: "훈련", color: "#8e4ec6", dash: false, on: false },
  ultralight: { label: "초경량", color: "#46a758", dash: true, on: false },
  ctr: { label: "관제권", color: "#3e63dd", dash: false, on: false },
  atz: { label: "비행장교통구역", color: "#3e63dd", dash: true, on: false },
  cta: { label: "지역관제구역", color: "#0090ff", dash: true, on: false },
  class: { label: "공역등급", color: "#5b5bd6", dash: true, on: false },
  route: { label: "항공로", color: "#8d8d8d", dash: false, on: false },
  uncontrolled: { label: "비관제", color: "#8d8d8d", dash: true, on: false },
  fir: { label: "비행정보구역", color: "#b0b4ba", dash: true, on: false },
  adiz: { label: "방공식별구역", color: "#b0b4ba", dash: false, on: false },
};
export const OTHER_STYLE: CategoryStyle = { label: "기타", color: "#9ba1a6", dash: true, on: false };
export const styleOf = (c: string): CategoryStyle => CATEGORY_STYLES[c] ?? OTHER_STYLE;
export const DEFAULT_CATEGORIES: readonly string[] = Object.entries(CATEGORY_STYLES).filter(([, s]) => s.on).map(([k]) => k);

// ---- 해석 -------------------------------------------------------------------------------------------------------------

const BASES: readonly AirspaceBasis[] = ["MSL", "FL", "AGL", "SFC", "UNL", "UNKNOWN"];
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const GEOMS = new Set(["Polygon", "MultiPolygon", "LineString", "MultiLineString"]);

function limit(x: unknown): AirspaceLimit | null {
  if (!isObj(x) || !BASES.includes(x.basis as AirspaceBasis) || typeof x.raw !== "string") return null;
  const ft = x.ft == null ? null : typeof x.ft === "number" && Number.isFinite(x.ft) ? x.ft : undefined;
  if (ft === undefined) return null;
  return { ft, basis: x.basis as AirspaceBasis, raw: x.raw };
}

/** 응답 → 화면 값. 봉투가 틀리면 null(마지막 값을 둔다), 틀린 도형은 버리고 센다 */
export function parseAirspace(x: unknown): Airspace | null {
  if (!isObj(x) || x.type !== "FeatureCollection" || !Array.isArray(x.features) || typeof x.source !== "string") return null;
  let edition: AirspaceEdition | null = null;
  if (x.edition != null) {
    const e = x.edition;
    if (!isObj(e) || typeof e.id !== "number" || typeof e.label !== "string" || typeof e.imported_at !== "string") return null;
    edition = { id: e.id, label: e.label, documentName: str(e.document_name) ?? null, importedAt: e.imported_at };
  }
  const features: Airspace["features"] = [];
  let dropped = 0;
  for (const f of x.features) {
    const p = isObj(f) ? f.properties : null;
    const g = isObj(f) ? f.geometry : null;
    const lower = isObj(p) ? limit(p.lower) : null;
    const upper = isObj(p) ? limit(p.upper) : null;
    if (!isObj(p) || !isObj(g) || !GEOMS.has(g.type as string) || !Array.isArray(g.coordinates) || typeof p.id !== "number"
      || typeof p.category !== "string" || typeof p.name !== "string" || typeof p.label !== "string" || typeof p.type_ko !== "string"
      || (p.kind !== "polygon" && p.kind !== "line") || !lower || !upper) {
      dropped++;
      continue;
    }
    features.push({
      type: "Feature", id: p.id, geometry: g as unknown as GeoJSON.Geometry,
      properties: { id: p.id, category: p.category, type_ko: p.type_ko, ident: str(p.ident), name: p.name, label: p.label, class_code: str(p.class_code), kind: p.kind, lower, upper },
    });
  }
  return { edition, source: x.source, features, dropped };
}

// ---- 고도 글 ------------------------------------------------------------------------------------------------------------

const n0 = (v: number) => v.toLocaleString("en-US");

/** 한계 하나: 'FL180' · '5,000 ft(해면)' · '지면 기준 2,000 ft' · '지면' · '무제한' · '모름(원문)' */
export function limitText(l: AirspaceLimit): string {
  switch (l.basis) {
    case "SFC": return "지면";
    case "UNL": return "무제한";
    case "FL": return `FL${String(Math.round((l.ft ?? 0) / 100)).padStart(3, "0")}`;
    case "MSL": return `${n0(l.ft ?? 0)} ft(해면)`;
    case "AGL": return `지면 기준 ${n0(l.ft ?? 0)} ft`;
    default: return l.raw ? `모름(${l.raw})` : "모름";
  }
}

/** 고도 범위 'SFC – FL180' 꼴 + 판정 주석(지면 기준 · 모름은 고도를 비교하지 않는다) */
export function bandText(lo: AirspaceLimit, hi: AirspaceLimit): { text: string; note: string | null } {
  const text = `${limitText(lo)} – ${limitText(hi)}`;
  if (lo.basis === "AGL" || hi.basis === "AGL") return { text, note: "지면 기준 한계 — 지형 높이를 더해야 해면 고도(이 서비스는 지형 자료가 없어 고도로 판정하지 않음)" };
  if (lo.basis === "UNKNOWN" || hi.basis === "UNKNOWN") return { text, note: "고도 기준을 알 수 없음 — 고도로 판정하지 않음" };
  return { text, note: null };
}

// ---- 지도 ---------------------------------------------------------------------------------------------------------------

interface LayerHost {
  addSource(id: string, spec: unknown): unknown;
  addLayer(spec: unknown, before?: string): unknown;
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
}

const matchColor = (): unknown[] => ["match", ["get", "category"], ...Object.entries(CATEGORY_STYLES).flatMap(([k, s]) => [k, s.color]), OTHER_STYLE.color];
const DASHED = Object.entries(CATEGORY_STYLES).filter(([, s]) => s.dash).map(([k]) => k);

/**
 * GeoJSON 소스 하나 + 채움(다각형 — 옅게) · 선(다각형 테두리와 항로 — 종류별 실선/점선은 두 레이어 대신 한 레이어에서 굵기로 가른다) · 이름표(줌 8+).
 * before 아래에 끼운다(상황판: 레이더 자리 아래 — 레이더 · SIGMET · 선박 · 항공기가 위).
 */
export function addAirspaceLayers(map: LayerHost, before?: string): void {
  if (map.getSource(AIRSPACE_SOURCE)) return;
  map.addSource(AIRSPACE_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "id", tolerance: 0.2 });
  map.addLayer({
    id: AIRSPACE_FILL_LAYER, type: "fill", source: AIRSPACE_SOURCE, filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": matchColor(), "fill-opacity": 0.08, "fill-antialias": false },
  }, before);
  map.addLayer({
    id: AIRSPACE_LINE_LAYER, type: "line", source: AIRSPACE_SOURCE,
    paint: {
      "line-color": matchColor(), "line-opacity": 0.8,
      "line-width": ["case", ["in", ["get", "category"], ["literal", DASHED]], 0.8, 1.4],
    },
  }, before);
  map.addLayer({
    id: AIRSPACE_LABEL_LAYER, type: "symbol", source: AIRSPACE_SOURCE, minzoom: AIRSPACE_LABEL_MINZOOM, filter: ["==", ["geometry-type"], "Polygon"],
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 10, "symbol-placement": "point" },
    paint: { "text-color": matchColor(), "text-halo-color": "#0b0d0f", "text-halo-width": 1 },
  }, before);
}

/** 보이는 종류만 — 세 레이어에 같은 거르기(채움 · 이름표는 다각형만 — 위의 기하 조건과 함께) */
export function categoryFilter(cats: readonly string[]): { all: unknown[]; polygons: unknown[] } {
  const inCats = ["in", ["get", "category"], ["literal", [...cats]]];
  return { all: inCats, polygons: ["all", ["==", ["geometry-type"], "Polygon"], inCats] };
}

// ---- 툴팁 · 상태 줄 ------------------------------------------------------------------------------------------------------

/** 지도 툴팁(공역 하나) — 이름 · 종류 · 고도 범위(기준) · 기준 차수 · 출처 */
export function airspaceTip(p: Record<string, unknown>, a: Airspace | null): Tip | null {
  if (typeof p.id !== "number" && typeof p.id !== "string") return null;
  const f = a?.features.find((x) => String(x.properties.id) === String(p.id));
  if (!f) return null;
  const q = f.properties;
  const band = bandText(q.lower, q.upper);
  const rows: [string, string][] = [
    ["종류", q.type_ko + (q.class_code ? ` · 등급 ${q.class_code}` : "")],
    ["고도", band.text],
    ["원문", `${q.lower.raw || "—"} / ${q.upper.raw || "—"}`],
    ["기준", a?.edition ? `${a.edition.label} · 국토교통부` : "—"],
  ];
  const flags: Tip["flags"] = [{ text: "AIRAC 최신 여부 확인 안 함", tone: "muted" }];
  if (band.note) flags.push({ text: band.note, tone: "warn" });
  return { title: q.ident ? `${q.ident} ${q.name !== q.ident ? q.name : ""}`.trim() : q.name, subtitle: q.kind === "line" ? "항로 선" : undefined, rows, flags };
}

export interface AirspaceStatusLine { text: string; tone: "ok" | "warn" | "bad" | "muted" }

/** 상태 줄: 기준 차수 · 출처 · 그린 도형 수 / 자료 없음 / 조회 실패 */
export function airspaceStatusLine(a: Airspace | null, error: string | null, shown: number | null): AirspaceStatusLine {
  if (!a) return error ? { text: `조회 실패(${error})`, tone: "bad" } : { text: "받는 중…", tone: "muted" };
  if (!a.edition) return { text: "공역 자료 없음 — 운영자가 가져오기 필요(make airspace-import)", tone: "warn" };
  const parts = [`${a.edition.label} 기준 · 국토교통부 · 최신 여부 확인 안 함`, `가져옴 ${fmtKstMinute(a.edition.importedAt, { date: true })}`];
  if (shown != null) parts.push(`그린 도형 ${n0(shown)}/${n0(a.features.length)}`);
  if (a.dropped > 0) parts.push(`형식 오류로 뺀 도형 ${n0(a.dropped)}`);
  const err = error ? ` · 조회 실패(${error}) — 마지막 값` : "";
  return { text: parts.join(" · ") + err, tone: error || a.dropped > 0 ? "warn" : "ok" };
}

// ---- 종류 선택 저장(이 브라우저에만) ---------------------------------------------------------------------------------------------

/** 저장된 종류 목록 — 없거나 깨졌으면 null(기본값을 쓴다). 저장소를 쓸 수 없어도 던지지 않는다 */
export function loadCategories(storage: Pick<Storage, "getItem"> | null = safeStorage()): string[] | null {
  try {
    const raw = storage?.getItem(AIRSPACE_PREFS_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return [...new Set(v.filter((c): c is string => typeof c === "string" && /^[a-z_]{1,32}$/.test(c)))];
  } catch {
    return null;
  }
}

export function saveCategories(cats: readonly string[], storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(AIRSPACE_PREFS_KEY, JSON.stringify([...cats]));
  } catch {
    /* 저장 못 해도 이번 화면은 그대로 */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 단추 줄에 보일 종류: 표의 순서 + 자료에 있는 모르는 종류(other 등 — 이름은 자료의 type_ko, 곧 원본 폴더 이름: 여럿이면 '·' 로 잇는다).
 * 모르는 종류를 짐작해 다른 이름을 붙이지 않는다.
 */
export function categoriesPresent(a: Airspace | null): { code: string; label: string }[] {
  const names = new Map<string, Set<string>>();
  for (const f of a?.features ?? []) {
    const s = names.get(f.properties.category) ?? new Set<string>();
    s.add(f.properties.type_ko);
    names.set(f.properties.category, s);
  }
  const known = Object.keys(CATEGORY_STYLES).filter((k) => names.has(k)).map((k) => ({ code: k, label: CATEGORY_STYLES[k].label }));
  const unknown = [...names.keys()].filter((k) => !(k in CATEGORY_STYLES)).sort().map((k) => ({ code: k, label: [...names.get(k)!].sort().join("·") }));
  return [...known, ...unknown];
}

// ---- 조회 ---------------------------------------------------------------------------------------------------------------

export type AirspacePollState = PollState<Airspace>;
export const AIRSPACE_POLL_NONE: AirspacePollState = POLL_NONE;

/** 레이어가 켜져 있는 동안만 도는 ETag 조회기(lib/etag-poller) — GeoJSON 으로 답하므로 Accept 를 그렇게 보낸다(아니면 406) */
export function airspacePoller(
  publish: (s: AirspacePollState) => void,
  initial: AirspacePollState = AIRSPACE_POLL_NONE,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  hidden: () => boolean = () => typeof document !== "undefined" && document.hidden,
  now: () => number = () => Date.now(),
  watch: WatchVisible = watchVisible,
): EtagPoller<Airspace> {
  return new EtagPoller({ url: AIRSPACE_URL, parse: parseAirspace, intervalMs: AIRSPACE_POLL_MS, visibleMinGapMs: AIRSPACE_VISIBLE_MIN_GAP_MS,
    accept: "application/geo+json" }, publish, initial, fetcher, hidden, now, watch);
}
