/** SIGMET 클라이언트 규칙(순수 함수): 만료 필터(REL-13)·발효 전 표시(DH-8)·고도대 출처(SEC-17/COR-5). */
import type { BandSource } from "./format";
import type { SigmetCollection, SigmetProps } from "./types";

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
