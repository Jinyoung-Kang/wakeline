// 첫 화면 JS 브라우저 측정(NFR-04, docs/PERF.md §10 · ADR-026): 상황판 `/` 를 새 브라우저 컨텍스트(빈 캐시)로 열고 받은 스크립트 응답을 센다.
//   node scripts/measure-first-screen-js.mjs http://localhost:8700            # 배포 스택(edge 경유) — 페이지를 여는 것 말고 아무것도 바꾸지 않는다
//   node scripts/measure-first-screen-js.mjs --serve 8790                     # 운영 빌드(.next/standalone server.js — 이미지와 같은 서버)를 127.0.0.1 에 띄워 재고 끈다
//                                                                             # (이 호스트의 Node 가 압축 — 바이트는 기준과 조금 다를 수 있다. 파일 목록을 빌드 결과와 맞춰 본다)
//   ... --json out.json --budget <바이트>                                      # 행 저장 · 예산(gzip 본문 바이트) 넘으면 종료 코드 1
// 두 창 크기(MEASURE_VIEWPORTS — Lighthouse 데스크톱 · 범례가 처음부터 펼쳐지는 넓은 창)로 재고 큰 쪽으로 판정한다.
// 첫 화면의 끝 = 페이지가 남기는 표시(AFTER_FIRST_SCREEN_MARK — 지도가 처음 다 그려진 뒤 한가할 때, 조각 미리 받기 직전). 그 뒤 요청은 따로 보인다.
// 무엇을 받는지는 브라우저가 정하고(스크립트 요청 · 워커 포함, 같은 주소는 한 번 — 두 번째는 캐시), 몇 바이트인지는 같은 주소를 같은 Accept-Encoding 으로
// 다시 받아 잰다(node:http, 풀지 않은 본문). Playwright 의 sizes() 는 워커 요청에서 0 · 음수가 나와 쓰지 않는다.
// 세는 값: 응답 본문의 전송 바이트(gzip 인코딩 그대로, 머리 제외 — 예산 단위) · 머리 바이트(대략) · 풀린 크기. 같은 출처 밖 요청(배경지도 타일 · 레이더)은
// DNS 규칙으로 막는다(스크립트가 아니고, 측정이 외부로 나가지 않게). Playwright 의 route 는 HTTP 캐시를 꺼서 쓰지 않는다(워커가 공용 청크를 캐시에서 쓰지 못한다).
// 종료 코드: 0 = 통과 · 1 = 예산을 넘음 또는 (--serve) 첫 화면 파일이 빌드 결과 목록과 다름 · 2 = 측정 실패(스크립트 실패 · 지도 없음 · 서버를 띄우지 못함).
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { join, resolve } from "node:path";
import {
  AFTER_FIRST_SCREEN_MARK, budgetVerdict, classifyScripts, compareWithBuild, compressorLabel, firstScreenFiles, fmtKiB, groupOfPath, isScriptResponse, MEASURE_USAGE,
  MEASURE_VIEWPORTS, parseMeasureArgs,
} from "./first-screen-js-lib.mjs";

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

/** 조용해질 때까지: 스크립트 응답이 settleMs 동안 새로 없고 진행 중인 script 요청도 없을 때(limitMs 를 넘으면 측정 실패로 끝낸다) */
async function settle(state, settleMs, limitMs, what) {
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - state.lastJsAt >= settleMs && ![...state.pending].some((r) => r.resourceType() === "script")) return;
    if (Date.now() - t0 > limitMs) throw new Error(`${limitMs / 1000} s 안에 스크립트 요청이 멎지 않았습니다(${what}) — 측정을 믿을 수 없어 끝냅니다`);
    await wait(200);
  }
}

/**
 * 한 창 크기로 `/` 를 새 컨텍스트(빈 캐시)로 열어 받은 스크립트 주소(중복 없이)를 모은다 — 크기는 fetchRaw 로 다시 잰다(워커 요청은 Playwright 의
 * sizes() 가 0 · 음수로 온다). 첫 화면의 끝은 페이지가 남기는 표시(AFTER_FIRST_SCREEN_MARK — 지도가 처음 다 그려진 뒤)다: 표시를 기다렸다가
 * 그 뒤의 미리 받기까지 조용해지면, 페이지의 Resource Timing 으로 각 요청이 표시 앞인지 뒤인지 가른다(classifyScripts).
 */
