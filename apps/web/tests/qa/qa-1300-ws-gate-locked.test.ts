/**
 * QA 2026-10-aws(docs/qa/2026-10-aws — 영역 web-code) QA-1300: 앞단 잠금(AWS 데모의 접근 코드 gate — ADR-039)이 만료되면 모든 같은 출처 요청이
 * 401 {"error":"locked"} 다. REST · ETag 조회기는 그 답을 알아보고 "접근 코드가 만료됨 — 새로고침…"을 보인다(AWS 리뷰 D-5 · L2). 그런데 WS 는
 * 브라우저 WebSocket API 가 업그레이드 응답(401)을 보여 주지 않아(handshake 실패 = close 1006) lib/ws.ts 가 잠금을 알 길이 없고, 재접속(1 → 30 s
 * 백오프)만 끝없이 되풀이한다. 상황판 기본 화면(알림 탭 · 기본 레이어)에서 실패를 보이는 곳은 상태 바의 연결 칩 하나뿐인데, 거기에는
 * "WS closed · retry N" 만 나온다 — 새로고침해야 풀린다는 안내가 없다(그대로 두면 저절로 회복되지 않는다).
 * 시나리오(실제): 평일 낮에 잠금을 푼 탭을 열어 둔 채 밤을 넘기면, 다음 날 스택이 다시 뜰 때 쿠키(12 h)는 이미 만료 — WS 재접속은 모두 401.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WakelineWsClient } from "@/lib/ws";
import { apiGet, ApiError } from "@/lib/api";
import { getData, resetData } from "@/lib/store";
import { connChip, statusInput } from "@/lib/statusbar";
import { FakeSocket } from "../helpers/fake-ws";

/** gate 가 잠금 쿠키 없는(만료된) 요청에 주는 답 — aws-deploy gate/gate.py:445 와 같은 본문(공개 주소 GET 기록 docs/qa/2026-10-aws/evidence/aws-readonly) */
const LOCKED_BODY = { error: "locked", message: "접근 코드가 필요합니다", unlock: "/__gate/" };
const lockedFetch = () => async () => new Response(JSON.stringify(LOCKED_BODY), { status: 401, headers: { "Content-Type": "application/json; charset=utf-8" } });

const NOW = Date.parse("2026-10-14T00:05:00Z"); // 09:05 KST — 스택이 다시 뜬 아침

beforeEach(() => {
  resetData();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(Math, "random").mockReturnValue(0.5); // 백오프 지터 없음
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 브라우저가 401 업그레이드 응답을 받았을 때처럼: 소켓은 열리지 않고 error → close(1006) */
function gateLockedSockets() {
  const sockets: FakeSocket[] = [];
  const createSocket = () => {
    const s = new FakeSocket();
    sockets.push(s);
    setTimeout(() => { s.readyState = 3; s.onerror?.({}); s.onclose?.({ code: 1006 }); }, 30);
    return s;
  };
  return { sockets, createSocket };
}

describe("QA-1300 the dashboard WS behind an expired access-code gate", () => {
  it("control: REST already recognises the gate's 401 locked (AWS review D-5)", async () => {
    vi.stubGlobal("fetch", lockedFetch());
    const e = (await apiGet("/api/v1/status").catch((x: unknown) => x)) as ApiError;
    expect([e.status, e.code]).toEqual([401, "ACCESS_LOCKED"]);
    expect(e.message).toContain("접근 코드");
  });

  it("after the WS handshakes keep failing behind the lock, the status bar's connection chip says the access code expired (reload)", async () => {
    vi.stubGlobal("fetch", lockedFetch()); // 같은 출처의 어떤 REST 요청이든 gate 가 401 locked 로 답한다
    const { sockets, createSocket } = gateLockedSockets();
    const worker = { postMessage() {} };
    const client = new WakelineWsClient(worker, { url: "ws://test/ws/v1", isHidden: () => false, createSocket, report: () => {} });
    client.subscribe([124, 33, 132, 39], 7);
    client.connect();
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 5분 — 재접속 백오프가 상한(30 s)에 닿을 만큼
    const d = getData();
    const chip = connChip(statusInput(d, Date.now(), Date.now()));
    // 증거: 5분 동안 소켓을 몇 번 만들었고, 칩에는 무엇이 보이는가
    console.info(`QA-1300 sockets=${sockets.length} conn=${d.conn} retry=${d.reconnectAttempt} chip="${chip.text}" title="${chip.title}"`);
    client.close();
    expect(sockets.length).toBeGreaterThan(3); // 끝없이 다시 붙는다(1 → 2 → 4 → … → 30 s)
    expect(`${chip.text} ${chip.title}`).toContain("접근 코드");
  });
});
