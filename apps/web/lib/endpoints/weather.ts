/**
 * 기상 REST(web-review §3.1) — 공항 카드 · 공항 목록 · SIGMET 카드(나중에 받는 조각)와 공항 기상 이력 화면이 부른다. 첫 화면 밖이다
 * (tests/first-screen-lazy CARRIED_BY_PARTS). 상황판 지도의 기상청 레이더 · 감시 공항 조회는 조건부 요청(304)이라 lib/etag-poller 가 따로 맡는다.
 * 함수마다 { signal } 을 받아 그대로 넘기고, 경로 조각은 ./path 로 인코딩하고(빈 값 · "." · ".." 는 요청하지 않고 거절), 파싱한 값을 돌려준다.
 */
import type * as GeoJSON from "geojson";
import { apiGet } from "@/lib/api";
import { parseWx, type AirportWx } from "@/lib/airport-wx";
import type { AirportProps } from "@/lib/tooltip";
import { pathSegment } from "./path";

type Opts = { signal?: AbortSignal };
export type AirportFeature = GeoJSON.Feature<GeoJSON.Point, AirportProps>;

/** 공항 기상(FR-22). 본문이 화면이 읽는 모양이 아니면 null(lib/airport-wx parseWx — 부른 쪽이 그리지 않고 그렇다고 말한다) */
export async function airportWx(icao: string, o?: Opts): Promise<AirportWx | null> {
  return apiGet<unknown>(`/api/v1/airports/${pathSegment(icao)}/wx`, o).then((body) => parseWx(body));
}

/** 감시 공항(공항 탭 목록): ICAO 가 글자인 지점만. features 가 목록이 아니면 빈 목록 */
export function watchedAirports(o?: Opts): Promise<AirportFeature[]> {
  return apiGet<GeoJSON.FeatureCollection<GeoJSON.Point, AirportProps>>("/api/v1/airports?watched=true", o)
    .then((fc) => (Array.isArray(fc.features) ? fc.features.filter((f) => f.properties && typeof f.properties.icao === "string") : []));
}

/** SIGMET 안 항공기(hex 목록). 응답에 목록이 없으면 null — 모름(0 대로 단정하지 않는다) */
export async function sigmetInside(id: string, o?: Opts): Promise<string[] | null> {
  return apiGet<{ aircraft_inside?: string[] }>(`/api/v1/sigmets/${pathSegment(id)}`, o)
    .then((x) => (Array.isArray(x.aircraft_inside) ? x.aircraft_inside : null));
}
