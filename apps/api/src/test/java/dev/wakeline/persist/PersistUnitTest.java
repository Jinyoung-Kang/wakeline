package dev.wakeline.persist;

import dev.wakeline.domain.Alert;
import dev.wakeline.domain.SigmetRecord;
import dev.wakeline.engine.AlertStateMachine.Event;
import dev.wakeline.engine.AlertStateMachine.EventType;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** DB 없이 확인하는 저장 규칙: 닫힘 이유, 이전 형식 SIGMET 출처(추정 없음), 내용 비교, 공항 관측 나이. */
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
}
