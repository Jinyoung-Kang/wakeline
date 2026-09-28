package dev.wakeline.ws;

import dev.wakeline.config.AppProperties;
import dev.wakeline.domain.Bbox;
import dev.wakeline.ingest.SnapshotStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.adapter.NativeWebSocketSession;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * /ws/v1 핸들러(계약서 §1). 클라이언트 메시지 ≤ 4 KB · 세션당 10 s 에 20 개(넘으면 1008 "rate limit") · hello 5 s(세션 타이머)
 * · 연결 상한(전체·IP별)을 원자적으로 예약 · 연결당 구독 1개 · bbox 면적 상한(전세계 뷰는 줌 ≤ 5 만).
 * 수신 스레드는 상태만 바꾸고 전송은 모두 세션 우편함(WsHub)에 맡긴다 — 여기서 블로킹 전송을 하지 않는다.
 * 선박(계약 v2 §B3): {type:"layers", aircraft, ships}(boolean — 없는 키는 그대로, 다른 형식은 BAD_LAYERS) · {type:"select_ship", mmsi|null}
 * (9자리 문자열 — 아니면 BAD_MMSI) · resync 는 항공기와 함께 선박 스냅샷도 다시 보낸다(웹은 sseq 틈에도 resync 를 보낸다).
 * resync scope(계약 v5 §E2): "alerts" · "sigmets" · "radar" 면 그 목록 하나만 버전과 무관하게 전체로(웹이 형식 오류로 버린 메시지), 그 밖은 BAD_RESYNC.
 */
@Profile("!cli & !migrate")
@Component
public class WakelineWsHandler extends TextWebSocketHandler {
    private static final Logger log = LoggerFactory.getLogger(WakelineWsHandler.class);
    public static final String ATTR_IP = "wakeline.ip";
    /** Tomcat 세션별 블로킹 전송 시간 제한(ms, Long) — 기본 20 s 를 설계 5.1 의 5 s 로. */
    static final String TOMCAT_BLOCKING_SEND_TIMEOUT = "org.apache.tomcat.websocket.BLOCKING_SEND_TIMEOUT";
    static final int MAX_MESSAGE_BYTES = 4096;
    static final int MAX_ZOOM = 24;
    private static final Pattern HEX = Pattern.compile("^[0-9a-f]{6}$");
    private static final Pattern MMSI = Pattern.compile("^[0-9]{9}$");
    private static final String PONG = "{\"type\":\"pong\"}";

    private final WsHub hub;
    private final AppProperties props;
    private final ObjectMapper json;
    private final SnapshotStore snapshots;
    private final ConnectionLimiter limiter;
    private final ShipFanout ships;
    private final Map<String, WsSession> byId = new ConcurrentHashMap<>();

