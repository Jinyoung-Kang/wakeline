// k6 run perf/ws.js — WS 200 연결 램프업, diff 수신 지연 측정 (NFR-03). `make bench` 가 api 에 직접(WS_MAX_CONN_PER_IP 상향) 붙는다.
import { WebSocket } from "k6/experimental/websockets";
import { Trend, Counter } from "k6/metrics";
import { sleep } from "k6";

const HTTP_BASE = __ENV.BASE_URL || "http://localhost:8700";
const BASE = HTTP_BASE.replace(/^http/, "ws");
const lag = new Trend("ws_diff_lag_ms", true);
const msgs = new Counter("ws_messages");
export const options = {
  scenarios: { ws: { executor: "ramping-vus", startVUs: 0, stages: [{ duration: "1m", target: Number(__ENV.CONN || 200) }, { duration: "3m", target: Number(__ENV.CONN || 200) }, { duration: "30s", target: 0 }] } },
  thresholds: { ws_diff_lag_ms: ["p(95)<500"] },
};

export default function () {
  // same-origin 검사: Origin 은 접속 호스트와 같아야 한다
  const ws = new WebSocket(`${BASE}/ws/v1`, null, { headers: { Origin: HTTP_BASE } });
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", proto: 1, client: "k6" }));
  ws.onmessage = (e) => {
    msgs.add(1);
    const m = JSON.parse(e.data);
    if (m.type === "welcome") ws.send(JSON.stringify({ type: "subscribe", bbox: [124, 33, 132, 39], zoom: 7, detail: "lite" }));
    if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    if (m.type === "diff" || m.type === "snapshot") lag.add(Date.now() - Date.parse(m.ts));
  };
  ws.onerror = () => {};
  sleep(200);
  ws.close();
}

export function handleSummary(data) {
  const m = data.metrics;
  const l = m.ws_diff_lag_ms ? m.ws_diff_lag_ms.values : {};
  const line = `\nWS: max VUs=${m.vus_max ? m.vus_max.values.max : "?"} messages=${m.ws_messages ? m.ws_messages.values.count : 0} lag p50=${(l.med || 0).toFixed(0)}ms p95=${(l["p(95)"] || 0).toFixed(0)}ms\n`;
  return { "results/ws-summary.json": JSON.stringify(data, null, 2), stdout: line };
}
