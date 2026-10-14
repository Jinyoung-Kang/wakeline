/**
 * QA 2026-10-aws(docs/qa/2026-10-aws — 영역 web-code) QA-1302: AWS 데모가 꺼져 있을 때(평일 18:00 뒤 · 주말 — EC2 정지) CloudFront 는 원본 오류
 * 502 · 504 를 S3 의 오프라인 안내 HTML(`/_offline/index.html` "지금은 데모 운영 시간이 아닙니다", 상태 503 — 배포판 전체에 걸린 오류 응답)로 바꾼다
 * (AWS 읽기 기록 docs/qa/2026-10-aws/evidence/aws-readonly). 그 시각에 열려 있던 화면의 REST · 조회기 요청도 이 HTML 503 을 받는다.
 * api 의 503 은 problem+json(code · Retry-After)이고 edge 도 /api 오류를 problem+json 으로 준다 — /api 경로에서 JSON 이 아닌 503 은 '앞단이 원본에
 * 닿지 못함'뿐인데, lib/api apiError 는 본문을 JSON 으로 읽지 못하면 메시지를 상태 숫자 "503" 으로 두고(화면: "503 (HTTP 503)"), lib/etag-poller 는
 * "HTTP 503" 만 적는다 — 무엇이 일어났는지(서버가 꺼짐 · 운영 시간 밖)도, 무엇을 하면 되는지도 말하지 않는다(D-5 의 잠금 401 과 같은 부류).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, errorLine, ApiError } from "@/lib/api";
import { EtagPoller, POLL_NONE, type PollState } from "@/lib/etag-poller";

/** aws-deploy/offline/index.html 의 머리(같은 모양 — 전체를 싣지 않는다) */
const OFFLINE_HTML = '<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<title>운영 시간 외</title>\n</head>\n<body><main><h1>지금은 데모 운영 시간이 아닙니다</h1></main></body></html>\n';
const offline = () => new Response(OFFLINE_HTML, { status: 503, headers: { "Content-Type": "text/html", "Cache-Control": "max-age=10" } });
const KOREAN = /[가-힣]/;

afterEach(() => { vi.unstubAllGlobals(); });

describe("QA-1302 the CloudFront offline page (HTML 503) reaching an open screen", () => {
  it("REST (lib/api): the error says what happened, not just the number 503", async () => {
    vi.stubGlobal("fetch", async () => offline());
    const e = (await apiGet("/api/v1/stats/alerts").catch((x: unknown) => x)) as ApiError;
    console.info(`QA-1302 apiGet → status=${e.status} code=${e.code} message="${e.message}" errorLine="${errorLine(e)}"`);
    expect(e.status).toBe(503);
    expect(e.message).toMatch(KOREAN); // 지금: "503" → 화면 "503 (HTTP 503)"
  });

  it("ETag pollers (lib/etag-poller — 특보 · 교통량 · 수신 범위 · 공역): the error says what happened, not just 'HTTP 503'", async () => {
    let st: PollState<unknown> = POLL_NONE;
    const p = new EtagPoller<unknown>({ url: "/api/v1/warnings", parse: (x) => x, intervalMs: 60_000, visibleMinGapMs: 15_000 },
      (s) => { st = s; }, POLL_NONE, async () => offline(), () => false, () => 1000, () => () => {});
    await p.poll();
    p.stop();
    console.info(`QA-1302 EtagPoller error → "${st.error}"`);
    expect(st.error).toMatch(KOREAN); // 지금: "HTTP 503"
  });
});
