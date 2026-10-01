/**
 * 공항 탭(선택 없음)의 감시 공항 목록 줄(R-40 · web-review §3.3 — components/AirportList 에서 옮겼다). 공항 탭 조각과 함께만 온다:
 * 첫 화면에 싣지 않는다(tests/first-screen-lazy CARRIED_BY_PARTS).
 * 카테고리는 글자로도 쓴다(색만으로 구분하지 않음). METAR 가 없으면 "METAR 없음", 2 h 보다 오래되면 "METAR 오래됨(경과)" — 오래된 카테고리를 지금 것처럼 보이지 않는다.
 */
import { CAT_COLORS, CAT_UNKNOWN_COLOR, fmtDuration, isMetarStale, metarAgeS } from "./format";
import type { AirportFeature } from "./endpoints/weather";

export interface AirportListRow {
  icao: string; name: string;
  /** 카테고리 칸 글자 */
  cat: string;
  /** 점 색 — 새 METAR 의 알려진 카테고리만 그 색, 그 밖은 회색 */
  color: string;
  stale: boolean;
  /** 지도 이동에 쓸 경위도(수가 아니면 null) */
  lonLat: [number, number] | null;
}

/** ICAO 순서의 줄. now = 서버 기준 지금(ms) — 0 이면 경과를 모른다(오래됨을 판정하지 않는다) */
export function airportListRows(features: readonly AirportFeature[], now: number): AirportListRow[] {
  return [...features].sort((a, b) => a.properties.icao.localeCompare(b.properties.icao)).map((f) => {
    const p = f.properties;
    const age = now ? metarAgeS(p, now) : null;
    const hasMetar = p.obs_time != null || age != null;
    const stale = hasMetar && now > 0 && isMetarStale(p, now);
    const cat = !hasMetar ? "METAR 없음" : stale ? `METAR 오래됨${age != null ? `(${fmtDuration(age)} 전)` : ""}` : p.flight_cat ?? "—";
    const color = !hasMetar || stale || !p.flight_cat ? CAT_UNKNOWN_COLOR : CAT_COLORS[p.flight_cat] ?? CAT_UNKNOWN_COLOR;
    const [lon, lat] = f.geometry?.coordinates ?? [];
    return { icao: p.icao, name: p.name ?? "", cat, color, stale, lonLat: Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null };
  });
}
