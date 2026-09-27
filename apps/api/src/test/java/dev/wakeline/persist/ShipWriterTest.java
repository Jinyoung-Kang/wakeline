package dev.wakeline.persist;

import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.Receipt;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/** 선박 저장기(DB 없이): 60 s 창 줄이기·10분 last_seen, 정적 정보 중복 제거, 종료 뒤 행은 dropped, 재시도·영수증, 공백은 순서 큐로. */
class ShipWriterTest {
    static final Instant T = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.HOURS).minusSeconds(3600); // 창 경계(:00), 저장 범위 안

    static ShipState pos(String mmsi, Instant seen) {
        return new ShipState(mmsi, 35, 129, 10.0, 90.0, 90, 0, null, "gnss", seen, "aisstream", "PositionReport", "A");
    }

    static ShipStatic stat(String mmsi, Instant updated) {
        return new ShipStatic(mmsi, "N", null, null, 70, null, null, null, null, null, null, null, null, null, null, updated, "aisstream");
    }

    /** 쓰기를 기록하는(또는 실패하는) 저장소. */
    static final class FakeRepo extends ShipRepository {
        final List<ShipState> positions = new CopyOnWriteArrayList<>();
        final List<ShipState> touched = new CopyOnWriteArrayList<>();
        final List<StaticRow> statics = new CopyOnWriteArrayList<>();
        final List<AisGap> gaps = new CopyOnWriteArrayList<>();
        volatile RuntimeException fail;
        final AtomicInteger attempts = new AtomicInteger();

        FakeRepo() { super(null, null); }

        /** 배치의 첫 쓰기(정적 정보)에서 실패한다 — DB 장애면 배치 전체가 실패하는 것과 같다. */
        @Override public void upsertStatics(List<StaticRow> rows) {
            attempts.incrementAndGet();
            if (fail != null) throw fail;
            statics.addAll(rows);
        }
        @Override public void writePositions(List<ShipState> rows) { positions.addAll(rows); }
        @Override public void touch(java.util.Collection<ShipState> rows) { touched.addAll(rows); }
        @Override public boolean insertGap(AisGap g) { gaps.add(g); return true; }
    }

    @Test void select_keepsFirstFixPerSixtySecondWindow_touchesEveryTenMinutes_dedupesStatics() {
        FakeRepo repo = new FakeRepo();
        ShipWriter w = new ShipWriter(repo, null, new SimpleMeterRegistry(), 1, 1);
        List<ShipWriter.Item> a = w.select(List.of(pos("440000001", T.plusSeconds(5)), pos("440000002", T.plusSeconds(59))),
                List.of(stat("440000001", T), stat("440000002", T)), T.plusSeconds(60));
        assertThat(a).hasSize(4);
        assertThat(a.stream().filter(i -> i instanceof ShipWriter.Pos p && p.touch()).count()).as("first sight touches ship.last_seen").isEqualTo(2);
        // 같은 창의 뒤 보고·더 이전 보고(백로그)는 버린다, 새 창은 받아들인다(10분 창 안이면 touch 없음)
        List<ShipWriter.Item> b = w.select(List.of(pos("440000001", T.plusSeconds(40)), pos("440000001", T.minusSeconds(30)), pos("440000002", T.plusSeconds(61))),
                List.of(stat("440000001", T)), T.plusSeconds(70));
        assertThat(b).hasSize(1);
        ShipWriter.Pos kept = (ShipWriter.Pos) b.getFirst();
        assertThat(kept.state().mmsi()).isEqualTo("440000002");
        assertThat(kept.touch()).isFalse();
        // 10분 창이 바뀌면 다시 touch, 새 정적 정보(updated_at 이 더 새것)는 다시 쓴다
        List<ShipWriter.Item> c = w.select(List.of(pos("440000002", T.plusSeconds(601))), List.of(stat("440000001", T.plusSeconds(300))), null);
        assertThat(c).hasSize(2);
        assertThat(c.stream().filter(i -> i instanceof ShipWriter.Pos p && p.touch()).count()).isEqualTo(1);
        ShipWriter.Stat s = (ShipWriter.Stat) c.getFirst();
        assertThat(s.receivedAt()).as("no envelope time → the static's own time").isEqualTo(T.plusSeconds(300));
    }

    @Test void reportsOutsideTheStoredRangeAreSkippedAndCounted() {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        ShipWriter w = new ShipWriter(new FakeRepo(), null, meters, 1, 1);
        Instant now = Instant.now();
        List<ShipWriter.Item> out = w.select(List.of(pos("440000001", now.minusSeconds(2 * 86_400)), pos("440000002", now.plusSeconds(3600)),
                pos("440000003", now.minusSeconds(30))), List.of(), now);
        assertThat(out).hasSize(1);
        assertThat(meters.find("wakeline_ship_rows_total").tag("result", "out_of_range").counter().count()).isEqualTo(2);
    }

    @Test void writesInOrder_retriesTransientFailures_andReleasesReceiptsAfterCommit() throws Exception {
        FakeRepo repo = new FakeRepo();
        ShipWriter w = new ShipWriter(repo, null, new SimpleMeterRegistry(), 5, 20);
        w.start();
        try {
            repo.fail = new org.springframework.dao.DataAccessResourceFailureException("db down");
            AtomicInteger acked = new AtomicInteger();
            Receipt r = new Receipt(acked::incrementAndGet);
            w.onShips(new IngestEvents.ShipsUpdated(T, "aisstream", List.of(pos("440000001", T), pos("440000002", T)), List.of(stat("440000001", T)),
                    Set.of(), Set.of(), r));
            r.release();
            long end = System.currentTimeMillis() + 5_000;
            while (repo.attempts.get() < 2 && System.currentTimeMillis() < end) Thread.sleep(5);
            assertThat(acked.get()).as("not durable yet — no ACK").isZero();
            repo.fail = null;
            while (acked.get() == 0 && System.currentTimeMillis() < end) Thread.sleep(5);
            assertThat(acked.get()).isEqualTo(1);
            assertThat(repo.positions).hasSize(2);
            assertThat(repo.statics).hasSize(1);
            assertThat(repo.touched).hasSize(2);
            // 만료·부트스트랩 이벤트(보고 없음)는 저장하지 않는다
            w.onShips(IngestEvents.ShipsUpdated.liveOnly(Set.of("440000001"), Set.of()));
            assertThat(w.queued()).isZero();
        } finally {
            w.stop();
        }
        // 종료 뒤 온 행은 쓸 스레드가 없다 — dropped
        w.enqueue(List.of(new ShipWriter.Pos(pos("440000009", T), false)), Receipt.NONE);
        assertThat(w.queued()).isZero();
    }

    @Test void permanentFailure_dropsTheBatchAfterThreeAttempts_andAcks() throws Exception {
        FakeRepo repo = new FakeRepo();
        ShipWriter w = new ShipWriter(repo, null, new SimpleMeterRegistry(), 1, 2);
        repo.fail = new org.springframework.dao.DataIntegrityViolationException("x", new java.sql.SQLException("no partition", "23514"));
        w.start();
        try {
            AtomicInteger acked = new AtomicInteger();
            Receipt r = new Receipt(acked::incrementAndGet);
            w.enqueue(List.of(new ShipWriter.Pos(pos("440000001", T), true)), r);
            r.release();
            long end = System.currentTimeMillis() + 5_000;
            while (acked.get() == 0 && System.currentTimeMillis() < end) Thread.sleep(5);
            assertThat(acked.get()).isEqualTo(1);
            assertThat(repo.attempts.get()).isEqualTo(ShipWriter.PERMANENT_ATTEMPTS);
        } finally {
            w.stop();
        }
    }

    @Test void shutdownFlushWritesWhatIsLeft() {
        FakeRepo repo = new FakeRepo();
        ShipWriter w = new ShipWriter(repo, null, new SimpleMeterRegistry(), 1, 1);
        // 워커 없이(시작 전 큐에 넣을 수 없으므로 running 만 켠 상태를 흉내): start 후 즉시 stop 경로로 flush 확인
        w.start();
        List<ShipWriter.Item> items = new ArrayList<>();
        for (int i = 0; i < 5; i++) items.add(new ShipWriter.Pos(pos(String.format("4400000%02d", i), T), false));
        AtomicInteger acked = new AtomicInteger();
        Receipt r = new Receipt(acked::incrementAndGet);
        w.enqueue(items, r);
        r.release();
        w.stop();
        assertThat(repo.positions).hasSize(5);
        assertThat(acked.get()).isEqualTo(1);
        assertThat(w.pendingMarks()).isZero();
    }

    @Test void gapsGoThroughTheOrderedWriterWithTheReceipt() {
        FakeRepo repo = new FakeRepo();
        OrderedWriter ordered = new OrderedWriter(new SimpleMeterRegistry(), 1, 1);
        ShipWriter w = new ShipWriter(repo, ordered, new SimpleMeterRegistry(), 1, 1);
        AtomicInteger acked = new AtomicInteger();
        Receipt r = new Receipt(acked::incrementAndGet);
        w.onGap(new IngestEvents.AisGapReceived(new AisGap(T, T.plusSeconds(60), "server closed (1006)", "aisstream"), r));
        r.release();
        assertThat(acked.get()).isZero();
        assertThat(ordered.drainNow()).isEqualTo(1);
        assertThat(repo.gaps).hasSize(1);
        assertThat(acked.get()).isEqualTo(1);
    }
}
