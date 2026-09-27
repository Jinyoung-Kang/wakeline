// k6 — WS 200 연결 램프업, diff/snapshot 수신 지연 측정 (NFR-03). `make bench` 가 api 에 직접(연결 상한 상향) 붙는다.
// k6/websockets 는 이벤트 루프 기반이라 sleep() 동안 메시지를 처리하지 않는다 → 연결 유지는 setTimeout 으로 한다.
import { WebSocket } from "k6/websockets";
import { Trend, Counter } from "k6/metrics";

const HTTP_BASE = __ENV.BASE_URL || "http://localhost:8700";
const BASE = HTTP_BASE.replace(/^http/, "ws");
// api 는 WS Origin 을 명시 허용 목록(WAKELINE_ALLOWED_ORIGINS, 기본 http://localhost:8700 · http://127.0.0.1:8700)으로만 받는다.
// api 에 직접 붙을 때(BASE_URL=http://10.77.0.30:8000)도 Origin 은 브라우저가 보내는 값과 같아야 한다 → ORIGIN 으로 지정.
const ORIGIN = __ENV.ORIGIN || "http://localhost:8700";
const HOLD_MS = Number(__ENV.HOLD_S || 240) * 1000;
const lag = new Trend("ws_diff_lag_ms", true);
const msgs = new Counter("ws_messages");
const diffs = new Counter("ws_diffs");
const snaps = new Counter("ws_snapshots");
const errors = new Counter("ws_errors");
export const options = {
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
  scenarios: {
    ws: { executor: "ramping-vus", startVUs: 0, gracefulRampDown: "10s",
      stages: [{ duration: "1m", target: Number(__ENV.CONN || 200) }, { duration: "3m", target: Number(__ENV.CONN || 200) }, { duration: "10s", target: 0 }] },
  },
  thresholds: { ws_diff_lag_ms: ["p(95)<500"], ws_errors: ["count<1"] },
};

export default function () {
  const ws = new WebSocket(`${BASE}/ws/v1`, null, { headers: { Origin: ORIGIN } });
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", proto: 1, client: "k6" }));
    setTimeout(() => ws.close(), HOLD_MS);
  };
  ws.onmessage = (e) => {
    msgs.add(1);
    const m = JSON.parse(e.data);
    if (m.type === "welcome") ws.send(JSON.stringify({ type: "subscribe", bbox: [124, 33, 132, 39], zoom: 7, detail: "lite" }));
    else if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    else if (m.type === "diff" || m.type === "snapshot") {
      lag.add(Date.now() - Date.parse(m.ts));
      if (m.type === "diff") diffs.add(1); else snaps.add(1);
    } else if (m.type === "error") errors.add(1);
  };
  ws.onerror = () => errors.add(1);   // Origin 이 허용 목록 밖이면 핸드셰이크가 거절되어 여기로 온다
}

export function handleSummary(data) {
  const m = data.metrics;
  const l = m.ws_diff_lag_ms ? m.ws_diff_lag_ms.values : {};
  const v = (k) => (m[k] ? m[k].values.count : 0);
  const line = `\nWS: max VUs=${m.vus_max ? m.vus_max.values.max : "?"} messages=${v("ws_messages")} snapshots=${v("ws_snapshots")} diffs=${v("ws_diffs")} errors=${v("ws_errors")}\n` +
    ` lag (server ts → client recv) p50=${(l.med || 0).toFixed(0)}ms p95=${(l["p(95)"] || 0).toFixed(0)}ms p99=${(l["p(99)"] || 0).toFixed(0)}ms max=${(l.max || 0).toFixed(0)}ms\n`;
  return { "results/ws-summary.json": JSON.stringify(data, null, 2), stdout: line };
}
