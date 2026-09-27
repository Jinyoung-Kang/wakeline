package dev.skywx.config;

import dev.skywx.ws.SkyWsHandler;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.socket.server.support.HttpSessionHandshakeInterceptor;

import java.util.Map;

/** /ws/v1 등록. Origin 은 기본(same-origin) 검사. 핸드셰이크에서 클라이언트 IP(edge XFF)를 세션 속성에 담는다. */
@org.springframework.context.annotation.Profile("!cli")  // --create-ops-user CLI 에서는 웹·소비자·잡을 띄우지 않는다
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {
    private final SkyWsHandler handler;
    private final AppProperties props;

    public WebSocketConfig(SkyWsHandler handler, AppProperties props) {
        this.handler = handler;
        this.props = props;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/v1").addInterceptors(new HandshakeInterceptor() {
            @Override
            public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler wsHandler, Map<String, Object> attributes) {
                if (request instanceof ServletServerHttpRequest s) {
                    HttpServletRequest req = s.getServletRequest();
                    attributes.put(SkyWsHandler.ATTR_IP, ClientIp.resolve(req, props.trustedProxy()));
                }
                return true;
            }

            @Override
            public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler wsHandler, Exception exception) { }
        });
    }
}
