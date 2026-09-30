// 첫 화면 JS(NFR-04 — 상황판 `/` 를 처음 열 때 받는 스크립트)의 순수 부분. 두 도구가 함께 쓴다(tests/first-screen-js.test.ts):
//  - scripts/check-first-screen-js.mjs  : 빌드 결과(.next · public/maplibre)만으로 계산 — 스택 없이 CI 에서 돈다.
//  - scripts/measure-first-screen-js.mjs: 실제 브라우저(Playwright)로 페이지를 열어 받은 스크립트를 센다 — 배포 스택 · 로컬 standalone 서버.
//
// 바이트 단위(예산이 쓰는 값): **gzip 본문 바이트**(Content-Encoding 이 붙은 채 전송된 본문, 응답 머리 제외).
//  - 웹 서버(Next standalone server.js)가 압축한다: Next 내장 compression(gzip · deflate 만, brotli 없음) · zlib 기본 수준 6 · 1 KiB 미만은 압축 안 함.
//  - edge(infra/edge/nginx.conf 의 gzip on)는 이미 Content-Encoding 이 붙은 응답을 다시 압축하지 않는다 → 배포 스택의 본문 바이트 = 웹 서버의 본문 바이트.
//  - 응답 머리는 뺀다: edge 가 보안 헤더 · Cache-Control 을 붙여 경로(edge · 직접)마다 다르다. Lighthouse 의 transferSize(PERF §7·§8 의 옛 값)는 머리를 포함한다.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** Next 내장 압축과 같은 설정 — compression 패키지 기본값(zlib 기본 수준 6 · 문턱 1 KiB) */
export const GZIP_LEVEL = 6;
export const GZIP_THRESHOLD = 1024;
export const KIB = 1024;

/**
 * 첫 화면 JS 예산(NFR-04 개정 — ADR-026): gzip 본문 바이트. **선택값**(잰 값이 아니다) = 이 값을 정할 때 잰 539,430 B(docs/PERF.md §10 — 카드 · 목록을
 * 나중에 받게 한 뒤) + 여유 10,570 B(약 2 %). 바닥(MapLibre 303,421 B + Next · React 실행 코드 133,462 B = 436,883 B)이 옛 목표 400 KB 를 넘어
 * 400 KB 는 지도 라이브러리를 버리지 않고는 닿을 수 없다. 올리려면 ADR-026 의 절차(무엇이 늘었는지 측정 · 근거)를 따른다.
 */
export const FIRST_SCREEN_JS_BUDGET = 550_000;

/** 지도 컴포넌트가 첫 화면에 띄우는 public 의 워커(components/MapView.tsx 의 new Worker("/…") — tests/first-screen-js.test.ts 가 맞춰 본다) */
export const FIRST_SCREEN_PUBLIC_SCRIPTS = ["interpolate.worker.js"];

/** 웹 서버가 보낼 본문 바이트(압축 문턱 미만은 그대로) */
export function servedBytes(buf) {
  return buf.length < GZIP_THRESHOLD ? buf.length : gzipSync(buf, { level: GZIP_LEVEL }).length;
}

export const fmtKiB = (b) => `${(b / KIB).toFixed(1)} KiB`;

/**
 * 빌드 결과에서 `/` 첫 화면에 받는 파일 목록. 세 묶음:
 *  - entry  : Next 가 `/` 의 첫 로드로 적은 청크(.next/diagnostics/route-bundle-stats.json 의 firstLoadChunkPaths — HTML 의 script 태그).
 *             polyfill(nomodule)은 목록에 없다 — 현대 브라우저는 받지 않는다.
 *  - dynamic: `/` 가 next/dynamic 으로 첫 렌더에 불러오는 청크(.next/server/app/page/react-loadable-manifest.json — 지도 컴포넌트).
 *             상호작용 뒤에만 쓰는 화면(카드 · 목록 · 상세)은 React.lazy(import()) 로 불러와 이 목록에 없다(ADR-026) — 받는 시점이 클릭 뒤다.
 *  - maplibre: public/maplibre/<버전>/ 의 배포본 전부(메인 · 공용 · 워커 — 지도를 만들면 셋 다 받는다, lib/maplibre.ts).
 *  - public : 지도가 띄우는 public 의 워커(FIRST_SCREEN_PUBLIC_SCRIPTS — 지도 컴포넌트의 new Worker 주소와 같은지 시험이 본다).
 * 형식이 예상과 다르면(파일 없음 · `/` 없음 · 버전 폴더가 하나가 아님) 조용히 0 으로 세지 않고 Error 를 던진다.
 */
