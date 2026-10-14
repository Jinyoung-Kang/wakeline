package dev.wakeline.platform.support;

/**
 * 요청 값의 앞뒤 공백 지우기(계약 v5 §G43 — "앞뒤 공백은 공백 글자만 지운다 — NUL 같은 제어 문자는 남아 각 경로의 형식 검사에 걸린다").
 * Java {@code String.strip()} 은 {@code Character.isWhitespace} 라 공백 말고 제어 문자 U+0009–U+000D(탭 · 줄바꿈) · U+001C–U+001F(정보 구분)도 지우고,
 * {@code trim()} 은 U+0000–U+0020 을 모두 지운다 — 그래서 {@code hex=71be01%1F} · {@code limit=10%09} 같은 값이 정상 값으로 지났다(QA-1103).
 * 여기서는 strip() 이 지우는 글자 가운데 제어 문자(유니코드 Cc)가 아닌 것 — 공백(U+0020)과 유니코드 공백 분리자(U+3000 등) — 만 지운다.
 * 제어 문자는 값에 남아 각 형식 검사가 400 으로 거른다. 공급자 · 저장 값을 읽는 곳에는 쓰지 않는다(요청 입력의 규칙이다).
 */
public final class Spaces {
    private Spaces() {}

    /** 앞뒤의 공백 글자(제어 문자가 아닌 공백)를 지운 값. null 은 null. */
    public static String strip(String s) {
        if (s == null) return null;
        int a = 0, b = s.length();
        while (a < b && isSpace(s.charAt(a))) a++;
        while (b > a && isSpace(s.charAt(b - 1))) b--;
        return s.substring(a, b);
    }

    /** null 이거나 공백 글자만 있다(제어 문자는 공백이 아니다 — {@code "\u001F"} 는 비지 않았다). */
    public static boolean isBlank(String s) {
        return s == null || strip(s).isEmpty();
    }

    /** 공백 글자: Java 의 공백(isWhitespace)이면서 제어 문자(Cc — U+0000–U+001F · U+007F–U+009F)가 아닌 것. */
    static boolean isSpace(char c) {
        return Character.isWhitespace(c) && !Character.isISOControl(c);
    }
}
