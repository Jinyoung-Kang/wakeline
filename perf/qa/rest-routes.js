// QA 2026-10 성능(계획 §3.5): 공개 REST 핵심 경로를 섞어 도착률 고정(MODE=fixed) 또는 계단식(MODE=step)으로 부른다. perf/rest.js 가 덮지 않는 경로를 더했다.
// 격리 스택 A 의 api 에 직접(측정 동안만 IP 제한 상향):
//   docker run --rm --network wakeline-e2e_wakeline -v <worktree>/perf:/perf -w /perf -e BASE_URL=http://10.78.0.30:8000 -e RPS=100 -e DURATION=3m \
//     grafana/k6:2.3.0@sha256:9c2dee7f… run qa/rest-routes.js
// 계단: -e MODE=step -e STEPS=50,100,200,300,400,600 -e STEP_S=60 (단계마다 p95 · 오류 — 태그 stage).
// edge 경유(제한 동작): -e BASE_URL=http://10.78.0.10:8700 -e HOST=localhost:8701 -e RPS=20 -e DURATION=1m (429 가 정상).
// 경로마다 임계값 p95 < 300 ms · 오류 < 1 % — 넘으면 k6 종료 코드 99(QA-4xx 재현).
// 데이터: tools/qa/seed_perf.sql 의 합성 항적(hex f1xxxx · f2xxxx) · 선박(MMSI 300000000–300011999) · 알림 · 통계, tools/qa/perf_feed.py 의 실시간 전세계 · 선박.
import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";

const BASE = __ENV.BASE_URL || "http://10.78.0.30:8000";
const HOST = __ENV.HOST || "";
const MODE = __ENV.MODE || "fixed";
const STEPS = (__ENV.STEPS || "50,100,200,300,400,600").split(",").map(Number);
const STEP_S = Number(__ENV.STEP_S || 60);
const ONLY = (__ENV.ONLY || "").split(",").filter(Boolean);
const OUT = __ENV.OUT || "results/qa-rest-summary.json";
const HDRS = HOST ? { Host: HOST } : {};

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const kstDay = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (a, b) => a + Math.random() * (b - a);
// 72 h 내내 같은 hex 인 관심 지역 합성 기체 10대(seed_perf.sql 0..9 번 칸) + 그때그때 바뀌는 칸의 hex 는 쓰지 않는다
const LONG_HEX = Array.from({ length: 10 }, (_, s) => (0xf10000 + s * 64).toString(16));
const REGION = "124,33,132,39";
const WIDE = "100,10,150,60"; // 넓이 2,500 sq° = 상한(max-bbox-area-sqdeg)

// [이름, 무게, 경로 만들기]
const ROUTES = [
  ["aircraft_region", 3, () => `/api/v1/aircraft?bbox=${REGION}&detail=lite`],
  ["aircraft_wide", 1, () => `/api/v1/aircraft?bbox=${WIDE}&detail=full`],
  ["ships_region", 2, () => `/api/v1/ships?bbox=120,30,135,42`],
  ["sigmets", 2, () => `/api/v1/sigmets?active=true`],
  ["status", 2, () => `/api/v1/status`],
  ["replay_72h", 1, () => `/api/v1/replay?at=${iso(now - rnd(10 * 60e3, 68 * 3600e3))}&bbox=${REGION}`],
  ["replay_1m", 1, () => `/api/v1/replay?at=${iso(now - rnd(4 * 86400e3, 29 * 86400e3))}&bbox=${REGION}`],
  ["stats_sigmet", 1, () => `/api/v1/stats/sigmet?group=${pick(["fir", "hazard"])}`],
  ["stats_alerts", 1, () => `/api/v1/stats/alerts`],
  ["stats_traffic", 1, () => `/api/v1/stats/traffic?day=${kstDay(now - Math.floor(rnd(1, 7)) * 86400e3)}`],
  ["aircraft_track", 1, () => `/api/v1/aircraft/${pick(LONG_HEX)}/track`],
  ["ship_track", 1, () => `/api/v1/ships/${300000000 + Math.floor(rnd(0, 12000))}/track`],
  ["alerts_history", 1, () => `/api/v1/alerts/history?from=${iso(now - rnd(2, 29) * 86400e3)}&limit=50`],
  ["aircraft_search", 1, () => `/api/v1/aircraft/search?q=${pick(["HL", "JA1", "B-2", "N4", "F2", "F10", "QA"])}`],
  ["ships_search", 1, () => `/api/v1/ships/search?q=${encodeURIComponent(pick(["QA VESSEL 1", "QA VESSEL 2", "3000012", "Q00A", "9000123"]))}&limit=10`],
  ["airport_wx", 1, () => `/api/v1/airports/${pick(["RKSI", "RKSS", "RKPC", "RKPK", "RJFF"])}/wx`],
].filter((r) => ONLY.length === 0 || ONLY.includes(r[0]));
const TOTAL = ROUTES.reduce((s, r) => s + r[1], 0);

