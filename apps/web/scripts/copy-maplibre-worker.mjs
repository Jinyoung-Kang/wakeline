// MapLibre GL 6 배포본(메인·워커·공용 청크)을 public/maplibre/<버전>/ 으로 복사한다(빌드·dev 시 자동 실행).
// - 워커: MapLibre 는 워커를 new Worker(new URL(...), {type:"module"}) 로 만드는데 Turbopack 이 이를 자산으로 취급해 로드에 실패한다 → setWorkerUrl().
// - 메인: 상황판은 메인도 이 폴더에서 import 한다(lib/maplibre.ts, R-02) — 워커와 같은 공용 청크(maplibre-gl-shared.mjs)를 한 번만 받는다.
// 경로에 버전이 있어 next.config.ts 가 오래(immutable) 캐시하게 한다. 이전 버전 폴더는 지운다.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const pkgPath = require.resolve("maplibre-gl/package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const dist = join(dirname(pkgPath), "dist");
const base = join(process.cwd(), "public", "maplibre");
const out = join(base, version);
rmSync(base, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ["maplibre-gl.mjs", "maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(join(dist, f), join(out, f));
console.log(`copied maplibre ${version} (main, worker, shared) to public/maplibre/${version}/`);
