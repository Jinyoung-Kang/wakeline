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
 * 그 밖의 클라이언트 값은 믿지 않고 새로 만든다(로그·헤더 주입 방지: 영숫자·'-' 8~64자만).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {
    public static final String HEADER = "X-Request-Id";
    public static final String ATTR = "wakeline.requestId";
    static final Pattern VALID = Pattern.compile("[0-9A-Za-z-]{8,64}");
    private static final SecureRandom RND = new SecureRandom();

    private final AppProperties props;

    public RequestIdFilter(AppProperties props) {
        this.props = props;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
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

    public static String current(HttpServletRequest req) {
        Object v = req.getAttribute(ATTR);
        return v == null ? "-" : v.toString();
    }
}
