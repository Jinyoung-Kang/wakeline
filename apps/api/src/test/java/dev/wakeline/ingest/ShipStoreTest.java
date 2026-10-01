package dev.wakeline.ingest;

import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.AisScope;
import dev.wakeline.geo.Bbox;
import dev.wakeline.domain.ShipCategory;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** 선박 실시간 상태: MMSI 별 단조 반영, 정적 정보 결합, 상한, bbox 색인, 만료(얼림·공백 시간 제외), 공백 기록. */
class ShipStoreTest {
    static final Instant T = Instant.parse("2026-09-28T03:00:00Z");
    static final long NOW = T.toEpochMilli();

    static ShipState pos(String mmsi, double lat, double lon, Instant seen) {
        return new ShipState(mmsi, lat, lon, 12.3, 45.6, 44, 0, null, "epfs", seen, "aisstream", "PositionReport", "A");
    }

    static ShipStatic stat(String mmsi, String name, Integer type, Instant updated) {
        return new ShipStatic(mmsi, name, "CALL", 9123456, type, 100, 20, 10, 10, 7.5, "BUSAN", 9, 28, 12, 0, updated, "aisstream");
    }

    @Test void apply_newerOnly_perMmsi_andVersionBumpsOnlyOnChange() {
        ShipStore s = new ShipStore();
        ShipStore.Change c = s.apply(List.of(pos("440000001", 35, 129, T)), List.of(), T, "aisstream", NOW);
        assertThat(c.changed()).containsExactly("440000001");
        ShipStore.View v1 = s.view();
        assertThat(v1.version()).isEqualTo(1);
        assertThat(v1.fetchedAt()).isEqualTo(T);
        assertThat(v1.provider()).isEqualTo("aisstream");
        assertThat(v1.newestSeenAt()).isEqualTo(T);
        assertThat(v1.appliedAtMs()).isEqualTo(NOW);

        // 같은 보고(재전달)·더 오래된 보고(백로그)는 최신을 되돌리지 않고 버전도 올리지 않는다
        c = s.apply(List.of(pos("440000001", 35, 129, T), pos("440000001", 34, 128, T.minusSeconds(30))), List.of(), T.minusSeconds(5), "x", NOW + 1);
        assertThat(c.isEmpty()).isTrue();
        assertThat(s.view().version()).isEqualTo(1);
        assertThat(s.view().get("440000001").state().lat()).isEqualTo(35);
        assertThat(s.view().fetchedAt()).as("older envelope does not move fetched_at back").isEqualTo(T);
        assertThat(s.view().provider()).isEqualTo("aisstream");
        assertThat(s.view().appliedAtMs()).as("the pipeline is alive").isEqualTo(NOW + 1);

        c = s.apply(List.of(pos("440000001", 35.1, 129, T.plusSeconds(10))), List.of(), T.plusSeconds(10), "aisstream", NOW + 2);
        assertThat(c.changed()).containsExactly("440000001");
        assertThat(s.view().version()).isEqualTo(2);
        assertThat(v1.get("440000001").state().lat()).as("old view is immutable").isEqualTo(35);
    }

