/**
 * e2e/dashboard-layout.spec.ts 가 fixture 스택의 WS 흐름에 끼워 넣거나 바꾸는 메시지(외부 호출 없음). fixture 모드의 노선은 'disabled'(계약 v4 §G A-2)라
 * 조회 중이 오지 않고, 알림 이벤트는 fixture 항공기가 합성 SIGMET 에 드나드는 때에 달려 있다 — 화면 모양을 결정적으로 보려고 이 둘만 만든다.
 * tests/e2e-inject.test.ts 가 이 메시지들이 schemas/ws/server.v1.json 과 웹 검증기(lib/ws-validate)를 버림 없이 통과하는지 확인한다.
 */
type Msg = Record<string, unknown>;

/** 서버의 selected 메시지에서 노선만 '조회 중'으로 바꾼다(상태가 없으면 그대로). 콜사인은 계약 모양(대문자 · 숫자 3–8자)일 때만 */
export function withPendingRoute(m: Msg): Msg {
  if (m.type !== "selected" || !m.state || typeof m.state !== "object") return m;
  const cs = String((m.state as { callsign?: unknown }).callsign ?? "").trim();
  return { ...m, route: { status: "pending", callsign: /^[A-Z0-9]{3,8}$/.test(cs) ? cs : null, source: "adsbdb" } };
}

/** 진입 예상(PREDICTED) 이벤트 하나 — 버전을 크게(틈) 두어 가진 목록과 상관없이 반영되고 배너가 뜬다(웹은 전체 목록을 다시 받는다) */
export function predictedEvent(nowMs: number): Msg {
  const at = new Date(nowMs).toISOString();
  return {
    type: "alerts_batch", version: 1_000_000, items: [{
      event: "PREDICTED", alert: {
        id: 990_001, kind: "PREDICTED", hex: "e2e001", callsign: "AAL2646", sigmet_id: "MMEX:E2E1", fir_id: "MMEX", hazard: "TS", qualifier: "EMBD",
        entered_at: at, eta_s: 300, eta_at: new Date(nowMs + 300_000).toISOString(), alt_ft: 30000, evidence: { judged_at: at }, estimated: true,
      },
    }],
  };
}