async function collect(browser, base, settleMs, viewport) {
  const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, locale: "ko-KR", serviceWorkers: "block" });
  // Resource Timing 버퍼 기본 250건 — 넘쳐 스크립트 항목이 빠지면 시각을 몰라 첫 화면으로 센다(적게 세지는 않지만 표시 뒤 청크가 섞인다)
  await ctx.addInitScript(() => { try { performance.setResourceTimingBufferSize(5000); } catch { /* 없으면 기본값 */ } });
  try {
    const page = await ctx.newPage();
    const state = { pending: new Set(), lastJsAt: Date.now() };
    const seen = new Map(); // url → { type, status | failed, times }
    ctx.on("request", (req) => { state.pending.add(req); if (req.resourceType() === "script") state.lastJsAt = Date.now(); });
    const finish = async (req, failed) => {
      state.pending.delete(req);
      const resp = failed ? null : await req.response().catch(() => null);
      const ct = resp ? await resp.headerValue("content-type").catch(() => null) : null;
      if (!isScriptResponse(req.resourceType(), ct) && !(failed && req.resourceType() === "script")) return;
      state.lastJsAt = Date.now();
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
    await page.goto(`${base}/`, { waitUntil: "load", timeout: 60_000 });
    await settle(state, settleMs, 60_000, "첫 로드");
    // 첫 화면의 끝 표시(지도 load 뒤 한가할 때 — 배경지도 스타일이 막혀 대체 스타일로 가는 경우도 포함). 없으면 모두 첫 화면으로 센다
    const markStart = await page.waitForFunction((name) => performance.getEntriesByName(name)[0]?.startTime ?? null, AFTER_FIRST_SCREEN_MARK, { timeout: MARK_WAIT_MS, polling: 200 })
      .then((h) => h.jsonValue()).catch(() => null);
    if (markStart != null) await settle(state, settleMs, 60_000, "첫 화면 뒤 미리 받기");
    const entries = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => ({ name: e.name, startTime: e.startTime })));
    const mapCanvas = await page.locator(".maplibregl-canvas").count();
    const workers = page.workers().map((w) => new URL(w.url()).pathname);
    const phase = classifyScripts([...seen.keys()], entries, markStart);
    return { seen, phase, markStart, mapCanvas, workers };
  } finally {
    await ctx.close();
  }
}

/** 첫 화면 끝 표시를 기다리는 최대 시간 — 배경지도 스타일이 오지 않으면 지도는 대체 스타일로 15 s 안에 load 된다(lib/maplayers STYLE_LOAD_TIMEOUT_MS) + 한가함 5 s */
const MARK_WAIT_MS = 30_000;

