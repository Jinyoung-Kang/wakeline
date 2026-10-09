/**
 * 재생 링크 만들기(SPEC F5-4 · 계약 v5 §G51) — 읽기 · 검증은 lib/replay-url. 근거 카드(조각)가 부르므로 재생 화면 모듈(lib/replay)을 불러오지 않는다
 * (불러오면 카드 조각들의 청크 목록이 길어져 첫 화면 JS 가 늘었다 — PERF §19).
 */
export type Bounds = [number, number, number, number];

/** 그 위치 둘레(± pad °)의 영역 — 위경도 범위 안으로 자른다 */
export function boundsAround(lat: number, lon: number, pad = 1.5): Bounds {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return [r(Math.max(-180, lon - pad)), r(Math.max(-90, lat - pad)), r(Math.min(180, lon + pad)), r(Math.min(90, lat + pad))];
}

export function replayLink(o: { at: number | string; bbox?: Bounds | null; hex?: string | null }): string {
  const t = typeof o.at === "number" ? o.at : Date.parse(o.at);
  const p = new URLSearchParams();
  p.set("at", new Date(Math.floor(t / 1000) * 1000).toISOString().replace(".000Z", "Z"));
  if (o.bbox) p.set("bbox", o.bbox.join(","));
  if (o.hex) p.set("hex", o.hex.toLowerCase());
  return `/replay?${p.toString().replace(/%2C/g, ",").replace(/%3A/g, ":")}`;
}
