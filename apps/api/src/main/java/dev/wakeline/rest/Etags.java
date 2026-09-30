package dev.wakeline.rest;

/**
 * If-None-Match 비교(RFC 9110 §13.1.2 — 약한 비교): 목록(쉼표) · '*' · 약한 표시 W/ 를 받는다. 리뷰 2026-09-30 밤: edge(nginx)는 1,024 B 이상의 JSON 을
 * gzip 으로 줄이며 강한 ETag 를 약한 것(W/"…")으로 바꿔 보내고, 브라우저 · 웹 조회기(lib/etag-poller)는 받은 그대로 되돌려 보낸다 — 전에는 api 가 글자
 * 그대로 견줘(etag.equals(If-None-Match)) edge 를 거친 조건부 요청이 304 를 받지 못했다(E2E edge-limits 가 edge 를 거쳐 304 를 본다).
 */
final class Etags {
    private Etags() {}

    /** ifNoneMatch 가 etag 와 (약한 비교로) 맞는가 — 맞으면 304. 헤더가 없거나 비었으면 false. */
    static boolean notModified(String etag, String ifNoneMatch) {
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