let child = null;
let code = 0;
let browser = null;
try {
  if (args.serve !== null) child = await serveStandalone(args.serve);
  browser = await chromium.launch({
    // WebGL(지도 생성 → 워커 생성)이 되도록 SwiftShader. 같은 출처 밖 이름은 풀리지 않게(측정이 밖으로 나가지 않는다)
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--host-resolver-rules=MAP * ~NOTFOUND, ${[...new Set([new URL(args.baseUrl).hostname, "localhost", "127.0.0.1"])].map((h) => `EXCLUDE ${h}`).join(", ")}`],
  });
  // 바이트를 만든 쪽은 서버의 압축기다 — --serve 는 이 호스트의 Node, 기준 주소는 그 서버(배포 스택이면 웹 이미지의 Node)
  const compressor = args.serve !== null
    ? `${compressorLabel()} (이 호스트의 Node 로 띄운 standalone 서버 — 예산의 기준인 웹 이미지의 Node 와 zlib 이 다르면 바이트가 조금 다르다)`
    : "그 서버의 Node(배포 스택이면 웹 이미지의 Node — 예산의 기준)";
  const sizes = new Map(); // url → fetchRaw 결과(창 크기마다 다시 받지 않는다)
  const build = args.serve !== null ? firstScreenFiles(WEB).map((f) => f.file) : null;
  const lines = [`첫 화면 JS — 브라우저 측정 ${args.baseUrl}/ (빈 캐시, ${new Date().toISOString()})`, `압축기: ${compressor}`];
  const results = [];
  let worst = null;
  for (const vp of MEASURE_VIEWPORTS) {
    const { seen, phase, markStart, mapCanvas, workers } = await collect(browser, args.baseUrl, args.settleMs, vp);
    const rows = [];
    const failed = [];
    for (const [url, st] of seen) {
      const u = new URL(url);
      if (st.failed || st.status !== 200) { failed.push({ file: u.pathname, why: st.failed ?? `HTTP ${st.status}` }); continue; }
      if (u.origin !== args.baseUrl) { failed.push({ file: url, why: "같은 출처 밖 스크립트" }); continue; }
      if (!sizes.has(url)) sizes.set(url, await fetchRaw(url));
      const r = sizes.get(url);
      if (r.status !== 200) { failed.push({ file: u.pathname, why: `다시 받기 HTTP ${r.status}` }); continue; }
      rows.push({ phase: phase[url], group: groupOfPath(u.pathname), file: u.pathname, type: st.type, times: st.times, encoding: r.encoding, raw: r.raw, body: r.body, headers: r.headerBytes });
    }
    rows.sort((a, b) => (a.phase === b.phase ? 0 : a.phase === "first" ? -1 : 1) || b.body - a.body || a.file.localeCompare(b.file));
    const first = rows.filter((r) => r.phase === "first"), after = rows.filter((r) => r.phase === "after");
    const sum = (rs, k) => rs.reduce((n, r) => n + r[k], 0);
    const w = Math.max(10, ...rows.map((r) => r.file.length));
    lines.push("", `■ 창 ${vp.width}×${vp.height} — ${vp.why}`, "");
    lines.push(`${"구간".padEnd(6)} ${"묶음".padEnd(9)} ${"파일".padEnd(w)} ${"종류".padEnd(7)} ${"요청".padStart(4)} ${"인코딩".padEnd(8)} ${"풀린 크기".padStart(11)} ${"gzip 본문".padStart(11)}`);
    for (const r of rows) lines.push(`${(r.phase === "first" ? "첫화면" : "뒤").padEnd(6)} ${r.group.padEnd(9)} ${r.file.padEnd(w)} ${r.type.padEnd(7)} ${String(r.times).padStart(4)} ${r.encoding.padEnd(8)} ${fmtKiB(r.raw).padStart(11)} ${fmtKiB(r.body).padStart(11)}`);
    for (const f of failed) lines.push(`실패   ${f.file} — ${f.why}`);
    const body = sum(first, "body");
    lines.push("", `  첫 화면: 스크립트 ${first.length}개(같은 주소를 여러 번 요청하면 한 번만 센다 — 두 번째는 캐시) · gzip 본문 합 ${fmtKiB(body)} (${body} B) · 응답 머리 합(대략, 이 서버 기준) ${sum(first, "headers")} B · 풀린 크기 합 ${fmtKiB(sum(first, "raw"))}`);
    lines.push(markStart != null
      ? `  첫 화면 뒤(표시 ${AFTER_FIRST_SCREEN_MARK} ${Math.round(markStart)} ms 뒤 — 지도가 처음 다 그려진 뒤 미리 받은 조각, 예산 밖): ${after.length}개 · ${fmtKiB(sum(after, "body"))} (${sum(after, "body")} B)`
      : `  첫 화면 끝 표시(${AFTER_FIRST_SCREEN_MARK})가 ${MARK_WAIT_MS / 1000} s 안에 없었다 — 받은 스크립트를 모두 첫 화면으로 센다`);
    lines.push(`  지도 캔버스 ${mapCanvas ? "있음" : "없음"} · 워커 ${workers.length ? workers.join(", ") : "없음"} · 실패 ${failed.length}`);
    if (failed.length) { lines.push("  실패한 스크립트 요청이 있습니다 — 첫 화면이 온전히 뜨지 않았습니다"); code = 2; }
    if (!mapCanvas) { lines.push("  지도 캔버스가 없습니다 — 지도(MapLibre · 워커)가 만들어지지 않아 측정이 모자랍니다"); code = 2; }
    let cmp = null;
    if (build) {
      cmp = compareWithBuild(build, first.map((r) => r.file));
      if (cmp.extra.length || cmp.missing.length) {
        lines.push(`  빌드 결과 목록(check:first-js 가 세는 것)과 다르다 — 첫 화면에만 있음: ${cmp.extra.join(", ") || "없음"} · 빌드 목록에만 있음: ${cmp.missing.join(", ") || "없음"}`);
        lines.push("  (import() · React.lazy 조각이 첫 그리기에 쓰였거나 Next 의 목록 형식이 바뀌었다 — CI 의 예산 검사가 첫 화면을 적게 센다)");
        if (code === 0) code = 1;
      } else lines.push(`  빌드 결과 목록과 같은 ${build.length}개 파일`);
    }
    results.push({ viewport: vp, markStart, rows, failed, mapCanvas, workers, body, after: sum(after, "body"), compareWithBuild: cmp });
    if (!worst || body > worst.body) worst = { vp, body };
  }
  lines.push("", `판정에 쓰는 값(두 창 가운데 큰 쪽): ${worst.vp.width}×${worst.vp.height} ${fmtKiB(worst.body)} (${worst.body} B)`);
  console.log(lines.join("\n"));
  if (args.json) writeFileSync(args.json, JSON.stringify({ base: args.baseUrl, measuredAt: new Date().toISOString(), compressor, results, worst: worst.body }, null, 2) + "\n");
  if (code === 0 && args.budget !== null) {
    const v = budgetVerdict(worst.body, args.budget);
    if (v) { console.error(v); code = 1; } else console.log(`  예산 ${args.budget} B (${fmtKiB(args.budget)}) 안`);
  }
  if (code === 1) console.error("첫 화면 파일 목록이 빌드 결과와 다르거나 예산을 넘었습니다 — 위 표를 보세요");
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  console.error(MEASURE_USAGE);
  code = 2;
} finally {
  await browser?.close().catch(() => {});
  await stop(child);
}
process.exit(code);
