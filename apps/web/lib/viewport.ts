/**
 * 지도 화면 → 서버에 보낼 구독 영역 [west, south, east, north](경도 −180~180).
 *
 * MapLibre 는 날짜변경선(±180°)을 넘는 화면에서 경도를 펼친 값(예: 20 ~ 280)을 준다. 그대로 180 으로 자르면 넘어간 쪽(아메리카 등)이
 * 구독에서 빠진다. 그래서:
 * - 화면이 한 바퀴 이상이거나, 줌 < HOT_MIN_ZOOM 에서 날짜변경선을 넘으면 그 위도 띠 전체(−180~180)를 구독한다.
 *   낮은 줌은 서버가 전세계·격자 인코딩으로 보내고, 핫 리전 수요도 내지 않는다(api DemandService.HOT_MIN_ZOOM).
 * - 줌 ≥ HOT_MIN_ZOOM 에서 넘으면 화면 중심이 있는 쪽만 구독한다. api 가 핫 리전 칸을 구독 영역의 중심으로 정하므로,
 *   위도 띠 전체를 보내면 중심이 경도 0 으로 잘못 잡힌다. 이때 반대쪽 좁은 조각은 빠진다(날짜변경선 근처를 크게 확대한 경우뿐).
 */
export const HOT_MIN_ZOOM = 7;

export type Bbox = [number, number, number, number];

export function subscriptionBbox(west: number, south: number, east: number, north: number, zoom: number, centerLon: number): Bbox {
  const s = Math.max(-90, south), n = Math.min(90, north);
  if (!(east > west) || east - west >= 360) return [-180, s, 180, n];
  const shift = Math.floor((west + 180) / 360) * 360; // west 를 [−180, 180) 로
  const w = west - shift, e = east - shift;
  if (e <= 180) return [w, s, e, n];
  if (zoom < HOT_MIN_ZOOM) return [-180, s, 180, n];
  const c = ((((centerLon + 180) % 360) + 360) % 360) - 180;
  return c >= w ? [w, s, 180, n] : [-180, s, e - 360, n];
}
