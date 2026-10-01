package dev.wakeline.ws;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.List;
import java.util.Map;

/**
 * WS 핸드셰이크 Origin 명시 허용 목록(SEC-7 · 계약 §1, 설정 wakeline.allowed-origins / WAKELINE_ALLOWED_ORIGINS).
 * Spring 의 기본 Origin 검사(OriginHandshakeInterceptor)는 허용 목록과 별개로 'Origin 이 Host 와 같으면' 항상 통과시킨다.
 * DNS 리바인딩 페이지는 Origin 과 Host 가 둘 다 공격자 도메인이라 그 검사를 통과하므로, 여기서 목록에 없는 Origin 은 모두 403 으로 막는다.
 * Origin 헤더가 없으면(브라우저가 아닌 클라이언트 — 브라우저는 WS 에 항상 Origin 을 보낸다) 통과시킨다.
 * 항목은 정확한 origin("http://localhost:8700") 또는 Spring origin 패턴("http://localhost:[*]"). 목록 정리("*" · 빈 값 제거, 비면 기본 목록)는
 * 설정 쪽(AppProperties.originPatterns)이 한다.
 */
public final class OriginAllowList implements HandshakeInterceptor {
    private static final Logger log = LoggerFactory.getLogger(OriginAllowList.class);

    private final List<String> patterns;
    private final CorsConfiguration cors = new CorsConfiguration();

    /** @param patterns 정리한 허용 목록(AppProperties.originPatterns) */
    public OriginAllowList(List<String> patterns) {
        this.patterns = List.copyOf(patterns);
        cors.setAllowedOriginPatterns(this.patterns);
    }

    public List<String> patterns() { return patterns; }

    /** @return 허용이면 true. origin 이 null 이면(헤더 없음) true. */
    public boolean allows(String origin) {
        if (origin == null) return true;
        return cors.checkOrigin(origin) != null;
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler wsHandler, Map<String, Object> attributes) {
        String origin = request.getHeaders().getOrigin();
        if (allows(origin)) return true;
        response.setStatusCode(HttpStatus.FORBIDDEN);
        log.debug("ws handshake rejected: origin {} not in allow-list", origin);
        return false;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler wsHandler, Exception exception) { }
}