    @Test void statics_attachBeforeOrAfterPosition_olderIgnored() {
        ShipStore s = new ShipStore();
        // 정적 정보가 먼저(위치 없음 — 실시간 목록에는 없다)
        s.apply(List.of(), List.of(stat("440000002", "EARLY", 70, T)), T, "aisstream", NOW);
        assertThat(s.view().size()).isZero();
        assertThat(s.staticOf("440000002").name()).isEqualTo("EARLY");
        s.apply(List.of(pos("440000002", 35, 129, T)), List.of(), T, "aisstream", NOW);
        assertThat(s.view().get("440000002").stat().name()).isEqualTo("EARLY");
        assertThat(s.view().get("440000002").category()).isEqualTo(ShipCategory.CARGO);

        // 위치가 먼저인 선박에 나중 정적 정보 → 붙고 changed
        s.apply(List.of(pos("440000003", 35, 129, T)), List.of(), T, "aisstream", NOW);
        assertThat(s.view().get("440000003").stat()).isNull();
        assertThat(s.view().get("440000003").category()).as("no code → unknown").isEqualTo(ShipCategory.UNKNOWN);
        ShipStore.Change c = s.apply(List.of(), List.of(stat("440000003", "LATE", 80, T)), T, "aisstream", NOW);
        assertThat(c.changed()).containsExactly("440000003");
        assertThat(s.view().get("440000003").stat().name()).isEqualTo("LATE");

        // 더 오래된 정적 정보(updated_at)는 무시, 같은 내용은 바뀐 것으로 치지 않는다
        c = s.apply(List.of(), List.of(stat("440000003", "OLDER", 80, T.minusSeconds(60))), T, "aisstream", NOW);
        assertThat(c.isEmpty()).isTrue();
        assertThat(s.staticOf("440000003").name()).isEqualTo("LATE");
        c = s.apply(List.of(), List.of(stat("440000003", "LATE", 80, T)), T, "aisstream", NOW);
        assertThat(c.isEmpty()).isTrue();
        // 같은 메시지 안: 정적 정보가 먼저 반영되어 새 선박에 붙는다
        s.apply(List.of(pos("440000004", 35, 129, T)), List.of(stat("440000004", "SAME", 60, T)), T, "aisstream", NOW);
        assertThat(s.view().get("440000004").stat().name()).isEqualTo("SAME");
    }

    @Test void caps_andFutureTimestampsAreCounted() {
        ShipStore s = new ShipStore(2, 1);
        ShipStore.Change c = s.apply(List.of(pos("440000001", 1, 1, T), pos("440000002", 1, 1, T), pos("440000003", 1, 1, T),
                pos("440000004", 1, 1, T.plusSeconds(3600))), List.of(stat("440000001", "A", 70, T), stat("440000002", "B", 70, T)), T, "aisstream", NOW);
        assertThat(c.rejectedCap()).isEqualTo(2);    // 정적 정보 1 + 선박 1
        assertThat(c.rejectedFuture()).isEqualTo(1);
        assertThat(s.view().size()).isEqualTo(2);
        assertThat(s.staticCount()).isEqualTo(1);
        // 이미 있는 선박의 갱신은 상한과 무관하다
        c = s.apply(List.of(pos("440000001", 2, 2, T.plusSeconds(5))), List.of(), T, "aisstream", NOW);
        assertThat(c.changed()).containsExactly("440000001");
    }

    @Test void bboxIndex_matchesBruteForce() {
        ShipStore s = new ShipStore();
        Random r = new Random(7);
        List<ShipState> all = new ArrayList<>();
        for (int i = 0; i < 3000; i++)
            all.add(pos(String.format("%09d", 200_000_000 + i), -90 + r.nextDouble() * 180, -180 + r.nextDouble() * 360, T));
        all.add(pos("999999991", 90, 180, T));      // 모서리
        all.add(pos("999999992", -90, -180, T));
        all.add(pos("999999993", 35.0, 129.0, T));  // 경계 위(정수 좌표)
        s.apply(all, List.of(), T, "aisstream", NOW);
        ShipStore.View v = s.view();
        List<Bbox> boxes = new ArrayList<>(List.of(Bbox.world(), new Bbox(129, 35, 130, 36), new Bbox(170, 80, 180, 90), new Bbox(-180, -90, -170, -80)));
        for (int i = 0; i < 200; i++) {
            double lo = -180 + r.nextDouble() * 350, la = -90 + r.nextDouble() * 170;
            boxes.add(new Bbox(lo, la, Math.min(180, lo + r.nextDouble() * 60), Math.min(90, la + r.nextDouble() * 40)));
        }
        for (Bbox b : boxes) {
            Set<String> expected = new HashSet<>();
            for (ShipState x : all) if (b.contains(x.lat(), x.lon())) expected.add(x.mmsi());
            Set<String> got = new HashSet<>();
            v.forEachIn(b, sh -> got.add(sh.mmsi()));
            assertThat(got).as(b.toString()).isEqualTo(expected);
            assertThat(v.countIn(b, Integer.MAX_VALUE)).isEqualTo(expected.size());
            assertThat(v.countIn(b, 5)).isEqualTo(Math.min(5, expected.size()));
        }
    }

