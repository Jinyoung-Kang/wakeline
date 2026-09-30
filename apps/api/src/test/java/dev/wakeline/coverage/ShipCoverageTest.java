package dev.wakeline.coverage;

import dev.wakeline.domain.ShipState;
import dev.wakeline.persist.ShipWriter;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.net.SocketTimeoutException;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 관측 수신 범위(ADR-027 · 계약 v5 §G27)의 주인: 실시간 셈(저장기가 고른 60 s 표본 — 셈 시작 시각 이전 보고는 부트스트랩 몫), 기동 때 한 번의 DB 부트스트랩
 * (가장 최근 시부터 거꾸로 · 시 하나에 문장 하나 · 멈추면 이어진 부분까지만 '덮음'), 응답 스냅숏(창 · since · 덮음 상태 · 캐시). 시계 · DB 는 가짜.
 */
class ShipCoverageTest {
    static final long H = CoverageGrid.HOUR_MS;
    /** api 시작: 2026-09-30 09:37:25.500Z → 셈 시작(live_from) = 09:37:00Z(60 s 창의 시작으로 내림) */
    static final long START = Instant.parse("2026-09-30T09:37:25.500Z").toEpochMilli();
    static final long CUT = Instant.parse("2026-09-30T09:37:00Z").toEpochMilli();
    static final long HOUR0 = Instant.parse("2026-09-30T09:00:00Z").toEpochMilli();

    static ShipState pos(String mmsi, double lat, double lon, long seenMs) {
        return new ShipState(mmsi, lat, lon, 10.0, 90.0, 90, 0, null, "epfs", Instant.ofEpochMilli(seenMs), "aisstream", "PositionReport", "A");
    }

    /** 시 조각마다 주어진 행을 주는(또는 n 번째 조각에서 실패하는) 가짜 DB. */
    static final class FakeSource implements CoverageSource {
        final List<long[]> reads = new ArrayList<>();
        final AtomicInteger opened = new AtomicInteger();
        final AtomicInteger closed = new AtomicInteger();
        volatile SQLException openError;
        volatile int failAtRead = -1;
        volatile SQLException readError;
        volatile Runnable onRead = () -> {};

        @Override
        public Session open() throws SQLException {
            if (openError != null) throw openError;
            opened.incrementAndGet();
            return new Session() {
                @Override
                public void read(long fromMs, long toMs, Consumer<Row> sink) throws SQLException {
                    reads.add(new long[]{fromMs, toMs});
                    onRead.run();
                    if (reads.size() - 1 == failAtRead) throw readError;
                    // 조각마다: 인천 앞바다 칸(126.0 · 37.0 → 색인 252 · 74)에 선박 하나(조각 시작 + 1 s 마지막 보고, 위치 3)
                    sink.accept(new Row(252, 74, 440_000_000 + reads.size(), 3, fromMs + 1_000));
                }

                @Override
                public void close() { closed.incrementAndGet(); }
            };
        }
    }

    static ShipCoverage coverage(FakeSource src, AtomicLong clock) {
        return new ShipCoverage(src, clock::get, new SimpleMeterRegistry(), 0, 100, 1_000);
    }

