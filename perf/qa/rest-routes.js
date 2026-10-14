// QA 2026-10 성능(계획 §3.5): 공개 REST 핵심 경로를 섞어 도착률 고정(MODE=fixed) 또는 계단식(MODE=step)으로 부른다. perf/rest.js 가 덮지 않는 경로를 더했다.
// 격리 스택 A 의 api 에 직접(측정 동안만 IP 제한 상향):
//   docker run --rm --network wakeline-e2e_wakeline -v <worktree>/perf:/perf -w /perf -e BASE_URL=http://10.78.0.30:8000 -e RPS=100 -e DURATION=3m \
//     grafana/k6:2.3.0@sha256:9c2dee7f… run qa/rest-routes.js
// 계단: -e MODE=step -e STEPS=50,100,200,300,400,600 -e STEP_S=60 (단계마다 p95 · 오류 — 태그 stage).
// edge 경유(제한 동작): -e BASE_URL=http://10.78.0.10:8700 -e HOST=localhost:8701 -e RPS=20 -e DURATION=1m (429 가 정상).
// 경로마다 임계값 p95 < 300 ms · 오류 < 1 % — 넘으면 k6 종료 코드 99(QA-4xx 재현).
// 데이터: tools/qa/seed_perf.sql 의 합성 항적(hex f1xxxx · f2xxxx) · 선박(MMSI 300000000–300011999) · 알림 · 통계, tools/qa/perf_feed.py 의 실시간 전세계 · 선박.
// QA 2026-10 AWS(docs/qa/2026-10-aws QA-PLAN §3.5): 공개 32경로(OpenAPI 스냅샷)를 모두 부른다 — 아래 ROUTES 끝의 13경로를 더했다(앞의 경로 이름 · 무게는 그대로).
//   SHIP_N: 선박 경로가 고르는 MMSI 범위(기본 12000 — seed_perf.sql, AWS 규모 seed_perf_aws.sql 은 3000).
//   status_503: 경로 · 단계마다 503 비율(공개 조회 격벽 — 허가를 1 s 안에 얻지 못하면 503). 실패(http_req_failed)와 따로 본다.
import http from "k6/http";
import { check } from "k6";
import { Rate } from "k6/metrics";
import exec from "k6/execution";

