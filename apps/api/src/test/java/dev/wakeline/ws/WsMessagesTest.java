package dev.wakeline.ws;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.engine.PredictionAvailability;
import dev.wakeline.ingest.Snapshot;
import dev.wakeline.ingest.SnapshotStore;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static dev.wakeline.ws.WsTestKit.JSON;
import static org.assertj.core.api.Assertions.assertThat;

/** 계약 §1 인코딩: 키 목록(정직성 필드를 빼지 않음), null 은 키 생략(0·false 로 채우지 않음), world 좌표 소수 3자리. */
class WsMessagesTest {
    static final Instant T = Instant.parse("2026-09-27T05:10:00Z");

    static AircraftState full() {
        return new AircraftState("71c123", "KAL081", "HL8001", "B77W", "A5", 37.123456, 126.987654, 35000, 480.0, 95.0, -64.0,
                false, "7700", T, "adsb_lol", T.plusSeconds(2), 3, false);
    }

    static AircraftState sparse() { // 공급자가 모르는 값은 null
        return new AircraftState("71c124", null, null, null, null, 37.0, 127.0, null, null, null, null,
                false, null, T, "opensky", T, 0, false);
    }

    @Test void lite_hasContractKeys_inOrder() {
        assertThat(WsMessages.encode(full(), WsMessages.Encoding.LITE).keySet()).containsExactly(
                "hex", "callsign", "lat", "lon", "alt_ft", "gs_kt", "track_deg", "vrate_fpm", "on_ground", "squawk", "seen_at", "provider", "quality");
    }

    @Test void world_keepsSeenAtSquawkOnGroundProvider_andRounds3Decimals() {
        Map<String, Object> m = WsMessages.encode(full(), WsMessages.Encoding.WORLD);
        assertThat(m.keySet()).containsExactly(
                "hex", "callsign", "lat", "lon", "alt_ft", "gs_kt", "track_deg", "on_ground", "squawk", "seen_at", "provider");
        assertThat(m.get("lat")).isEqualTo(37.123);
        assertThat(m.get("lon")).isEqualTo(126.988);
        assertThat(m.get("seen_at")).isEqualTo("2026-09-27T05:10:00Z");
        assertThat(m.get("squawk")).isEqualTo("7700"); // 저배율에서도 비상 squawk 강조가 가능하다(COR-8)
    }

    @Test void full_isLitePlusStaticFields() {
        assertThat(WsMessages.encode(full(), WsMessages.Encoding.FULL).keySet()).containsExactly(
                "hex", "callsign", "lat", "lon", "alt_ft", "gs_kt", "track_deg", "vrate_fpm", "on_ground", "squawk", "seen_at", "provider", "quality",
                "registration", "type_code", "category", "fetched_at");
    }

    @Test void unknownValues_areOmitted_neverZeroOrFalse() {
        for (WsMessages.Encoding e : WsMessages.Encoding.values()) {
            Map<String, Object> m = WsMessages.encode(sparse(), e);
            assertThat(m).doesNotContainKeys("callsign", "alt_ft", "gs_kt", "track_deg", "vrate_fpm", "squawk", "registration", "type_code", "category");
            assertThat(m).containsKeys("hex", "lat", "lon", "seen_at", "provider", "on_ground");
        }
    }

    @Test void legacyEncodeSignature_mapsDetailAndWorld() {
        assertThat(WsMessages.encode(full(), "full", false)).containsKey("registration");
        assertThat(WsMessages.encode(full(), "lite", false)).doesNotContainKey("registration").containsKey("quality");
        assertThat(WsMessages.encode(full(), "full", true)).doesNotContainKey("quality");
    }

    @Test void snapshotMessage_hasSeqSourcesAndRawAircraftArray() {
        Snapshot region = new Snapshot(7, "region", "adsb_lol", T.minusSeconds(4), T, "-", Map.of());
        Snapshot global = Snapshot.empty("global");
        var view = new SnapshotStore.View(region, global, Map.of(), Long.MAX_VALUE);
        var msg = new WsMessages.SnapshotMsg("snapshot", 1, 7, T, WsHub.sources(view, T), 3, "[{\"hex\":\"abc123\"}]");
        JsonNode n = JSON.readTree(JSON.writeValueAsString(msg));
        assertThat(n.path("seq").asInt()).isEqualTo(1);
        assertThat(n.path("sigmets_version").asLong()).isEqualTo(3);
        assertThat(n.path("aircraft").get(0).path("hex").asString()).isEqualTo("abc123");
        JsonNode src = n.path("sources");
        assertThat(src.path("region").path("provider").asString()).isEqualTo("adsb_lol");
        assertThat(src.path("region").path("lag_s").asDouble()).isEqualTo(4.0);
        assertThat(src.path("region").path("stale").asBoolean()).isFalse();
        assertThat(src.has("global")).isTrue();          // 전세계 피드가 없으면 null(키는 있다)
        assertThat(src.get("global").isNull()).isTrue();
        assertThat(n.has("provider")).isFalse();          // 지역 공급자 하나로 전체를 표시하던 필드는 없다(GAP-2)
    }

    @Test void sources_staleThresholdsPerScope_andUnknownLagIsNull() {
        Instant now = T;
        Snapshot region = new Snapshot(1, "region", "adsb_fi", now.minusSeconds(61), now, "-", Map.of());
        Snapshot global = new Snapshot(2, "global", "opensky", now.minusSeconds(299), now, "-", Map.of());
        var s = WsHub.sources(new SnapshotStore.View(region, global, Map.of(), Long.MAX_VALUE), now);
        assertThat(s.region().stale()).isTrue();   // 지역 60 s 초과
        assertThat(s.global().stale()).isFalse();  // 전세계 300 s 이하
        assertThat(s.global().provider()).isEqualTo("opensky");
        var none = WsHub.source(Snapshot.empty("region"), now, 60);
        assertThat(none.lagS()).isNull();
        assertThat(none.fetchedAt()).isNull();
        assertThat(none.provider()).isNull();
        assertThat(none.stale()).isTrue();
    }

    @Test void diffMessage_upsertIsRawArray() {
        JsonNode n = JSON.readTree(JSON.writeValueAsString(new WsMessages.DiffMsg("diff", 5, 9, T, "[{\"hex\":\"a\"}]", List.of("b"))));
        assertThat(n.path("seq").asInt()).isEqualTo(5);
        assertThat(n.path("upsert").get(0).path("hex").asString()).isEqualTo("a");
        assertThat(n.path("remove").get(0).asString()).isEqualTo("b");
    }

    @Test void selectedMessage_nullStateIsExplicit_reasonOmittedWhenNull() {
        JsonNode gone = JSON.readTree(JSON.writeValueAsString(new WsMessages.SelectedMsg("selected", "71c123", null, new PredictionAvailability(false, null))));
        assertThat(gone.has("state")).isTrue();
        assertThat(gone.get("state").isNull()).isTrue();
        assertThat(gone.path("prediction").path("available").asBoolean()).isFalse();
        assertThat(gone.path("prediction").has("reason")).isFalse();
        JsonNode turning = JSON.readTree(JSON.writeValueAsString(new WsMessages.SelectedMsg("selected", "71c123", "{\"hex\":\"71c123\"}",
                PredictionAvailability.unavailable(PredictionAvailability.TURNING))));
        assertThat(turning.path("state").path("hex").asString()).isEqualTo("71c123");
        assertThat(turning.path("prediction").path("reason").asString()).isEqualTo("turning");
    }
}
