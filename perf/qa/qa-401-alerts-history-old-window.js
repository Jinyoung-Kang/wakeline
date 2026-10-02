// QA-401 재현(k6): /api/v1/alerts/history 를 30일 보존 안의 '오래된 좁은 창'(15–29일 전, 1 h — 합법 파라미터)으로 부르면 DB 가 alert_event 를
// id 역순으로 거의 전부 훑어 공개 조회 상한 3 s 에 끊기고 503 이 된다. 같은 동안 그 요청이 공개 조회 격벽(허가 6)을 3 s 씩 잡아 다른 공개 DB 조회
// (재생 · 통계 · 항적)도 503 이 된다.
//   docker run --rm --network wakeline-e2e_wakeline -v <worktree>/perf:/perf -w /perf -e BASE_URL=http://10.78.0.30:8000 grafana/k6:2.3.0@sha256:… \
//     run -e ATTACK_RPS=2 -e VICTIM_RPS=10 qa/qa-401-alerts-history-old-window.js
// edge 경유(기본 제한 — IP 당 10 r/s · api 분당 120 = 2 r/s 이므로 공격 2 r/s 는 제한 안): -e BASE_URL=http://10.78.0.10:8700 -e HOST=localhost:8701
// ATTACK_RPS=0 이면 기준선(피해 요청만), VICTIM_RPS=0 이면 공격만(edge 에서는 IP 가 다른 두 k6 컨테이너로 나눠 돌린다 — api 의 IP 당 한도). 임계값: 오래된 창 p95 < 300 ms · 실패 < 1 %, 피해 요청 실패 < 1 % — 결함이면 k6 종료 코드 99.
// 데이터: tools/qa/seed_perf.sql(alert_event 약 117만 행, 29.5일).
import http from "k6/http";

const BASE = __ENV.BASE_URL || "http://10.78.0.30:8000";
const HDRS = __ENV.HOST ? { Host: __ENV.HOST } : {};
const ATTACK = Number(__ENV.ATTACK_RPS || 2);
const VICTIM = Number(__ENV.VICTIM_RPS || 10);
const DUR = __ENV.DURATION || "60s";
const OUT = __ENV.OUT || "results/qa-401.json";
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const rnd = (a, b) => a + Math.random() * (b - a);

const scenarios = {};
if (VICTIM > 0) scenarios.victim = { executor: "constant-arrival-rate", exec: "victim", rate: VICTIM, timeUnit: "1s", duration: DUR, preAllocatedVUs: 20, maxVUs: 200 };
if (ATTACK > 0) scenarios.old_window = { executor: "constant-arrival-rate", exec: "oldWindow", rate: ATTACK, timeUnit: "1s", duration: DUR, preAllocatedVUs: 10, maxVUs: 100 };

export const options = {
  summaryTrendStats: ["med", "p(95)", "p(99)", "max"],
  scenarios,
  thresholds: {
    "http_req_duration{name:alerts_history_old}": ["p(95)<300"],
    "http_req_failed{name:alerts_history_old}": ["rate<0.01"],
    "http_req_failed{name:victim}": ["rate<0.01"],
    "http_req_duration{name:victim}": ["p(95)<300"],
    "http_reqs{name:alerts_history_old}": ["count>=0"],
    "http_reqs{name:victim}": ["count>=0"],
  },
};

export function oldWindow() {
  const from = now - rnd(15, 29) * 86400e3;
  http.get(`${BASE}/api/v1/alerts/history?from=${iso(from)}&to=${iso(from + 3600e3)}&limit=50`, { tags: { name: "alerts_history_old" }, headers: HDRS, timeout: "30s" });
}

const VICTIM_PATHS = [
  () => `/api/v1/replay?at=${iso(now - rnd(600e3, 60 * 3600e3))}&bbox=124,33,132,39`,
  () => `/api/v1/stats/sigmet?group=fir`,
  () => `/api/v1/stats/traffic?day=${new Date(now + 9 * 3600e3 - 86400e3).toISOString().slice(0, 10)}`,
  () => `/api/v1/aircraft/f10000/track`,
  () => `/api/v1/ships/${300000000 + Math.floor(rnd(0, 12000))}/track`,
  () => `/api/v1/alerts/history?limit=50`,
];
export function victim() {
  const p = VICTIM_PATHS[Math.floor(Math.random() * VICTIM_PATHS.length)]();
  http.get(`${BASE}${p}`, { tags: { name: "victim" }, headers: HDRS, timeout: "30s" });
}

export function handleSummary(data) {
  const m = data.metrics;
  const line = (n) => {
    const d = m[`http_req_duration{name:${n}}`];
    if (!d || !m[`http_reqs{name:${n}}`]) return `${n}: none\n`;
    const v = d.values;
    return `${n.padEnd(20)} n=${m[`http_reqs{name:${n}}`].values.count} p50=${v.med.toFixed(0)} p95=${v["p(95)"].toFixed(0)} p99=${v["p(99)"].toFixed(0)} max=${v.max.toFixed(0)} ms ` +
      `failed=${(m[`http_req_failed{name:${n}}`].values.rate * 100).toFixed(1)}%\n`;
  };
  return { [OUT]: JSON.stringify(data, null, 1), stdout: `\nQA-401 attack=${ATTACK}/s victim=${VICTIM}/s\n` + line("alerts_history_old") + line("victim") };
}