const BASE = __ENV.BASE_URL || "http://10.78.0.30:8000";
const HOST = __ENV.HOST || "";
const MODE = __ENV.MODE || "fixed";
const STEPS = (__ENV.STEPS || "50,100,200,300,400,600").split(",").map(Number);
const STEP_S = Number(__ENV.STEP_S || 60);
const ONLY = (__ENV.ONLY || "").split(",").filter(Boolean);
const OUT = __ENV.OUT || "results/qa-rest-summary.json";
const HDRS = HOST ? { Host: HOST } : {};
const SHIP_N = Number(__ENV.SHIP_N || 12000);
const status503 = new Rate("status_503");

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
  ["ship_track", 1, () => `/api/v1/ships/${300000000 + Math.floor(rnd(0, SHIP_N))}/track`],
  ["alerts_history", 1, () => `/api/v1/alerts/history?from=${iso(now - rnd(2, 29) * 86400e3)}&limit=50`],
  ["aircraft_search", 1, () => `/api/v1/aircraft/search?q=${pick(["HL", "JA1", "B-2", "N4", "F2", "F10", "QA"])}`],
  ["ships_search", 1, () => `/api/v1/ships/search?q=${encodeURIComponent(pick(["QA VESSEL 1", "QA VESSEL 2", "3000012", "Q00A", "9000123"]))}&limit=10`],
  ["airport_wx", 1, () => `/api/v1/airports/${pick(["RKSI", "RKSS", "RKPC", "RKPK", "RJFF"])}/wx`],
  // 출시 QA 2차(docs/qa/2026-10-release §3.5): 앞선 QA 뒤 더한 공개 경로 — 관심 대상(상한 50: 항공기 20 · 선박 10 · 공항 20 — 공항은 DB) · 알림 한 건(DB) ·
  // 특보 · 특보 이력(DB) · 공역(압축 전 수백 KB — 기본 거르기 없음)
  ["watch_50", 1, () => `/api/v1/watch?aircraft=${LONG_HEX.concat(LONG_HEX.map((h) => h.replace("f1", "f2"))).join(",")}` +
    `&ships=${Array.from({ length: 10 }, () => 300000000 + Math.floor(rnd(0, SHIP_N))).join(",")}` +
    `&airports=${["RKSI", "RKSS", "RKPC", "RKPK", "RJFF", "RJTT", "RJAA", "RCTP", "VHHH", "ZSPD", "RKTN", "RKTU", "RKJJ", "RKNY", "RKJB", "RKPU", "RKTH", "RJBB", "RJCC", "ZBAA"].join(",")}`],
  ["alert_one", 1, () => `/api/v1/alerts/${ALERT_IDS.length ? pick(ALERT_IDS) : 1}`],
  ["warnings", 1, () => `/api/v1/warnings`],
  ["warnings_history", 1, () => `/api/v1/warnings/history?from=${iso(now - rnd(1, 29) * 86400e3)}`],
  ["airspace", 1, () => `/api/v1/airspace`],
  // QA 2026-10 AWS: 공개 32경로 중 위에 없던 13경로. [이름, 무게, 경로, (선택) 정상으로 볼 상태 · POST 본문]
  ["aircraft_detail", 1, () => `/api/v1/aircraft/${pick(LONG_HEX)}`],
  ["ship_detail", 1, () => `/api/v1/ships/${300000000 + Math.floor(rnd(0, SHIP_N))}`],
  ["airports", 1, () => `/api/v1/airports${pick(["", "?watched=false"])}`],
  ["ais_gaps", 1, () => `/api/v1/ais/gaps?from=${iso(now - rnd(1, 30) * 86400e3)}`],
  ["alerts_active", 1, () => `/api/v1/alerts`],
  ["sigmet_one", 1, () => `/api/v1/sigmets/${encodeURIComponent(SIGMET_IDS.length ? pick(SIGMET_IDS) : "none")}`, [404]],
  ["radar_frames", 1, () => `/api/v1/radar/frames`],
  ["radar_kr", 1, () => `/api/v1/radar/kr`],
  // fixture 모드는 기상청 레이더가 꺼져 프레임이 없다 — 없는 프레임의 404 경로(Redis 조회 한 번)를 잰다
  ["radar_kr_png", 1, () => `/api/v1/radar/kr/${RADAR_TM}.png`, [404]],
  ["ships_coverage", 1, () => `/api/v1/ships/coverage`],
  ["traffic_grid", 1, () => `/api/v1/traffic/grid`],
  // 브라우저 오류 수집(POST) — 자체 제한(IP 당 분당 10 · 전체 분당 120, Redis)이 있어 k6 한 IP 에서는 429 가 정상이다
  ["client_errors", 1, () => `/api/v1/client-errors`, [429], () => JSON.stringify({ message: "qa perf synthetic", stack: null, path: "/", component: "qa-perf", ts: new Date().toISOString() })],
  ["healthz", 1, () => `/healthz`],
].filter((r) => ONLY.length === 0 || ONLY.includes(r[0]));
const TOTAL = ROUTES.reduce((s, r) => s + r[1], 0);
// 알림 한 건: 시험 자료의 닫힌 알림 id(setup 이 이력에서 읽는다 — 없으면 404 경로를 잰다)
let ALERT_IDS = [];
// SIGMET 한 건: 지금 유효한 SIGMET id(setup) · 기상청 레이더 프레임 tm(setup — 없으면 지금 5분 단위 tm)
let SIGMET_IDS = [];
let RADAR_TM = "";
const tmNow = () => { const d = new Date(Math.floor((now - 10 * 60e3) / 300e3) * 300e3); return d.toISOString().replace(/[-:T]/g, "").slice(0, 12); };
export function setup() {
  const out = { ids: [], sigmets: [], tm: tmNow() };
  const r = http.get(`${BASE}/api/v1/alerts/history?from=${iso(now - 29 * 86400e3)}&limit=200`, { headers: HDRS });
  try { out.ids = JSON.parse(r.body).items.map((a) => a.id); } catch (e) { /* 없으면 404 경로 */ }
  const s = http.get(`${BASE}/api/v1/sigmets?active=true`, { headers: HDRS });
  try { out.sigmets = JSON.parse(s.body).features.map((f) => f.id || (f.properties || {}).id).filter(Boolean); } catch (e) { /* 없으면 404 경로 */ }
  const k = http.get(`${BASE}/api/v1/radar/kr`, { headers: HDRS });
  try { const j = JSON.parse(k.body); if (j.latest_tm) out.tm = j.latest_tm; } catch (e) { /* 지금 tm */ }
  return out;
}

