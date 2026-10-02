/**
 * MapLibre 불러오기(R-02 — 상황판 · 재생 화면). MapLibre GL 6 의 배포본은 메인(maplibre-gl.mjs)·워커(maplibre-gl-worker.mjs)가 공용 청크
 * (maplibre-gl-shared.mjs, 약 145 KiB gzip)를 함께 import 한다. 메인을 번들하면 번들러가 공용 코드를 메인 청크에 한 벌 넣고,
 * 워커는 public 에서 또 한 벌 받는다. 그래서 상황판은 메인도 public 의 같은 배포본을 브라우저가 직접 import 한다 — 공용 청크는
 * 한 번만 받고(워커는 캐시에서 쓴다) 번들에는 MapLibre 가 없다.
 * - 경로에 버전을 넣는다: scripts/copy-maplibre-worker.mjs 가 설치본을 public/maplibre/<버전>/ 에 복사하고, next.config.ts 가
 *   이 경로를 1년 immutable 로 캐시하게 한다. MAPLIBRE_VERSION 은 설치본과 같아야 한다(tests/mapview-lifecycle.test.ts 가 검사).
 * - 타입은 패키지에서(import type), 실행 코드는 이 모듈이 불러온 것만 쓴다.
 */
import type * as MapLibre from "maplibre-gl";

export type MapLibreModule = typeof MapLibre;

export const MAPLIBRE_VERSION = "6.11.2";
export const MAPLIBRE_BASE = `/maplibre/${MAPLIBRE_VERSION}`;
export const MAPLIBRE_MODULE_URL = `${MAPLIBRE_BASE}/maplibre-gl.mjs`;
/** 지도 워커 — 지도를 만들기 전에 setWorkerUrl() 로 지정한다(loadMaplibre 가 한다 — 상황판 · 재생 화면 모두) */
export const MAPLIBRE_WORKER_URL = `${MAPLIBRE_BASE}/maplibre-gl-worker.mjs`;

let loaded: MapLibreModule | null = null;
let loading: Promise<MapLibreModule> | null = null;

/** public 의 MapLibre 를 한 번 불러오고 워커 경로를 지정한다. 실패하면 다음 호출에서 다시 시도한다. */
export function loadMaplibre(): Promise<MapLibreModule> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= (import(/* webpackIgnore: true */ /* @vite-ignore */ MAPLIBRE_MODULE_URL) as Promise<MapLibreModule>).then(
    (m) => { m.setWorkerUrl(MAPLIBRE_WORKER_URL); loaded = m; return m; },
    (e: unknown) => { loading = null; throw e; },
  );
  return loading;
}

/** 불러온 MapLibre(loadMaplibre 가 끝난 뒤에만 부른다 — 상황판 · 재생 화면은 지도 컴포넌트를 불러올 때 함께 기다린다) */
export function maplibre(): MapLibreModule {
  if (!loaded) throw new Error("MapLibre is not loaded yet (call loadMaplibre() first)");
  return loaded;
}
