package dev.wakeline.ws;

import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.platform.support.Receipt;
import dev.wakeline.route.RouteInfoTest;
import dev.wakeline.route.RouteReader;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

import static dev.wakeline.ws.WsTestKit.ofType;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 계약 v4: selected 의 route(§A — 콜사인별 5 s 캐시, 노선 상태만 바뀌어도 다시 보냄)와 ship_selected 의 destination_info(§B).
 * 노선 값은 합성(가짜 Redis).
 */
class RouteAndDestinationWsTest {
    final Map<String, String> redis = new HashMap<>();
    final AtomicLong clock = new AtomicLong(1_000_000);

    RouteReader reader() { return new RouteReader(redis::get, RouteInfoTest.JSON, clock::get); }

    static AircraftState plane(String hex, String callsign, double lat, double lon, Instant seen) {
        return new AircraftState(hex, callsign, "HL0000", "A321", "A3", lat, lon, 36000, 450.0, 90.0, 0.0, false, null, seen, "adsb_fi", seen, 0, false);
    }

    @Test void selectedCarriesRoute_andIsResentWhenOnlyTheRouteChanges() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            k.hub.setRouteSource(RouteLookups.of(reader()));
            Instant now = Instant.now();
            AircraftState a = plane("bbb001", "syn736", 50, 10, now);
            k.publish("global", now, a);
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb001\"}");
            List<JsonNode> sel = ofType(f, "selected");
            assertThat(sel).hasSize(1);
            assertThat(sel.getFirst().path("route").path("status").asString()).isEqualTo("pending");
            assertThat(sel.getFirst().path("route").path("callsign").asString()).isEqualTo("SYN736");
            assertThat(sel.getFirst().path("route").path("source").asString()).isEqualTo("adsbdb");

            // 수집기가 캐시에 쓴다 — 5 s 캐시가 지나기 전에는 같은 값(다시 보내지 않는다)
            redis.put("wakeline:route:SYN736", RouteInfoTest.found("SYN736").toString());
            k.publish("region", now.plusSeconds(1), WsTestKit.ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            assertThat(ofType(f, "selected")).hasSize(1);
            clock.addAndGet(RouteReader.TTL_MS);
            k.publish("region", now.plusSeconds(2), WsTestKit.ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            sel = ofType(f, "selected");
            assertThat(sel).as("state unchanged, route pending → found").hasSize(2);
            JsonNode route = sel.getLast().path("route");
            assertThat(route.path("status").asString()).isEqualTo("found");
            assertThat(route.path("origin").path("icao").asString()).isEqualTo("ZZAA");
            assertThat(route.path("destination").path("name").asString()).isEqualTo("Bravo Test Airport");
            assertThat(route.path("fetched_at").asString()).isEqualTo("2026-09-28T03:21:00Z");
            assertThat(route.has("midpoint")).isFalse();
            assertThat(sel.getLast().path("state").path("callsign").asString()).isEqualTo("syn736");

            k.publish("region", now.plusSeconds(3), WsTestKit.ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            assertThat(ofType(f, "selected")).as("nothing changed").hasSize(2);

            k.publish("global", now.plusSeconds(30)); // 스냅샷에서 사라짐 → 콜사인을 모른다
            JsonNode gone = ofType(f, "selected").getLast();
            assertThat(gone.get("state").isNull()).isTrue();
            assertThat(gone.has("route")).isTrue();
            assertThat(gone.get("route").isNull()).isTrue();
        }
    }

    @Test void focusObservationOfTheSameStateIsResentOnlyWhenTheRouteChanged() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            k.hub.setRouteSource(RouteLookups.of(reader()));
            Instant now = Instant.now();
            AircraftState a = plane("ddd001", "SYN9", 40, -40, now);
            FakeWsSession f = k.subscribed("s", "1.1.1.1"); // 한국 화면 — 대서양 항공기는 팬아웃 범위 밖
            k.msg(f, "{\"type\":\"select\",\"hex\":\"ddd001\"}");
            k.publishFocus(now.plusSeconds(1), a);
            assertThat(ofType(f, "selected")).hasSize(2);
            assertThat(ofType(f, "selected").getLast().path("route").path("status").asString()).isEqualTo("pending");
            k.publishFocus(now.plusSeconds(2), a); // 같은 상태 객체, 노선도 그대로 → 보내지 않는다
            assertThat(ofType(f, "selected")).hasSize(2);
            redis.put("wakeline:route:SYN9", RouteInfoTest.cached("not_found", "SYN9").toString());
            clock.addAndGet(RouteReader.TTL_MS);
            k.publishFocus(now.plusSeconds(3), a);
            assertThat(ofType(f, "selected")).hasSize(3);
            assertThat(ofType(f, "selected").getLast().path("route").path("status").asString()).isEqualTo("not_found");
        }
    }

    /** 계약 v4 §G A-2: 수집기가 묻지 않은 노선(disabled — fixture 모드·운영자가 adsbdb 끔)은 selected.route.status disabled, 조회 시각 없음. */
    @Test void selectedRouteDisabled() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            k.hub.setRouteSource(RouteLookups.of(reader()));
            redis.put("wakeline:route:SYN5", RouteInfoTest.cached("disabled", "SYN5").toString());
            Instant now = Instant.now();
            k.publish("global", now, plane("bbb005", " syn5", 50, 10, now));
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb005\"}");
            JsonNode route = ofType(f, "selected").getLast().path("route");
            assertThat(route.path("status").asString()).isEqualTo("disabled");
            assertThat(route.path("callsign").asString()).isEqualTo("SYN5");
            assertThat(route.has("fetched_at")).isFalse();
            assertThat(route.has("origin")).isFalse();
        }
    }

    @Test void selectedWithoutARouteSourceHasNullRoute() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            k.publish("global", now, plane("bbb002", "SYN1", 50, 10, now));
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            k.hub.setRouteSource(null);
            k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb002\"}");
            JsonNode sel = ofType(f, "selected").getFirst();
            assertThat(sel.has("route")).isTrue();
            assertThat(sel.get("route").isNull()).isTrue();
        }
    }

    @Test void shipSelectedCarriesDestinationInfo() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant t = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS);
            ShipState pos = new ShipState("440000001", 35.1, 129.1, 12.0, 45.0, 44, 0, 3, "epfs", t, "aisstream", "PositionReport", "A");
            ShipStatic stat = new ShipStatic("440000001", "SYNTH", null, null, 70, null, null, null, null, null, "krpus <=> ca van", null, null, null, null,
                    t.minusSeconds(60), "aisstream");
            ShipStatic noDest = new ShipStatic("440000002", "NODEST", null, null, 70, null, null, null, null, null, null, null, null, null, null,
                    t.minusSeconds(60), "aisstream");
            var c = k.ships.apply(List.of(pos), List.of(stat, noDest), t, "aisstream", System.currentTimeMillis());
            k.shipFanout.onShips(new IngestEvents.ShipsUpdated(t, "aisstream", List.of(pos), List.of(stat, noDest), c.changed(), Set.of(), Receipt.NONE));
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"440000001\"}");
            JsonNode d = ofType(f, "ship_selected").getLast().path("destination_info");
            assertThat(d.path("raw").asString()).isEqualTo("krpus <=> ca van");
            assertThat(d.path("kind").asString()).isEqualTo("between");
            assertThat(d.has("from")).isFalse();
            assertThat(d.has("to")).isFalse();
            assertThat(d.path("places").get(0).path("locode").asString()).isEqualTo("KRPUS");
            assertThat(d.path("places").get(0).path("ambiguous").asBoolean()).isFalse();
            assertThat(d.path("places").get(1).path("name").asString()).isEqualTo("Vancouver");
            assertThat(d.path("places").get(1).path("ambiguous").asBoolean()).as("spaced form").isFalse();

            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"440000002\"}");
            JsonNode none = ofType(f, "ship_selected").getLast();
            assertThat(none.has("destination_info")).isTrue();
            assertThat(none.get("destination_info").isNull()).isTrue();
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"123456789\"}");
            assertThat(ofType(f, "ship_selected").getLast().get("destination_info").isNull()).isTrue();
        }
    }
}
