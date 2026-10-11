/**
 * 기상특보(계약 v5 §G49 · ADR-036 · SPEC F3) — api GET /api/v1/warnings(수집기가 5분마다 받은 기상청 특보현황 목록 전체). 특보 탭을 볼 때만 받는 조각
 * (components/WarningPanel — ADR-026). 종류 · 수준 · 명령은 원문 글자 그대로, 시각은 KST 로 적는다. 예비특보는 시각이 아니라 때(원문 부호의 시간대).
 * 선박 위치와 구역을 잇지 않는다(구역 경계 자료 없음 — SPEC F9 보류). 받은 적이 없으면 '수신 전'(특보 없음과 구분), 15분 넘게 새 목록이 없으면 오래됨.
 */
import { EtagPoller, POLL_NONE, watchVisible, type Fetcher, type PollState, type WatchVisible } from "./etag-poller";
import { fmtKstMinute } from "./time";
import { countPhases, notYetText } from "./warning-phase";

export const WARNINGS_URL = "/api/v1/warnings";
export const WARNINGS_POLL_MS = 60_000;
export const WARNINGS_STALE_S = 900;

export interface Warning {
  zone_code: string; zone_name: string; parent_code?: string; parent_name?: string; sea: boolean; kind: string; level: string; command: string;
  preliminary: boolean; issued_at: string; effective_at?: string; effective_from?: string; effective_to?: string; effective_text?: string; end_notice?: string; raw: string;
}
export interface Warnings { received: boolean; items: Warning[]; dropped: number; source: string; fetchedAt: string | null; stale: boolean; bad: number }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const s = (x: unknown) => (typeof x === "string" ? x : undefined);

/** 응답 → 화면 값. 봉투가 틀리면 null(마지막 값을 둔다), 틀린 항목은 버리고 센다 */
export function parseWarnings(x: unknown): Warnings | null {
  if (!isObj(x) || typeof x.received !== "boolean" || !Array.isArray(x.items) || typeof x.source !== "string" || !isObj(x.meta)) return null;
  const items: Warning[] = [];
  let bad = 0;
  for (const it of x.items) {
    if (!isObj(it) || !/^[LS][0-9]{7}$/.test(String(it.zone_code)) || typeof it.zone_name !== "string" || typeof it.kind !== "string" || typeof it.level !== "string"
      || typeof it.command !== "string" || typeof it.issued_at !== "string" || typeof it.sea !== "boolean" || typeof it.preliminary !== "boolean") { bad++; continue; }
    items.push({
      zone_code: String(it.zone_code), zone_name: it.zone_name, parent_code: s(it.parent_code), parent_name: s(it.parent_name), sea: it.sea, kind: it.kind,
      level: it.level, command: it.command, preliminary: it.preliminary, issued_at: it.issued_at, effective_at: s(it.effective_at), effective_from: s(it.effective_from),
      effective_to: s(it.effective_to), effective_text: s(it.effective_text), end_notice: s(it.end_notice), raw: typeof it.raw === "string" ? it.raw : "",
    });
  }
  return {
    received: x.received, items, dropped: typeof x.dropped === "number" ? x.dropped : 0, source: x.source, fetchedAt: s(x.meta.fetched_at) ?? null,
    stale: x.meta.stale === true, bad,
  };
}

/** 묶음: 해상(상위 구역 이름별) 먼저, 육상은 따로(화면이 접는다). 각 묶음 안은 경보 → 주의보 → 예비 → 그 밖, 같은 수준은 구역 이름 순 */
export function groupWarnings(items: readonly Warning[]): { sea: { parent: string; items: Warning[] }[]; land: Warning[] } {
  const rank = (w: Warning) => (w.level.includes("경보") ? 0 : w.level.includes("주의보") ? 1 : w.preliminary ? 2 : 3);
  const order = (a: Warning, b: Warning) => rank(a) - rank(b) || a.zone_name.localeCompare(b.zone_name, "ko");
  const byParent = new Map<string, Warning[]>();
  for (const w of items.filter((x) => x.sea)) {
    const k = w.parent_name ?? "상위 구역 모름";
    byParent.set(k, [...(byParent.get(k) ?? []), w]);
  }
  return {
    sea: [...byParent.entries()].sort(([a], [b]) => a.localeCompare(b, "ko")).map(([parent, ws]) => ({ parent, items: ws.sort(order) })),
    land: items.filter((x) => !x.sea).sort(order),
  };
}

/** 발효 글: 정확한 시각이면 'MM-DD HH:MM KST 발효', 예비면 그 때 글자, 모르면 '—' */
export function effectiveText(w: Warning): string {
  if (w.effective_at) return `${fmtKstMinute(w.effective_at, { date: true })} 발효`;
  if (w.effective_text) return `${w.effective_text} 예상`;
  return "—";
}

/** 상태 줄: 수신 전 · 발효 중 N건(발효 예정 · 예비는 따로) · 오래됨 · 조회 실패. demo = 공개 데모(ADR-039 — 운영 화면을 가리키지 않는다) */
export function warningsStatus(w: Warnings | null, error: string | null, nowMs: number, demo = false): { text: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (!w) return error ? { text: `조회 실패(${error})`, tone: "bad" } : { text: "받는 중…", tone: "muted" };
  if (!w.received) return { text: `특보 목록 수신 전 — 수집기가 아직 보내지 않았거나 꺼져 있음${demo ? "" : "(운영 화면의 kma_warning)"}`, tone: "warn" };
  const ageMin = w.fetchedAt ? Math.round((nowMs - Date.parse(w.fetchedAt)) / 60_000) : null;
  const p = countPhases(w.items, nowMs);
  const sea = p.in_force.filter((x) => x.sea).length;
  const later = notYetText(p);
  const base = `발효 중 ${p.in_force.length}건(해상 ${sea} · 육상 ${p.in_force.length - sea})${later ? ` · ${later}` : ""} · ${w.source} · 받음 ${w.fetchedAt ? fmtKstMinute(w.fetchedAt) : "—"}`;
  const notes = [w.stale || (ageMin != null && ageMin * 60 > WARNINGS_STALE_S) ? `오래됨 — ${ageMin ?? "—"}분 전 목록` : null,
    w.dropped + w.bad > 0 ? `형식 오류로 뺀 줄 ${w.dropped + w.bad}` : null, error ? `조회 실패(${error}) — 마지막 값` : null].filter(Boolean);
  return { text: [base, ...notes].join(" · "), tone: notes.length ? "warn" : "ok" };
}

export type WarningsPollState = PollState<Warnings>;
export const WARNINGS_POLL_NONE: WarningsPollState = POLL_NONE;

export function warningsPoller(
  publish: (s: WarningsPollState) => void,
  initial: WarningsPollState = WARNINGS_POLL_NONE,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  hidden: () => boolean = () => typeof document !== "undefined" && document.hidden,
  now: () => number = () => Date.now(),
  watch: WatchVisible = watchVisible,
): EtagPoller<Warnings> {
  return new EtagPoller({ url: WARNINGS_URL, parse: parseWarnings, intervalMs: WARNINGS_POLL_MS, visibleMinGapMs: 15_000 }, publish, initial, fetcher, hidden, now, watch);
}
