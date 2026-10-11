package dev.wakeline.platform.web;

/**
 * If-None-Match 비교(RFC 9110 §13.1.2 — 약한 비교): 목록(쉼표) · '*' · 약한 표시 W/ 를 받는다. 리뷰 2026-09-30 밤: edge(nginx)는 1,024 B 이상의 JSON 을
 * gzip 으로 줄이며 강한 ETag 를 약한 것(W/"…")으로 바꿔 보내고, 브라우저 · 웹 조회기(lib/etag-poller)는 받은 그대로 되돌려 보낸다 — 전에는 api 가 글자
 * 그대로 견줘(etag.equals(If-None-Match)) edge 를 거친 조건부 요청이 304 를 받지 못했다(E2E edge-limits 가 edge 를 거쳐 304 를 본다).
 */
public final class Etags {
    private Etags() {}

    /**
     * 이 프로세스의 표식(처음 쓴 때의 유닉스 ms, 36진수) — 프로세스 안 순번으로 만드는 ETag(특보 · SIGMET · 선박 목록)에 넣는다. 순번은 재기동마다 1부터
     * 다시 세므로, 매일 같은 시각에 기동하는 AWS 데모(ADR-039)에서는 어제와 같은 순번이 나와 브라우저 캐시가 어제 본문을 304 로 되살렸다(AWS 리뷰 B-6).
     * 시각 · 내용으로 만드는 ETag(항공기 · 레이더 · 공역 · 교통량 · 관측 수신)는 이미 재기동을 넘어 겹치지 않는다.
     */
    public static final String BOOT = Long.toString(System.currentTimeMillis(), 36);

    /** ifNoneMatch 가 etag 와 (약한 비교로) 맞는가 — 맞으면 304. 헤더가 없거나 비었으면 false. */
    public static boolean notModified(String etag, String ifNoneMatch) {
        if (etag == null || ifNoneMatch == null || ifNoneMatch.isBlank()) return false;
        String want = opaque(etag);
        for (String part : ifNoneMatch.split(",")) {
            String t = part.trim();
            if (t.equals("*") || opaque(t).equals(want)) return true;
        }
        return false;
    }

    private static String opaque(String tag) {
        String t = tag.trim();
        return t.startsWith("W/") ? t.substring(2) : t;
    }
}
