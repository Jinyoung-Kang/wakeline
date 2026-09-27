// MapLibre GL 6 는 워커를 new Worker(new URL(...), {type:"module"}) 로 만드는데 Turbopack 이 이를 자산으로 취급해 로드에 실패한다.
// 워커(+shared 청크)를 public/maplibre/ 로 복사하고 setWorkerUrl() 로 그 경로를 쓴다(빌드 시 자동 실행).
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/package.json")) + "/dist";
const out = join(process.cwd(), "public", "maplibre");
mkdirSync(out, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(join(dist, f), join(out, f));
console.log("copied maplibre worker to public/maplibre/");