    @Test
    void liveReportsCountFromTheMinuteOfApiStart_olderOnesAreLeftToTheDbAndFutureOnesAreIgnored() {
        AtomicLong clock = new AtomicLong(START);
        ShipCoverage c = coverage(new FakeSource(), clock);
        assertThat(c.liveFromMs()).isEqualTo(CUT);
        c.onSampled(new ShipWriter.Sampled(List.of(
                pos("440000001", 37.2, 126.2, CUT - 1),                   // 재시작 전 백로그 — DB 몫(두 번 세지 않는다)
                pos("440000002", 37.2, 126.2, CUT),                       // 셈 시작의 첫 순간
                pos("440000003", 37.2, 126.2, START + 6 * 60_000),        // 5분 넘게 미래 — 세지 않는다
                pos("ABC", 37.2, 126.2, START))));                        // MMSI 모양이 아님 — 세지 않는다(수집기가 이미 막는 값)
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.cells()).hasSize(1);
        assertThat(s.cells().getFirst().ships()).isEqualTo(1);
        assertThat(s.cells().getFirst().positions()).isEqualTo(1);
        assertThat(s.cells().getFirst().lastSeenMs()).isEqualTo(CUT);
        assertThat(s.provider()).isEqualTo("aisstream");
        assertThat(s.newestSeen()).isEqualTo(Instant.ofEpochMilli(CUT));
    }

    @Test
    void beforeTheBootstrapTheWindowIsCoveredOnlySinceApiStart_andSaysSo() {
        AtomicLong clock = new AtomicLong(START);
        ShipCoverage c = coverage(new FakeSource(), clock);
        clock.set(START + 5_000);
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.windowFrom()).isEqualTo(Instant.ofEpochMilli(HOUR0 - 24 * H));
        assertThat(s.generatedAt()).isEqualTo(Instant.ofEpochMilli(START + 5_000));
        assertThat(s.since()).isEqualTo(Instant.ofEpochMilli(CUT));
        assertThat(s.covered()).isEqualTo("since_api_start");
        assertThat(s.bootstrap().state()).isEqualTo("pending");
        assertThat(s.apiStartedAt()).isEqualTo(Instant.ofEpochMilli(START));
        assertThat(s.liveFrom()).isEqualTo(Instant.ofEpochMilli(CUT));
        assertThat(s.cells()).isEmpty();
        assertThat(s.newestSeen()).isNull();
        // 창이 지나 api 시작이 창보다 앞서면 부트스트랩 없이도 창 전체를 덮는다(지어내지 않고 — 셈이 그만큼 이어졌다)
        clock.set(CUT + 26 * H);
        ShipCoverage.Snapshot later = c.snapshotNow();
        assertThat(later.covered()).isEqualTo("full");
        assertThat(later.since()).isEqualTo(later.windowFrom());
    }

    @Test
    void theBootstrapReadsNewestHourFirst_oneStatementPerHour_upToTheLiveCut_andThenTheWholeWindowIsCovered() {
        AtomicLong clock = new AtomicLong(START + 30_000);
        FakeSource src = new FakeSource();
        ShipCoverage c = coverage(src, clock);
        c.runBootstrap();
        assertThat(src.opened.get()).isEqualTo(1);
        assertThat(src.closed.get()).as("the connection is closed after the bootstrap").isEqualTo(1);
        assertThat(src.reads).hasSize(25);
        assertThat(src.reads.getFirst()).as("the current hour up to the cut first").containsExactly(HOUR0, CUT);
        assertThat(src.reads.get(1)).containsExactly(HOUR0 - H, HOUR0);
        assertThat(src.reads.getLast()).as("the oldest hour of the window last").containsExactly(HOUR0 - 24 * H, HOUR0 - 23 * H);
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("done");
        assertThat(s.bootstrap().hoursLoaded()).isEqualTo(25);
        assertThat(s.bootstrap().hoursTotal()).isEqualTo(25);
        assertThat(s.bootstrap().rows()).isEqualTo(25);
        assertThat(s.bootstrap().finishedAt()).isEqualTo(Instant.ofEpochMilli(START + 30_000));
        assertThat(s.covered()).isEqualTo("full");
        assertThat(s.since()).isEqualTo(s.windowFrom());
        assertThat(s.cells()).hasSize(1);
        assertThat(s.cells().getFirst().ships()).isEqualTo(25);
        assertThat(s.cells().getFirst().positions()).isEqualTo(75);
        assertThat(s.positions()).isEqualTo(75);
        assertThat(s.cells().getFirst().lastSeenMs()).as("the newest bootstrap row").isEqualTo(HOUR0 + 1_000);
    }

    @Test
    void whenTheApiStartsOnAnHourBoundaryThereIsNoEmptyFirstChunk() {
        long start = HOUR0 + 20; // 09:00:00.020 → 셈 시작 09:00:00
        AtomicLong clock = new AtomicLong(start + 30_000);
        FakeSource src = new FakeSource();
        ShipCoverage c = new ShipCoverage(src, clock::get, new SimpleMeterRegistry(), 0, 100, 1_000, start);
        c.runBootstrap();
        assertThat(src.reads).hasSize(24);
        assertThat(src.reads.getFirst()).containsExactly(HOUR0 - H, HOUR0);
        assertThat(c.snapshotNow().covered()).as("24 whole hours + the live part cover the 25-bucket window").isEqualTo("full");
    }

    @Test
    void aStatementTimeoutStopsTheBootstrap_theContiguousPartBackFromTheCutIsCovered_andTheKindIsNamed() {
        AtomicLong clock = new AtomicLong(START + 30_000);
        FakeSource src = new FakeSource();
        src.failAtRead = 3;
        src.readError = new SQLException("canceling statement due to statement timeout", "57014");
        ShipCoverage c = coverage(src, clock);
        c.runBootstrap();
        assertThat(src.reads).hasSize(4);
        assertThat(src.closed.get()).isEqualTo(1);
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("failed");
        assertThat(s.bootstrap().error()).isEqualTo("statement_timeout");
        assertThat(s.bootstrap().hoursLoaded()).isEqualTo(3);
        assertThat(s.covered()).isEqualTo("partial");
        assertThat(s.since()).as("current hour + two whole hours before it").isEqualTo(Instant.ofEpochMilli(HOUR0 - 2 * H));
        assertThat(s.bootstrap().loadedFrom()).isEqualTo(Instant.ofEpochMilli(HOUR0 - 2 * H));
    }

    @Test
    void errorKindsAreNamedWithoutServerText() {
        assertThat(ShipCoverage.errorKind(new SQLException("x", "08001"))).isEqualTo("connection");
        assertThat(ShipCoverage.errorKind(new SQLException("An I/O error occurred", "08006", new SocketTimeoutException("Read timed out")))).isEqualTo("read_timeout");
        assertThat(ShipCoverage.errorKind(new SQLException("permission denied for table ship_position", "42501"))).isEqualTo("error");
        assertThat(ShipCoverage.errorKind(new IllegalStateException("boom"))).isEqualTo("error");
        assertThat(ShipCoverage.errorKind(new SQLException("no state"))).isEqualTo("error");
    }

    @Test
    void aConnectionFailureLeavesTheWindowCoveredOnlySinceApiStart() {
        AtomicLong clock = new AtomicLong(START + 30_000);
        FakeSource src = new FakeSource();
        src.openError = new SQLException("Connection refused", "08001");
        ShipCoverage c = coverage(src, clock);
        c.runBootstrap();
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("failed");
        assertThat(s.bootstrap().error()).isEqualTo("connection");
        assertThat(s.bootstrap().hoursLoaded()).isZero();
        assertThat(s.covered()).isEqualTo("since_api_start");
        assertThat(s.since()).isEqualTo(Instant.ofEpochMilli(CUT));
    }

    @Test
    void theDeadlineStopsBetweenHours_andTheStateSaysDeadline() {
        AtomicLong clock = new AtomicLong(START + 30_000);
        FakeSource src = new FakeSource();
        src.onRead = () -> clock.addAndGet(ShipCoverage.BOOTSTRAP_DEADLINE_MS / 2 + 1); // 조각마다 마감의 절반 넘게 걸린다
        ShipCoverage c = coverage(src, clock);
        c.runBootstrap();
        assertThat(src.reads).hasSize(2);
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("failed");
        assertThat(s.bootstrap().error()).isEqualTo("deadline");
        assertThat(s.bootstrap().hoursLoaded()).isEqualTo(2);
        assertThat(s.covered()).isEqualTo("partial");
    }

    @Test
    void theSnapshotIsCachedForSixtySeconds_andTheEtagFollowsTheSnapshot() {
        AtomicLong clock = new AtomicLong(START + 1_000);
        ShipCoverage c = coverage(new FakeSource(), clock);
        ShipCoverage.Snapshot a = c.snapshot();
        c.onSampled(new ShipWriter.Sampled(List.of(pos("440000002", 37.2, 126.2, START))));
        clock.addAndGet(ShipCoverage.SNAPSHOT_MS - 1);
        ShipCoverage.Snapshot b = c.snapshot();
        assertThat(b).as("same snapshot within 60 s").isSameAs(a);
        assertThat(b.cells()).isEmpty();
        clock.addAndGet(1);
        ShipCoverage.Snapshot d = c.snapshot();
        assertThat(d).isNotSameAs(a);
        assertThat(d.cells()).hasSize(1);
        assertThat(d.etag()).isNotEqualTo(a.etag()).startsWith("\"o").endsWith("\"");
    }

    @Test
    void capsAreCountedAndReported_notSilent() {
        AtomicLong clock = new AtomicLong(START);
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        ShipCoverage c = new ShipCoverage(new FakeSource(), clock::get, meters, 0, 1, 1_000);
        c.onSampled(new ShipWriter.Sampled(List.of(pos("440000002", 37.2, 126.2, START), pos("440000003", 10.2, 10.2, START))));
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.dropped()).isEqualTo(1);
        assertThat(s.maxCells()).isEqualTo(1);
        assertThat(s.maxShipCells()).isEqualTo(1_000);
        assertThat(meters.counter("wakeline_ship_coverage_dropped_total", "reason", "cells").count()).isEqualTo(1.0);
        assertThat(meters.get("wakeline_ship_coverage_cells").gauge().value()).isEqualTo(1.0);
        assertThat(meters.get("wakeline_ship_coverage_ship_cells").gauge().value()).isEqualTo(1.0);
    }

    @Test
    void theLifecycleRunsTheBootstrapOnceAfterTheGrace_offTheCallerThread() throws Exception {
        FakeSource src = new FakeSource();
        ShipCoverage c = new ShipCoverage(src, System::currentTimeMillis, new SimpleMeterRegistry(), 0, 100, 1_000);
        assertThat(c.isRunning()).isFalse();
        c.start();
        assertThat(c.isRunning()).isTrue();
        long until = System.nanoTime() + Duration.ofSeconds(10).toNanos();
        while (!"done".equals(c.snapshotNow().bootstrap().state()) && System.nanoTime() < until) Thread.sleep(20);
        assertThat(c.snapshotNow().bootstrap().state()).isEqualTo("done");
        assertThat(src.opened.get()).isEqualTo(1);
        c.stop();
        assertThat(c.isRunning()).isFalse();
    }

    @Test
    void stoppingWhileReadingStopsBeforeTheNextHour_andSaysStopped() throws Exception {
        FakeSource src = new FakeSource();
        ShipCoverage[] holder = new ShipCoverage[1];
        src.onRead = () -> { if (src.reads.size() == 2) holder[0].stop(); };
        ShipCoverage c = new ShipCoverage(src, System::currentTimeMillis, new SimpleMeterRegistry(), 0, 100, 1_000);
        holder[0] = c;
        c.start();
        long until = System.nanoTime() + Duration.ofSeconds(10).toNanos();
        while (!"failed".equals(c.snapshotNow().bootstrap().state()) && System.nanoTime() < until) Thread.sleep(20);
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("failed");
        assertThat(s.bootstrap().error()).isEqualTo("stopped");
        assertThat(s.bootstrap().hoursLoaded()).isEqualTo(2);
        assertThat(src.closed.get()).isEqualTo(1);
    }

    @Test
    void aReadFailingBecauseOfStopIsNamedStopped_notAConnectionError() throws Exception {
        FakeSource src = new FakeSource();
        ShipCoverage[] holder = new ShipCoverage[1];
        src.failAtRead = 1;
        src.readError = new SQLException("An I/O error occurred while sending to the backend.", "08006");
        src.onRead = () -> { if (src.reads.size() == 2) holder[0].stop(); }; // 종료가 읽는 중인 스레드를 깨워 소켓이 닫힌 것처럼
        ShipCoverage c = new ShipCoverage(src, System::currentTimeMillis, new SimpleMeterRegistry(), 0, 100, 1_000);
        holder[0] = c;
        c.start();
        long until = System.nanoTime() + Duration.ofSeconds(10).toNanos();
        while (!"failed".equals(c.snapshotNow().bootstrap().state()) && System.nanoTime() < until) Thread.sleep(20);
        assertThat(c.snapshotNow().bootstrap().error()).isEqualTo("stopped");
        assertThat(c.snapshotNow().bootstrap().hoursLoaded()).isEqualTo(1);
    }

    @Test
    void stoppingBeforeTheGraceEndsSkipsTheBootstrap() throws Exception {
        FakeSource src = new FakeSource();
        ShipCoverage c = new ShipCoverage(src, System::currentTimeMillis, new SimpleMeterRegistry(), 60_000, 100, 1_000);
        c.start();
        c.stop();
        Thread.sleep(100);
        assertThat(src.opened.get()).isZero();
        assertThat(c.snapshotNow().bootstrap().state()).isEqualTo("pending");
    }
}
