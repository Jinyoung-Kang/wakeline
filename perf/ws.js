// k6 run perf/ws.js — WS 200 연결 램프업, diff 수신 지연 측정 (NFR-03).
import { WebSocket } from "k6/experimental/websockets";
import { Trend, Counter } from "k6/metrics";
import { sleep } from "k6";

const BASE = (__ENV.BASE_URL || "http://localhost:8700").replace(/^http/, "ws");
const lag = new Trend("ws_diff_lag_ms", true);
const msgs = new Counter("ws_messages");
export const options = {
  scenarios: { ws: { executor: "ramping-vus", startVUs: 0, stages: [{ duration: "1m", target: Number(__ENV.CONN || 200) }, { duration: "3m", target: Number(__ENV.CONN || 200) }, { duration: "30s", target: 0 }] } },
  thresholds: { ws_diff_lag_ms: ["p(95)<500"] },
};
// 연결 상한은 IP당 5 → 로컬 측정 시 SKYWX_WS_MAX_CONN_PER_IP=500 으로 올려 실행한다(README 성능 절).
export default function () {
  const ws = new WebSocket(`${BASE}/ws/v1`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", proto: 1, client: "k6" }));
  };
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
