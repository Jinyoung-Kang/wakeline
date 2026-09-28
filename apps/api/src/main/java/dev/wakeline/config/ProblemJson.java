package dev.wakeline.config;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Spring MVC 밖(보안 필터·방화벽·Tomcat 밸브)에서 쓰는 RFC 9457 본문 — {@link ProblemAdvice} 와 같은 모양
 * (type · title · status · detail · instance + code · request_id). 문자열은 JSON 으로 이스케이프한다(instance 는 요청 경로 원문).
 */
public final class ProblemJson {
    public static final String CONTENT_TYPE = "application/problem+json";

    private ProblemJson() {}

    public static String body(int status, String code, String title, String detail, String instance, String requestId) {
        return "{\"type\":" + str("https://wakeline.invalid/problems/" + code.toLowerCase(Locale.ROOT).replace('_', '-'))
                + ",\"title\":" + str(title) + ",\"status\":" + status + ",\"detail\":" + str(detail)
                + ",\"instance\":" + str(instance) + ",\"code\":" + str(code) + ",\"request_id\":" + str(requestId) + "}";
    }

    /** 응답에 problem+json 을 쓴다(요청 id 는 {@link RequestIdFilter} 가 붙인 값). */
    public static void write(HttpServletResponse res, HttpServletRequest req, int status, String code, String title, String detail) throws IOException {
        res.setStatus(status);
        res.setContentType(CONTENT_TYPE);
        res.getOutputStream().write(body(status, code, title, detail, req.getRequestURI(), RequestIdFilter.current(req)).getBytes(StandardCharsets.UTF_8));
    }

    /** 상태 코드만 아는 오류(컨테이너 수준): code = 상태 이름(BAD_REQUEST …), title·detail = 사유 문구(소문자). */
    static String[] codeAndTitle(int status) {
        HttpStatus st = HttpStatus.resolve(status);
        if (st == null) return new String[]{"ERROR", "error"};
        return new String[]{st.name(), st.getReasonPhrase().toLowerCase(Locale.ROOT)};
    }

    /** JSON 문자열 리터럴(따옴표 포함). null → null. */
    static String str(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c < 0x20 || c == ' ' || c == ' ') b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
                }
            }
        }
        return b.append('"').toString();
    }
}
