/**
 * 배경지도 스타일을 받지 못할 때의 대체(R-01) — 지도 하나에 붙인다. 배경지도 스타일(STYLE_URL — 외부 호스트)을 받지 못하면 MapLibre 'load' 가 오지 않아
 * 우리 데이터 레이어도 그려지지 않는다 → 로컬 최소 스타일(FALLBACK_STYLE)로 한 번 바꾸고 onFail 로 알린다(화면이 "배경지도를 불러오지 못함"을 그린다).
 * - 실패 = 스타일이 오기 전의 sourceId 없는 'error'(타일 · 소스 오류는 sourceId 가 있고, 스프라이트 · 글꼴 오류는 style.load 뒤에 온다), 또는
 *   STYLE_LOAD_TIMEOUT_MS 안에 style.load 가 오지 않음(오류 없이 멈춘 요청 — 패킷 DROP · DNS 블랙홀).
 * - 한 번만 바꾼다: 바꾼 뒤에는 늦게 온 이벤트 · 오류 · 타이머가 다시 바꾸지 않는다(setStyle 은 이전 스타일의 요청을 취소하고 그 이벤트를 떼어 낸다).
 * - 스타일을 받을 때마다 알려진 층의 색만 바꾼다(배경지도 시인성 — 계약 v4 §E · lib/basemap). 대체 스타일에는 칠할 지형이 없어 건너뛴다.
 * - 'error' 처리기를 달면 MapLibre 가 오류를 콘솔에 찍지 않으므로 그대로 찍는다.
 * React 를 쓰지 않는다(ADR-029 §6) — 부르는 쪽(지도를 만드는 효과)이 정리에서 dispose() 를 부른다(떠난 지도의 스타일을 바꾸지 않게).
 */
import type * as maplibregl from "maplibre-gl";
import { applyBasemap } from "./basemap";
import { FALLBACK_STYLE, STYLE_LOAD_TIMEOUT_MS } from "./maplayers";

export interface BasemapWatch {
  /** 대체 스타일로 바꿨는가 — 그러면 배경지도 크레딧을 붙이지 않는다(그리지 않은 지도의 출처) */
  readonly failed: boolean;
  /** 시간 제한 타이머를 끈다(지도를 지울 때) */
  dispose(): void;
}

export function watchBasemapStyle(map: maplibregl.Map, onFail: () => void): BasemapWatch {
  let styleLoaded = false;
  let noBasemap = false;
  const fallBack = () => {
    if (styleLoaded || noBasemap) return;
    noBasemap = true;
    onFail();
    map.setStyle(FALLBACK_STYLE, { diff: false });
  };
  const styleTimer = setTimeout(fallBack, STYLE_LOAD_TIMEOUT_MS);
  map.on("style.load", () => { styleLoaded = true; clearTimeout(styleTimer); if (!noBasemap) applyBasemap(map); });
  map.on("error", (e: { error?: unknown; sourceId?: string }) => {
    console.error(e?.error ?? e);
    if (e?.sourceId) return;
    fallBack();
  });
  return { get failed() { return noBasemap; }, dispose: () => clearTimeout(styleTimer) };
}
