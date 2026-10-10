/**
 * 관심 대상(SPEC F4 · ADR-037 · 계약 v5 §G50) — React 없는 규칙: 목록(이 브라우저에만 · 50개) · 저장소 읽기 검증 · 조회 답 해석 ·
 * 이전 답 ↔ 새 답 비교로 사건 만들기 · 사건 열쇠 · 10분 반복 억제 · 숨은 탭 예외의 조건.
 * 서버는 목록을 저장하지 않는다(요청 URL 에만 실린다). 사건은 브라우저가 찾는다 — 첫 답은 기준일 뿐 사건을 만들지 않는다(열자마자 알림이 쏟아지지 않게).
 */
import { CLOSE_REASON_LABEL } from "./alerts";
import type { CloseReason } from "./types";

export type WatchKind = "aircraft" | "ship" | "airport";
export interface WatchTarget { kind: WatchKind; id: string; label?: string }

export const WATCH_KEY = "wakeline.watch";
export const WATCH_MAX = 50;
export const WATCH_POLL_MS = 30_000;
export const WATCH_REPEAT_MS = 10 * 60_000;
/** 선박 위치를 이보다 오래 못 받으면 '끊김'(서버 저장소도 30분 뒤 뺀다 — ShipStore.LIVE_MAX_AGE_MS) */
export const SHIP_LOST_S = 1_800;

const ID: Record<WatchKind, RegExp> = { aircraft: /^[0-9a-f]{6}$/, ship: /^[0-9]{9}$/, airport: /^[A-Z0-9]{4}$/ };
const KIND_NAME: Record<WatchKind, string> = { aircraft: "항공기", ship: "선박", airport: "공항" };

/** 목록 정규화: 형식이 맞는 것만 · 같은 대상 한 번 · 50개까지. id 는 서버 형식(hex 소문자 · ICAO 대문자)으로 */
export function normalizeTargets(x: unknown): { targets: WatchTarget[]; dropped: number } {
  if (!Array.isArray(x)) return { targets: [], dropped: x == null ? 0 : 1 };
  const out: WatchTarget[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const v of x) {
    const o = v as Partial<WatchTarget> | null;
    const kind = o?.kind;
    const raw = typeof o?.id === "string" ? o.id.trim() : "";
    const id = kind === "aircraft" ? raw.toLowerCase() : kind === "airport" ? raw.toUpperCase() : raw;
    if (!kind || !(kind in ID) || !ID[kind].test(id) || seen.has(`${kind}:${id}`) || out.length >= WATCH_MAX) { dropped++; continue; }
    seen.add(`${kind}:${id}`);
    const label = typeof o?.label === "string" && o.label.trim() ? o.label.trim().slice(0, 40) : undefined;
    out.push(label ? { kind, id, label } : { kind, id });
  }
  return { targets: out, dropped };
}

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }
/** 저장소 상태: ok · unavailable(사생활 모드 · 차단 — 이번 접속 동안만) · corrupt(깨진 값을 버렸다 — 알린다) */
export type WatchStorageState = "ok" | "unavailable" | "corrupt";

export function loadTargets(s: StorageLike | null): { targets: WatchTarget[]; state: WatchStorageState } {
  if (!s) return { targets: [], state: "unavailable" };
  let raw: string | null;
  try { raw = s.getItem(WATCH_KEY); } catch { return { targets: [], state: "unavailable" }; }
  if (raw == null) return { targets: [], state: "ok" };
  try {
    const { targets, dropped } = normalizeTargets(JSON.parse(raw));
    return { targets, state: dropped ? "corrupt" : "ok" };
  } catch {
    return { targets: [], state: "corrupt" };
  }
}

/** 저장 — 실패하면 false(사생활 모드 · 용량) — 부르는 쪽이 '이번 접속 동안만'을 알린다 */
export function saveTargets(s: StorageLike | null, targets: readonly WatchTarget[]): boolean {
  if (!s) return false;
  try { s.setItem(WATCH_KEY, JSON.stringify(targets)); return true; } catch { return false; }
}

