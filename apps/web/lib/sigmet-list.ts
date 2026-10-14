/**
 * SIGMET 탭 목록의 줄(R-40: 지도 클릭 없이 키보드·스크린리더로 고르기) — SIGMET 목록 조각(components/SigmetList, 탭을 연 뒤)만 쓴다. 첫 화면에 싣지 않는다
 * (ADR-026 — lib/sigmet 은 지도가 쓰므로 첫 화면에 있다; tests/first-screen-lazy CARRIED_BY_PARTS).
 */
import type * as GeoJSON from "geojson";
import { activeSigmetFeatures } from "./sigmet";
import type { Alert, SigmetCollection } from "./types";

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
  // 공역 알림(계약 v5 §G48 — sigmet_id 없음)은 SIGMET 의 수에 넣지 않는다
  if (alerts) for (const a of alerts) { if (!a.sigmet_id) continue; const m = a.kind === "OBSERVED" ? inside : predicted; m.set(a.sigmet_id, (m.get(a.sigmet_id) ?? 0) + 1); }
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