    @Test void expire_afterThirtyMinutesOfHealthyReception_frozenWhileInputDown() {
        ShipStore s = new ShipStore();
        s.apply(List.of(pos("440000001", 35, 129, T), pos("440000002", 35, 129, T.plusSeconds(20 * 60))),
                List.of(stat("440000001", "GONE", 70, T), stat("440000009", "ORPHAN", 70, T)), T, "aisstream", NOW + 20 * 60_000L);
        long now = NOW + 31 * 60_000L;
        assertThat(s.expire(now, true).isEmpty()).as("input down → frozen").isTrue();
        assertThat(s.view().size()).isEqualTo(2);
        ShipStore.Change c = s.expire(now, false);
        assertThat(c.removed()).containsExactly("440000001");
        assertThat(s.view().size()).isEqualTo(1);
        // 주인 없는 정적 정보는 받은 지 60분 뒤 정리(실시간 선박의 정적 정보는 남는다)
        s.expire(NOW + 81 * 60_000L, true);
        assertThat(s.staticOf("440000009")).isNull();
        assertThat(s.staticOf("440000001")).as("orphaned after expiry too").isNull();
    }

    @Test void expire_doesNotCountClosedGapTimeAsSilence() {
        ShipStore s = new ShipStore();
        s.apply(List.of(pos("440000001", 35, 129, T)), List.of(), T, "aisstream", NOW);
        // 보고 10분 뒤부터 25분 동안 수신 공백 → 35분이 지나도 수신 정상 시간은 10분
        s.addGap(new AisGap(T.plusSeconds(600), T.plusSeconds(600 + 25 * 60), "server closed (1006)", "aisstream"));
        assertThat(s.expire(NOW + 35 * 60_000L, false).isEmpty()).isTrue();
        // 수신 정상 시간이 30분을 넘으면 뺀다(공백 25분 + 31분)
        assertThat(s.expire(NOW + (25 + 31) * 60_000L, false).removed()).containsExactly("440000001");
    }

    @Test void gaps_dedupedSortedCappedAndPruned() {
        ShipStore s = new ShipStore();
        assertThat(s.lastGap()).isNull();
        assertThat(s.addGap(new AisGap(T.plusSeconds(100), T.plusSeconds(200), "b", "aisstream"))).isTrue();
        assertThat(s.addGap(new AisGap(T, T.plusSeconds(50), "a", "aisstream"))).isTrue();
        assertThat(s.addGap(new AisGap(T, T.plusSeconds(60), "dup", "aisstream"))).as("same start = same gap").isFalse();
        assertThat(s.addGap(new AisGap(T, null, "open", "aisstream"))).as("open gaps are not stored").isFalse();
        assertThat(s.addGap(null)).isFalse();
        assertThat(s.gaps()).extracting(AisGap::reason).containsExactly("a", "b");
        assertThat(s.lastGap().reason()).isEqualTo("b");
        for (int i = 0; i < ShipStore.MAX_GAPS + 5; i++) s.addGap(new AisGap(T.plusSeconds(1000 + i * 10L), T.plusSeconds(1005 + i * 10L), "g" + i, "aisstream"));
        assertThat(s.gaps()).hasSize(ShipStore.MAX_GAPS);
        s.expire(NOW + ShipStore.GAP_KEEP_MS + 7_200_000L, true);
        assertThat(s.gaps()).isEmpty();
    }

    static final AisScope AMERICAS = AisScope.parse("-90,-180,90,0"), ASIA_PACIFIC = AisScope.parse("-90,45,90,180");

    /** 계약 v4 §D: 멈춤은 그 구역 상자 안의 선박만 — 다른 구역·구역 밖 선박은 평소처럼 만료한다. */
    @Test void expire_freezesOnlyShipsInsideTheFrozenShards() {
        ShipStore s = new ShipStore();
        s.apply(List.of(pos("440000001", 35, 129, T), pos("366000001", 40, -70, T), pos("247000001", 45, 10, T)), List.of(), T, "aisstream", NOW);
        long now = NOW + 31 * 60_000L;
        ShipStore.Freeze asia = ShipStore.Freeze.of(List.of(ASIA_PACIFIC));
        assertThat(asia.any()).isTrue();
        assertThat(s.expire(now, asia).removed()).containsExactlyInAnyOrder("366000001", "247000001");
        assertThat(s.view().size()).isEqualTo(1);
        assertThat(s.expire(now, ShipStore.Freeze.ALL).isEmpty()).isTrue();
        assertThat(s.expire(now, ShipStore.Freeze.NONE).removed()).containsExactly("440000001");
        assertThat(ShipStore.Freeze.of(List.of())).isSameAs(ShipStore.Freeze.NONE);
        assertThat(ShipStore.Freeze.NONE.any()).isFalse();
        assertThat(ShipStore.Freeze.ALL.covers(0, 0)).isTrue();
    }

