// 첫 화면 JS 브라우저 측정(NFR-04, docs/PERF.md §10 · ADR-026): 상황판 `/` 를 새 브라우저 컨텍스트(빈 캐시)로 열고 받은 스크립트 응답을 센다.
//   node scripts/measure-first-screen-js.mjs http://localhost:8700            # 배포 스택(edge 경유) — 페이지를 여는 것 말고 아무것도 바꾸지 않는다
//   node scripts/measure-first-screen-js.mjs --serve 8790                     # 운영 빌드(.next/standalone server.js — 이미지와 같은 서버 · 같은 gzip)를 127.0.0.1 에 띄워 재고 끈다
//   ... --json out.json --budget <바이트>                                      # 행 저장 · 예산(gzip 본문 바이트) 넘으면 종료 코드 1
// 무엇을 받는지는 브라우저가 정하고(스크립트 요청 · 워커 포함, 같은 주소는 한 번 — 두 번째는 캐시), 몇 바이트인지는 같은 주소를 같은 Accept-Encoding 으로
// 다시 받아 잰다(node:http, 풀지 않은 본문). Playwright 의 sizes() 는 워커 요청에서 0 · 음수가 나와 쓰지 않는다.
// 세는 값: 응답 본문의 전송 바이트(gzip 인코딩 그대로, 머리 제외 — 예산 단위) · 머리 바이트(대략) · 풀린 크기. 같은 출처 밖 요청(배경지도 타일 · 레이더)은
// DNS 규칙으로 막는다(스크립트가 아니고, 측정이 외부로 나가지 않게). Playwright 의 route 는 HTTP 캐시를 꺼서 쓰지 않는다(워커가 공용 청크를 캐시에서 쓰지 못한다).
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { join, resolve } from "node:path";
import { budgetVerdict, compressorLabel, fmtKiB, groupOfPath, isScriptResponse, MEASURE_USAGE, parseMeasureArgs } from "./first-screen-js-lib.mjs";

const WEB = resolve(import.meta.dirname, "..");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Chromium 이 보내는 값과 같게(서버가 고르는 인코딩이 브라우저와 같도록) */
const ACCEPT_ENCODING = "gzip, deflate, br, zstd";

let args;
try { args = parseMeasureArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }

