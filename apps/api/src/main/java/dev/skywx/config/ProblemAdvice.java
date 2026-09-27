package dev.skywx.config;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.net.URI;

/** 모든 오류를 application/problem+json(RFC 9457)으로. 확장 필드 code · request_id. 스택·내부 메시지는 싣지 않는다. */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestControllerAdvice
public class ProblemAdvice {
    private static final Logger log = LoggerFactory.getLogger(ProblemAdvice.class);

    @ExceptionHandler(Problem.class)
    ResponseEntity<ProblemDetail> problem(Problem e, HttpServletRequest req) {
        return build(e.status(), e.code(), e.title(), e.getMessage(), req);
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

    @ExceptionHandler(Exception.class)
    ResponseEntity<ProblemDetail> other(Exception e, HttpServletRequest req) {
        log.error("unhandled error request_id={} path={}", RequestIdFilter.current(req), req.getRequestURI(), e);
        return build(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL", "internal error", "unexpected error", req);
    }

    static ResponseEntity<ProblemDetail> build(HttpStatus status, String code, String title, String detail, HttpServletRequest req) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(status, detail);
        pd.setTitle(title);
        pd.setType(URI.create("https://skywx.dev/problems/" + code.toLowerCase().replace('_', '-')));
        pd.setInstance(URI.create(req.getRequestURI()));
        pd.setProperty("code", code);
        pd.setProperty("request_id", RequestIdFilter.current(req));
        return ResponseEntity.status(status).header("Content-Type", "application/problem+json").body(pd);
    }
}
