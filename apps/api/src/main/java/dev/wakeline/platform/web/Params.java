package dev.wakeline.platform.web;

import java.util.regex.Pattern;

/** 여러 컨트롤러가 같은 규칙으로 읽는 요청 파라미터(api-review §2.5-2 — 예전에는 날씨 컨트롤러가 항공기 컨트롤러의 도우미를 빌려 썼다). */
public final class Params {
    private Params() {}

    /** 제어 문자(유니코드 Cc — NUL · 줄바꿈 · 탭 포함). */
    private static final Pattern CONTROL = Pattern.compile("\\p{Cc}");

    /**
     * 자유 글자 필터(SQL 매개변수로 가는 값): 제어 문자가 있으면 400 BAD_FILTER(QA-205 · QA-002 — NUL 은 PostgreSQL 이 'invalid byte sequence for
     * encoding "UTF8": 0x00' 로 거절해 500 + ERROR 스택이었다). 공개 검색(BAD_QUERY)과 같이 저장소에 닿기 전에 거른다. null 은 그대로(조건 없음).
     */
    public static String filterText(String name, String value) {
        if (value != null && CONTROL.matcher(value).find())
            throw Problem.badRequest("BAD_FILTER", name + " must not contain control characters");
        return value;
    }

    /** 항공기 hex(ICAO 24-bit 주소): 앞뒤 공백을 빼고 소문자 6자리 16진수만. 아니면 400 BAD_HEX. */
    public static String hex(String hex) {
        String h = hex == null ? "" : hex.trim().toLowerCase();
        if (!h.matches("^[0-9a-f]{6}$")) throw Problem.badRequest("BAD_HEX", "hex must be 6 hex chars");
        return h;
    }
}