/** Dockerfile 과 같은 배치(.next/static · public 을 standalone 옆에)로 server.js 를 띄운다 — 이 스크립트가 띄운 자식만 끈다 */
async function serveStandalone(port) {
  const sa = join(WEB, ".next", "standalone");
  if (!existsSync(join(sa, "server.js"))) throw new Error(".next/standalone/server.js 가 없습니다 — 먼저 npm run build");
  for (const [from, to] of [[join(WEB, ".next", "static"), join(sa, ".next", "static")], [join(WEB, "public"), join(sa, "public")]]) {
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  }
  const child = spawn(process.execPath, ["server.js"], {
    cwd: sa,
    env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`서버가 끝났습니다(exit ${child.exitCode}):\n${log.slice(-2000)}`);
    try { if ((await fetch(`${base}/health`)).ok) return child; } catch { /* 아직 안 뜸 */ }
    await wait(200);
  }
  child.kill("SIGTERM");
  throw new Error(`서버가 20 s 안에 뜨지 않았습니다:\n${log.slice(-2000)}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([done, wait(5000)]);
  if (child.exitCode === null) { child.kill("SIGKILL"); await done; }
}

/** 한 주소를 다시 받아 전송 본문 바이트를 잰다 — 브라우저와 같은 Accept-Encoding, 자동으로 풀지 않는다(node:http) */
function fetchRaw(url) {
  return new Promise((res, rej) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { headers: { "accept-encoding": ACCEPT_ENCODING, "user-agent": "wakeline-measure-first-screen-js" } }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const buf = Buffer.concat(chunks);
        const enc = String(r.headers["content-encoding"] ?? "identity");
        let raw = buf.length;
        if (enc === "gzip") raw = gunzipSync(buf).length;
        else if (enc === "br") raw = brotliDecompressSync(buf).length;
        else if (enc === "deflate") raw = inflateSync(buf).length;
        else if (enc !== "identity") return rej(new Error(`${url}: 모르는 Content-Encoding ${enc}`));
        // 머리 바이트(대략): 상태 줄 + 'name: value\r\n' 들 + 빈 줄 — HTTP/1.1 기준
        const headerBytes = `HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n`.length + r.rawHeaders.reduce((s, v) => s + v.length + 2, 0) + 2; // 이름 뒤 ": " · 값 뒤 "\r\n" 이 각 2 B
        res({ status: r.statusCode, encoding: enc, body: buf.length, raw, headerBytes });
      });
      r.on("error", rej);
    });
    req.on("error", rej);
    req.setTimeout(30_000, () => req.destroy(new Error(`${url}: 30 s 시간 초과`)));
  });
}

/** 브라우저로 `/` 를 열어 받은 스크립트 주소(중복 없이)를 모은다 — 크기는 fetchRaw 로 다시 잰다(워커 요청은 Playwright 의 sizes() 가 0 · 음수로 온다) */
async function collect(base, settleMs) {
  const host = new URL(base).hostname;
  const excludes = [...new Set([host, "localhost", "127.0.0.1"])].map((h) => `EXCLUDE ${h}`).join(", ");
  const browser = await chromium.launch({
    // WebGL(지도 생성 → 워커 생성)이 되도록 SwiftShader. 같은 출처 밖 이름은 풀리지 않게(측정이 밖으로 나가지 않는다)
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--host-resolver-rules=MAP * ~NOTFOUND, ${excludes}`],
  });
  try {
    // Lighthouse 데스크톱과 같은 창 크기(PERF §7·§8 의 옛 측정)
    const ctx = await browser.newContext({ viewport: { width: 1350, height: 940 }, locale: "ko-KR", serviceWorkers: "block" });
    const page = await ctx.newPage();
    const pending = new Set();
    const seen = new Map(); // url → { type, status | failed, times }
    let lastJsAt = Date.now();
    ctx.on("request", (req) => { pending.add(req); if (req.resourceType() === "script") lastJsAt = Date.now(); });
    const finish = async (req, failed) => {
      pending.delete(req);
      const resp = failed ? null : await req.response().catch(() => null);
      const ct = resp ? await resp.headerValue("content-type").catch(() => null) : null;
      if (!isScriptResponse(req.resourceType(), ct) && !(failed && req.resourceType() === "script")) return;
      lastJsAt = Date.now();
      const prev = seen.get(req.url());
      seen.set(req.url(), {
        type: req.resourceType(),
        status: resp ? resp.status() : null,
        failed: failed ? (req.failure()?.errorText ?? "failed") : null,
        times: (prev?.times ?? 0) + 1,
      });
    };
    ctx.on("requestfinished", (r) => { finish(r, false); });
    ctx.on("requestfailed", (r) => { finish(r, true); });
    const t0 = Date.now();
    await page.goto(`${base}/`, { waitUntil: "load", timeout: 60_000 });
    // 조용해질 때까지: 스크립트 응답이 settleMs 동안 새로 없고 진행 중인 script 요청도 없을 때(최대 60 s — 넘으면 측정 실패로 끝낸다)
    for (;;) {
      if (Date.now() - lastJsAt >= settleMs && ![...pending].some((r) => r.resourceType() === "script")) break;
      if (Date.now() - t0 > 60_000) throw new Error("60 s 안에 스크립트 요청이 멎지 않았습니다 — 측정을 믿을 수 없어 끝냅니다");
      await wait(200);
    }
    const mapCanvas = await page.locator(".maplibregl-canvas").count();
    const workers = page.workers().map((w) => new URL(w.url()).pathname);
    await ctx.close();
    return { seen, mapCanvas, workers };
  } finally {
    await browser.close();
  }
}

