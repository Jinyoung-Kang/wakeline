package dev.wakeline.persist;

import dev.wakeline.domain.Alert;
import dev.wakeline.domain.SigmetRecord;
import dev.wakeline.engine.AlertStateMachine.Event;
import dev.wakeline.engine.AlertStateMachine.EventType;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** DB 없이 확인하는 저장 규칙: 닫힘 이유, 이전 형식 SIGMET 출처(추정 없음), 내용 비교, 공항 관측 나이, 항적 저장기의 종료. */
@ExtendWith(OutputCaptureExtension.class)
class PersistUnitTest {
    static final Instant NOW = Instant.parse("2026-09-27T12:00:00Z");

    static Alert alert(String reason) {
        return new Alert(1, "OBSERVED", "abc123", null, "S", null, null, null, NOW, NOW, reason, null, null, null, Map.of(), false);
    }

    @Test
    void closeReasonFollowsTheEngineThenTheEventType() {
        assertThat(AlertRepository.closeReason(new Event(EventType.LOST, alert("signal_lost")))).isEqualTo("signal_lost");
        assertThat(AlertRepository.closeReason(new Event(EventType.LOST, alert(null)))).isEqualTo("signal_lost");
        assertThat(AlertRepository.closeReason(new Event(EventType.LEFT, alert(null)))).isEqualTo("left");
        assertThat(AlertRepository.closeReason(new Event(EventType.PREDICTION_CLEARED, alert(null)))).isEqualTo("prediction_cleared");
    }

    @Test
    void legacySigmetSourcesAreDeterministicOnly() {
        var zero = new SigmetRecord("A", "X", null, null, "1", "TS", null, 0, null, NOW, NOW.plusSeconds(60), null, "no_polygon", null, null, null, "r", "p", NOW);
        var band = new SigmetRecord("B", "X", null, null, "1", "TS", null, 3000, 20000, NOW, NOW.plusSeconds(60), null, "no_polygon", null, null, null, "r", "p", NOW);
        assertThat(SigmetRepository.dbBaseSource(zero)).isEqualTo("unknown");
        assertThat(SigmetRepository.dbTopSource(zero)).isEqualTo("unknown");
        assertThat(SigmetRepository.dbBaseSource(band)).isEqualTo("json");
        assertThat(SigmetRepository.dbTopSource(band)).isEqualTo("json");
        // 수신 시각만 다른 같은 경보는 같은 내용
        var later = new SigmetRecord("A", "X", null, null, "1", "TS", null, 0, null, NOW, NOW.plusSeconds(60), null, "no_polygon", null, null, null, "r", "p",
                NOW.plusSeconds(300));
        assertThat(SigmetRepository.contentOf(later)).isEqualTo(SigmetRepository.contentOf(zero));
    }

    @Test
    void airportObservationAge() {
        Map<String, Object> fresh = new LinkedHashMap<>(Map.of("obs_time", NOW.minusSeconds(600)));
        assertThat(AirportRepository.withAge(fresh, NOW)).containsEntry("obs_age_s", 600L).containsEntry("stale", false);
        Map<String, Object> old = new LinkedHashMap<>(Map.of("obs_time", NOW.minusSeconds(7_201)));
        assertThat(AirportRepository.withAge(old, NOW)).containsEntry("stale", true);
        Map<String, Object> none = new LinkedHashMap<>();
        none.put("obs_time", null);
        Map<String, Object> r = AirportRepository.withAge(none, NOW);
        assertThat(r.get("obs_age_s")).isNull();
        assertThat(r.get("stale")).isNull(); // 관측이 없으면 '오래됨' 도 '최신' 도 아니다
    }