/** 더하기 · 빼기(같은 대상이면 뺀다). 50개가 차 있으면 더하지 않고 full */
export function toggleTarget(list: readonly WatchTarget[], t: WatchTarget): { list: WatchTarget[]; full: boolean } {
  const i = list.findIndex((x) => x.kind === t.kind && x.id === t.id);
  if (i >= 0) return { list: list.filter((_, j) => j !== i), full: false };
  if (list.length >= WATCH_MAX) return { list: [...list], full: true };
  const { targets } = normalizeTargets([...list, t]);
  return { list: targets, full: false };
}

export function watchQuery(targets: readonly WatchTarget[]): string {
  const of = (k: WatchKind) => targets.filter((t) => t.kind === k).map((t) => t.id).join(",");
  const p = new URLSearchParams();
  for (const [k, name] of [["aircraft", "aircraft"], ["ship", "ships"], ["airport", "airports"]] as const) { const v = of(k); if (v) p.set(name, v); }
  return p.toString();
}

// ---------------------------------------------------------------- 조회 답(§G50)
export interface WatchAlert { id: number; kind: "OBSERVED" | "PREDICTED"; zone_type: string; level?: string; sigmet_id?: string; hazard?: string; zone_name?: string; entered_at: string; eta_at?: string; left_at?: string; close_reason?: string }
export interface WatchAircraft { hex: string; found: boolean; callsign?: string; seen_at?: string; fresh?: boolean; open_alerts: WatchAlert[]; closed_alerts: WatchAlert[] }
export interface WatchShip { mmsi: string; found: boolean; name?: string; seen_at?: string; age_s?: number }
export interface WatchAirport { icao: string; found: boolean; name?: string; flight_cat?: string; obs_time?: string; obs_age_s?: number; stale?: boolean }
export interface WatchState { aircraft: WatchAircraft[]; ships: WatchShip[]; airports: WatchAirport[]; aisLastGap: { started_at: string; ended_at?: string; reason: string } | null }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const alertOk = (a: unknown): a is WatchAlert => isObj(a) && typeof a.id === "number" && (a.kind === "OBSERVED" || a.kind === "PREDICTED") && typeof a.entered_at === "string";

/** 답 해석 — 모양이 틀린 줄은 버린다. 본문 자체가 틀리면 null */
export function parseWatch(x: unknown): WatchState | null {
  if (!isObj(x) || !Array.isArray(x.aircraft) || !Array.isArray(x.ships) || !Array.isArray(x.airports)) return null;
  const aircraft = x.aircraft.filter((a): a is WatchAircraft => isObj(a) && typeof a.hex === "string" && typeof a.found === "boolean")
    .map((a) => ({ ...a, open_alerts: (Array.isArray(a.open_alerts) ? a.open_alerts : []).filter(alertOk), closed_alerts: (Array.isArray(a.closed_alerts) ? a.closed_alerts : []).filter(alertOk) }));
  const ships = x.ships.filter((s): s is WatchShip => isObj(s) && typeof s.mmsi === "string" && typeof s.found === "boolean");
  const airports = x.airports.filter((a): a is WatchAirport => isObj(a) && typeof a.icao === "string" && typeof a.found === "boolean");
  const g = x.ais_last_gap;
  const aisLastGap = isObj(g) && typeof g.started_at === "string" && typeof g.reason === "string"
    ? { started_at: g.started_at, reason: g.reason, ...(typeof g.ended_at === "string" ? { ended_at: g.ended_at } : {}) } : null;
  return { aircraft, ships, airports, aisLastGap };
}

// ---------------------------------------------------------------- 사건
export interface WatchEvent {
  /** 같은 사건이면 같은 열쇠(중복 · 10분 반복 억제) */
  key: string;
  target: WatchTarget;
  title: string;
  body: string;
  /** 누르면 갈 알림(근거) — 알림 사건만 */
  alertId?: number;
  tone: "alert" | "info";
}

