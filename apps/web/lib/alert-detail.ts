/**
 * 알림 한 건 — 근거 공유(SPEC F5 · 계약 v5 §G51) 응답 해석 · 화면용 값. React 없음.
 * 열린 알림(엔진)과 닫힌 알림(DB)은 같은 Alert 모양으로 맞춘다: DB 의 공역 알림에는 고도 한계가 근거(lower · upper)에만 있어, 구역 사본의 원문으로 채운다.
 * DB 장애 때 열린 알림은 200 + meta.db_unavailable 로 오고 구역 사본은 메모리 값(메모리에도 없으면 null)이다(IM-20) — 그 표시를 dbUnavailable 로 받는다.
 */
import type { Alert, AlertAirspaceLimit } from "./types";
import { boundsAround, replayLink } from "./replay-link";

export interface SigmetCopy { id: string; fir_id: string; fir_name?: string; hazard: string; qualifier?: string; base_ft: number; top_ft?: number; base_source?: string; top_source?: string; valid_from: string; valid_to: string; withdrawn_at?: string; raw_text: string; provider: string }
export interface AirspaceCopy { id: number; category: string; type_ko: string; ident?: string; name: string; lower_ft?: number; lower_basis: string; lower_raw: string; upper_ft?: number; upper_basis: string; upper_raw: string; edition: string; edition_active: boolean }
/** dbUnavailable = api 가 DB 없이 답했다(meta.db_unavailable — 구역 사본은 저장 사본이 아니라 메모리 값이거나 null) */
export interface AlertDetail { alert: Alert; source: "engine" | "db"; sigmet: SigmetCopy | null; airspace: AirspaceCopy | null; retentionDays: number; dbUnavailable: boolean; raw: unknown }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseAlertDetail(x: unknown): AlertDetail | null {
  if (!isObj(x) || !isObj(x.alert) || (x.source !== "engine" && x.source !== "db")) return null;
  const a = x.alert;
  if (typeof a.id !== "number" || (a.kind !== "OBSERVED" && a.kind !== "PREDICTED") || typeof a.hex !== "string" || typeof a.entered_at !== "string") return null;
  const sigmet = isObj(x.sigmet) && typeof x.sigmet.raw_text === "string" ? (x.sigmet as unknown as SigmetCopy) : null;
  const airspace = isObj(x.airspace) && typeof x.airspace.name === "string" ? (x.airspace as unknown as AirspaceCopy) : null;
  const alert = { evidence: {}, estimated: a.kind === "PREDICTED", ...a } as unknown as Alert;
  if (alert.zone_type === "airspace" && alert.airspace && airspace && !alert.airspace.lower) {
    const lim = (ft: number | undefined, basis: string, raw: string): AlertAirspaceLimit => ({ ft: ft ?? null, basis: basis as AlertAirspaceLimit["basis"], raw });
    alert.airspace = { ...alert.airspace, lower: lim(airspace.lower_ft, airspace.lower_basis, airspace.lower_raw), upper: lim(airspace.upper_ft, airspace.upper_basis, airspace.upper_raw) };
  }
  const dbUnavailable = isObj(x.meta) && x.meta.db_unavailable === true;
  return { alert, source: x.source, sigmet, airspace, retentionDays: typeof x.retention_days === "number" ? x.retention_days : 30, dbUnavailable, raw: x };
}

/**
 * 알림이 가리키는데 응답에 없는(읽지 못한) 구역 사본 — api 와 같은 열쇠로 본다(sigmet_id 가 있으면 SIGMET 사본, airspace.id 가 있으면 공역 사본).
 * DB 장애로 메모리에도 없거나, 저장 순서가 밀려 열린 알림의 행이 아직 없을 때 null 로 온다 — 화면은 칸을 빼지 않고 '사본을 읽지 못함'을 적는다(IM-20).
 */
export function missingCopies(d: AlertDetail): { sigmet: boolean; airspace: boolean } {
  const a = d.alert;
  return { sigmet: !d.sigmet && typeof a.sigmet_id === "string", airspace: !d.airspace && isObj(a.airspace) && typeof a.airspace.id === "number" };
}

/** 판정 때 위치(근거 position [lat, lon]) — 없으면 null */
export function evidencePosition(a: Alert): { lat: number; lon: number } | null {
  const p = (a.evidence as Record<string, unknown> | undefined)?.position;
  return Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v)) ? { lat: p[0] as number, lon: p[1] as number } : null;
}

/** "그 시각 재생" 링크: 관측 시각(없으면 진입 시각) · 위치 둘레 3° 상자 · 그 항공기 */
export function alertReplayLink(a: Alert): string {
  const ev = (a.evidence ?? {}) as Record<string, unknown>;
  const at = typeof ev.seen_at === "string" ? ev.seen_at : a.entered_at;
  const pos = evidencePosition(a);
  return replayLink({ at, bbox: pos ? boundsAround(pos.lat, pos.lon) : null, hex: a.hex });
}

/** 내려받는 JSON — API 응답 그대로 + 내려받은 시각(KST 글 · UTC) */
export function alertJson(d: AlertDetail, savedAtKst: string, savedAtIso: string): string {
  return JSON.stringify({ downloaded_at_kst: savedAtKst, downloaded_at: savedAtIso, response: d.raw }, null, 2);
}
