// k6 run perf/rest.js — REST 100 rps · 3분 (NFR-02). 결과는 perf/results/ 에 요약을 남긴다.
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:8700";
export const options = {
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
  scenarios: {
    rest: { executor: "constant-arrival-rate", rate: Number(__ENV.RPS || 100), timeUnit: "1s", duration: __ENV.DURATION || "3m", preAllocatedVUs: 50, maxVUs: 200 },
  },
  thresholds: {
    "http_req_duration{name:aircraft}": ["p(95)<300"],
    "http_req_duration{name:sigmets}": ["p(95)<300"],
    "http_req_duration{name:status}": ["p(95)<300"],
    checks: ["rate>0.99"],
  },
};
// `make bench` 는 api 에 직접(제한 상향) 붙는다. edge(8700) 경유(`make bench-edge`)는 요청 제한 때문에 8 rps 를 넘기면 429 가 정상이다.
export default function () {
  const r = Math.random();
  let res;
  if (r < 0.6) res = http.get(`${BASE}/api/v1/aircraft?bbox=124,33,132,39&detail=lite`, { tags: { name: "aircraft" } });
  else if (r < 0.85) res = http.get(`${BASE}/api/v1/sigmets?active=true`, { tags: { name: "sigmets" } });
  else res = http.get(`${BASE}/api/v1/status`, { tags: { name: "status" } });
  check(res, { "status 200/304": (x) => x.status === 200 || x.status === 304, "has meta": (x) => x.status !== 200 || String(x.body).includes("generated_at") });
}

export function handleSummary(data) {
  return { "results/rest-summary.json": JSON.stringify(data, null, 2), stdout: textSummary(data) };
}
function textSummary(d) {
  const m = d.metrics;
  const p = (n) => (m[n] ? `p50=${m[n].values.med.toFixed(1)}ms p95=${m[n].values["p(95)"].toFixed(1)}ms p99=${m[n].values["p(99)"].toFixed(1)}ms max=${m[n].values.max.toFixed(1)}ms` : "n/a");
  return `\nREST: reqs=${m.http_reqs.values.count} rate=${m.http_reqs.values.rate.toFixed(1)}/s failed=${(m.http_req_failed.values.rate * 100).toFixed(2)}%\n aircraft ${p("http_req_duration{name:aircraft}")}\n sigmets  ${p("http_req_duration{name:sigmets}")}\n status   ${p("http_req_duration{name:status}")}\n`;
}
