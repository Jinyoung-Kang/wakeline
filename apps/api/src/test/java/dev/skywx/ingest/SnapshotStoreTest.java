package dev.skywx.ingest;

import dev.skywx.domain.AircraftState;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** 병합 뷰(계약 §1): 600 s 넘은 global 기체 제외 · region 우선 · 시간 경과로도 다시 계산. fetched_at 단조 교체(REL-8). */
class SnapshotStoreTest {
    static final Instant NOW = Instant.parse("2026-09-27T05:10:00Z");

    static AircraftState st(String hex, Instant seenAt, String provider) {
        return new AircraftState(hex, null, null, null, null, 36, 127, 30000, 450.0, 90.0, 0.0, false, null, seenAt, provider, seenAt, 0, false);
    }

    static Snapshot snap(SnapshotStore store, String scope, Instant fetchedAt, AircraftState... states) {
        Map<String, AircraftState> m = new java.util.HashMap<>();
        for (AircraftState a : states) m.put(a.hex(), a);
        return new Snapshot(store.nextVersion(), scope, scope.equals("global") ? "opensky" : "adsb_lol", fetchedAt, fetchedAt, "-", Map.copyOf(m));
    }

    @Test void merged_dropsGlobalOlderThan600s_regionWins() {
        SnapshotStore store = new SnapshotStore();
        AircraftState g1 = st("000001", NOW.minusSeconds(100), "opensky");
        AircraftState gOld = st("000002", NOW.minusSeconds(601), "opensky");
        AircraftState gDup = st("000003", NOW.minusSeconds(50), "opensky");
        AircraftState r = st("000003", NOW.minusSeconds(2), "adsb_lol");
        AircraftState rOld = st("000004", NOW.minusSeconds(3600), "adsb_lol"); // region 은 나이로 빼지 않는다(클라이언트가 stale 표시)
        store.replace(snap(store, "global", NOW.minusSeconds(60), g1, gOld, gDup));
        store.replace(snap(store, "region", NOW.minusSeconds(2), r, rOld));
        Map<String, AircraftState> m = store.merged(NOW);
        assertThat(m).containsOnlyKeys("000001", "000003", "000004");
        assertThat(m.get("000003")).isSameAs(r);
        assertThat(store.merged(NOW)).isSameAs(m); // 같은 스냅샷·같은 구간 → 캐시 재사용
    }

    @Test void merged_recomputedWhenGlobalAircraftAgeOutWithoutNewSnapshot() {
        SnapshotStore store = new SnapshotStore();
        store.replace(snap(store, "global", NOW, st("000001", NOW.minusSeconds(100), "opensky"), st("000002", NOW.minusSeconds(10), "opensky")));
        assertThat(store.merged(NOW)).containsOnlyKeys("000001", "000002");
        assertThat(store.merged(NOW.plusSeconds(499))).containsOnlyKeys("000001", "000002");
        assertThat(store.merged(NOW.plusSeconds(501))).containsOnlyKeys("000002"); // global 이 멈춰도(새 스냅샷 없음) 600 s 넘으면 빠진다
        assertThat(store.merged(NOW.plusSeconds(700))).isEmpty();
    }

    @Test void find_followsMergedRules() {
        SnapshotStore store = new SnapshotStore();
        store.replace(snap(store, "global", NOW, st("000001", NOW.minusSeconds(100), "opensky"), st("000002", Instant.now().minusSeconds(3600), "opensky")));
        assertThat(store.find("000002")).isNull();
        assertThat(store.find(null)).isNull();
    }

    @Test void replaceIfNewer_rejectsOlderAndEqualFetchedAt_perScope() {
        SnapshotStore store = new SnapshotStore();
        Snapshot r2 = snap(store, "region", NOW);
        assertThat(store.replaceIfNewer(r2)).isNotNull();
        assertThat(store.replaceIfNewer(snap(store, "region", NOW.minusSeconds(10)))).isNull();
        assertThat(store.replaceIfNewer(snap(store, "region", NOW))).isNull();
        assertThat(store.region()).isSameAs(r2);
        // 스코프별로 따로: global 은 region 보다 오래된 fetched_at 이어도 자기 현재값보다 새 것이면 받는다
        Snapshot g = snap(store, "global", NOW.minusSeconds(100));
        assertThat(store.replaceIfNewer(g)).isNotNull();
        assertThat(store.global()).isSameAs(g);
        Snapshot r3 = snap(store, "region", NOW.plusSeconds(10));
        assertThat(store.replaceIfNewer(r3)).isSameAs(r2);
    }
}
