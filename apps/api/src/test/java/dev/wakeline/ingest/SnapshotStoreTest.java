package dev.wakeline.ingest;

import dev.wakeline.domain.AircraftState;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 병합 뷰(계약 §1 · v2 §A3): 600 s 넘은 global 기체 제외 · 신선도 우선(DH-2, 같으면 region > focus > hot > global) · 시간 경과로도 다시 계산.
 * fetched_at 단조 교체(REL-8) · hot 셀별 90 s · focus hex 별 60 s · focus 임대 밖 제거.
 */
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

    static AircraftState at(String hex, double lat, double lon, Instant seenAt, String provider) {
        return new AircraftState(hex, null, null, null, null, lat, lon, 30000, 450.0, 90.0, 0.0, false, null, seenAt, provider, seenAt, 0, false);
    }

    static Snapshot scoped(SnapshotStore store, String scope, Instant fetchedAt, AircraftState... states) {
        Map<String, AircraftState> m = new java.util.HashMap<>();
        for (AircraftState a : states) m.put(a.hex(), a);
        return new Snapshot(store.nextVersion(), scope, "adsb_fi", fetchedAt, fetchedAt, "-", Map.copyOf(m));
    }

    @Test void merged_dropsGlobalOlderThan600s_newerSeenAtWins() {
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

    // ---- DH-2: 신선도 우선 병합 ----

    @Test void dh2_frozenRegion_freshGlobalWins_tieKeepsRegion() {
        SnapshotStore store = new SnapshotStore();
        AircraftState frozen = st("000001", NOW.minusSeconds(90), "adsb_fi");   // 관심 지역 피드가 90 s 전에 멈춤
        AircraftState fresh = st("000001", NOW.minusSeconds(20), "opensky");   // 전세계 피드는 계속 보고
        AircraftState tieR = st("000002", NOW.minusSeconds(5), "adsb_fi");
        AircraftState tieG = st("000002", NOW.minusSeconds(5), "opensky");
        store.replace(snap(store, "region", NOW.minusSeconds(90), frozen, tieR));
        store.replace(snap(store, "global", NOW.minusSeconds(20), fresh, tieG));
        SnapshotStore.View v = store.view(NOW);
        assertThat(v.states().get("000001")).isSameAs(fresh);
        assertThat(v.scopeOf("000001")).isEqualTo("global");
        assertThat(v.states().get("000002")).isSameAs(tieR); // 같은 seen_at → region
        assertThat(v.scopeOf("000002")).isEqualTo("region");
        assertThat(v.scopeOf("ffffff")).isNull();
    }

    @Test void priorityOnTie_regionThenFocusThenHotThenGlobal() {
        SnapshotStore store = new SnapshotStore();
        Instant t = NOW.minusSeconds(3);
        AircraftState f = at("0000aa", 36, 127, t, "adsb_fi"), h = at("0000aa", 36, 127, t, "adsb_fi"), g = at("0000aa", 36, 127, t, "opensky");
        store.replace(snap(store, "global", NOW, g));
        store.replaceHotIfNewer("35.5:139.5:150", scoped(store, "hot", NOW, h));
        assertThat(store.view(NOW).sourceOf("0000aa")).isEqualTo("hot:35.5:139.5:150");
        assertThat(store.view(NOW).scopeOf("0000aa")).isEqualTo("hot");
        assertThat(store.applyFocus(scoped(store, "focus", NOW, f))).isNotNull();
        assertThat(store.view(NOW).states().get("0000aa")).isSameAs(f);
        assertThat(store.view(NOW).scopeOf("0000aa")).isEqualTo("focus");
        AircraftState r = at("0000aa", 36, 127, t, "adsb_lol");
        store.replace(snap(store, "region", NOW, r));
        assertThat(store.view(NOW).states().get("0000aa")).isSameAs(r);
        // 더 새 관측이 오면 스코프와 무관하게 그것
        AircraftState newerHot = at("0000aa", 36.1, 127, NOW.minusSeconds(1), "adsb_fi");
        store.replaceHotIfNewer("35.5:139.5:150", scoped(store, "hot", NOW.plusSeconds(1), newerHot));
        assertThat(store.view(NOW.plusSeconds(1)).states().get("0000aa")).isSameAs(newerHot);
    }

    // ---- hot ----

    @Test void hot_perCellMonotonic_droppedAfter90s_viewVersionMoves() {
        SnapshotStore store = new SnapshotStore();
        String cell = "35.5:139.5:150";
        long v0 = store.view(NOW).version();
        Snapshot h1 = scoped(store, "hot", NOW, at("0000b1", 35.5, 139.5, NOW, "adsb_fi"));
        assertThat(store.replaceHotIfNewer(cell, h1).states()).isEmpty();      // 처음 → 빈 이전 스냅샷
        assertThat(store.replaceHotIfNewer(cell, scoped(store, "hot", NOW.minusSeconds(1)))).isNull(); // 오래됨
        assertThat(store.replaceHotIfNewer(cell, scoped(store, "hot", NOW))).isNull();                 // 같음
        Snapshot other = scoped(store, "hot", NOW.minusSeconds(30));
        assertThat(store.replaceHotIfNewer("36.0:140.0:50", other)).isNotNull(); // 셀별로 따로(다른 셀보다 오래되어도)
        SnapshotStore.View v = store.view(NOW.plusSeconds(10));
        assertThat(v.version()).isGreaterThan(v0);
        assertThat(v.states()).containsKey("0000b1");
        assertThat(v.recheckAtMs()).isEqualTo(NOW.minusSeconds(30).plusSeconds(90).toEpochMilli()); // 가장 이른 셀 만료
        assertThat(v.scopeVersion("hot")).isEqualTo(other.version()); // 마지막으로 받은 hot 메시지(부재 계수 표식)
        assertThat(v.scopeFetchedAt("hot")).isEqualTo(NOW);             // 가장 새 hot fetched_at(피드 끊김 판단)
        assertThat(store.view(NOW.plusSeconds(91)).states()).doesNotContainKey("0000b1"); // 마지막 메시지 뒤 90 s
        assertThat(store.hot()).containsKey(cell); // 메모리에서는 다음 쓰기 때 걷힌다
        store.replaceHotIfNewer("10.0:10.0:50", scoped(store, "hot", NOW.plusSeconds(200)));
        assertThat(store.hot()).containsOnlyKeys("10.0:10.0:50");
    }

    @Test void hot_cellCountIsBounded() {
        SnapshotStore store = new SnapshotStore();
        for (int i = 0; i < SnapshotStore.MAX_HOT_CELLS + 5; i++)
            store.replaceHotIfNewer(i + ".0:10.0:50", scoped(store, "hot", NOW.plusSeconds(i)));
        assertThat(store.hot()).hasSize(SnapshotStore.MAX_HOT_CELLS);
        assertThat(store.hot()).doesNotContainKey("0.0:10.0:50"); // 가장 오래된 것부터
    }

    // ---- focus ----

    @Test void focus_perHexMonotonic_expires60sAfterSeenAt() {
        SnapshotStore store = new SnapshotStore();
        AircraftState a1 = at("0000c1", 50, 10, NOW.minusSeconds(2), "adsb_fi");
        Snapshot prev = store.applyFocus(scoped(store, "focus", NOW, a1));
        assertThat(prev).isNotNull();
        assertThat(prev.states()).isEmpty();
        // 더 오래된 fetched_at · 더 오래된 seen_at 은 받지 않는다
        assertThat(store.applyFocus(scoped(store, "focus", NOW.minusSeconds(5), at("0000c1", 51, 10, NOW, "adsb_fi")))).isNull();
        assertThat(store.applyFocus(scoped(store, "focus", NOW.plusSeconds(5), at("0000c1", 51, 10, NOW.minusSeconds(10), "adsb_fi")))).isNull();
        AircraftState a2 = at("0000c1", 50.1, 10, NOW.plusSeconds(3), "adsb_fi");
        Snapshot p2 = store.applyFocus(scoped(store, "focus", NOW.plusSeconds(5), a2));
        assertThat(p2.states().get("0000c1")).isSameAs(a1);
        SnapshotStore.View v = store.view(NOW.plusSeconds(5));
        assertThat(v.states().get("0000c1")).isSameAs(a2);
        assertThat(v.scopeOf("0000c1")).isEqualTo("focus");
        assertThat(v.scopeFetchedAt("focus")).isEqualTo(NOW.plusSeconds(5));
        assertThat(store.view(NOW.plusSeconds(62)).states()).containsKey("0000c1");
        assertThat(store.view(NOW.plusSeconds(64)).states()).doesNotContainKey("0000c1"); // seen_at + 60 s
    }

    @Test void focus_leases_dropUnleasedAndIgnoreUnleasedMessages_coveringFollowsLeases() {
        SnapshotStore store = new SnapshotStore();
        store.applyFocus(scoped(store, "focus", NOW, at("0000d1", 50, 10, NOW, "adsb_fi"), at("0000d2", 51, 10, NOW, "adsb_fi")));
        SnapshotStore.View before = store.view(NOW);
        assertThat(before.covering("focus", "0000d1", NOW.toEpochMilli())).isTrue(); // 임대를 모르면 관측이 있는 동안
        assertThat(store.setLeases(Set.of(), Set.of("0000d1"))).isTrue();          // d2 선택 해제 → 바로 뺀다
        SnapshotStore.View v = store.view(NOW);
        assertThat(v.states()).containsKey("0000d1").doesNotContainKey("0000d2");
        assertThat(v.version()).isGreaterThan(before.version());
        assertThat(v.covering("focus", "0000d2", NOW.toEpochMilli())).isFalse();
        assertThat(v.covering("region", "0000d2", NOW.toEpochMilli())).isTrue();
        assertThat(v.covering(null, "0000d2", NOW.toEpochMilli())).isFalse();
        // 임대에 없는 hex 의 메시지는 실시간 상태에 넣지 않는다
        assertThat(store.applyFocus(scoped(store, "focus", NOW.plusSeconds(5), at("0000d2", 51, 10, NOW.plusSeconds(5), "adsb_fi")))).isNull();
        assertThat(store.setLeases(Set.of(), Set.of("0000d1"))).isFalse(); // 그대로 — 새 스코프 객체도 만들지 않는다
        assertThat(store.view(NOW)).isSameAs(v);
    }

    @Test void focus_countIsBounded_andExpiredPrunedOnWrite() {
        SnapshotStore store = new SnapshotStore();
        store.applyFocus(scoped(store, "focus", NOW, at("0000e0", 50, 10, NOW, "adsb_fi")));
        store.applyFocus(scoped(store, "focus", NOW.plusSeconds(120), at("0000e1", 50, 10, NOW.plusSeconds(120), "adsb_fi")));
        assertThat(store.focus()).containsOnlyKeys("0000e1"); // 120 s 전 관측은 걷혔다
        AircraftState[] many = new AircraftState[SnapshotStore.MAX_FOCUS + 10];
        for (int i = 0; i < many.length; i++) many[i] = at(String.format("%06x", 0x100 + i), 50, 10, NOW.plusSeconds(130 + i), "adsb_fi");
        store.applyFocus(scoped(store, "focus", NOW.plusSeconds(130), many));
        assertThat(store.focus()).hasSize(SnapshotStore.MAX_FOCUS);
    }

    @Test void hotCovering_followsLeaseAndExpiry() {
        SnapshotStore store = new SnapshotStore();
        String cell = "35.5:139.5:150";
        store.replaceHotIfNewer(cell, scoped(store, "hot", NOW, at("0000f1", 35.5, 139.5, NOW, "adsb_fi")));
        SnapshotStore.View v = store.view(NOW);
        assertThat(v.covering("hot:" + cell, "0000f1", NOW.toEpochMilli())).isTrue();
        assertThat(v.covering("hot:" + cell, "0000f1", NOW.plusSeconds(91).toEpochMilli())).isFalse();
        store.setLeases(Set.of(), Set.of());
        assertThat(store.view(NOW).covering("hot:" + cell, "0000f1", NOW.toEpochMilli())).isFalse(); // 셀 임대가 끝남
        assertThat(store.view(NOW).states()).containsKey("0000f1"); // 관측은 90 s 까지 남는다
        assertThat(v.covering("unknown", "0000f1", NOW.toEpochMilli())).isFalse();
    }

    @Test void wrongScopeForWriter_isRejected() {
        SnapshotStore store = new SnapshotStore();
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> store.replace(scoped(store, "hot", NOW))).isInstanceOf(IllegalArgumentException.class);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> store.replaceIfNewer(scoped(store, "focus", NOW))).isInstanceOf(IllegalArgumentException.class);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> store.replaceHotIfNewer("1.0:1.0:50", scoped(store, "region", NOW))).isInstanceOf(IllegalArgumentException.class);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> store.applyFocus(scoped(store, "hot", NOW))).isInstanceOf(IllegalArgumentException.class);
        assertThat(store.view(NOW).scopeVersion("nope")).isZero();
        assertThat(store.view(NOW).scopeFetchedAt("nope")).isEqualTo(Instant.EPOCH);
        assertThat(store.current("global")).isSameAs(store.global());
    }
}
