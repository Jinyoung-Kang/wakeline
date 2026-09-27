package dev.skywx.config;

import org.springframework.http.HttpStatus;

/** RFC 9457 오류로 변환되는 애플리케이션 예외. 내부 정보는 담지 않는다. retryAfterS 가 있으면 Retry-After 헤더로 나간다. */
public class Problem extends RuntimeException {
    /** DB·Redis 가 잠시 없을 때 클라이언트에게 알려 주는 재시도 간격(계약 §2: 503 + Retry-After: 10). */
    public static final int UNAVAILABLE_RETRY_AFTER_S = 10;

    private final HttpStatus status;
    private final String code;
    private final String title;
    private final Integer retryAfterS;

    public Problem(HttpStatus status, String code, String title, String detail) {
        this(status, code, title, detail, null);
    }

    public Problem(HttpStatus status, String code, String title, String detail, Integer retryAfterS) {
        super(detail);
        this.status = status;
        this.code = code;
        this.title = title;
        this.retryAfterS = retryAfterS;
    }

    public static Problem badRequest(String code, String detail) { return new Problem(HttpStatus.BAD_REQUEST, code, "bad request", detail); }
    public static Problem unprocessable(String code, String title, String detail) { return new Problem(HttpStatus.UNPROCESSABLE_CONTENT, code, title, detail); }
    public static Problem notFound(String detail) { return new Problem(HttpStatus.NOT_FOUND, "NOT_FOUND", "not found", detail); }
    public static Problem conflict(String code, String detail) { return new Problem(HttpStatus.CONFLICT, code, "conflict", detail); }
    public static Problem unavailable(String detail) {
        return new Problem(HttpStatus.SERVICE_UNAVAILABLE, "UNAVAILABLE", "service unavailable", detail, UNAVAILABLE_RETRY_AFTER_S);
    }
    public static Problem tooManyRequests(String detail, long retryAfterS) {
        return new Problem(HttpStatus.TOO_MANY_REQUESTS, "RATE_LIMITED", "rate limited", detail, (int) Math.max(1, Math.min(retryAfterS, 3600)));
    }

    public HttpStatus status() { return status; }
    public String code() { return code; }
    public String title() { return title; }
    public Integer retryAfterS() { return retryAfterS; }
}