function alertWhat(a: WatchAlert): string {
  const zone = a.zone_type === "airspace" ? `공역 ${a.zone_name ?? "—"}${a.level === "info" ? "(정보)" : ""}` : `SIGMET ${a.hazard ?? "—"}${a.sigmet_id ? ` ${a.sigmet_id}` : ""}`;
  return zone;
}

/** 알림 하나 → 사건(열림). WS 로 받은 알림도 같은 열쇠를 쓴다 — 조회와 WS 가 같은 사건을 두 번 알리지 않게 */
export function openEvent(target: WatchTarget, a: WatchAlert): WatchEvent {
  const pred = a.kind === "PREDICTED";
  return {
    key: `ac:${target.id}:alert:${a.id}:open`, target, alertId: a.id, tone: a.level === "info" ? "info" : "alert",
    title: `${label(target)} — ${pred ? "예측 진입" : "진입"}`, body: alertWhat(a),
  };
}

export function closedEvent(target: WatchTarget, a: WatchAlert): WatchEvent {
  const why = a.close_reason && a.close_reason in CLOSE_REASON_LABEL ? CLOSE_REASON_LABEL[a.close_reason as CloseReason] : "종료";
  return { key: `ac:${target.id}:alert:${a.id}:closed`, target, alertId: a.id, tone: "info", title: `${label(target)} — ${a.kind === "PREDICTED" ? "예측 해제" : "알림 닫힘"}`, body: `${alertWhat(a)} · ${why}` };
}

export function label(t: WatchTarget): string {
  return `${KIND_NAME[t.kind]} ${t.label ? `${t.label} (${t.id})` : t.id}`;
}

const FLIGHT_CATS = new Set(["VFR", "MVFR", "IFR", "LIFR"]);

/** 답에서 목록에 있는 대상의 줄만(이전 답으로 둘 때 — 지운 대상의 옛 줄이 다시 더한 뒤의 비교에 쓰이지 않게, QA-704) */
export function onlyTargets(s: WatchState, targets: readonly WatchTarget[]): WatchState {
  const has = (k: WatchKind, id: string) => targets.some((t) => t.kind === k && t.id === id);
  return { ...s, aircraft: s.aircraft.filter((a) => has("aircraft", a.hex)), ships: s.ships.filter((x) => has("ship", x.mmsi)), airports: s.airports.filter((a) => has("airport", a.icao)) };
}

/**
 * 이전 답 → 새 답의 사건. prev 가 null 이면(첫 답) 사건 없음 — 기준만 잡는다. 목록에 없는 대상의 줄은 보지 않는다.
 * - 항공기: 새로 열린 알림(진입 · 예측 진입) · 새로 닫힌 알림(창 15분 안 — 이전 답에 없던 닫힘) · 받다가 못 받음(신호 끊김 — 받는 범위 밖일 수도).
 * - 선박: 받다가 30분 넘게 못 받음(마지막 AIS 수신 공백이 열려 있으면 그 까닭) · 못 받다가 다시 받음.
 * - 공항: 비행 등급 변화(둘 다 아는 값일 때만 — 모름은 변화가 아니다).
 */