export function firstScreenFiles(webDir) {
  const next = join(webDir, ".next");
  const statsPath = join(next, "diagnostics", "route-bundle-stats.json");
  if (!existsSync(statsPath)) throw new Error(`${statsPath} 가 없습니다 — 먼저 npm run build (Next 16 빌드 진단 파일)`);
  const stats = JSON.parse(readFileSync(statsPath, "utf8"));
  const root = Array.isArray(stats) ? stats.find((r) => r && r.route === "/") : null;
  if (!root || !Array.isArray(root.firstLoadChunkPaths) || root.firstLoadChunkPaths.length === 0) {
    throw new Error(`${statsPath} 에 '/' 의 firstLoadChunkPaths 가 없습니다 — Next 빌드 진단 형식이 바뀌었는지 확인하세요`);
  }
  const out = [];
  const seen = new Set();
  const add = (group, rel, abs) => {
    if (seen.has(abs)) return;
    if (!existsSync(abs)) throw new Error(`빌드 목록의 파일이 없습니다: ${rel}`);
    seen.add(abs);
    out.push({ group, file: rel, abs });
  };
  for (const p of root.firstLoadChunkPaths) {
    if (typeof p !== "string" || !p.startsWith(".next/static/")) throw new Error(`예상하지 못한 첫 로드 경로: ${String(p)}`);
    add("entry", "/_next/" + p.slice(".next/".length), join(webDir, p));
  }
  const loadablePath = join(next, "server", "app", "page", "react-loadable-manifest.json");
  if (!existsSync(loadablePath)) throw new Error(`${loadablePath} 가 없습니다 — '/' 의 next/dynamic 목록(Next 빌드 형식이 바뀌었는지 확인)`);
  const loadable = JSON.parse(readFileSync(loadablePath, "utf8"));
  for (const entry of Object.values(loadable)) {
    for (const f of entry?.files ?? []) {
      if (typeof f !== "string" || !f.startsWith("static/") || !f.endsWith(".js")) continue; // CSS 는 스크립트가 아니다
      add("dynamic", "/_next/" + f, join(next, f));
    }
  }
  const mlBase = join(webDir, "public", "maplibre");
  const versions = existsSync(mlBase) ? readdirSync(mlBase, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  if (versions.length !== 1) throw new Error(`public/maplibre 에 버전 폴더가 ${versions.length}개입니다(1개여야 함) — scripts/copy-maplibre-worker.mjs(prebuild)`);
  const vdir = join(mlBase, versions[0]);
  const mjs = readdirSync(vdir).filter((f) => f.endsWith(".mjs")).sort();
  if (mjs.length === 0) throw new Error(`${vdir} 에 .mjs 가 없습니다`);
  for (const f of mjs) add("maplibre", `/maplibre/${versions[0]}/${f}`, join(vdir, f));
  for (const f of FIRST_SCREEN_PUBLIC_SCRIPTS) add("public", `/${f}`, join(webDir, "public", f));
  return out;
}

/** 파일 목록 → 행(원본 · 전송 본문 바이트). 행 순서는 전송 바이트 내림차순 */
export function measureFiles(files) {
  return files
    .map(({ group, file, abs }) => {
      const buf = readFileSync(abs);
      return { group, file, raw: buf.length, body: servedBytes(buf) };
    })
    .sort((a, b) => b.body - a.body || a.file.localeCompare(b.file));
}

/** 행 합계(묶음별 · 전체) */
export function summarize(rows) {
  const groups = {};
  let raw = 0, body = 0;
  for (const r of rows) {
    const g = (groups[r.group] ??= { count: 0, raw: 0, body: 0 });
    g.count++; g.raw += r.raw; g.body += r.body;
    raw += r.raw; body += r.body;
  }
  return { count: rows.length, raw, body, groups };
}

/**
 * 예산 판정. budget 은 gzip 본문 바이트. 넘으면 fail 문구, 아니면 null.
 * 예산이 숫자가 아니면(설정 실수) 통과시키지 않고 Error.
 */
export function budgetVerdict(totalBody, budget) {
  if (!Number.isInteger(budget) || budget <= 0) throw new Error(`예산이 올바르지 않습니다: ${String(budget)}`);
  if (totalBody <= budget) return null;
  return `첫 화면 JS ${totalBody} B (${fmtKiB(totalBody)}) 가 예산 ${budget} B (${fmtKiB(budget)}) 를 ${totalBody - budget} B 넘었습니다`;
}

/** 표(사람이 읽는 출력). rows: { group, file, raw, body, ...extra } */
export function formatReport(rows, title) {
  const s = summarize(rows);
  const lines = [title, ""];
  const w = Math.max(10, ...rows.map((r) => r.file.length));
  lines.push(`${"묶음".padEnd(9)} ${"파일".padEnd(w)} ${"원본".padStart(10)} ${"gzip 본문".padStart(12)}`);
  for (const r of rows) lines.push(`${r.group.padEnd(9)} ${r.file.padEnd(w)} ${fmtKiB(r.raw).padStart(10)} ${fmtKiB(r.body).padStart(12)}`);
  lines.push("");
  for (const [g, v] of Object.entries(s.groups).sort((a, b) => b[1].body - a[1].body)) {
    lines.push(`  ${g.padEnd(9)} ${String(v.count).padStart(3)}개  원본 ${fmtKiB(v.raw).padStart(10)}  gzip 본문 ${fmtKiB(v.body).padStart(10)} (${v.body} B)`);
  }
  lines.push(`  ${"합계".padEnd(9)} ${String(s.count).padStart(3)}개  원본 ${fmtKiB(s.raw).padStart(10)}  gzip 본문 ${fmtKiB(s.body).padStart(10)} (${s.body} B)`);
  return lines.join("\n");
}

/** 브라우저 측정에서 스크립트로 셀 응답: 요청 종류가 script 이거나(모듈 import 포함) JS 형식(워커 스크립트는 종류가 other 로 온다) */
export function isScriptResponse(resourceType, contentType) {
  if (resourceType === "script") return true;
  return /^(application|text)\/(javascript|ecmascript)\b/i.test(contentType ?? "");
}

/** 브라우저 측정 행의 묶음 — 빌드 계산과 같은 이름(entry/dynamic 은 브라우저가 구분할 수 없어 next 로 묶는다) */
export function groupOfPath(pathname) {
  if (pathname.startsWith("/maplibre/")) return "maplibre";
  if (pathname.startsWith("/_next/")) return "next";
  return "public";
}

export const MEASURE_USAGE =
  "사용법: node scripts/measure-first-screen-js.mjs [기준 주소] [--serve <포트 8790–8799>] [--settle <ms>] [--json <파일>] [--budget <바이트>]\n" +
  "  기준 주소: 이미 떠 있는 서버(예: 배포 스택 http://localhost:8700). --serve 를 주면 .next/standalone 서버를 127.0.0.1:<포트> 에 띄워 재고 끈다.";

/** 측정 스크립트 인자. 틀리면 Error(문구에 사용법) */
export function parseMeasureArgs(argv) {
  const out = { baseUrl: null, serve: null, settleMs: 3000, json: null, budget: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} 뒤에 값\n${MEASURE_USAGE}`); return v; };
    if (a === "--serve") {
      const p = Number(val());
      if (!Number.isInteger(p) || p < 8790 || p > 8799) throw new Error(`--serve 포트는 8790–8799(다른 프로젝트 포트와 겹치지 않게)\n${MEASURE_USAGE}`);
      out.serve = p;
    } else if (a === "--settle") {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 500 || n > 60_000) throw new Error(`--settle 은 500–60000 ms\n${MEASURE_USAGE}`);
      out.settleMs = n;
    } else if (a === "--json") out.json = val();
    else if (a === "--budget") {
      const n = Number(val());
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--budget 은 양의 정수(바이트)\n${MEASURE_USAGE}`);
      out.budget = n;
    } else if (a.startsWith("-")) throw new Error(`알 수 없는 옵션 ${a}\n${MEASURE_USAGE}`);
    else if (out.baseUrl === null) out.baseUrl = a;
    else throw new Error(`기준 주소는 하나만\n${MEASURE_USAGE}`);
  }
  if (out.serve !== null && out.baseUrl !== null) throw new Error(`기준 주소와 --serve 는 함께 쓰지 않습니다\n${MEASURE_USAGE}`);
  if (out.serve === null && out.baseUrl === null) throw new Error(MEASURE_USAGE);
  if (out.baseUrl !== null) {
    let u;
    try { u = new URL(out.baseUrl); } catch { throw new Error(`기준 주소가 URL 이 아닙니다: ${out.baseUrl}\n${MEASURE_USAGE}`); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`기준 주소는 http(s)\n${MEASURE_USAGE}`);
    out.baseUrl = u.origin;
  } else out.baseUrl = `http://127.0.0.1:${out.serve}`;
  return out;
}

