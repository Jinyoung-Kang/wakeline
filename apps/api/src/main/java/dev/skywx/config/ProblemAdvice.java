package dev.skywx.config;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.NonTransientDataAccessResourceException;
import org.springframework.dao.RecoverableDataAccessException;
import org.springframework.dao.TransientDataAccessException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.web.ErrorResponse;
import org.springframework.web.HttpMediaTypeNotAcceptableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.net.URI;
import java.util.Locale;

/**
 * 모든 오류를 application/problem+json(RFC 9457)으로. 확장 필드 code · request_id. 스택·내부 메시지는 싣지 않는다.
 * <ul>
 *   <li>DB·Redis 연결 실패·풀 대기 초과·일시 오류 → 503 + Retry-After: 10 (5.1절 'DB 종료·느림', 계약 §2). WARN 한 줄(스택 없음).</li>
 *   <li>Spring MVC 가 이미 상태를 아는 예외(405·406·415 등, {@link ErrorResponse}) → 그 상태 그대로, 헤더(Allow 등) 유지.
 *       4xx 는 INFO 한 줄 — 익명 요청으로 ERROR 스택을 쏟아내게 할 수 없다(SEC-10).</li>
 *   <li>그 밖의 예외만 500 + ERROR(스택).</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestControllerAdvice
public class ProblemAdvice {
    private static final Logger log = LoggerFactory.getLogger(ProblemAdvice.class);

    @ExceptionHandler(Problem.class)
    ResponseEntity<ProblemDetail> problem(Problem e, HttpServletRequest req) {
        return withRetryAfter(build(e.status(), e.code(), e.title(), e.getMessage(), req), e.retryAfterS());
    }

    @ExceptionHandler({MissingServletRequestParameterException.class, MethodArgumentTypeMismatchException.class,
            HttpMessageNotReadableException.class, MethodArgumentNotValidException.class, HandlerMethodValidationException.class})
    ResponseEntity<ProblemDetail> badRequest(Exception e, HttpServletRequest req) {
        String detail = e instanceof MissingServletRequestParameterException m ? "missing parameter: " + m.getParameterName()
                : e instanceof MethodArgumentTypeMismatchException t ? "invalid parameter: " + t.getName()
                : "invalid request";
        return build(HttpStatus.BAD_REQUEST, "BAD_REQUEST", "bad request", detail, req);
    }

    @ExceptionHandler(NoResourceFoundException.class)
    ResponseEntity<ProblemDetail> notFound(NoResourceFoundException e, HttpServletRequest req) {
        return build(HttpStatus.NOT_FOUND, "NOT_FOUND", "not found", "no such resource", req);
    }

    /** 저장소(DB·Redis)를 지금 쓸 수 없다 — 서버 버그가 아니므로 스택 없이 한 줄, 클라이언트에는 재시도 간격을 준다. */
    @ExceptionHandler({DataAccessResourceFailureException.class, NonTransientDataAccessResourceException.class,
            TransientDataAccessException.class, RecoverableDataAccessException.class, CannotCreateTransactionException.class})
    ResponseEntity<ProblemDetail> unavailable(Exception e, HttpServletRequest req) {
        log.warn("data store unavailable request_id={} path={}: {}", RequestIdFilter.current(req), req.getRequestURI(), brief(e));
        return withRetryAfter(build(HttpStatus.SERVICE_UNAVAILABLE, "UNAVAILABLE", "service unavailable",
                "data store temporarily unavailable; retry later", req), Problem.UNAVAILABLE_RETRY_AFTER_S);
    }

    /** 클라이언트가 이미 연결을 끊어 응답을 쓸 수 없다 — 보낼 것도, 오류로 남길 것도 없다. */
    @ExceptionHandler(AsyncRequestNotUsableException.class)
    void clientGone(AsyncRequestNotUsableException e, HttpServletRequest req) {
        log.debug("response not usable (client gone) path={}", req.getRequestURI());
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<?> other(Exception e, HttpServletRequest req) {
        if (e instanceof ErrorResponse er) return springError(e, er, req);
        log.error("unhandled error request_id={} path={}", RequestIdFilter.current(req), req.getRequestURI(), e);
        return build(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL", "internal error", "unexpected error", req);
    }

    /** Spring MVC 가 상태를 정한 예외(405 Method Not Allowed · 406 · 415 · 413 등) — 그 상태와 헤더를 그대로 돌려준다. */
    static ResponseEntity<?> springError(Exception e, ErrorResponse er, HttpServletRequest req) {
        HttpStatusCode sc = er.getStatusCode();
        HttpStatus st = HttpStatus.resolve(sc.value());
        if (st == null) st = sc.is4xxClientError() ? HttpStatus.BAD_REQUEST : HttpStatus.INTERNAL_SERVER_ERROR;
        if (st.is5xxServerError()) log.warn("{} {} {} request_id={}: {}", st.value(), req.getMethod(), req.getRequestURI(), RequestIdFilter.current(req), e.getClass().getSimpleName());
        else log.info("client error {} {} {} request_id={}: {}", st.value(), req.getMethod(), req.getRequestURI(), RequestIdFilter.current(req), e.getClass().getSimpleName());
        HttpHeaders headers = new HttpHeaders();
        headers.putAll(er.getHeaders());
        // 406: 클라이언트가 받을 수 있는 형식이 없다 — problem+json 본문을 붙이면 다시 406 이 된다. 상태만.
        if (e instanceof HttpMediaTypeNotAcceptableException) return ResponseEntity.status(st).headers(headers).build();
        String title = st.getReasonPhrase().toLowerCase(Locale.ROOT);
        ProblemDetail pd = build(st, st.name(), title, title, req).getBody();
        headers.setContentType(MediaType.APPLICATION_PROBLEM_JSON);
        return ResponseEntity.status(st).headers(headers).body(pd);
    }

    static ResponseEntity<ProblemDetail> build(HttpStatus status, String code, String title, String detail, HttpServletRequest req) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(status, detail);
        pd.setTitle(title);
        pd.setType(URI.create("https://skywx.dev/problems/" + code.toLowerCase(Locale.ROOT).replace('_', '-')));
        pd.setInstance(URI.create(req.getRequestURI()));
        pd.setProperty("code", code);
        pd.setProperty("request_id", RequestIdFilter.current(req));
        return ResponseEntity.status(status).header("Content-Type", "application/problem+json").body(pd);
    }

    private static ResponseEntity<ProblemDetail> withRetryAfter(ResponseEntity<ProblemDetail> r, Integer retryAfterS) {
        if (retryAfterS == null) return r;
        return ResponseEntity.status(r.getStatusCode()).headers(r.getHeaders()).header(HttpHeaders.RETRY_AFTER, String.valueOf(retryAfterS)).body(r.getBody());
    }

    /** 로그용 한 줄: 예외 종류 + 가장 안쪽 원인 메시지(200자). 스택은 남기지 않는다. */
    static String brief(Throwable e) {
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        String msg = String.valueOf(root.getMessage());
        if (msg.length() > 200) msg = msg.substring(0, 200) + "…";
        return e.getClass().getSimpleName() + (root == e ? "" : " ← " + root.getClass().getSimpleName()) + ": " + msg;
    }
}
