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
import java.util.regex.Pattern;

/**
 * 요청마다 X-Request-Id 를 정해 에코하고 MDC(request_id)에 넣는다 — 로그 줄([rid:…], logging.pattern.correlation)과 오류 본문에 같은 값이 실린다.
 * edge(신뢰 프록시, {@link ClientIp} 와 같은 판정)가 보낸 형식이 맞는 값(nginx $request_id 등)은 그대로 쓴다 — edge 접근 로그와 이어진다(R-49).
 * 그 밖의 클라이언트 값은 믿지 않고 새로 만든다(로그·헤더 주입 방지: 영숫자·'-' 8~64자만). 요청이 들어온 시각도 남긴다({@link #elapsedMs}).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {
    public static final String HEADER = "X-Request-Id";
    public static final String ATTR = "wakeline.requestId";
    /** 요청이 이 필터에 들어온 시각(System.nanoTime) — {@link #elapsedMs}. */
    static final String START_ATTR = "wakeline.requestStartNanos";
    static final Pattern VALID = Pattern.compile("[0-9A-Za-z-]{8,64}");
    private static final SecureRandom RND = new SecureRandom();

    private final AppProperties props;

    public RequestIdFilter(AppProperties props) {
        this.props = props;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        req.setAttribute(START_ATTR, System.nanoTime());
        String id = resolve(req, props.trustedProxy());
        req.setAttribute(ATTR, id);
        res.setHeader(HEADER, id);
        MDC.put("request_id", id);
        try {
            chain.doFilter(req, res);
        } finally {
            MDC.remove("request_id");
        }
    }

    /** 신뢰 프록시(edge)가 보낸 형식이 맞는 X-Request-Id 면 그 값, 아니면 새 id. */
    public static String resolve(HttpServletRequest req, String trustedProxy) {
        String h = req.getHeader(HEADER);
        boolean fromEdge = trustedProxy != null && !trustedProxy.isBlank() && trustedProxy.equals(req.getRemoteAddr());
        return fromEdge && h != null && VALID.matcher(h).matches() ? h : newId();
    }

    /** 새 요청 id: 시각(ms, 16진) + 난수 8바이트(16진). */
    public static String newId() {
        byte[] b = new byte[8];
        RND.nextBytes(b);
        return Long.toHexString(System.currentTimeMillis()) + HexFormat.of().formatHex(b);
    }

    /**
     * 이 요청이 이 필터(가장 앞 필터)에 들어온 뒤 흐른 시간(ms) — 503 WARN 이 그 요청이 얼마나 걸렸는지 적는다(조사 2026-10-01 오류 F3: 느린 조회와
     * 연결 · 잠금 대기를 가려 보려면 걸린 시간이 있어야 한다). Tomcat 대기열에서 기다린 시간은 들지 않는다. 필터를 거치지 않았으면 null(모름 — 0 이 아니다).
     */
    public static Long elapsedMs(HttpServletRequest req) {
        return req.getAttribute(START_ATTR) instanceof Long t ? (System.nanoTime() - t) / 1_000_000 : null;
    }

    public static String current(HttpServletRequest req) {
        Object v = req.getAttribute(ATTR);
        return v == null ? "-" : v.toString();
    }
}
