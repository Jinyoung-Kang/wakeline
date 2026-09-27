package dev.skywx.ws;

import dev.skywx.config.AppProperties;
import dev.skywx.config.ClientIp;
import dev.skywx.domain.Bbox;
import dev.skywx.engine.EngineService;
import dev.skywx.ingest.SnapshotStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** /ws/v1 핸들러. 클라이언트 메시지 ≤ 4 KB, hello 5 s, 연결당 구독 1개, bbox 면적 상한(전세계 뷰는 줌 ≤ 5 만). */
@org.springframework.context.annotation.Profile("!cli")
@Component
public class SkyWsHandler extends TextWebSocketHandler {
    private static final Logger log = LoggerFactory.getLogger(SkyWsHandler.class);
    public static final String ATTR_IP = "skywx.ip";
    private final WsHub hub;
    private final AppProperties props;
    private final ObjectMapper json;
    private final SnapshotStore snapshots;
    private final EngineService engine;
    private final Map<String, WsSession> byId = new ConcurrentHashMap<>();

    public SkyWsHandler(WsHub hub, AppProperties props, ObjectMapper json, SnapshotStore snapshots, EngineService engine) {
        this.hub = hub;
        this.props = props;
        this.json = json;
        this.snapshots = snapshots;
        this.engine = engine;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession raw) {
        raw.setTextMessageSizeLimit(4096);
        String ip = String.valueOf(raw.getAttributes().getOrDefault(ATTR_IP, "?"));
        if (hub.count() >= props.wsMaxConn() || hub.countByIp(ip) >= props.wsMaxConnPerIp()) {
            try { raw.close(CloseStatus.SERVICE_OVERLOAD.withReason("connection limit")); } catch (Exception ignored) { }
            return;
        }
        WsSession s = new WsSession(raw, ip);
        byId.put(raw.getId(), s);
        hub.add(s);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession raw, CloseStatus status) {
        byId.remove(raw.getId());
        hub.remove(raw.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession raw, TextMessage message) {
        WsSession s = byId.get(raw.getId());
        if (s == null) return;
        JsonNode m;
        try { m = json.readTree(message.getPayload()); } catch (Exception e) { error(s, "BAD_JSON", "invalid json", true); return; }
        String type = m.path("type").asString("");
        if (!s.hello && !"hello".equals(type)) { error(s, "HELLO_REQUIRED", "first message must be hello", true); return; }
        switch (type) {
            case "hello" -> {
                if (m.path("proto").asInt(0) != 1) { error(s, "UNSUPPORTED_PROTO", "proto must be 1", true); return; }
                s.hello = true;
                s.sendOrDrop(hub.toJson(WsMessages.Welcome.of(s.id, snapshots.version(), props.maxBboxAreaSqdeg(), props.wsDiffIntervalS(), props.wsResyncIntervalS())));
            }
            case "subscribe" -> subscribe(s, m);
            case "select" -> s.selectedHex = m.hasNonNull("hex") ? m.get("hex").asString() : null;
            case "pause" -> s.paused = true;
            case "resume" -> { s.paused = false; s.needsResync = true; }
            case "resync" -> s.needsResync = true;
            case "pong" -> s.missedPongs = 0;
            case "ping" -> s.sendOrDrop(hub.toJson(new WsMessages.Simple("pong")));
            default -> error(s, "UNKNOWN_TYPE", "unknown message type", false);
        }
    }

    private void subscribe(WsSession s, JsonNode m) {
        JsonNode b = m.path("bbox");
        if (!b.isArray() || b.size() != 4) { error(s, "BAD_BBOX", "bbox must be [lomin,lamin,lomax,lamax]", false); return; }
        Bbox bbox;
        try {
            bbox = Bbox.parse(b.get(0).asDouble() + "," + b.get(1).asDouble() + "," + b.get(2).asDouble() + "," + b.get(3).asDouble(), 0);
        } catch (RuntimeException e) { error(s, "BAD_BBOX", "bbox out of range", false); return; }
        int zoom = m.path("zoom").asInt(7);
        boolean world = bbox.area() > props.maxBboxAreaSqdeg();
        if (world && zoom > 5) { error(s, "BBOX_TOO_LARGE", "bbox area exceeds limit; zoom out to ≤ 5 for world view", false); return; }
        s.bbox = bbox;
        s.zoom = zoom;
        s.world = world;
        s.detail = "full".equals(m.path("detail").asString("lite")) ? "full" : "lite";
        s.paused = false;
        s.needsResync = true;
        hub.sendInitial(s, engine.activeAlerts(null));
    }

    private void error(WsSession s, String code, String detail, boolean fatal) {
        s.sendOrDrop(hub.toJson(new WsMessages.ErrorMsg("error", code, code.toLowerCase().replace('_', ' '), detail)));
        if (fatal) s.close(CloseStatus.PROTOCOL_ERROR.withReason(code));
    }

    @Override
    public void handleTransportError(WebSocketSession raw, Throwable ex) {
        log.debug("ws transport error {}: {}", raw.getId(), ex.toString());
    }
}
