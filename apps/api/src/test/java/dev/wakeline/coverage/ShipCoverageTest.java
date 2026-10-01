package dev.wakeline.coverage;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import dev.wakeline.ships.core.ShipEvents;
import dev.wakeline.ships.core.ShipState;
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
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 관측 수신 범위(ADR-027 · 계약 v5 §G27)의 주인: 실시간 셈(저장기가 고른 60 s 표본 — 셈 시작 시각 이전 보고는 부트스트랩 몫), 기동 때 한 번의 DB 부트스트랩
 * (가장 최근 시부터 거꾸로 · 시 하나에 문장 하나 · 못 읽은 시는 나중에 다시 읽고 그동안 나머지를 이어 읽음 · 이어진 부분까지만 '덮음'), 응답 스냅숏(창 · since ·
 * 덮음 상태 · 빈 시 · 캐시). 시계 · DB · 기다림(sleeper)은 가짜.
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
        /** 이 시각에 시작하는 조각은 읽을 때마다 실패한다(readError) — Long.MIN_VALUE 면 없음. */
        volatile long failFrom = Long.MIN_VALUE;
        /** 이 조건에 맞는 시각에 시작하는 조각은 읽을 때마다 실패한다(readError). */
        volatile java.util.function.LongPredicate failIf = from -> false;
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
                    if (reads.size() - 1 == failAtRead || fromMs == failFrom || failIf.test(fromMs)) throw readError;
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
        ShipCoverage c = new ShipCoverage(src, clock::get, new SimpleMeterRegistry(), 0, 100, 1_000);
        c.sleeper = clock::addAndGet; // 다시 읽기 전 기다림은 가짜 시계를 그만큼 옮긴다
        return c;
    }

    static final SQLException TIMEOUT = new SQLException("canceling statement due to statement timeout", "57014");

    static List<ILoggingEvent> lines(ListAppender<ILoggingEvent> app, String part) {
        return app.list.stream().filter(e -> e.getFormattedMessage().contains(part)).toList();
    }

    @Test
    void liveReportsCountFromTheMinuteOfApiStart_olderOnesAreLeftToTheDbAndFutureOnesAreIgnored() {
        AtomicLong clock = new AtomicLong(START);
        ShipCoverage c = coverage(new FakeSource(), clock);
        assertThat(c.liveFromMs()).isEqualTo(CUT);
        c.onSampled(new ShipEvents.ShipsSampled(List.of(
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

    /**
     * 2026-09-30 22:49 KST 배포 직후: 부트스트랩이 5/25시간을 29 s 에 읽고 여섯째 시에서 statement_timeout 으로 멈췄고(재시작 직후의 DB 경합 — 같은 한 시 문장은 한가한
     * DB 에서 0.44 s), 다음 재시작까지 레이어가 일부만 셌다. 이제 시간 초과 · 일시적 실패인 시는 나중에 다시 읽고(1 · 2 · 5 · 10분 — 고른 값), 그동안 나머지 시를 이어
     * 읽는다. 기다리는 동안 응답이 어느 시를 셌고 어느 시가 다시 읽기를 기다리는지 말한다. 수정 전 실패(첫 시간 초과에서 멈췄다).
     */
    @Test
    void aTimedOutHourIsRetriedLater_theRemainingHoursAreReadMeanwhile_andTheSnapshotNamesTheMissingHourUntilThen() {
        AtomicLong clock = new AtomicLong(START + 30_000);
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        FakeSource src = new FakeSource();
        src.failAtRead = 3; // 넷째 조각(06:00–07:00) — 한 번만 실패한다
        src.readError = TIMEOUT;
        ShipCoverage c = new ShipCoverage(src, clock::get, meters, 0, 100, 1_000);
        List<Long> waits = new ArrayList<>();
        AtomicReference<ShipCoverage.Snapshot> during = new AtomicReference<>();
        int[] openDuringWait = new int[1];
        c.sleeper = ms -> {
            waits.add(ms);
            if (during.get() == null) {
                during.set(c.snapshotNow());
                openDuringWait[0] = src.opened.get() - src.closed.get();
                // 기다리는 동안: 다시 읽을 시의 보고는 그 몫(세지 않는다), 이미 읽은 시(빈 시보다 오래된 시)의 늦은 보고는 실시간으로 센다
                c.onSampled(new ShipEvents.ShipsSampled(List.of(pos("440000501", 37.2, 126.2, HOUR0 - 3 * H + 5_000),
                        pos("440000502", 37.2, 126.2, HOUR0 - 5 * H + 5_000))));
            }
            clock.addAndGet(ms);
        };
        c.runBootstrap();

        ShipCoverage.Snapshot w = during.get();
        assertThat(w).as("the bootstrap waited before retrying").isNotNull();
        assertThat(w.bootstrap().state()).isEqualTo("running");
        assertThat(w.bootstrap().hoursLoaded()).as("the other 24 hours were read after the timeout").isEqualTo(24);
        assertThat(w.bootstrap().missing()).containsExactly(new ShipCoverage.Missing(Instant.ofEpochMilli(HOUR0 - 3 * H), Instant.ofEpochMilli(HOUR0 - 2 * H),
                "retry", 1, "statement_timeout"));
        assertThat(w.bootstrap().nextRetryAt()).isEqualTo(Instant.ofEpochMilli(START + 30_000 + 60_000));
        assertThat(w.bootstrap().nextRetry()).isEqualTo(1);
        assertThat(w.covered()).isEqualTo("partial");
        assertThat(w.since()).as("counted without a gap back to the missing hour").isEqualTo(Instant.ofEpochMilli(HOUR0 - 2 * H));
        assertThat(w.bootstrap().loadedFrom()).isEqualTo(Instant.ofEpochMilli(HOUR0 - 2 * H));
        assertThat(openDuringWait[0]).as("no connection is held while waiting").isZero();

        assertThat(waits).containsExactly(60_000L);
        assertThat(src.reads).hasSize(26);
        assertThat(src.reads.getLast()).as("the retry reads only the missing hour").containsExactly(HOUR0 - 3 * H, HOUR0 - 2 * H);
        assertThat(src.opened.get()).as("one connection per pass — a statement timeout keeps the connection").isEqualTo(2);
        assertThat(src.closed.get()).isEqualTo(2);
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("done");
        assertThat(s.bootstrap().hoursLoaded()).isEqualTo(25);
        assertThat(s.bootstrap().hoursTotal()).isEqualTo(25);
        assertThat(s.bootstrap().missing()).isEmpty();
        assertThat(s.bootstrap().nextRetryAt()).isNull();
        assertThat(s.bootstrap().nextRetry()).isNull();
        assertThat(s.bootstrap().error()).isNull();
        assertThat(s.covered()).isEqualTo("full");
        assertThat(s.cells().getFirst().ships()).as("25 hours of one ship each + the late report").isEqualTo(26);
        assertThat(meters.counter("wakeline_ship_coverage_late_counted_total").count()).isEqualTo(1.0);
        assertThat(meters.counter("wakeline_ship_coverage_ignored_total", "reason", "before_live").count()).isEqualTo(1.0);
    }

    /** 다시 읽어도 못 읽는 시는 네 번(1 · 2 · 5 · 10분 뒤) 다시 읽은 뒤 포기하고, 응답 · 로그가 그 시와 까닭을 밝힌다(다음 재시작 전까지 빈 시). 수정 전 실패. */
    @Test
    void anHourThatKeepsTimingOutIsGivenUpAfterTheChosenBackoff_withAnExplicitReason() {
        ListAppender<ILoggingEvent> logs = captureLogs();
        try {
            AtomicLong clock = new AtomicLong(START + 30_000);
            FakeSource src = new FakeSource();
            src.failFrom = HOUR0 - 3 * H;
            src.readError = TIMEOUT;
            ShipCoverage c = coverage(src, clock);
            List<Long> waits = new ArrayList<>();
            c.sleeper = ms -> { waits.add(ms); clock.addAndGet(ms); };
            c.runBootstrap();
            assertThat(waits).containsExactly(60_000L, 120_000L, 300_000L, 600_000L);
            assertThat(ShipCoverage.RETRY_BACKOFF_MS).containsExactly(60_000L, 120_000L, 300_000L, 600_000L);
            assertThat(src.reads.stream().filter(r -> r[0] == HOUR0 - 3 * H)).as("first read + 4 retries").hasSize(5);
            ShipCoverage.Snapshot s = c.snapshotNow();
            assertThat(s.bootstrap().state()).isEqualTo("failed");
            assertThat(s.bootstrap().error()).isEqualTo("statement_timeout");
            assertThat(s.bootstrap().hoursLoaded()).isEqualTo(24);
            assertThat(s.bootstrap().missing()).containsExactly(new ShipCoverage.Missing(Instant.ofEpochMilli(HOUR0 - 3 * H), Instant.ofEpochMilli(HOUR0 - 2 * H),
                    "given_up", 5, "statement_timeout"));
            assertThat(s.bootstrap().nextRetryAt()).isNull();
            assertThat(s.bootstrap().finishedAt()).isNotNull();
            assertThat(s.covered()).isEqualTo("partial");
            assertThat(s.since()).isEqualTo(Instant.ofEpochMilli(HOUR0 - 2 * H));
            // 차례마다 WARN 한 줄(다시 읽기 네 번) + 포기 WARN 한 줄 — 서버 글자 없이 종류만
            assertThat(lines(logs, "retrying")).hasSize(4).allSatisfy(e -> assertThat(e.getLevel()).isEqualTo(Level.WARN));
            assertThat(lines(logs, "retrying").getFirst().getFormattedMessage()).contains("24/25").contains("statement_timeout").contains("60 s").contains("1/4");
            List<ILoggingEvent> gaveUp = lines(logs, "gave up");
            assertThat(gaveUp).hasSize(1);
            assertThat(gaveUp.getFirst().getLevel()).isEqualTo(Level.WARN);
            assertThat(gaveUp.getFirst().getFormattedMessage()).contains("1/25").contains("statement_timeout").contains("SQLException").doesNotContain("canceling");
            assertThat(lines(logs, "bootstrap stopped")).isEmpty();
        } finally {
            release(logs);
        }
    }

    /** 일시적이지 않은 실패(권한 · 형식 — 다시 읽어도 같다)는 곧바로 그 시만 포기하고 나머지 시를 읽는다 — 다시 읽으려 기다리지 않는다. */
    @Test
    void aNonTransientFailureGivesThatHourUpAtOnce_andTheOthersAreStillRead() {
        AtomicLong clock = new AtomicLong(START + 30_000);
        FakeSource src = new FakeSource();
        src.failFrom = HOUR0 - H;
        src.readError = new SQLException("permission denied for table ship_position", "42501");
        ShipCoverage c = coverage(src, clock);
        List<Long> waits = new ArrayList<>();
        c.sleeper = ms -> { waits.add(ms); clock.addAndGet(ms); };
        c.runBootstrap();
        assertThat(waits).isEmpty();
        assertThat(src.reads).hasSize(25);
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("failed");
        assertThat(s.bootstrap().error()).isEqualTo("error");
        assertThat(s.bootstrap().hoursLoaded()).isEqualTo(24);
        assertThat(s.bootstrap().missing()).extracting(ShipCoverage.Missing::state, ShipCoverage.Missing::attempts, ShipCoverage.Missing::error)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("given_up", 1, "error"));
        assertThat(s.since()).isEqualTo(Instant.ofEpochMilli(HOUR0));
        assertThat(src.opened.get()).as("a new connection after a failure other than a statement timeout").isEqualTo(2);
        assertThat(src.closed.get()).isEqualTo(2);
    }

    @Test
    void transientFailuresAreRetried_othersAreNot() {
        assertThat(ShipCoverage.retryable(TIMEOUT)).isTrue();
        assertThat(ShipCoverage.retryable(new SQLException("x", "08006"))).isTrue();
        assertThat(ShipCoverage.retryable(new SQLException("An I/O error occurred", "08006", new SocketTimeoutException("Read timed out")))).isTrue();
        assertThat(ShipCoverage.retryable(new SQLException("too many connections", "53300"))).isTrue();
        assertThat(ShipCoverage.retryable(new SQLException("deadlock detected", "40P01"))).isTrue();
        assertThat(ShipCoverage.retryable(new SQLException("lock not available", "55P03"))).isTrue();
        assertThat(ShipCoverage.retryable(new SQLException("the database system is starting up", "57P03"))).isTrue();
        assertThat(ShipCoverage.retryable(new SQLException("permission denied", "42501"))).isFalse();
        assertThat(ShipCoverage.retryable(new SQLException("no state"))).isFalse();
        assertThat(ShipCoverage.retryable(new IllegalStateException("boom"))).isFalse();
    }

    /**
     * 끊긴 연결을 닫다가 난 예외는 삼킨다(다음 시는 새 연결) · 서버 상태 없는 예외(RuntimeException)로 연결을 열지 못하면 다시 읽어도 같다 — 그 차례의 시를 곧바로 포기한다.
     * 두 번 넘게 다시 읽고 다 읽으면 INFO 에 그 횟수를 적는다.
     */
    @Test
    void closeFailuresAreSwallowed_nonSqlOpenFailuresGiveUp_andSeveralRetriesAreCounted() {
        ListAppender<ILoggingEvent> logs = captureLogs();
        try {
            AtomicLong clock = new AtomicLong(START + 30_000);
            AtomicInteger reads = new AtomicInteger();
            CoverageSource flaky = () -> new CoverageSource.Session() {
                @Override
                public void read(long fromMs, long toMs, Consumer<CoverageSource.Row> sink) throws SQLException {
                    int n = reads.incrementAndGet();
                    if (n == 1 || n == 26) throw new SQLException("An I/O error occurred while sending to the backend.", "08006"); // 첫 시: 두 번 끊김
                    sink.accept(new CoverageSource.Row(252, 74, 440_000_000 + n, 1, fromMs + 1_000));
                }

                @Override
                public void close() { throw new IllegalStateException("already closed"); }
            };
            ShipCoverage c = new ShipCoverage(flaky, clock::get, new SimpleMeterRegistry(), 0, 100, 1_000);
            c.sleeper = clock::addAndGet;
            c.runBootstrap();
            assertThat(c.snapshotNow().bootstrap().state()).isEqualTo("done");
            assertThat(c.snapshotNow().bootstrap().hoursLoaded()).isEqualTo(25);
            assertThat(lines(logs, "25 hours, 25 rows").getFirst().getFormattedMessage()).contains("after 2 retries");

            ShipCoverage broken = new ShipCoverage(() -> { throw new IllegalStateException("driver missing"); }, clock::get, new SimpleMeterRegistry(), 0, 100, 1_000);
            List<Long> waits = new ArrayList<>();
            broken.sleeper = ms -> { waits.add(ms); clock.addAndGet(ms); };
            broken.runBootstrap();
            assertThat(waits).isEmpty();
            ShipCoverage.Snapshot s = broken.snapshotNow();
            assertThat(s.bootstrap().state()).isEqualTo("failed");
            assertThat(s.bootstrap().error()).isEqualTo("error");
            assertThat(s.bootstrap().missing()).hasSize(25).allSatisfy(m -> assertThat(m.state()).isEqualTo("given_up"));
            assertThat(lines(logs, "gave up on 25/25").getFirst().getFormattedMessage()).contains("IllegalStateException").doesNotContain("driver missing");
        } finally {
            release(logs);
        }
    }

    /** 결과마다 한 줄: 다 읽음은 INFO(다시 읽었으면 몇 번 뒤인지), 다시 읽기를 기다림은 차례마다 WARN, 포기는 WARN, 종료는 INFO. 첫 차례에 다 읽으면 WARN 이 없다. */
    @Test
    void eachBootstrapOutcomeIsLoggedOnce_failuresAsWarn() {
        ListAppender<ILoggingEvent> logs = captureLogs();
        try {
            AtomicLong clock = new AtomicLong(START + 30_000);
            coverage(new FakeSource(), clock).runBootstrap();
            assertThat(logs.list.stream().filter(e -> e.getLevel() == Level.WARN)).isEmpty();
            assertThat(lines(logs, "25 hours, 25 rows")).hasSize(1);
            logs.list.clear();
            FakeSource once = new FakeSource();
            once.failAtRead = 3;
            once.readError = TIMEOUT;
            coverage(once, clock).runBootstrap();
            assertThat(lines(logs, "retrying")).hasSize(1);
            assertThat(lines(logs, "retrying").getFirst().getLevel()).isEqualTo(Level.WARN);
            List<ILoggingEvent> done = lines(logs, "25 hours, 25 rows");
            assertThat(done).hasSize(1);
            assertThat(done.getFirst().getLevel()).isEqualTo(Level.INFO);
            assertThat(done.getFirst().getFormattedMessage()).contains("after 1 retry");
        } finally {
            release(logs);
        }
    }

    /** 연결을 열지 못하면 그 차례의 남은 시를 모두 다시 읽기로 미룬다(연결 시도를 시마다 거듭하지 않는다) — 다음 차례에 열리면 다 읽는다. 수정 전 실패(멈췄다). */
    @Test
    void aConnectionFailureDefersThePass_andTheRetryReadsEverything() {
        AtomicLong clock = new AtomicLong(START + 30_000);
        FakeSource src = new FakeSource();
        src.openError = new SQLException("Connection refused", "08001");
        ShipCoverage c = coverage(src, clock);
        AtomicReference<ShipCoverage.Snapshot> during = new AtomicReference<>();
        c.sleeper = ms -> {
            if (during.get() == null) during.set(c.snapshotNow());
            src.openError = null;
            clock.addAndGet(ms);
        };
        c.runBootstrap();
        ShipCoverage.Snapshot w = during.get();
        assertThat(w.bootstrap().state()).isEqualTo("running");
        assertThat(w.bootstrap().hoursLoaded()).isZero();
        assertThat(w.bootstrap().missing()).hasSize(25).allSatisfy(m -> {
            assertThat(m.state()).isEqualTo("retry");
            assertThat(m.error()).isEqualTo("connection");
            assertThat(m.attempts()).isEqualTo(1);
        });
        assertThat(w.bootstrap().missing().getFirst().from()).as("oldest first").isEqualTo(Instant.ofEpochMilli(HOUR0 - 24 * H));
        assertThat(w.bootstrap().missing().getLast().to()).isEqualTo(Instant.ofEpochMilli(CUT));
        assertThat(w.covered()).isEqualTo("since_api_start");
        assertThat(w.since()).isEqualTo(Instant.ofEpochMilli(CUT));
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("done");
        assertThat(s.covered()).isEqualTo("full");
        assertThat(src.reads).hasSize(25);
    }

    @Test
    void aDatabaseThatStaysUnreachableIsGivenUpAsAConnectionFailure() {
        AtomicLong clock = new AtomicLong(START + 30_000);
        FakeSource src = new FakeSource();
        src.openError = new SQLException("Connection refused", "08001");
        ShipCoverage c = coverage(src, clock);
        c.runBootstrap();
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("failed");
        assertThat(s.bootstrap().error()).isEqualTo("connection");
        assertThat(s.bootstrap().hoursLoaded()).isZero();
        assertThat(s.bootstrap().missing()).hasSize(25).allSatisfy(m -> assertThat(m).extracting(ShipCoverage.Missing::state, ShipCoverage.Missing::attempts)
                .containsExactly("given_up", 5));
        assertThat(s.covered()).isEqualTo("since_api_start");
        assertThat(s.since()).isEqualTo(Instant.ofEpochMilli(CUT));
    }

    /** 한 차례의 마감(180 s — 고른 값)에 걸리면 남은 시는 다음 차례로 미룬다(까닭 deadline) — 멈추지 않는다. 수정 전 실패. */
    @Test
    void theDeadlineDefersTheRestOfThePassToTheNextRetry() {
        AtomicLong clock = new AtomicLong(START + 30_000);
        FakeSource src = new FakeSource();
        src.onRead = () -> { if (src.reads.size() <= 2) clock.addAndGet(ShipCoverage.BOOTSTRAP_DEADLINE_MS / 2 + 1); }; // 첫 두 조각만 느리다
        ShipCoverage c = coverage(src, clock);
        AtomicReference<ShipCoverage.Snapshot> during = new AtomicReference<>();
        c.sleeper = ms -> { if (during.get() == null) during.set(c.snapshotNow()); clock.addAndGet(ms); };
        c.runBootstrap();
        ShipCoverage.Snapshot w = during.get();
        assertThat(w.bootstrap().hoursLoaded()).isEqualTo(2);
        assertThat(w.bootstrap().missing()).hasSize(23).allSatisfy(m -> assertThat(m).extracting(ShipCoverage.Missing::state, ShipCoverage.Missing::attempts,
                ShipCoverage.Missing::error).containsExactly("retry", 0, "deadline")); // 조회하지 않았다 — 못 읽은 횟수에 세지 않는다
        assertThat(w.covered()).isEqualTo("partial");
        assertThat(w.since()).isEqualTo(Instant.ofEpochMilli(HOUR0 - H));
        assertThat(src.reads).hasSize(25);
        assertThat(c.snapshotNow().bootstrap().state()).isEqualTo("done");
    }

    /**
     * 리뷰 2026-10-01: 다시 읽는 차례가 늘 가장 최근 시부터 읽었고, 차례 마감으로 미룬 시도 '못 읽은 차례'로 셌다. 늘 느린 가장 최근 시 여섯(읽을 때마다 30 s 문장
     * 상한에 걸림)이 차례마다 마감(180 s)을 다 써서, 한 번도 조회하지 않은 시 열아홉(한가하면 0.44 s)이 다섯 차례 뒤 'deadline · 5번 못 읽음'으로 포기됐다.
     * 이제 다시 읽는 차례는 적게 조회한 시부터(마감으로 미룬 시가 먼저) 읽고, 마감으로 미룬 차례는 attempts 에 세지 않는다(조회하지 않았다). 수정 전 실패.
     */
    @Test
    void hoursDeferredByTheDeadlineAreReadBeforeHoursThatTimedOut_andADeferralIsNotCountedAsAFailedRead() {
        // api 시작 09:00:30Z(셈 시작 09:00 — 시 조각 24개, 모두 한 시). 다섯 차례와 기다림(약 33분)이 10:00 전에 끝나 창이 넘어가지 않는다
        AtomicLong clock = new AtomicLong(HOUR0 + 30_000);
        FakeSource src = new FakeSource();
        long slow = HOUR0 - 6 * H; // 가장 최근 여섯 시(03 ~ 08시)는 읽을 때마다 30 s 상한에 걸린다
        src.failIf = from -> from >= slow;
        src.readError = TIMEOUT;
        src.onRead = () -> clock.addAndGet(src.reads.getLast()[0] >= slow ? 30_001 : 440);
        ShipCoverage c = coverage(src, clock);
        AtomicReference<ShipCoverage.Snapshot> first = new AtomicReference<>();
        List<Long> waits = new ArrayList<>();
        c.sleeper = ms -> { if (first.get() == null) first.set(c.snapshotNow()); waits.add(ms); clock.addAndGet(ms); };
        c.runBootstrap();

        // 첫 차례: 느린 여섯을 읽다 마감 — 나머지 열여덟은 조회하지 않았다(attempts 0 · deadline), 느린 여섯은 한 번 못 읽었다
        ShipCoverage.Bootstrap b1 = first.get().bootstrap();
        assertThat(b1.missing()).hasSize(24);
        assertThat(b1.missing().stream().filter(m -> m.error().equals("deadline"))).hasSize(18).allSatisfy(m -> assertThat(m.attempts()).isZero());
        assertThat(b1.missing().stream().filter(m -> m.error().equals("statement_timeout"))).hasSize(6).allSatisfy(m -> assertThat(m.attempts()).isEqualTo(1));
        assertThat(b1.nextRetry()).as("the first of four retries").isEqualTo(1);
        // 다시 읽는 차례는 마감으로 미룬 시부터 — 한가한 시는 모두 한 번씩 조회해 읽었다
        for (long from = HOUR0 - 24 * H; from < slow; from += H) {
            long f = from;
            assertThat(src.reads.stream().filter(r -> r[0] == f)).as("hour %s", Instant.ofEpochMilli(f)).hasSize(1);
        }
        assertThat(waits).containsExactly(60_000L, 120_000L, 300_000L, 600_000L);
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("failed");
        assertThat(s.bootstrap().hoursLoaded()).isEqualTo(18);
        assertThat(s.bootstrap().hoursTotal()).isEqualTo(24);
        assertThat(s.bootstrap().error()).isEqualTo("statement_timeout");
        assertThat(s.bootstrap().missing()).hasSize(6).allSatisfy(m -> assertThat(m).extracting(ShipCoverage.Missing::state, ShipCoverage.Missing::attempts,
                ShipCoverage.Missing::error).containsExactly("given_up", 5, "statement_timeout"));
        assertThat(s.bootstrap().missing().getFirst().from()).as("oldest first").isEqualTo(Instant.ofEpochMilli(slow));
        // 가장 최근 시가 비어 있으므로 셈 시작부터 이어 읽은 시는 없다 — api 시작 뒤만 이어 셌다고 말한다(읽은 열여덟 시는 격자에 있다)
        assertThat(s.covered()).isEqualTo("since_api_start");
        assertThat(s.since()).isEqualTo(Instant.ofEpochMilli(HOUR0));
        assertThat(s.cells().getFirst().ships()).isEqualTo(18);
    }

    /**
     * 차례마다 마감에 걸려 끝내 한 번도 조회하지 못한 시는 '마감(deadline) · 0번'으로 포기한다 — 조회하지 않은 시를 '다섯 번 못 읽었다'고 하지 않는다. 한 번 못 읽은 뒤
     * 마감으로 미룬 시는 제 실패 종류와 횟수를 그대로 둔다(마감이 덮지 않는다). 수정 전 실패.
     */
    @Test
    void anHourNeverQueriedBecauseOfTheDeadlineIsGivenUpAsDeadlineWithZeroAttempts_andAnEarlierFailureIsKept() {
        AtomicLong clock = new AtomicLong(HOUR0 + 30_000); // 시 조각 24개 — 다섯 차례와 기다림(약 33분)이 10:00 전에 끝난다
        FakeSource src = new FakeSource();
        src.failAtRead = 0; // 가장 최근 조각은 첫 읽기에서 한 번 시간 초과
        src.readError = TIMEOUT;
        // 읽기마다 마감을 넘긴다(가짜 — 운영의 문장은 30 s 상한 안에 끝난다): 차례마다 한 시만 조회한다
        src.onRead = () -> clock.addAndGet(ShipCoverage.BOOTSTRAP_DEADLINE_MS + 1);
        ShipCoverage c = coverage(src, clock);
        ListAppender<ILoggingEvent> logs = captureLogs();
        try {
            c.runBootstrap();
        } finally {
            release(logs);
        }
        assertThat(lines(logs, "gave up on 20/24 hours").getFirst().getFormattedMessage())
                .contains("after up to 1 failed reads per hour").contains("deadline x19").contains("19 of them never queried");
        assertThat(src.reads).as("one statement per pass, five passes").hasSize(5);
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("failed");
        assertThat(s.bootstrap().hoursLoaded()).isEqualTo(4);
        List<ShipCoverage.Missing> gone = s.bootstrap().missing();
        assertThat(gone).hasSize(20).allSatisfy(m -> assertThat(m.state()).isEqualTo("given_up"));
        assertThat(gone.getLast()).as("the newest hour timed out once, then waited behind the deadline")
                .extracting(ShipCoverage.Missing::from, ShipCoverage.Missing::attempts, ShipCoverage.Missing::error)
                .containsExactly(Instant.ofEpochMilli(HOUR0 - H), 1, "statement_timeout");
        assertThat(gone.subList(0, 19)).allSatisfy(m -> assertThat(m).extracting(ShipCoverage.Missing::attempts, ShipCoverage.Missing::error)
                .containsExactly(0, "deadline"));
    }

    /**
     * 다시 읽기를 기다리는 사이 창이 한 시 넘어가 빈 시가 창 밖으로 나가면 그 시는 더 읽지 않는다 — 읽을 시에서 빼고(hours_total), 응답에서도 뺀다(창 밖의 시를 말하지
     * 않는다). 남은 시를 다 읽었으면 done · full.
     */
    @Test
    void aMissingHourThatLeavesTheWindowWhileWaitingIsNotReadAnyMore() {
        AtomicLong clock = new AtomicLong(START + 30_000);
        FakeSource src = new FakeSource();
        src.failFrom = HOUR0 - 24 * H; // 창의 가장 오래된 시
        src.readError = TIMEOUT;
        ShipCoverage c = coverage(src, clock);
        AtomicReference<ShipCoverage.Snapshot> after = new AtomicReference<>();
        c.sleeper = ms -> {
            clock.set(HOUR0 + H + 30_000); // 10:00:30 — 창이 한 시 넘어갔다
            if (after.get() == null) after.set(c.snapshotNow());
        };
        c.runBootstrap();
        ShipCoverage.Snapshot rolled = after.get();
        assertThat(rolled.bootstrap().missing()).as("an hour outside the window is not reported").isEmpty();
        assertThat(rolled.bootstrap().nextRetryAt()).isNull();
        assertThat(rolled.covered()).isEqualTo("full");
        assertThat(src.reads).as("the expired hour is not read again").hasSize(25);
        ShipCoverage.Snapshot s = c.snapshotNow();
        assertThat(s.bootstrap().state()).isEqualTo("done");
        assertThat(s.bootstrap().hoursLoaded()).isEqualTo(24);
        assertThat(s.bootstrap().hoursTotal()).as("the hour that left the window is no longer to be read").isEqualTo(24);
        assertThat(s.covered()).isEqualTo("full");
    }

    /** 종료가 다시 읽기 전 기다림을 깨우면(가상 스레드 interrupt) 곧바로 멈추고 INFO 한 줄 — 남은 시는 stopped 로 포기. 수정 전 실패(기다림이 없었다). */
    @Test
    void stoppingWhileWaitingToRetryEndsAtOnce_andSaysStopped() throws Exception {
        ListAppender<ILoggingEvent> logs = captureLogs();
        try {
            FakeSource src = new FakeSource();
            src.failFrom = Math.floorDiv(System.currentTimeMillis(), H) * H - 2 * H;
            src.readError = TIMEOUT;
            ShipCoverage c = new ShipCoverage(src, System::currentTimeMillis, new SimpleMeterRegistry(), 0, 100, 1_000);
            c.start(); // 실제 시계 · 실제 잠 — 1분을 기다리는 동안 멈춘다
            long until = System.nanoTime() + Duration.ofSeconds(10).toNanos();
            while (c.snapshotNow().bootstrap().nextRetryAt() == null && System.nanoTime() < until) Thread.sleep(20);
            assertThat(c.snapshotNow().bootstrap().nextRetryAt()).isNotNull();
            long t0 = System.nanoTime();
            c.stop();
            while (!"failed".equals(c.snapshotNow().bootstrap().state()) && System.nanoTime() < until) Thread.sleep(20);
            assertThat((System.nanoTime() - t0) / 1_000_000).as("not after the one-minute wait").isLessThan(5_000);
            ShipCoverage.Snapshot s = c.snapshotNow();
            assertThat(s.bootstrap().error()).isEqualTo("stopped");
            assertThat(s.bootstrap().missing()).extracting(ShipCoverage.Missing::state, ShipCoverage.Missing::error)
                    .containsExactly(org.assertj.core.groups.Tuple.tuple("given_up", "stopped"));
            Thread.sleep(50);
            assertThat(lines(logs, "bootstrap stopped")).hasSize(1).allSatisfy(e -> assertThat(e.getLevel()).isEqualTo(Level.INFO));
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
    void theSnapshotIsCachedForSixtySeconds_andTheEtagFollowsTheSnapshot() {
        AtomicLong clock = new AtomicLong(START + 1_000);
        ShipCoverage c = coverage(new FakeSource(), clock);
        ShipCoverage.Snapshot a = c.snapshot();
        c.onSampled(new ShipEvents.ShipsSampled(List.of(pos("440000002", 37.2, 126.2, START))));
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
        c.onSampled(new ShipEvents.ShipsSampled(List.of(pos("440000001", 37.2, 126.2, CUT - 1)))); // +31 s: 재시작 전 보고가 아직 온다
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
            stuck.onSampled(new ShipEvents.ShipsSampled(List.of(pos("440000001", 37.2, 126.2, CUT - 1))));
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
            if (src.reads.size() == 2) holder[0].onSampled(new ShipEvents.ShipsSampled(List.of(pos("440000077", 37.2, 126.2, HOUR0 - H + 5_000))));
        };
        ShipCoverage c = new ShipCoverage(src, clock::get, meters, 0, 100, 1_000, START);
        holder[0] = c;
        c.onSampled(new ShipEvents.ShipsSampled(List.of(pos("440000066", 37.2, 126.2, CUT - 1)))); // 부트스트랩 전 — 그 몫
        c.runBootstrap();
        ShipCoverage.Snapshot before = c.snapshotNow();
        c.onSampled(new ShipEvents.ShipsSampled(List.of(
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
        c.onSampled(new ShipEvents.ShipsSampled(List.of(pos("440000002", 37.2, 126.2, START), pos("440000003", 10.2, 10.2, START))));
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