const thresholds = {};
for (const [n] of ROUTES) {
  thresholds[`http_req_duration{name:${n}}`] = ["p(95)<300"];
  thresholds[`http_req_failed{name:${n}}`] = ["rate<0.01"];
  thresholds[`http_reqs{name:${n}}`] = ["count>=0"];
}
if (MODE === "step") {
  STEPS.forEach((_, i) => {
    thresholds[`http_req_duration{stage:s${i}}`] = ["p(95)<300"];
    thresholds[`http_req_failed{stage:s${i}}`] = ["rate<0.01"];
    thresholds[`http_reqs{stage:s${i}}`] = ["count>=0"];
  });
}

export const options = {
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
  discardResponseBodies: false,
  scenarios: MODE === "step"
    ? { step: { executor: "ramping-arrival-rate", startRate: STEPS[0], timeUnit: "1s", preAllocatedVUs: 200, maxVUs: 2000,
        stages: STEPS.flatMap((r) => [{ duration: "5s", target: r }, { duration: `${STEP_S - 5}s`, target: r }]) } }
    : { rest: { executor: "constant-arrival-rate", rate: Number(__ENV.RPS || 100), timeUnit: "1s", duration: __ENV.DURATION || "3m",
        preAllocatedVUs: 100, maxVUs: 1000 } },
  thresholds,
};

function choose() {
  let x = Math.random() * TOTAL;
  for (const r of ROUTES) { if ((x -= r[1]) < 0) return r; }
  return ROUTES[ROUTES.length - 1];
}

export default function () {
  const [name, , path] = choose();
  const tags = { name };
  if (MODE === "step") tags.stage = `s${Math.min(STEPS.length - 1, Math.floor(exec.instance.currentTestRunDuration / 1000 / STEP_S))}`;
  const res = http.get(`${BASE}${path()}`, { tags, headers: HDRS, timeout: "30s" });
  check(res, { "2xx/304": (x) => (x.status >= 200 && x.status < 300) || x.status === 304 }, tags);
}

export function handleSummary(data) {
  const m = data.metrics;
  const names = ROUTES.map((r) => r[0]);
  const dur = data.state.testRunDurationMs / 1000;
  const line = (key, label, secs) => {
    const d = m[`http_req_duration{${key}}`];
    const f = m[`http_req_failed{${key}}`];
    const c = m[`http_reqs{${key}}`];
    if (!d) return `${label.padEnd(16)} n/a\n`;
    const v = d.values;
    return `${label.padEnd(16)} n=${String(c ? c.values.count : 0).padStart(6)} rate=${(c ? c.values.count / (secs || dur) : 0).toFixed(1).padStart(6)}/s ` +
      `p50=${v.med.toFixed(1)} p95=${v["p(95)"].toFixed(1)} p99=${v["p(99)"].toFixed(1)} max=${v.max.toFixed(1)} ms err=${(f ? f.values.rate * 100 : 0).toFixed(2)}%\n`;
  };
  let out = `\nREST(${MODE}): reqs=${m.http_reqs.values.count} rate=${m.http_reqs.values.rate.toFixed(1)}/s failed=${(m.http_req_failed.values.rate * 100).toFixed(2)}% ` +
    `dropped_iterations=${m.dropped_iterations ? m.dropped_iterations.values.count : 0} vus_max=${m.vus_max ? m.vus_max.values.max : "?"}\n`;
  out += `all              p50=${m.http_req_duration.values.med.toFixed(1)} p95=${m.http_req_duration.values["p(95)"].toFixed(1)} p99=${m.http_req_duration.values["p(99)"].toFixed(1)} max=${m.http_req_duration.values.max.toFixed(1)} ms\n`;
  for (const n of names) out += line(`name:${n}`, n);
  if (MODE === "step") STEPS.forEach((r, i) => { out += line(`stage:s${i}`, `step ${r} rps`, STEP_S); });
  return { [OUT]: JSON.stringify(data, null, 1), stdout: out };
}
