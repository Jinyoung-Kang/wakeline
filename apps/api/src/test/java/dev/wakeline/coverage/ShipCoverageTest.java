package dev.wakeline.coverage;

import dev.wakeline.domain.ShipState;
import dev.wakeline.ingest.IngestEvents;
import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import java.net.SocketTimeoutException;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
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

    /** 이 클래스의 로그(부트스트랩 멈춤 줄)를 모은다 — 시험이 끝나면 떼어 낸다. */
    static ListAppender<ILoggingEvent> captureLogs() {
        ListAppender<ILoggingEvent> app = new ListAppender<>();
        app.start();
        ((Logger) LoggerFactory.getLogger(ShipCoverage.class)).addAppender(app);
        return app;
    }

    static void release(ListAppender<ILoggingEvent> app) {
        ((Logger) LoggerFactory.getLogger(ShipCoverage.class)).detachAppender(app);
    }

    static List<ILoggingEvent> stopLines(ListAppender<ILoggingEvent> app) {
        return app.list.stream().filter(e -> e.getFormattedMessage().contains("bootstrap stopped")).toList();
    }

    static ShipCoverage coverage(FakeSource src, AtomicLong clock) {
        return new ShipCoverage(src, clock::get, new SimpleMeterRegistry(), 0, 100, 1_000);
    }

    @Test
    void liveReportsCountFromTheMinuteOfApiStart_olderOnesAreLeftToTheDbAndFutureOnesAreIgnored() {
        AtomicLong clock = new AtomicLong(START);
        ShipCoverage c = coverage(new FakeSource(), clock);
        assertThat(c.liveFromMs()).isEqualTo(CUT);
        c.onSampled(new IngestEvents.ShipsSampled(List.of(
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

    /**
     * 리뷰(2026-09-30): 멈춤 하나가 WARN 두 줄이었다(catch 에서 한 번, 끝에서 'stopped' · 'deadline' 으로 또 한 번) — 로그 화면([로그])에 같은 멈춤이 둘로 보였고,
     * api 를 다시 시작할 때마다(종료가 읽기를 깨움) WARN 이 떴다. 이제 결과마다 한 줄: 실패 · 마감은 WARN, 종료로 멈춤은 INFO(운영 동작이지 문제가 아니다). 수정 전 실패.
     */
    @Test
    void eachBootstrapOutcomeIsLoggedOnce_failuresAsWarn() {
        ListAppender<ILoggingEvent> logs = captureLogs();
        try {
            AtomicLong clock = new AtomicLong(START + 30_000);
            FakeSource src = new FakeSource();
            src.failAtRead = 3;
            src.readError = new SQLException("canceling statement due to statement timeout", "57014");
            coverage(src, clock).runBootstrap();
            assertThat(stopLines(logs)).hasSize(1);
            assertThat(stopLines(logs).getFirst().getLevel()).isEqualTo(Level.WARN);
            assertThat(stopLines(logs).getFirst().getFormattedMessage()).contains("statement_timeout").contains("SQLException").contains("3/25");
            logs.list.clear();
            FakeSource slow = new FakeSource();
            slow.onRead = () -> clock.addAndGet(ShipCoverage.BOOTSTRAP_DEADLINE_MS / 2 + 1);
            coverage(slow, clock).runBootstrap();
            assertThat(stopLines(logs)).hasSize(1);
            assertThat(stopLines(logs).getFirst().getLevel()).isEqualTo(Level.WARN);
            assertThat(stopLines(logs).getFirst().getFormattedMessage()).contains("deadline");
        } finally {
            release(logs);
        }
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
        c.onSampled(new IngestEvents.ShipsSampled(List.of(pos("440000002", 37.2, 126.2, START))));
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

    /**
     * 리뷰(2026-09-30): 60 s 가 지난 바로 뒤 동시에 온 요청들이 잠금 밖에서 '지났다'고 본 뒤 차례로 스냅숏을 다시 만들었다(칸 전부를 격자 잠금 안에서 정렬 —
     * 스트림 소비 스레드와 같은 잠금 · 요청마다 다른 ETag). 이제 잠금 안에서 다시 보고, 먼저 만든 것을 함께 쓴다. 시계로 순서를 정해 결정적으로 — 수정 전 실패.
     */
    @Test
    void requestsArrivingTogetherAfterExpiryShareOneRebuild() throws Exception {
        long t = START + 1_000 + ShipCoverage.SNAPSHOT_MS;
        CountDownLatch aInside = new CountDownLatch(1), bChecked = new CountDownLatch(1);
        Thread[] a = new Thread[1], b = new Thread[1];
        ThreadLocal<int[]> calls = ThreadLocal.withInitial(() -> new int[1]);
        AtomicLong base = new AtomicLong(START + 1_000);
        java.util.function.LongSupplier clock = () -> {
            int n = ++calls.get()[0];
            Thread me = Thread.currentThread();
            if (me == a[0] && n == 2) { // A 는 잠금 안(두 번째 시계) — B 가 잠금 밖에서 '지났다'고 볼 때까지 기다린다
                aInside.countDown();
                try { bChecked.await(5, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            }
            if (me == b[0] && n == 1) bChecked.countDown(); // B 는 이미 옛 스냅숏을 읽었다
            return base.get();
        };
        ShipCoverage c = new ShipCoverage(new FakeSource(), clock, new SimpleMeterRegistry(), 0, 100, 1_000);
        ShipCoverage.Snapshot old = c.snapshotNow();
        base.set(t);
        AtomicReference<ShipCoverage.Snapshot> ra = new AtomicReference<>(), rb = new AtomicReference<>();
        a[0] = new Thread(() -> ra.set(c.snapshot()));
        b[0] = new Thread(() -> rb.set(c.snapshot()));
        a[0].start();
        assertThat(aInside.await(5, TimeUnit.SECONDS)).isTrue();
        b[0].start();
        a[0].join(5_000);
        b[0].join(5_000);
        assertThat(ra.get()).isNotSameAs(old);
        assertThat(rb.get()).as("the second request uses the rebuild the first one made").isSameAs(ra.get());
    }

    /**
     * 리뷰(2026-09-30): 스냅숏이 격자를 복사한 뒤에 부트스트랩 상태를 읽었다 — 그 사이 부트스트랩이 한 시를 합치고 loaded_from 을 올리면 복사본에 없는 시까지
     * '셌다'(since · covered)고 말할 수 있었다. 이제 상태를 먼저 읽는다(합친 뒤에 올리므로 읽은 상태는 뒤의 복사본에 늘 들어 있다). 리뷰 2026-09-30 밤: 전의 시험은
     * 동시에 돌리며 바랐을 뿐이라(수정 전에도 대개 통과) 두 읽기 사이의 창구(beforeGridCopy)에서 부트스트랩이 한 시를 더 합치게 해 결정적으로 본다 — 두 읽기의
     * 순서를 되돌리면 '2시간을 셌다 · 칸에는 1시간' 으로 실패한다.
     */
    @Test
    void aSnapshotNeverClaimsHoursItsCellsDoNotHold_whileTheBootstrapRuns() throws Exception {
        AtomicLong clock = new AtomicLong(START + 40_000);
        FakeSource src = new FakeSource();
        CountDownLatch secondReading = new CountDownLatch(1), releaseSecond = new CountDownLatch(1);
        src.onRead = () -> {
            if (src.reads.size() != 2) return;
            secondReading.countDown();
            try { releaseSecond.await(5, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        };
        ShipCoverage c = new ShipCoverage(src, clock::get, new SimpleMeterRegistry(), 0, 100, 1_000, START);
        Thread boot = new Thread(c::runBootstrap);
        boot.start();
        assertThat(secondReading.await(5, TimeUnit.SECONDS)).isTrue(); // 첫 시를 합치고 1시간을 셌다고 적은 뒤, 둘째 시를 읽는 중
        c.beforeGridCopy = () -> { // 스냅숏이 한쪽을 읽은 뒤 다른 쪽을 읽기 전에 둘째 시를 합치고 적게 한다
            releaseSecond.countDown();
            long until = System.nanoTime() + Duration.ofSeconds(5).toNanos();
            while (c.bootstrapState().hoursLoaded() < 2 && System.nanoTime() < until) Thread.onSpinWait();
        };
        ShipCoverage.Snapshot s = c.snapshotNow();
        c.beforeGridCopy = () -> {};
        boot.join(5_000);
        int ships = s.cells().stream().mapToInt(CoverageGrid.CellView::ships).sum(); // 시 조각마다 서로 다른 선박 하나
        assertThat(c.bootstrapState().hoursLoaded()).as("the second hour was merged between the two reads").isGreaterThanOrEqualTo(2);
        assertThat(ships).as("%d hours claimed", s.bootstrap().hoursLoaded()).isGreaterThanOrEqualTo(s.bootstrap().hoursLoaded());
    }

    /**
     * 리뷰 2026-09-30 밤: 부트스트랩은 기동 30 s 뒤에 고정이라, 긴 정지 뒤 스트림 백로그(셈 시작 앞 보고)를 저장하는 데 30 s 넘게 걸리면 그 시를 읽은 뒤에 저장된
     * 행을 어디서도 세지 않았다(응답은 그래도 full). 이제 셈 시작 앞 보고가 10 s 동안 오지 않고, 그때까지 저장기 큐에 넣은 행이 모두 끝난 뒤에 읽는다(뒤따르는
     * 실시간 행은 기다리지 않는다) — 상한 grace + 300 s 뒤에는 WARN 한 줄과 함께 읽는다.
     */
    @Test
    void theBootstrapWaitsForTheStreamBacklogBeforeLiveFromToBeWritten_withAnUpperBound() {
        AtomicLong clock = new AtomicLong(START + 31_000), queued = new AtomicLong(), settled = new AtomicLong();
        ShipCoverage.WriterProgress w = new ShipCoverage.WriterProgress() {
            @Override public long enqueued() { return queued.get(); }

            @Override public long settled() { return settled.get(); }
        };
        ShipCoverage c = new ShipCoverage(new FakeSource(), clock::get, new SimpleMeterRegistry(), 30_000, 100, 1_000, START, w);
        assertThat(c.backlogWritten(START + 30_000)).as("no backlog seen, queue settled").isTrue();
        queued.set(500);
        settled.set(100);
        c.onSampled(new IngestEvents.ShipsSampled(List.of(pos("440000001", 37.2, 126.2, CUT - 1)))); // +31 s: 재시작 전 보고가 아직 온다
        assertThat(c.backlogWritten(START + 35_000)).as("reports before live_from still arriving").isFalse();
        queued.set(700);
        assertThat(c.backlogWritten(START + 41_000)).as("quiet for 10 s, rows up to 700 not written yet").isFalse();
        queued.set(900); // 실시간 행은 계속 온다 — 기다릴 번호는 조용해진 때의 700 이다
        settled.set(699);
        assertThat(c.backlogWritten(START + 42_000)).isFalse();
        settled.set(700);
        assertThat(c.backlogWritten(START + 43_000)).isTrue();

        ListAppender<ILoggingEvent> logs = captureLogs();
        try {
            clock.set(START + 31_000);
            ShipCoverage stuck = new ShipCoverage(new FakeSource(), clock::get, new SimpleMeterRegistry(), 30_000, 100, 1_000, START, w);
            settled.set(0);
            stuck.onSampled(new IngestEvents.ShipsSampled(List.of(pos("440000001", 37.2, 126.2, CUT - 1))));
            assertThat(stuck.backlogWritten(START + 30_000 + ShipCoverage.BACKLOG_WAIT_MAX_MS - 1)).isFalse();
            assertThat(stuck.backlogWritten(START + 30_000 + ShipCoverage.BACKLOG_WAIT_MAX_MS)).isTrue();
            assertThat(stuck.backlogWritten(START + 30_000 + ShipCoverage.BACKLOG_WAIT_MAX_MS + 1_000)).isTrue();
            List<ILoggingEvent> warn = logs.list.stream().filter(e -> e.getFormattedMessage().contains("still being written")).toList();
            assertThat(warn).hasSize(1);
            assertThat(warn.getFirst().getLevel()).isEqualTo(Level.WARN);
        } finally {
            release(logs);
        }
    }

    /**
     * 리뷰 2026-09-30 밤: 부트스트랩이 그 시를 다 읽은 뒤 도착한 셈 시작 앞 보고는 전에는 어디서도 세지 않았다. 저장기는 알린 뒤에 큐에 넣으므로 그 행은 그 읽기에
     * 없었다 — 실시간으로 센다(두 번 세지 않는다). 읽는 중인 시에 도착한 보고는 그 읽기에 있었는지 모르므로 세지 않고 '세지 못했을 수 있음'으로 센다.
     */
    @Test
    void aBacklogReportArrivingAfterItsHourWasReadIsCountedLive_andOneArrivingWhileItIsReadIsNamed() {
        AtomicLong clock = new AtomicLong(START + 40_000);
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        FakeSource src = new FakeSource();
        ShipCoverage[] holder = new ShipCoverage[1];
        src.onRead = () -> { // 둘째 시(08:00–09:00)를 읽는 동안 그 시의 보고가 도착한다
            if (src.reads.size() == 2) holder[0].onSampled(new IngestEvents.ShipsSampled(List.of(pos("440000077", 37.2, 126.2, HOUR0 - H + 5_000))));
        };
        ShipCoverage c = new ShipCoverage(src, clock::get, meters, 0, 100, 1_000, START);
        holder[0] = c;
        c.onSampled(new IngestEvents.ShipsSampled(List.of(pos("440000066", 37.2, 126.2, CUT - 1)))); // 부트스트랩 전 — 그 몫
        c.runBootstrap();
        ShipCoverage.Snapshot before = c.snapshotNow();
        c.onSampled(new IngestEvents.ShipsSampled(List.of(
                pos("440000088", 37.2, 126.2, CUT - 10_000),                  // 다 읽은 첫 시(09:00–09:37) — 늦게 저장된 백로그: 실시간으로 센다
                pos("440000099", 37.2, 126.2, before.windowFrom().toEpochMilli() - 1)))); // 창보다 오래됨 — 세지 않는다
        ShipCoverage.Snapshot after = c.snapshotNow();
        assertThat(after.cells().getFirst().ships()).isEqualTo(before.cells().getFirst().ships() + 1);
        assertThat(after.cells().getFirst().positions()).isEqualTo(before.cells().getFirst().positions() + 1);
        assertThat(meters.counter("wakeline_ship_coverage_late_counted_total").count()).isEqualTo(1.0);
        assertThat(meters.counter("wakeline_ship_coverage_ignored_total", "reason", "during_read").count()).isEqualTo(1.0);
        assertThat(meters.counter("wakeline_ship_coverage_ignored_total", "reason", "before_live").count()).isEqualTo(2.0);
        assertThat(after.covered()).isEqualTo("full");
    }

    @Test
    void capsAreCountedAndReported_notSilent() {
        AtomicLong clock = new AtomicLong(START);
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        ShipCoverage c = new ShipCoverage(new FakeSource(), clock::get, meters, 0, 1, 1_000);
        c.onSampled(new IngestEvents.ShipsSampled(List.of(pos("440000002", 37.2, 126.2, START), pos("440000003", 10.2, 10.2, START))));
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

    /** 종료가 읽는 중인 부트스트랩을 깨우면 한 줄(INFO) — 같은 멈춤을 WARN 두 줄로 적지 않는다(리뷰 2026-09-30, 수정 전 실패). */
    @Test
    void aBootstrapStoppedByShutdownIsOneInfoLine_notTwoWarnings() throws Exception {
        ListAppender<ILoggingEvent> logs = captureLogs();
        try {
            FakeSource src = new FakeSource();
            ShipCoverage[] holder = new ShipCoverage[1];
            src.failAtRead = 1;
            src.readError = new SQLException("An I/O error occurred while sending to the backend.", "08006");
            src.onRead = () -> { if (src.reads.size() == 2) holder[0].stop(); };
            ShipCoverage c = new ShipCoverage(src, System::currentTimeMillis, new SimpleMeterRegistry(), 0, 100, 1_000);
            holder[0] = c;
            c.start();
            long until = System.nanoTime() + Duration.ofSeconds(10).toNanos();
            while (!"failed".equals(c.snapshotNow().bootstrap().state()) && System.nanoTime() < until) Thread.sleep(20);
            Thread.sleep(50); // 상태를 쓴 뒤의 로그까지
            assertThat(stopLines(logs)).hasSize(1);
            assertThat(stopLines(logs).getFirst().getLevel()).isEqualTo(Level.INFO);
            assertThat(stopLines(logs).getFirst().getFormattedMessage()).contains("(stopped");
        } finally {
            release(logs);
        }
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