    /**
     * 조사 2026-10-01(종료): 항적 저장기도 종료 flush 를 워커가 한다 — 워커의 쓰기가 stop 의 예전 기다림(2 s)보다 오래 걸려도 다른 스레드가 같은 배치를
     * 동시에 쓰지 않는다(쓰는 스레드는 하나). 첫 쓰기(A)는 문이 열릴 때까지 막혔다가 커밋하고, 그 뒤 쓰기(B)는 실패한다(DB 가 죽었다).
     */
    @Test
    void trackShutdownKeepsASingleWriterAndDoesNotAckTheUnwrittenBatch() throws Exception {
        java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1), gate = new java.util.concurrent.CountDownLatch(1),
                second = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger(),
                active = new java.util.concurrent.atomic.AtomicInteger(), maxActive = new java.util.concurrent.atomic.AtomicInteger();
        org.springframework.jdbc.core.JdbcTemplate jdbc = new org.springframework.jdbc.core.JdbcTemplate() {
            @Override
            public <T> int[][] batchUpdate(String sql, java.util.Collection<T> args, int batchSize,
                                           org.springframework.jdbc.core.ParameterizedPreparedStatementSetter<T> pss) {
                maxActive.accumulateAndGet(active.incrementAndGet(), Math::max);
                try {
                    if (calls.incrementAndGet() == 1) {
                        entered.countDown();
                        try { gate.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                        return new int[0][];
                    }
                    second.countDown();
                    throw new org.springframework.dao.DataAccessResourceFailureException("db down");
                } finally {
                    active.decrementAndGet();
                }
            }
        };
        AircraftRepository aircraft = new AircraftRepository(null, null) {
            @Override public int touch(java.util.Collection<dev.wakeline.domain.AircraftState> states) { return states.size(); }
        };
        var meters = new io.micrometer.core.instrument.simple.SimpleMeterRegistry();
        TrackWriter tw = new TrackWriter(jdbc, aircraft, meters, 5, 10);
        tw.start();
        java.util.concurrent.atomic.AtomicInteger ackA = new java.util.concurrent.atomic.AtomicInteger(), ackB = new java.util.concurrent.atomic.AtomicInteger();
        dev.wakeline.ingest.Receipt ra = new dev.wakeline.ingest.Receipt(ackA::incrementAndGet), rb = new dev.wakeline.ingest.Receipt(ackB::incrementAndGet);
        tw.enqueue(java.util.List.of(ac("a00001")), ra);
        ra.release();
        assertThat(entered.await(5, java.util.concurrent.TimeUnit.SECONDS)).as("the worker is writing batch A").isTrue();
        tw.enqueue(java.util.List.of(ac("a00002")), rb);
        rb.release();
        Thread stopper = Thread.ofVirtual().start(tw::stop);
        boolean overlapped = second.await(3, java.util.concurrent.TimeUnit.SECONDS); // 예전 코드: 2 s 뒤 flush 가 A 를 다시 쓰기 시작한다
        gate.countDown();
        stopper.join(15_000);
        org.assertj.core.api.SoftAssertions.assertSoftly(s -> {
            s.assertThat(stopper.isAlive()).isFalse();
            s.assertThat(overlapped).as("a second write started while the worker's write was still in flight").isFalse();
            s.assertThat(maxActive.get()).as("threads writing at the same time").isEqualTo(1);
            s.assertThat(ackA.get()).isEqualTo(1);
            s.assertThat(ackB.get()).as("B was never written").isZero();
            s.assertThat(tw.pendingMarks()).isEqualTo(1);
            s.assertThat(meters.counter("wakeline_track_rows_total", "result", "dropped").count()).isEqualTo(1.0);
            s.assertThat(meters.counter("wakeline_track_rows_total", "result", "written").count()).as("A counted once, not twice").isEqualTo(1.0);
        });
    }

    /**
     * 느린 DB 흉내(항적): 첫 batchUpdate 는 문이 열릴 때까지 막혔다가 커밋한다(firstFails 가 있으면 그것을 던진다 — 예외든 오류든). 그 뒤 쓰기는 성공한다.
     */
    static final class GateJdbc extends org.springframework.jdbc.core.JdbcTemplate {
        final java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1), gate = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        final java.util.List<String> written = new java.util.concurrent.CopyOnWriteArrayList<>();
        volatile Throwable firstFails;

