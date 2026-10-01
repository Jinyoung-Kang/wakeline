package dev.wakeline.ws;

import dev.wakeline.aircraft.web.AircraftJson;
import dev.wakeline.engine.PredictionAvailability;
import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.aircraft.core.SnapshotStore;
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

    /** region·global 스냅샷 두 벌로 된 병합 뷰. */
    static SnapshotStore.View viewOf(Snapshot region, Snapshot global) {
        SnapshotStore store = new SnapshotStore();
        store.replace(region);
        store.replace(global);
        return store.view(T);
    }

    @Test void snapshotMessage_hasSeqSourcesAndRawAircraftArray() {
        Snapshot region = new Snapshot(7, "region", "adsb_lol", T.minusSeconds(4), T, "-", Map.of());
        Snapshot global = Snapshot.empty("global");
        var view = viewOf(region, global);
        var msg = new WsMessages.SnapshotMsg("snapshot", 1, 7, T, AircraftJson.sources(view, T), 3, "[{\"hex\":\"abc123\"}]");
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

    @Test void diffMessage_upsertIsRawArray() {
        JsonNode n = JSON.readTree(JSON.writeValueAsString(new WsMessages.DiffMsg("diff", 5, 9, T, "[{\"hex\":\"a\"}]", List.of("b"))));
        assertThat(n.path("seq").asInt()).isEqualTo(5);
        assertThat(n.path("upsert").get(0).path("hex").asString()).isEqualTo("a");
        assertThat(n.path("remove").get(0).asString()).isEqualTo("b");
    }

    @Test void selectedMessage_nullStateIsExplicit_reasonOmittedWhenNull() {
        JsonNode gone = JSON.readTree(JSON.writeValueAsString(new WsMessages.SelectedMsg("selected", "71c123", null, new PredictionAvailability(false, null), null)));
        assertThat(gone.has("state")).isTrue();
        assertThat(gone.get("state").isNull()).isTrue();
        assertThat(gone.path("prediction").path("available").asBoolean()).isFalse();
        assertThat(gone.path("prediction").has("reason")).isFalse();
        JsonNode turning = JSON.readTree(JSON.writeValueAsString(new WsMessages.SelectedMsg("selected", "71c123", "{\"hex\":\"71c123\"}",
                PredictionAvailability.unavailable(PredictionAvailability.TURNING), null)));
        assertThat(turning.path("state").path("hex").asString()).isEqualTo("71c123");
        assertThat(turning.path("prediction").path("reason").asString()).isEqualTo("turning");
    }
}
