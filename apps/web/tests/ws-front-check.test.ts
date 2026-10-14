/**
 * lib/ws 앞단 확인(QA-1300): 열린 적 없는 실패가 2번 이어지면 같은 출처 확인 요청 하나로 까닭을 가리고(스토어 connIssue), 최소 60 s 간격으로만 다시 묻고,
 * 연결이 다시 열리면(welcome) 지운다. 한 번의 실패 · 열린 뒤 닫힘은 묻지 않는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WakelineWsClient } from "@/lib/ws";
import { ApiError } from "@/lib/api";
import { getData, resetData } from "@/lib/store";
import { FakeSocket } from "./helpers/fake-ws";

beforeEach(() => {
  resetData();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-14T00:05:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function rig(answer: () => Promise<unknown>) {
  const sockets: FakeSocket[] = [];
  const checks: number[] = [];
  const client = new WakelineWsClient({ postMessage() {} }, {
    url: "ws://test/ws/v1", isHidden: () => false, report: () => {},
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    checkFront: () => { checks.push(Date.now()); return answer(); },
  });
  /** 지금 소켓을 열지 않고 실패(1006)시킨 뒤 다음 재접속까지 */
  const failOpen = async () => { sockets.at(-1)!.onclose?.({ code: 1006 }); await vi.advanceTimersByTimeAsync(31_000); };
  return { client, sockets, checks, failOpen };
}
const locked = () => Promise.reject(new ApiError(401, "locked", null, "ACCESS_LOCKED"));

describe("lib/ws front check (QA-1300)", () => {
  it("asks once after the second never-opened failure, and at most once a minute after that", async () => {
    const r = rig(locked);
    r.client.connect();
    await r.failOpen();
    expect(r.checks).toHaveLength(0); // 한 번은 망이 잠깐 흔들린 것일 수 있다
    await r.failOpen();
    expect(r.checks).toHaveLength(1);
    expect(getData().connIssue).toBe("locked");
    await r.failOpen(); // 31 s 뒤 — 간격 안
    expect(r.checks).toHaveLength(1);
    await r.failOpen(); // 62 s 뒤
    expect(r.checks).toHaveLength(2);
    r.client.close();
  });

  it("an answer from the app (not the front) means the cause is unknown; reopening clears a known cause", async () => {
    let answer: () => Promise<unknown> = () => Promise.reject(new ApiError(503, "<html>", null, "ORIGIN_UNREACHABLE"));
    const r = rig(() => answer());
    r.client.connect();
    await r.failOpen();
    await r.failOpen();
    expect(getData().connIssue).toBe("unreachable");
    r.sockets.at(-1)!.open();
    r.sockets.at(-1)!.recv({ type: "welcome", server_time: "2026-10-14T00:06:00Z", limits: {} });
    expect(getData().connIssue).toBeNull();
    answer = () => Promise.resolve({});
    r.sockets.at(-1)!.close(1006); // 열린 뒤 닫힘 — 업그레이드 실패가 아니다
    await vi.advanceTimersByTimeAsync(31_000);
    await r.failOpen();
    await r.failOpen();
    expect(r.checks).toHaveLength(2);
    expect(getData().connIssue).toBeNull();
    r.client.close();
  });
});
