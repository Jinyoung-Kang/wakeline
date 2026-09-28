/** SIGMET 클라이언트 규칙(순수 함수): 만료 필터(REL-13)·발효 전 표시(DH-8)·고도대 출처(SEC-17/COR-5). */
import type { BandSource } from "./format";
import type { Alert, SigmetCollection, SigmetProps } from "./types";

/**
 * 지도에 그릴 SIGMET: 폴리곤이 있고 유효시간이 끝나지 않은 것만. 새 메시지가 오지 않아도(AWC 장애 등)
 * 30 s 마다 다시 걸러 만료된 경보를 "활성"처럼 남기지 않는다. valid_to 를 해석할 수 없으면 서버 active 값을 따른다.
 * 아직 발효 전(valid_from > 지금)인 것은 `pending: true` 를 달아 따로 그린다(DH-8) — 엔진은 발효 전 경보로 판정하지 않는다.
 */
export function activeSigmetFeatures(fc: SigmetCollection | null | undefined, nowMs: number): SigmetCollection["features"] {
  if (!fc || !Array.isArray(fc.features)) return [];
  return fc.features
    .filter((f) => f.geometry && !isExpired(f.properties, nowMs))
    .map((f) => ({ ...f, properties: { ...f.properties, pending: isPending(f.properties, nowMs) } }));
}

/** 발효 전인가: valid_from 이 (서버 기준) 지금보다 뒤. 해석할 수 없으면 false(발효 전이라고 단정하지 않는다). */
export function isPending(p: Pick<SigmetProps, "valid_from"> | null | undefined, nowMs: number): boolean {
  if (!p || typeof p.valid_from !== "string") return false;
  const t = Date.parse(p.valid_from);
  return !Number.isNaN(t) && t > nowMs;
}

export function isExpired(p: Pick<SigmetProps, "valid_to" | "active"> | null | undefined, nowMs: number): boolean {
  if (!p) return true;
  const t = Date.parse(p.valid_to);
  return Number.isNaN(t) ? p.active === false : t <= nowMs;
}

/**
 * 원문이 "TOP ABV FLxxx" 로 상한을 밝혔고 그 값이 top_ft 와 같으면 true — 발표값은 상한의 하한(그 이상)이다.
 * 결정적 규칙(정규식)으로 원문을 읽을 뿐 추정하지 않는다.
 */
export function topAboveFromRaw(raw: string | null | undefined, topFt: number | null | undefined): boolean {
  if (!raw || topFt == null) return false;
  const m = /\bTOP\s+ABV\s+FL(\d{3})\b/.exec(raw);
  return m != null && Number(m[1]) * 100 === topFt;
}

export function sigmetBandSource(p: Pick<SigmetProps, "base_source" | "top_source" | "raw_text" | "top_ft">): BandSource {
  return { base_source: p.base_source ?? null, top_source: p.top_source ?? null, top_above: p.top_source === "raw_text" && topAboveFromRaw(p.raw_text, p.top_ft) };
}

// ---- SIGMET 목록(R-40: 지도 클릭 없이 키보드·스크린리더로 고르기) ----

export interface SigmetListItem {
  id: string;
  hazard: string;
  qualifier: string | null;
  fir_id: string;
  fir_name: string | null;
  valid_to: string;
  pending: boolean;
  /** 안에 있는 항공기(관측 알림 수). null = 알림 목록을 아직 받지 못해 모름 */
  inside: number | null;
  /** 진입 예상(예측 알림 수, 추정). null = 모름 */
  predicted: number | null;
  /** 지도 이동 목표 [lon, lat](폴리곤 외접 상자의 가운데 — 표시값이 아니라 카메라 위치). 폴리곤이 없으면 null */
  center: [number, number] | null;
}

/** 폴리곤 외접 상자의 가운데. 날짜변경선을 넘는 폴리곤(경도 폭 > 180°)은 음수 경도를 +360 해서 계산한다. */
export function polygonCenter(g: GeoJSON.MultiPolygon | null | undefined): [number, number] | null {
  const pts = (g?.coordinates ?? []).flat(2).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return null;
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  let lo = Math.min(...lons), hi = Math.max(...lons);
  if (hi - lo > 180) { const shifted = lons.map((x) => (x < 0 ? x + 360 : x)); lo = Math.min(...shifted); hi = Math.max(...shifted); }
  const lon = (lo + hi) / 2;
  return [lon > 180 ? lon - 360 : lon, (Math.min(...lats) + Math.max(...lats)) / 2];
}

/**
 * 지금 그려지는 SIGMET(만료 제외, 발효 전 포함) 목록. 안에 있는 항공기 수는 실시간 알림 목록에서 센다(서버 판정 — 추정이 아님).
 * 알림 목록을 아직 받지 못했으면(alerts=null) 수를 "모름"으로 둔다. 정렬: 안 항공기 많은 순 → 진입 예상 많은 순 → 발효 전은 뒤 → FIR·유형.
 */
export function sigmetListItems(fc: SigmetCollection | null | undefined, alerts: Iterable<Alert> | null, nowMs: number): SigmetListItem[] {
  const inside = new Map<string, number>(), predicted = new Map<string, number>();
  if (alerts) for (const a of alerts) { const m = a.kind === "OBSERVED" ? inside : predicted; m.set(a.sigmet_id, (m.get(a.sigmet_id) ?? 0) + 1); }
  const known = alerts != null;
  return activeSigmetFeatures(fc, nowMs)
    .map((f): SigmetListItem => {
      const p = f.properties;
      return {
        id: p.id, hazard: p.hazard, qualifier: p.qualifier ?? null, fir_id: p.fir_id, fir_name: p.fir_name ?? null, valid_to: p.valid_to, pending: p.pending === true,
        inside: known ? inside.get(p.id) ?? 0 : null, predicted: known ? predicted.get(p.id) ?? 0 : null, center: polygonCenter(f.geometry),
      };
    })
    .sort((a, b) => (b.inside ?? 0) - (a.inside ?? 0) || (b.predicted ?? 0) - (a.predicted ?? 0) || Number(a.pending) - Number(b.pending)
      || a.fir_id.localeCompare(b.fir_id) || a.hazard.localeCompare(b.hazard) || a.id.localeCompare(b.id));
}
