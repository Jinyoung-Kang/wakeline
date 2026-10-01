package dev.wakeline.ships.web;

import dev.wakeline.ships.core.ShipState;
import dev.wakeline.ships.core.ShipStatic;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 선박 JSON(계약 v2 §B3 · v5 §G17) — WS(ships_* · ship_selected)와 REST(/ships · 상세)가 같은 인코딩 · 같은 상한을 쓴다.
 * 예전에는 WS 쪽(WsMessages · ShipFanout)에 있어 REST 컨트롤러가 WS 패키지를 import 했다(api-review E6 · §2.5-6).
 */
public final class ShipJson {
    private ShipJson() {}

    /** WS ships 메시지 한 번 · REST /ships 한 응답의 개별 선박 상한(계약 v4 §C — 줌 ≥ 7). */
    public static final int MAX_SHIPS_PER_MESSAGE = 5_000;

    /** ship_selected.static_source(계약 v5 §G17): api 메모리(ShipStore — 선박 스트림에서 받은 정적 정보). */
    public static final String STATIC_LIVE = "live";
    /** 메모리에 없어 DB ship 표의 마지막 저장 정적 보고를 실었다(static_updated_at = 저장 행의 updated_at). */
    public static final String STATIC_STORED = "stored";
    /** 메모리에도 DB 에도 정적 보고가 없다(static null). */
    public static final String STATIC_NONE = "none";
    /** 메모리에 없고 DB 를 읽지 못했다(시간 초과 · 연결 없음 — 저장돼 있는지 모름, static null). */
    public static final String STATIC_STORED_UNAVAILABLE = "stored_unavailable";

    /**
     * ShipLite(계약 v2 §B3): mmsi, lat, lon, sog_kn, cog_deg, heading_deg, ship_type, name, seen_at, position_source, nav_status.
     * 값이 없으면 키를 뺀다(모름 — 0 이나 빈 문자열로 채우지 않는다). ship_type·name 은 정적 정보가 있을 때만.
     */
    public static Map<String, Object> encodeShipLite(ShipState s, ShipStatic st) {
        Map<String, Object> m = new LinkedHashMap<>(16);
        m.put("mmsi", s.mmsi());
        m.put("lat", s.lat());
        m.put("lon", s.lon());
        put(m, "sog_kn", s.sogKn());
        put(m, "cog_deg", s.cogDeg());
        put(m, "heading_deg", s.headingDeg());
        if (st != null) {
            put(m, "ship_type", st.shipType());
            put(m, "name", st.name());
        }
        put(m, "seen_at", s.seenAt() == null ? null : s.seenAt().toString());
        put(m, "position_source", s.positionSource());
        put(m, "nav_status", s.navStatus());
        return m;
    }

    /** ShipState 전체(ship_selected.state · REST 상세). */
    public static Map<String, Object> encodeShipState(ShipState s) {
        Map<String, Object> m = new LinkedHashMap<>(16);
        m.put("mmsi", s.mmsi());
        m.put("lat", s.lat());
        m.put("lon", s.lon());
        put(m, "sog_kn", s.sogKn());
        put(m, "cog_deg", s.cogDeg());
        put(m, "heading_deg", s.headingDeg());
        put(m, "nav_status", s.navStatus());
        put(m, "rot", s.rot());
        put(m, "position_source", s.positionSource());
        put(m, "seen_at", s.seenAt() == null ? null : s.seenAt().toString());
        put(m, "provider", s.provider());
        put(m, "msg_type", s.msgType());
        put(m, "class", s.shipClass());
        return m;
    }

    /** ShipStatic 전체(ship_selected.static · REST 상세). 모든 값은 선박이 보낸 보고값. */
    public static Map<String, Object> encodeShipStatic(ShipStatic s) {
        Map<String, Object> m = new LinkedHashMap<>(24);
        m.put("mmsi", s.mmsi());
        put(m, "name", s.name());
        put(m, "call_sign", s.callSign());
        put(m, "imo", s.imo());
        put(m, "ship_type", s.shipType());
        put(m, "dim_a", s.dimA());
        put(m, "dim_b", s.dimB());
        put(m, "dim_c", s.dimC());
        put(m, "dim_d", s.dimD());
        put(m, "draught_m", s.draughtM());
        put(m, "destination", s.destination());
        put(m, "eta_month", s.etaMonth());
        put(m, "eta_day", s.etaDay());
        put(m, "eta_hour", s.etaHour());
        put(m, "eta_minute", s.etaMinute());
        put(m, "updated_at", s.updatedAt() == null ? null : s.updatedAt().toString());
        put(m, "provider", s.provider());
        return m;
    }

    private static void put(Map<String, Object> m, String k, Object v) {
        if (v != null) m.put(k, v);
    }
}
