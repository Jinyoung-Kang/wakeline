package dev.skywx.config;

import org.springframework.http.HttpStatus;

/** RFC 9457 오류로 변환되는 애플리케이션 예외. 내부 정보는 담지 않는다. */
public class Problem extends RuntimeException {
    private final HttpStatus status;
    private final String code;
    private final String title;

    public Problem(HttpStatus status, String code, String title, String detail) {
        super(detail);
        this.status = status;
        this.code = code;
        this.title = title;
    }

    public static Problem badRequest(String code, String detail) { return new Problem(HttpStatus.BAD_REQUEST, code, "bad request", detail); }
    public static Problem unprocessable(String code, String title, String detail) { return new Problem(HttpStatus.UNPROCESSABLE_CONTENT, code, title, detail); }
    public static Problem notFound(String detail) { return new Problem(HttpStatus.NOT_FOUND, "NOT_FOUND", "not found", detail); }
    public static Problem conflict(String code, String detail) { return new Problem(HttpStatus.CONFLICT, code, "conflict", detail); }
    public static Problem unavailable(String detail) { return new Problem(HttpStatus.SERVICE_UNAVAILABLE, "UNAVAILABLE", "service unavailable", detail); }

    public HttpStatus status() { return status; }
    public String code() { return code; }
    public String title() { return title; }
}