    /** 계약 v4 §D: 구역이 있는 끝난 공백은 그 구역 안 선박의 '보고 없음' 에서만 빼고, 구역 없는 공백(옛 기록)은 모두에서 뺀다. 겹치는 공백은 한 번만. */
    @Test void expire_closedGapTimeIsDiscountedOnlyInsideItsShard() {
        ShipStore s = new ShipStore();
        s.apply(List.of(pos("440000001", 35, 129, T), pos("366000001", 40, -70, T)), List.of(), T, "aisstream", NOW);
        s.addGap(new AisGap(T.plusSeconds(600), T.plusSeconds(600 + 25 * 60), "server closed (1006)", "aisstream", ASIA_PACIFIC));
        assertThat(s.expire(NOW + 35 * 60_000L, false).removed()).as("the Americas ship had no gap").containsExactly("366000001");
        assertThat(s.view().get("440000001")).isNotNull();

        ShipStore o = new ShipStore();
        o.apply(List.of(pos("440000001", 35, 129, T)), List.of(), T, "aisstream", NOW);
        // 같은 10분(600~1200 s)을 구역 공백과 구역 없는 공백이 함께 덮는다 → 한 번만 뺀다
        o.addGap(new AisGap(T.plusSeconds(600), T.plusSeconds(1200), "a", "aisstream", ASIA_PACIFIC));
        o.addGap(new AisGap(T.plusSeconds(900), T.plusSeconds(1200), "b", "aisstream"));
        assertThat(o.expire(NOW + 39 * 60_000L, false).isEmpty()).as("39 min − 10 min = 29 min").isTrue();
        assertThat(o.expire(NOW + 41 * 60_000L, false).removed()).as("41 min − 10 min = 31 min (not 26)").containsExactly("440000001");
        assertThat(ShipStore.downMs(List.of(), 0, 0, 0, 10)).isZero();
    }

    @Test void gaps_dedupedPerShard() {
        ShipStore s = new ShipStore();
        assertThat(s.addGap(new AisGap(T, T.plusSeconds(50), "am", "aisstream", AMERICAS))).isTrue();
        assertThat(s.addGap(new AisGap(T, T.plusSeconds(60), "ap", "aisstream", ASIA_PACIFIC))).as("another shard, same start").isTrue();
        assertThat(s.addGap(new AisGap(T, T.plusSeconds(70), "legacy", "aisstream"))).as("no scope is its own key").isTrue();
        assertThat(s.addGap(new AisGap(T, T.plusSeconds(55), "dup", "aisstream", AisScope.parse("-90,-180,90,0")))).isFalse();
        assertThat(s.addGap(new AisGap(T, T.plusSeconds(75), "dup", "aisstream"))).isFalse();
        assertThat(s.gaps()).hasSize(3);
    }

    @Test void gapOverlapAndBetween() {
        AisGap g = new AisGap(T.plusSeconds(10), T.plusSeconds(20), "r", "aisstream");
        assertThat(g.overlapMs(NOW, NOW + 15_000)).isEqualTo(5_000);
        assertThat(g.overlapMs(NOW + 30_000, NOW + 40_000)).isZero();
        assertThat(g.between(T, T.plusSeconds(11))).isTrue();
        assertThat(g.between(T.plusSeconds(20), T.plusSeconds(30))).isFalse();
        AisGap open = new AisGap(T.plusSeconds(10), null, "r", "aisstream");
        assertThat(open.overlapMs(NOW, NOW + 60_000)).isEqualTo(50_000);
        assertThat(open.between(T.plusSeconds(100), T.plusSeconds(200))).isTrue();
    }
}
