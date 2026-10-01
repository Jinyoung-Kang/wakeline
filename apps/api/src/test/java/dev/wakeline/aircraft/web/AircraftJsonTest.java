package dev.wakeline.aircraft.web;

import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.aircraft.core.SnapshotStore;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 계약 §1 인코딩: 키 목록(정직성 필드를 빼지 않음), null 은 키 생략(0·false 로 채우지 않음), world 좌표 소수 3자리 · 스코프별 sources.
 * WsMessagesTest 에서 인코더(WsMessages.encode · WsHub.sources)와 함께 옮겼다(api-review §2.5-6 AircraftJson).
 */
class AircraftJsonTest {
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
        assertThat(AircraftJson.encode(full(), AircraftJson.Encoding.LITE).keySet()).containsExactly(
                "hex", "callsign", "lat", "lon", "alt_ft", "gs_kt", "track_deg", "vrate_fpm", "on_ground", "squawk", "seen_at", "provider", "quality");
    }

    @Test void world_keepsSeenAtSquawkOnGroundProvider_andRounds3Decimals() {
        Map<String, Object> m = AircraftJson.encode(full(), AircraftJson.Encoding.WORLD);
        assertThat(m.keySet()).containsExactly(
                "hex", "callsign", "lat", "lon", "alt_ft", "gs_kt", "track_deg", "on_ground", "squawk", "seen_at", "provider");
        assertThat(m.get("lat")).isEqualTo(37.123);
        assertThat(m.get("lon")).isEqualTo(126.988);
        assertThat(m.get("seen_at")).isEqualTo("2026-09-27T05:10:00Z");
        assertThat(m.get("squawk")).isEqualTo("7700"); // 저배율에서도 비상 squawk 강조가 가능하다(COR-8)
    }

    @Test void full_isLitePlusStaticFields() {
        assertThat(AircraftJson.encode(full(), AircraftJson.Encoding.FULL).keySet()).containsExactly(
                "hex", "callsign", "lat", "lon", "alt_ft", "gs_kt", "track_deg", "vrate_fpm", "on_ground", "squawk", "seen_at", "provider", "quality",
                "registration", "type_code", "category", "fetched_at");
    }

    @Test void unknownValues_areOmitted_neverZeroOrFalse() {
        for (AircraftJson.Encoding e : AircraftJson.Encoding.values()) {
            Map<String, Object> m = AircraftJson.encode(sparse(), e);
            assertThat(m).doesNotContainKeys("callsign", "alt_ft", "gs_kt", "track_deg", "vrate_fpm", "squawk", "registration", "type_code", "category");
            assertThat(m).containsKeys("hex", "lat", "lon", "seen_at", "provider", "on_ground");
        }
    }

    @Test void legacyEncodeSignature_mapsDetailAndWorld() {
        assertThat(AircraftJson.encode(full(), "full", false)).containsKey("registration");
        assertThat(AircraftJson.encode(full(), "lite", false)).doesNotContainKey("registration").containsKey("quality");
        assertThat(AircraftJson.encode(full(), "full", true)).doesNotContainKey("quality");
    }

    /** region·global 스냅샷 두 벌로 된 병합 뷰. */
    static SnapshotStore.View viewOf(Snapshot region, Snapshot global) {
        SnapshotStore store = new SnapshotStore();
        store.replace(region);
        store.replace(global);
        return store.view(T);
    }

    @Test void sources_staleThresholdsPerScope_andUnknownLagIsNull() {
        Instant now = T;
        Snapshot region = new Snapshot(1, "region", "adsb_fi", now.minusSeconds(61), now, "-", Map.of());
        Snapshot global = new Snapshot(2, "global", "opensky", now.minusSeconds(299), now, "-", Map.of());
        var s = AircraftJson.sources(viewOf(region, global), now);
        assertThat(s.region().stale()).isTrue();   // 지역 60 s 초과
        assertThat(s.global().stale()).isFalse();  // 전세계 300 s 이하
        assertThat(s.global().provider()).isEqualTo("opensky");
        var none = AircraftJson.source(Snapshot.empty("region"), now, 60);
        assertThat(none.lagS()).isNull();
        assertThat(none.fetchedAt()).isNull();
        assertThat(none.provider()).isNull();
        assertThat(none.stale()).isTrue();
    }
}
