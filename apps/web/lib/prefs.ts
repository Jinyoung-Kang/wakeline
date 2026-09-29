/**
 * 이 브라우저에만 기억하는 화면 설정(계약 v2 §B4: 레이어 토글은 뷰어별 localStorage). 저장소가 없거나(사생활 보호 모드·차단)
 * 값이 깨져 있어도 화면은 기본값으로 동작한다 — 읽기·쓰기를 모두 try/catch 로 감싸고, 알려진 키의 boolean 만 받는다.
 */
import type { Layers } from "./ui-store";
import { SHIP_CATEGORIES, type ShipCategory } from "./ships";

export const LAYERS_KEY = "wakeline.layers";
const LAYER_KEYS: readonly (keyof Layers)[] = ["radar", "sigmet", "aircraft", "ships", "airports", "tracks", "prediction", "traffic"];

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }

function storage(): KV | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

/** 저장된 레이어(알려진 키의 boolean 만). 없거나 깨졌으면 null. */
export function loadLayers(kv: KV | null = storage()): Partial<Layers> | null {
  if (!kv) return null;
  try {
    const raw = kv.getItem(LAYERS_KEY);
    if (!raw || raw.length > 1024) return null;
    const o: unknown = JSON.parse(raw);
    if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
    const out: Partial<Layers> = {};
    for (const k of LAYER_KEYS) { const v = (o as Record<string, unknown>)[k]; if (typeof v === "boolean") out[k] = v; }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/**
 * 범례를 처음(저장된 선택이 없을 때) 펼칠 최소 화면 폭(px). 좁은 화면에서는 범례가 지도 대부분을 덮고(R-39),
 * 1280×720·1440×900 노트북에서도 지도의 23–27 % 를 가린다(R-31) — 그보다 넓을 때만 처음부터 펼친다.
 */
export const LEGEND_OPEN_MIN_WIDTH = 1600;
export function legendDefaultOpen(viewportWidth: number): boolean {
  return Number.isFinite(viewportWidth) && viewportWidth >= LEGEND_OPEN_MIN_WIDTH;
}

export function saveLayers(l: Layers, kv: KV | null = storage()): void {
  if (!kv) return;
  const o: Partial<Layers> = {};
  for (const k of LAYER_KEYS) if (l[k] !== undefined) o[k] = l[k] === true; // 선택 필드(traffic)가 없는 객체는 그 키를 쓰지 않는다(끔으로 읽힌다)
  try { kv.setItem(LAYERS_KEY, JSON.stringify(o)); } catch { /* 저장소 가득 참·차단 — 기억하지 못할 뿐 */ }
}

// ---- 선종 필터(계약 v5 §B3 — 설정은 브라우저에만) ----

export const SHIP_CATS_KEY = "wakeline.shipCats";
const CAT_SET: ReadonlySet<string> = new Set(SHIP_CATEGORIES);

/**
 * 저장된 선종 필터 → 켜진 선종(SHIP_CATEGORIES 순서). 저장은 꺼진 선종 목록({hidden: [...]}) — 나중에 선종이 늘어도 새 선종은 켜진 채로 보인다.
 * 모르는 이름은 버린다. 없거나 깨졌으면 null(모두 켬).
 */
export function loadShipCats(kv: KV | null = storage()): ShipCategory[] | null {
  if (!kv) return null;
  try {
    const raw = kv.getItem(SHIP_CATS_KEY);
    if (!raw || raw.length > 1024) return null;
    const o: unknown = JSON.parse(raw);
    if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
    const hidden = (o as { hidden?: unknown }).hidden;
    if (!Array.isArray(hidden)) return null;
    const off = new Set(hidden.filter((h): h is string => typeof h === "string" && CAT_SET.has(h)));
    return SHIP_CATEGORIES.filter((c) => !off.has(c));
  } catch { return null; }
}

export function saveShipCats(enabled: readonly ShipCategory[], kv: KV | null = storage()): void {
  if (!kv) return;
  const on = new Set(enabled);
  try { kv.setItem(SHIP_CATS_KEY, JSON.stringify({ hidden: SHIP_CATEGORIES.filter((c) => !on.has(c)) })); } catch { /* 저장소 가득 참·차단 — 기억하지 못할 뿐 */ }
}
