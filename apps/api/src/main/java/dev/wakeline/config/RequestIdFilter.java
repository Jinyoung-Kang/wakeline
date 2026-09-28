package dev.wakeline.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.security.SecureRandom;
import java.util.HexFormat;

/** 요청마다 X-Request-Id 를 발급(클라이언트 값은 신뢰하지 않음)·에코하고 MDC 에 넣어 로그와 오류 본문에 같은 값이 실린다. */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {
    public static final String HEADER = "X-Request-Id";
    public static final String ATTR = "wakeline.requestId";
    private static final SecureRandom RND = new SecureRandom();

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String id = newId();
        req.setAttribute(ATTR, id);
        res.setHeader(HEADER, id);
        MDC.put("request_id", id);
        try {
            chain.doFilter(req, res);
        } finally {
            MDC.remove("request_id");
        }
    }

    /** 새 요청 id: 시각(ms, 16진) + 난수 8바이트(16진). */
    public static String newId() {
        byte[] b = new byte[8];
        RND.nextBytes(b);
        return Long.toHexString(System.currentTimeMillis()) + HexFormat.of().formatHex(b);
    }

    public static String current(HttpServletRequest req) {
        Object v = req.getAttribute(ATTR);
        return v == null ? "-" : v.toString();
    }
}