const thresholds = {};
for (const [n] of ROUTES) {
  thresholds[`http_req_duration{name:${n}}`] = ["p(95)<300"];
  thresholds[`http_req_failed{name:${n}}`] = ["rate<0.01"];
  thresholds[`http_reqs{name:${n}}`] = ["count>=0"];
  thresholds[`status_503{name:${n}}`] = ["rate>=0"];
}
thresholds["status_503"] = ["rate>=0"];
if (MODE === "step") {
  STEPS.forEach((_, i) => {
    thresholds[`http_req_duration{stage:s${i}}`] = ["p(95)<300"];
    thresholds[`http_req_failed{stage:s${i}}`] = ["rate<0.01"];
    thresholds[`http_reqs{stage:s${i}}`] = ["count>=0"];
    thresholds[`status_503{stage:s${i}}`] = ["rate>=0"];
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

export default function (data) {
  if (data && data.ids && ALERT_IDS.length === 0) ALERT_IDS = data.ids;
  if (data && data.sigmets && SIGMET_IDS.length === 0) SIGMET_IDS = data.sigmets;
  if (data && data.tm && !RADAR_TM) RADAR_TM = data.tm;
  const [name, , path, okExtra, body] = choose();
  const tags = { name };
  if (MODE === "step") tags.stage = `s${Math.min(STEPS.length - 1, Math.floor(exec.instance.currentTestRunDuration / 1000 / STEP_S))}`;
  const params = { tags, headers: HDRS, timeout: "30s" };
  // 경로가 정상으로 보는 상태(404 · 429)는 실패로 세지 않는다 — 503 · 5xx · 시간 초과만 실패
  if (okExtra) params.responseCallback = http.expectedStatuses({ min: 200, max: 399 }, ...okExtra);
  const res = body
    ? http.post(`${BASE}${path()}`, body(), Object.assign(params, { headers: Object.assign({ "Content-Type": "application/json" }, HDRS) }))
    : http.get(`${BASE}${path()}`, params);
  status503.add(res.status === 503, tags);
  check(res, { "2xx/304": (x) => (x.status >= 200 && x.status < 300) || x.status === 304 || (okExtra || []).includes(x.status) }, tags);
}

export function handleSummary(data) {
  const m = data.metrics;
  const names = ROUTES.map((r) => r[0]);
  const dur = data.state.testRunDurationMs / 1000;
  const line = (key, label, secs) => {
    const d = m[`http_req_duration{${key}}`];
    const f = m[`http_req_failed{${key}}`];
    const c = m[`http_reqs{${key}}`];
    const s5 = m[`status_503{${key}}`];
    if (!d) return `${label.padEnd(16)} n/a\n`;
    const v = d.values;
    return `${label.padEnd(16)} n=${String(c ? c.values.count : 0).padStart(6)} rate=${(c ? c.values.count / (secs || dur) : 0).toFixed(1).padStart(6)}/s ` +
      `p50=${v.med.toFixed(1)} p95=${v["p(95)"].toFixed(1)} p99=${v["p(99)"].toFixed(1)} max=${v.max.toFixed(1)} ms err=${(f ? f.values.rate * 100 : 0).toFixed(2)}%` +
      ` 503=${(s5 ? s5.values.rate * 100 : 0).toFixed(2)}%\n`;
  };
  let out = `\nREST(${MODE}): reqs=${m.http_reqs.values.count} rate=${m.http_reqs.values.rate.toFixed(1)}/s failed=${(m.http_req_failed.values.rate * 100).toFixed(2)}% ` +
    `503=${(m.status_503 ? m.status_503.values.rate * 100 : 0).toFixed(2)}% ` +
    `dropped_iterations=${m.dropped_iterations ? m.dropped_iterations.values.count : 0} vus_max=${m.vus_max ? m.vus_max.values.max : "?"}\n`;
  out += `all              p50=${m.http_req_duration.values.med.toFixed(1)} p95=${m.http_req_duration.values["p(95)"].toFixed(1)} p99=${m.http_req_duration.values["p(99)"].toFixed(1)} max=${m.http_req_duration.values.max.toFixed(1)} ms\n`;
  for (const n of names) out += line(`name:${n}`, n);
  if (MODE === "step") STEPS.forEach((r, i) => { out += line(`stage:s${i}`, `step ${r} rps`, STEP_S); });
  return { [OUT]: JSON.stringify(data, null, 1), stdout: out };
}