/**
 * 예산 검사(scripts/check-first-screen-js.mjs 의 본체 — 시험이 가짜 빌드로 부른다). code: 0 = 예산 안, 1 = 넘음(표 + 넘은 바이트),
 * 2 = 빌드 결과를 읽지 못함(조용히 통과시키지 않는다).
 */
export function runCheck(webDir, budget = FIRST_SCREEN_JS_BUDGET) {
  let rows;
  try {
    rows = measureFiles(firstScreenFiles(webDir));
  } catch (e) {
    return { code: 2, out: "", err: `첫 화면 JS 를 계산하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` };
  }
  const out = formatReport(rows, "첫 화면 JS(`/`) — 빌드 결과에서 계산(gzip 수준 6 = Next 내장 압축, 응답 머리 제외)");
  const total = summarize(rows).body;
  const verdict = budgetVerdict(total, budget);
  if (verdict) {
    return { code: 1, out, err: `${verdict} — 표에서 새로 실린 것을 찾아 상호작용 뒤로 미루거나(components/DashboardParts), 예산을 바꾸려면 ADR-026 절차(측정 · 근거)를 따르세요.` };
  }
  return { code: 0, out: `${out}\n\n예산 ${budget} B (${fmtKiB(budget)}) 안 — 남은 여유 ${budget - total} B`, err: "" };
}
