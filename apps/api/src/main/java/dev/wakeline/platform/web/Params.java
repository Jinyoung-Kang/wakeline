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

    /**
     * 항공기 hex(ICAO 24-bit 주소): 앞뒤 공백을 빼고 ASCII 6자리 16진수만 — 소문자로 돌려준다. 아니면 400 BAD_HEX.
     * ASCII 를 먼저 검사하고 Locale.ROOT 로 바꾼다(QA 2026-10 기능 개선 제안 5 — 바꾼 뒤 검사하면 비 ASCII 글자가 ASCII 로 바뀌어 지날 수 있다).
     */
    public static String hex(String hex) {
        String h = hex == null ? "" : hex.strip(); // strip: 공백만 — trim() 은 NUL 같은 제어 문자도 지웠다(§G43)
        if (!h.matches("^[0-9A-Fa-f]{6}$")) throw Problem.badRequest("BAD_HEX", "hex must be 6 hex chars");
        return h.toLowerCase(java.util.Locale.ROOT);
    }

    /**
     * 정해진 값 중 하나를 고르는 필터(계약 v5 §G42 — QA 2026-10 기능 개선 제안 3): 없거나 빈 값이면 def, 맞는 값은 대소문자를 가리지 않고 소문자로 돌려준다.
     * 모르는 값이면 400 BAD_FILTER — 예전에는 경로마다 달랐다(모르는 kind → 관측 + 예측 모두, group → fir, detail → lite). 열린 값(SIGMET hazard 처럼 공급자가 주는
     * 글자)에는 쓰지 않는다.
     */
    public static String choice(String name, String value, String def, String... allowed) {
        if (value == null || value.isBlank()) return def;
        String v = value.strip();
        for (String a : allowed) if (a.equalsIgnoreCase(v)) return a;
        throw Problem.badRequest("BAD_FILTER", name + " must be one of " + String.join(", ", allowed));
    }

    /**
     * 공항 ICAO 코드: 앞뒤 공백을 빼고 ASCII 영숫자 4자 — 대문자로 돌려준다. 아니면 400 BAD_ICAO. ASCII 를 먼저 검사한다(QA 2026-10 기능 개선 제안 5 —
     * 예전에는 대문자로 바꾼 뒤 검사해 'rksı'(점 없는 ı — 어느 로캘에서든 대문자가 I)가 RKSI 로 찾아졌다).
     */
    public static String icao(String icao) {
        String c = icao == null ? "" : icao.strip();
        if (!c.matches("^[A-Za-z0-9]{4}$")) throw Problem.badRequest("BAD_ICAO", "icao must be 4 chars");
        return c.toUpperCase(java.util.Locale.ROOT);
    }
}