export function diffWatch(prev: WatchState | null, next: WatchState, targets: readonly WatchTarget[]): WatchEvent[] {
  if (!prev) return [];
  const out: WatchEvent[] = [];
  const find = (k: WatchKind, id: string) => targets.find((t) => t.kind === k && t.id === id);
  for (const a of next.aircraft) {
    const t = find("aircraft", a.hex);
    if (!t) continue;
    const before = prev.aircraft.find((p) => p.hex === a.hex);
    if (!before) continue; // 막 더한 대상 — 이번 답이 기준
    const openBefore = new Set(before.open_alerts.map((x) => x.id));
    const closedBefore = new Set(before.closed_alerts.map((x) => x.id));
    for (const x of a.open_alerts) if (!openBefore.has(x.id)) out.push(openEvent(t, x));
    for (const x of a.closed_alerts) if (!closedBefore.has(x.id)) out.push(closedEvent(t, x));
    if (before.found && !a.found)
      out.push({ key: `ac:${t.id}:lost:${before.seen_at ?? ""}`, target: t, tone: "info", title: `${label(t)} — 신호 끊김`, body: "지금 받는 범위(관심 지역 · 전세계 120초 · 핫 리전)에서 사라졌다 — 착륙 · 범위 밖 · 수신 공백일 수 있다" });
  }
  for (const s of next.ships) {
    const t = find("ship", s.mmsi);
    const before = prev.ships.find((p) => p.mmsi === s.mmsi);
    if (!t || !before) continue;
    const liveBefore = before.found && (before.age_s ?? 0) < SHIP_LOST_S;
    const liveNow = s.found && (s.age_s ?? 0) < SHIP_LOST_S;
    if (liveBefore && !liveNow) {
      const gap = next.aisLastGap && !next.aisLastGap.ended_at ? ` · AIS 수신 공백 중(${next.aisLastGap.reason})` : "";
      out.push({ key: `ship:${t.id}:lost:${before.seen_at ?? ""}`, target: t, tone: "info", title: `${label(t)} — 위치 수신 끊김(30분)`, body: `마지막 위치 뒤 30분 넘게 받지 못함${gap}` });
    } else if (!liveBefore && liveNow) {
      out.push({ key: `ship:${t.id}:back:${s.seen_at ?? ""}`, target: t, tone: "info", title: `${label(t)} — 위치 다시 받음`, body: "AIS 위치를 다시 받기 시작했다" });
    }
  }
  for (const a of next.airports) {
    const t = find("airport", a.icao);
    const before = prev.airports.find((p) => p.icao === a.icao);
    if (!t || !before) continue;
    const from = before.flight_cat, to = a.flight_cat;
    if (from && to && from !== to && FLIGHT_CATS.has(from) && FLIGHT_CATS.has(to))
      out.push({ key: `apt:${t.id}:cat:${a.obs_time ?? ""}:${to}`, target: t, tone: to === "IFR" || to === "LIFR" ? "alert" : "info", title: `${label(t)} — 비행 등급 ${from} → ${to}`, body: `METAR 기준${a.stale ? " (관측이 2시간 넘음)" : ""}` });
  }
  return out;
}

/** 사건 억제: 같은 열쇠는 한 번(이미 알린 열쇠), 같은 대상 · 같은 종류의 사건은 10분 안에 반복하지 않는다. 상태를 바꾼 새 기억을 돌려준다 */
export function suppress(events: readonly WatchEvent[], fired: ReadonlyMap<string, number>, nowMs: number): { pass: WatchEvent[]; fired: Map<string, number> } {
  const next = new Map([...fired].filter(([, at]) => nowMs - at < 24 * 3600_000)); // 하루 지난 열쇠는 잊는다(메모리)
  const pass: WatchEvent[] = [];
  for (const e of events) {
    const family = repeatFamily(e.key);
    const last = Math.max(next.get(e.key) ?? -Infinity, next.get(family) ?? -Infinity);
    if (next.has(e.key) || nowMs - last < WATCH_REPEAT_MS) continue;
    next.set(e.key, nowMs);
    next.set(family, nowMs);
    pass.push(e);
  }
  return { pass, fired: next };
}

/** 반복 억제의 묶음: 알림은 알림 하나(열림 · 닫힘 따로), 끊김 · 다시 받음 · 등급 변화는 대상 하나 */
function repeatFamily(key: string): string {
  const p = key.split(":");
  if (p[2] === "alert") return `~${p.slice(0, 5).join(":")}`;
  return `~${p[0]}:${p[1]}:${p[2]}`;
}

/**
 * 숨은 탭 예외(ADR-037 — ADR-029 §5-2 의 하나뿐인 예외): 관심 대상이 있고 브라우저 알림을 허락했을 때만 숨은 탭에서도 30 s 에 한 번 조회한다.
 * 다른 주기 요청 · WS 는 숨으면 멈춘다(tests/watch.test.ts 가 이 함수를 쓰는 곳이 하나뿐임을 고정한다).
 */
export function pollWhileHidden(targetCount: number, permission: string | null): boolean {
  return targetCount > 0 && permission === "granted";
}