let child = null;
let code = 0;
try {
  if (args.serve !== null) child = await serveStandalone(args.serve);
  const { seen, mapCanvas, workers } = await collect(args.baseUrl, args.settleMs);
  const rows = [];
  const failed = [];
  for (const [url, s] of seen) {
    const u = new URL(url);
    if (s.failed || s.status !== 200) { failed.push({ file: u.pathname, why: s.failed ?? `HTTP ${s.status}` }); continue; }
    if (u.origin !== args.baseUrl) { failed.push({ file: url, why: "같은 출처 밖 스크립트" }); continue; }
    const r = await fetchRaw(url);
    if (r.status !== 200) { failed.push({ file: u.pathname, why: `다시 받기 HTTP ${r.status}` }); continue; }
    rows.push({ group: groupOfPath(u.pathname), file: u.pathname, type: s.type, times: s.times, encoding: r.encoding, raw: r.raw, body: r.body, headers: r.headerBytes });
  }
  rows.sort((a, b) => b.body - a.body || a.file.localeCompare(b.file));
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const w = Math.max(10, ...rows.map((r) => r.file.length));
  // 바이트를 만든 쪽은 서버의 압축기다 — --serve 는 이 호스트의 Node, 기준 주소는 그 서버(배포 스택이면 웹 이미지의 Node)
  const compressor = args.serve !== null
    ? `${compressorLabel()} (이 호스트의 Node 로 띄운 standalone 서버 — 예산의 기준인 웹 이미지의 Node 와 zlib 이 다르면 바이트가 조금 다르다)`
    : "그 서버의 Node(배포 스택이면 웹 이미지의 Node — 예산의 기준)";
  const lines = [`첫 화면 JS — 브라우저 측정 ${args.baseUrl}/ (빈 캐시, ${new Date().toISOString()})`, `압축기: ${compressor}`, ""];
  lines.push(`${"묶음".padEnd(9)} ${"파일".padEnd(w)} ${"종류".padEnd(7)} ${"요청".padStart(4)} ${"인코딩".padEnd(8)} ${"풀린 크기".padStart(11)} ${"gzip 본문".padStart(11)}`);
  for (const r of rows) lines.push(`${r.group.padEnd(9)} ${r.file.padEnd(w)} ${r.type.padEnd(7)} ${String(r.times).padStart(4)} ${r.encoding.padEnd(8)} ${fmtKiB(r.raw).padStart(11)} ${fmtKiB(r.body).padStart(11)}`);
  for (const f of failed) lines.push(`실패      ${f.file} — ${f.why}`);
  const body = sum("body"), headers = sum("headers");
  lines.push("", `  스크립트 ${rows.length}개(같은 주소를 여러 번 요청하면 한 번만 센다 — 두 번째는 캐시) · 실패 ${failed.length}`);
  lines.push(`  gzip 본문 합 ${fmtKiB(body)} (${body} B) · 응답 머리 합(대략, 이 서버 기준) ${headers} B · 풀린 크기 합 ${fmtKiB(sum("raw"))}`);
  lines.push(`  지도 캔버스 ${mapCanvas ? "있음" : "없음"} · 워커 ${workers.length ? workers.join(", ") : "없음"}`);
  console.log(lines.join("\n"));
  if (args.json) writeFileSync(args.json, JSON.stringify({ base: args.baseUrl, measuredAt: new Date().toISOString(), compressor, rows, failed, mapCanvas, workers, body, headers }, null, 2) + "\n");
  if (failed.length) { console.error("실패한 스크립트 요청이 있습니다 — 첫 화면이 온전히 뜨지 않았습니다"); code = 2; }
  if (!mapCanvas) { console.error("지도 캔버스가 없습니다 — 지도(MapLibre · 워커)가 만들어지지 않아 측정이 모자랍니다"); code = 2; }
  if (code === 0 && args.budget !== null) {
    const v = budgetVerdict(body, args.budget);
    if (v) { console.error(v); code = 1; } else console.log(`  예산 ${args.budget} B (${fmtKiB(args.budget)}) 안`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  console.error(MEASURE_USAGE);
  code = 2;
} finally {
  await stop(child);
}
process.exit(code);