        @Override
        public <T> int[][] batchUpdate(String sql, java.util.Collection<T> args, int batchSize,
                                       org.springframework.jdbc.core.ParameterizedPreparedStatementSetter<T> pss) {
            if (calls.incrementAndGet() == 1) {
                entered.countDown();
                try { gate.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                if (firstFails instanceof RuntimeException r) throw r;
                if (firstFails instanceof Error err) throw err;
            }
            for (T a : args) written.add(((dev.wakeline.domain.AircraftState) a).hex());
            return new int[0][];
        }
    }

    static TrackWriter trackWriter(GateJdbc jdbc, io.micrometer.core.instrument.MeterRegistry meters, long backoffStartMs, long backoffMaxMs) {
        AircraftRepository aircraft = new AircraftRepository(null, null) {
            @Override public int touch(java.util.Collection<dev.wakeline.domain.AircraftState> states) { return states.size(); }
        };
        return new TrackWriter(jdbc, aircraft, meters, backoffStartMs, backoffMaxMs);
    }

    /**
     * 리뷰 2026-10-01(ShipWriterTest.aWriteThatOutlastsTheStopWait 의 항적 판): 쓰기 하나가 stop 의 기다림 상한보다 오래 걸리면 stop 은 그렇다고 WARN 하고
     * 돌아간다. 워커는 마감(stop 요청 + 상한 − 1 s)이 지난 뒤에는 새 배치를 쓰기 시작하지 않는다 — 늦게 끝난 A 만 커밋, B 는 쓰지 않고 ACK 하지 않는다.
     */
    @Test
    void aTrackWriteThatOutlastsTheStopWait_theWorkerStartsNoNewWriteAfterTheDeadline(CapturedOutput out) throws Exception {
        GateJdbc jdbc = new GateJdbc();
        var meters = new io.micrometer.core.instrument.simple.SimpleMeterRegistry();
        TrackWriter tw = trackWriter(jdbc, meters, 5, 10);
        tw.stopWaitMs = 1_200;
        tw.start();
        java.util.concurrent.atomic.AtomicInteger ackA = new java.util.concurrent.atomic.AtomicInteger(), ackB = new java.util.concurrent.atomic.AtomicInteger();
        dev.wakeline.ingest.Receipt ra = new dev.wakeline.ingest.Receipt(ackA::incrementAndGet), rb = new dev.wakeline.ingest.Receipt(ackB::incrementAndGet);
        tw.enqueue(java.util.List.of(ac("a00001")), ra);
        ra.release();
        assertThat(jdbc.entered.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        tw.enqueue(java.util.List.of(ac("a00002")), rb);
        rb.release();
        long t0 = System.nanoTime();
        tw.stop();
        long waitedMs = (System.nanoTime() - t0) / 1_000_000;
        assertThat(waitedMs).isBetween(1_100L, 5_000L);
        assertThat(out.getAll()).contains("track writer still busy 1200 ms after stop");
        jdbc.gate.countDown();
        long end = System.currentTimeMillis() + 5_000;
        while (!out.getAll().contains("track flush on shutdown") && System.currentTimeMillis() < end) Thread.sleep(10);
        assertThat(ackA.get()).isEqualTo(1);
        assertThat(ackB.get()).isZero();
        assertThat(jdbc.calls.get()).as("no write started after the deadline").isEqualTo(1);
        assertThat(out.getAll()).contains("track flush on shutdown: 0 rows written, 1 rows dropped");
        assertThat(meters.counter("wakeline_track_rows_total", "result", "dropped").count()).isEqualTo(1.0);
    }

    /** 리뷰 2026-10-01: stop 요청 뒤 진행 중 쓰기가 실패하면 기다림은 없다 — WARN 은 'retry in …' 이 아니라 종료 flush 가 한 번 더 쓴다고 말한다. */
    @Test
    void aTrackWriteThatFailsAfterStopWasRequested_theWarnSaysTheShutdownFlushTriesIt(CapturedOutput out) throws Exception {
        GateJdbc jdbc = new GateJdbc();
        jdbc.firstFails = new org.springframework.dao.DataAccessResourceFailureException("db restarting");
        TrackWriter tw = trackWriter(jdbc, new io.micrometer.core.instrument.simple.SimpleMeterRegistry(), 2_000, 30_000);
        tw.start();
        java.util.concurrent.atomic.AtomicInteger ackA = new java.util.concurrent.atomic.AtomicInteger();
        dev.wakeline.ingest.Receipt ra = new dev.wakeline.ingest.Receipt(ackA::incrementAndGet);
        tw.enqueue(java.util.List.of(ac("a00001")), ra);
        ra.release();
        assertThat(jdbc.entered.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        java.util.concurrent.CountDownLatch stopped = new java.util.concurrent.CountDownLatch(1);
        tw.stop(stopped::countDown);
        jdbc.gate.countDown();
        assertThat(stopped.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        assertThat(out.getAll()).contains("track batch (1 rows) failed while stopping — the shutdown flush tries it once more before its deadline (queue 0): "
                + "org.springframework.dao.DataAccessResourceFailureException: db restarting").doesNotContain("retry in");
        assertThat(out.getAll()).contains("track flush on shutdown: 1 rows written");
        assertThat(ackA.get()).isEqualTo(1);
        assertThat(jdbc.written).containsExactly("a00001");
    }

    /** 리뷰 2026-10-01: 워커가 오류(Error)로 죽으면 ERROR 한 줄, stop 은 — 쓰는 스레드가 이제 자기뿐이므로 — 남은 행을 직접 쓴다(예전: 조용히 아무것도). */
    @Test
    void aTrackWorkerKilledByAnError_logsIt_andStopStillFlushesTheQueuedRows(CapturedOutput out) throws Exception {
        GateJdbc jdbc = new GateJdbc();
        jdbc.firstFails = new StackOverflowError("test: the worker dies");
        jdbc.gate.countDown();
        TrackWriter tw = trackWriter(jdbc, new io.micrometer.core.instrument.simple.SimpleMeterRegistry(), 5, 10);
        tw.start();
        java.util.concurrent.atomic.AtomicInteger ackA = new java.util.concurrent.atomic.AtomicInteger(), ackB = new java.util.concurrent.atomic.AtomicInteger();
        dev.wakeline.ingest.Receipt ra = new dev.wakeline.ingest.Receipt(ackA::incrementAndGet), rb = new dev.wakeline.ingest.Receipt(ackB::incrementAndGet);
        tw.enqueue(java.util.List.of(ac("a00001")), ra);
        ra.release();
        long end = System.currentTimeMillis() + 5_000;
        while (!out.getAll().contains("track writer thread died") && System.currentTimeMillis() < end) Thread.sleep(5);
        assertThat(out.getAll()).contains("track writer thread died (java.lang.StackOverflowError: test: the worker dies)");
        tw.enqueue(java.util.List.of(ac("a00002")), rb);
        rb.release();
        tw.stop();
        assertThat(jdbc.written).containsExactly("a00001", "a00002");
        assertThat(ackA.get()).isEqualTo(1);
        assertThat(ackB.get()).isEqualTo(1);
        assertThat(tw.pendingMarks()).isZero();
        assertThat(out.getAll()).contains("track flush on shutdown: 2 rows written");
    }

    static dev.wakeline.domain.AircraftState ac(String hex) {
        return new dev.wakeline.domain.AircraftState(hex, null, null, null, null, 36, 127, 30000, null, null, null, false, null, NOW, "adsb_lol", NOW, 0, false);
    }

    /** DB 가 오래 죽어 있으면 ACK 를 기다리는 표식은 상한(MAX_MARKS)에서 가장 오래된 것부터 놓는다 — 그 메시지는 스트림에서 이미 지워졌다. */
    @Test
    void pendingReceiptMarksAreBounded() throws Exception {
        javax.sql.DataSource down = new org.springframework.jdbc.datasource.AbstractDataSource() {
            @Override public java.sql.Connection getConnection() throws java.sql.SQLException { throw new java.sql.SQLTransientConnectionException("down"); }
            @Override public java.sql.Connection getConnection(String u, String p) throws java.sql.SQLException { return getConnection(); }
        };
        var meters = new io.micrometer.core.instrument.simple.SimpleMeterRegistry();
        TrackWriter tw = new TrackWriter(new org.springframework.jdbc.core.JdbcTemplate(down), new AircraftRepository(
                org.springframework.jdbc.core.simple.JdbcClient.create(down), null), meters, 50, 100);
        tw.start();
        java.util.concurrent.atomic.AtomicInteger acked = new java.util.concurrent.atomic.AtomicInteger();
        java.util.List<dev.wakeline.ingest.Receipt> rs = new java.util.ArrayList<>();
        for (int i = 0; i <= TrackWriter.MAX_MARKS; i++) {
            dev.wakeline.ingest.Receipt r = new dev.wakeline.ingest.Receipt(acked::incrementAndGet);
            rs.add(r);
            tw.enqueue(java.util.List.of(new dev.wakeline.domain.AircraftState(String.format("%06x", i), null, null, null, null, 36, 127, 30000,
                    null, null, null, false, null, NOW, "adsb_lol", NOW, 0, false)), r);
            r.release();
        }
        assertThat(tw.pendingMarks()).isEqualTo(TrackWriter.MAX_MARKS);
        assertThat(acked.get()).isEqualTo(1);
        assertThat(rs.getFirst().holds()).isZero();
        assertThat(meters.counter("wakeline_track_receipts_forced_total").count()).isEqualTo(1.0);
        tw.stop();
        assertThat(acked.get()).as("nothing else was durable").isEqualTo(1);
    }

    /**
     * 리뷰 cto-2026-10 D3(B6): 원인 사슬에 SQLState 가 없고 일시 장애로 아는 종류도 아닌 예외(쓰기 코드의 결함 등)는 영구 오류처럼 3번 뒤 버린다 —
     * ERROR 로 남기고 failed 로 세고 영수증을 놓는다. 예전에는 일시 장애로 보고 같은 배치를 끝없이 다시 시도해 큐 머리를 막았다(새 행이 넘쳐 버려졌다).
     */
    @Test
    void aTrackWriteErrorWithoutSqlStateIsGivenUpAfterThreeAttemptsNotRetriedForever(CapturedOutput out) throws Exception {
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        org.springframework.jdbc.core.JdbcTemplate jdbc = new org.springframework.jdbc.core.JdbcTemplate() {
            @Override
            public <T> int[][] batchUpdate(String sql, java.util.Collection<T> args, int batchSize,
                                           org.springframework.jdbc.core.ParameterizedPreparedStatementSetter<T> pss) {
                calls.incrementAndGet();
                throw new IllegalStateException("bug in the statement setter");
            }
        };
        AircraftRepository aircraft = new AircraftRepository(null, null) {
            @Override public int touch(java.util.Collection<dev.wakeline.domain.AircraftState> states) { return states.size(); }
        };
        var meters = new io.micrometer.core.instrument.simple.SimpleMeterRegistry();
        TrackWriter tw = new TrackWriter(jdbc, aircraft, meters, 1, 1);
        tw.start();
        try {
            java.util.concurrent.atomic.AtomicInteger acked = new java.util.concurrent.atomic.AtomicInteger();
            dev.wakeline.ingest.Receipt r = new dev.wakeline.ingest.Receipt(acked::incrementAndGet);
            tw.enqueue(java.util.List.of(ac("a00001")), r);
            r.release();
            long end = System.currentTimeMillis() + 5_000;
            while (acked.get() == 0 && System.currentTimeMillis() < end) Thread.sleep(5);
            Thread.sleep(50);
            assertThat(acked.get()).as("receipt released").isEqualTo(1);
            assertThat(calls.get()).as("attempts").isEqualTo(TrackWriter.PERMANENT_ATTEMPTS);
            assertThat(meters.counter("wakeline_track_rows_total", "result", "failed").count()).isEqualTo(1.0);
            assertThat(out.getAll()).contains("ERROR").contains("track batch (1 rows) failed 3 times with an error that has no SQLState");
        } finally {
            tw.stop();
        }
    }
}