    public WakelineWsHandler(WsHub hub, AppProperties props, ObjectMapper json, SnapshotStore snapshots, ShipFanout ships) {
        this.hub = hub;
        this.props = props;
        this.json = json;
        this.snapshots = snapshots;
        this.ships = ships;
        this.limiter = new ConnectionLimiter(props.wsMaxConn(), props.wsMaxConnPerIp());
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession raw) {
        raw.setTextMessageSizeLimit(MAX_MESSAGE_BYTES);
        applySendTimeout(raw);
        String ip = String.valueOf(raw.getAttributes().getOrDefault(ATTR_IP, "?"));
        if (!limiter.tryAcquire(ip)) { // 검사와 예약이 한 임계 구역 — 동시 접속도 상한을 넘지 못한다(SEC-12)
            hub.rejected();
            try { raw.close(CloseStatus.SERVICE_OVERLOAD.withReason("connection limit")); } catch (Exception ignored) { }
            return;
        }
        try {
            WsSession s = hub.newSession(raw, ip);
            byId.put(raw.getId(), s);
            hub.add(s);
        } catch (RuntimeException e) {
            byId.remove(raw.getId());
            limiter.release(ip);
            throw e;
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession raw, CloseStatus status) {
        WsSession s = byId.remove(raw.getId());
        if (s == null) return; // 상한으로 거절한 연결 — 예약하지 않았다
        hub.remove(s);
        limiter.release(s.ip);
    }

    @Override
    protected void handleTextMessage(WebSocketSession raw, TextMessage message) {
        WsSession s = byId.get(raw.getId());
        if (s == null || s.isClosing() || s.inboundBlocked) return;
        if (!s.inbound.tryAcquire(System.nanoTime())) { hub.rateLimited(s); return; }
        JsonNode m;
        try {
            m = json.readTree(message.getPayload());
        } catch (RuntimeException e) {
            hub.fatal(s, "BAD_JSON", "invalid json", CloseStatus.PROTOCOL_ERROR);
            return;
        }
        String type = m == null ? "" : m.path("type").asString("");
        if (!s.hello && !"hello".equals(type)) { hub.fatal(s, "HELLO_REQUIRED", "first message must be hello", CloseStatus.PROTOCOL_ERROR); return; }
        switch (type) {
            case "hello" -> hello(s, m);
            case "subscribe" -> subscribe(s, m);
            case "select" -> select(s, m);
            case "pause" -> { s.paused = true; hub.demandChanged(); } // 보지 않는 세션은 수요를 내지 않는다(계약 v2 §A1)
            case "resume" -> resume(s);
            case "resync" -> resync(s, m);
            case "layers" -> layers(s, m);
            case "select_ship" -> selectShip(s, m);
            case "pong" -> s.missedPongs.set(0);
            case "ping" -> hub.reply(s, PONG);
            default -> hub.error(s, "UNKNOWN_TYPE", "unknown message type");
        }
    }

    /**
     * resync: scope 가 없으면 다음 스냅샷을 기다리지 않고 바로 — 항공기와 (켜져 있으면) 선박 모두(seq · sseq 틈, 버린 흐름 메시지).
     * scope 가 있으면 그 목록 하나만 전체로(계약 v5 §E2 — 알림 배치는 증분이라 버린 배치가 다음 배치로 바로잡히지 않는다). null 은 없는 것과 같다.
     */
    private void resync(WsSession s, JsonNode m) {
        JsonNode scope = m.get("scope");
        if (scope == null || scope.isNull()) {
            s.needsResync = true;
            hub.requestFanout(s);
            ships.resync(s);
            return;
        }
        switch (scope.isString() ? scope.asString() : "") {
            case "alerts" -> hub.resyncAlerts(s);
            case "sigmets" -> hub.resyncSigmets(s);
            case "radar" -> hub.resyncRadar(s);
            default -> hub.error(s, "BAD_RESYNC", "scope must be alerts, sigmets, radar or absent");
        }
    }

    private void hello(WsSession s, JsonNode m) {
        if (m.path("proto").asInt(0) != 1) { hub.fatal(s, "UNSUPPORTED_PROTO", "proto must be 1", CloseStatus.PROTOCOL_ERROR); return; }
        s.hello = true;
        hub.reply(s, hub.toJson(WsMessages.Welcome.of(s.id, snapshots.version(), props.maxBboxAreaSqdeg(), props.wsDiffIntervalS(),
                props.wsResyncIntervalS(), props.wsResyncWorldIntervalS(), WsSession.RATE_MAX, WsSession.RATE_WINDOW_S,
                (int) (WsHub.HELLO_TIMEOUT_MS / 1000))));
    }

    private void subscribe(WsSession s, JsonNode m) {
        Bbox bbox = parseBbox(m.path("bbox"));
        if (bbox == null) { hub.error(s, "BAD_BBOX", "bbox must be [lomin,lamin,lomax,lamax] within range"); return; }
        JsonNode z = m.path("zoom");
        int zoom = z.isNumber() ? Math.max(0, Math.min(MAX_ZOOM, z.asInt())) : 7;
        if (bbox.area() > props.maxBboxAreaSqdeg() && zoom > 5) {
            hub.error(s, "BBOX_TOO_LARGE", "bbox area exceeds limit; zoom out to ≤ 5 for world view");
            return;
        }
        String detail = "full".equals(m.path("detail").asString("lite")) ? "full" : "lite";
        s.sub = new WsSession.Sub(bbox, zoom, detail);
        s.paused = false;
        hub.sendInitial(s, false); // 대기 중인 초기 전송이 있으면 합쳐진다(마지막 bbox 가 이긴다)
        hub.demandChanged();      // 줌·화면 중심이 바뀌면 핫 리전 수요가 바뀐다(1 s 로 모아 계산)
    }

    static Bbox parseBbox(JsonNode b) {
        if (b == null || !b.isArray() || b.size() != 4) return null;
        double[] v = new double[4];
        for (int i = 0; i < 4; i++) {
            JsonNode n = b.get(i);
            if (n == null || !n.isNumber()) return null;
            v[i] = n.asDouble();
        }
        return Bbox.checked(v[0], v[1], v[2], v[3]); // REST 와 같은 규칙(유한 · 범위 · 최소 < 최대, R-16)
    }

    /**
     * 선택(계약 §1) — 선택은 집중 추적 수요가 된다(계약 v2 §A1). 같은 hex 를 다시 선택해도 선택 시각을 새로 잡는다
     * (30분 상한 뒤 "다시 선택하면 이어진다"). 시각을 먼저 쓰고 hex 를 쓴다(WsSession.selectedAtMs 참고).
     */
    private void select(WsSession s, JsonNode m) {
        JsonNode h = m.get("hex");
        if (h == null || h.isNull()) {
            s.selectedHex = null;
            s.selectedAtMs = 0;
            hub.demandChanged();
            return;
        }
        String hex = h.isString() ? h.asString().toLowerCase(Locale.ROOT) : "";
        if (!HEX.matcher(hex).matches()) { hub.error(s, "BAD_HEX", "hex must be 6 hex digits or null"); return; }
        s.selectedAtMs = System.currentTimeMillis();
        s.selectedHex = hex;
        hub.requestSelected(s); // 바로 한 번, 이후 스냅샷마다 바뀌면
        hub.demandChanged();
    }

    /**
     * 레이어(계약 v2 §B3): 항공기를 끄면 항공기 목록과 핫 리전 수요를 멈추고, 켜면 seq 1 스냅샷부터 다시. 선박을 켜면 선박 전체를 보내고, 끄면 멈춘다.
     * 없는 키는 그대로 둔다. boolean 이 아닌 값은 거절한다(어느 레이어도 바꾸지 않는다).
     */
    private void layers(WsSession s, JsonNode m) {
        JsonNode a = m.get("aircraft"), sh = m.get("ships");
        if ((a != null && !a.isBoolean()) || (sh != null && !sh.isBoolean())) {
            hub.error(s, "BAD_LAYERS", "aircraft and ships must be booleans");
            return;
        }
        boolean air = a == null ? s.layerAircraft : a.asBoolean();
        boolean shp = sh == null ? s.layerShips : sh.asBoolean();
        boolean airChanged = air != s.layerAircraft, shipsChanged = shp != s.layerShips;
        s.layerAircraft = air;
        s.layerShips = shp;
        if (airChanged) {
            if (air) {
                s.needsResync = true;
                hub.requestFanout(s);
            }
            hub.demandChanged(); // 항공기를 보지 않는 세션은 핫 리전 수요를 내지 않는다
        }
        if (shipsChanged) ships.layersChanged(s);
    }

    /** 선박 선택(계약 v2 §B3): 바로 ship_selected 한 번, 이후 그 선박이 바뀔 때마다. null 은 선택 해제(응답 없음). */
    private void selectShip(WsSession s, JsonNode m) {
        JsonNode v = m.get("mmsi");
        if (v == null || v.isNull()) {
            s.selectedMmsi = null;
            ships.selected(s);
            return;
        }
        String mmsi = v.isString() ? v.asString() : "";
        if (!MMSI.matcher(mmsi).matches()) { hub.error(s, "BAD_MMSI", "mmsi must be 9 digits or null"); return; }
        s.selectedMmsi = mmsi;
        ships.selected(s);
    }

    /** 일시정지 중 놓친 것(알림·SIGMET·레이더·항공기)을 전체 초기 세트로 다시 보낸다(GAP-3/COR-7). */
    private void resume(WsSession s) {
        boolean wasPaused = s.paused;
        s.paused = false;
        if (wasPaused && s.sub != null) hub.sendInitial(s, true);
        if (wasPaused) hub.demandChanged();
    }

    /** 이 세션의 블로킹 전송이 5 s 를 넘으면 Tomcat 이 IOException 을 던지게 한다(기본 20 s, REL-2). */
    static void applySendTimeout(WebSocketSession raw) {
        try {
            if (raw instanceof NativeWebSocketSession n) {
                jakarta.websocket.Session ns = n.getNativeSession(jakarta.websocket.Session.class);
                if (ns != null) ns.getUserProperties().put(TOMCAT_BLOCKING_SEND_TIMEOUT, (long) WsSession.SEND_TIME_LIMIT_MS);
            }
        } catch (RuntimeException e) {
            log.debug("ws send timeout not applied: {}", e.toString());
        }
    }

    @Override
    public void handleTransportError(WebSocketSession raw, Throwable ex) {
        log.debug("ws transport error {}: {}", raw.getId(), ex.toString());
    }

    /** 테스트용 */
    WsSession session(String id) { return byId.get(id); }

    ConnectionLimiter limiter() { return limiter; }
}
