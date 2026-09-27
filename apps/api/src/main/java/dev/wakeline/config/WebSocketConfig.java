package dev.wakeline.config;

import dev.wakeline.ws.OriginAllowList;
import dev.wakeline.ws.WakelineWsHandler;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Map;

/**
 * /ws/v1 등록.
 * - Origin: 명시 허용 목록(wakeline.allowed-origins, env WAKELINE_ALLOWED_ORIGINS)만 받는다. Spring 기본 검사는 same-origin 이면 목록과 무관하게
 *   통과시키므로(DNS 리바인딩에 취약) OriginAllowList 가 먼저 목록 밖 Origin 을 403 으로 막는다(SEC-7).
 * - 핸드셰이크에서 클라이언트 IP(edge XFF)를 세션 속성에 담는다(연결 상한·로그용).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 웹·소비자·잡을 띄우지 않는다
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {
    private static final Logger log = LoggerFactory.getLogger(WebSocketConfig.class);
    private final WakelineWsHandler handler;
    private final AppProperties props;

    public WebSocketConfig(WakelineWsHandler handler, AppProperties props) {
        this.handler = handler;
        this.props = props;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        OriginAllowList origins = new OriginAllowList(props.allowedOrigins());
        registry.addHandler(handler, "/ws/v1")
                .addInterceptors(origins, new ClientIpInterceptor(props.trustedProxy()))
                // Spring 의 Origin 검사도 같은 목록을 쓰게 한다(목록 안의 교차 출처 Origin 이 same-origin 검사로 거절되지 않게)
                .setAllowedOriginPatterns(origins.patterns().toArray(String[]::new));
        log.info("ws /ws/v1 allowed origins: {}", origins.patterns());
    }

    /** edge 가 넘긴 클라이언트 IP(신뢰 프록시 XFF 만 해석)를 세션 속성에 담는다. */
    static final class ClientIpInterceptor implements HandshakeInterceptor {
        private final String trustedProxy;

        ClientIpInterceptor(String trustedProxy) { this.trustedProxy = trustedProxy; }

        @Override
        public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler wsHandler, Map<String, Object> attributes) {
            if (request instanceof ServletServerHttpRequest s) {
                HttpServletRequest req = s.getServletRequest();
                attributes.put(WakelineWsHandler.ATTR_IP, ClientIp.resolve(req, trustedProxy));
            }
            return true;
        }

        @Override
        public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler wsHandler, Exception exception) { }
    }
}
