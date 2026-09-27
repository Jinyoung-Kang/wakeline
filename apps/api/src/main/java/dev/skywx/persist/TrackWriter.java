package dev.skywx.persist;

import dev.skywx.domain.AircraftState;
import dev.skywx.ingest.IngestEvents;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 항적 배치 저장(가상 스레드). 큐 상한 50,000행 — 초과 시 오래된 것부터 버리고 지표로 남긴다(5.1절 DB 느림).
 * (hex, ts) PK 에 ON CONFLICT DO NOTHING 이라 재처리로 같은 행이 와도 중복되지 않는다. 실시간 경로는 DB 에 의존하지 않는다.
 */
@org.springframework.context.annotation.Profile("!cli")  // --create-ops-user CLI 에서는 웹·소비자·잡을 띄우지 않는다
@Component
public class TrackWriter implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(TrackWriter.class);
    private static final int QUEUE_MAX = 50_000;
    private static final int BATCH = 2_000;
    private static final String SQL = """
            INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, vrate_fpm, on_ground, squawk, provider, fetched_at, quality)
            VALUES (?, ?, ST_SetSRID(ST_MakePoint(?, ?), 4326), ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (hex, ts) DO NOTHING""";

    private final JdbcTemplate jdbc;
    private final AircraftRepository aircraft;
    private final BlockingQueue<AircraftState> queue = new ArrayBlockingQueue<>(QUEUE_MAX);
    private final Counter droppedRows;
    private final Counter writtenRows;
    private volatile boolean running;
    private Thread worker;

    public TrackWriter(JdbcTemplate jdbc, AircraftRepository aircraft, MeterRegistry meters) {
        this.jdbc = jdbc;
        this.aircraft = aircraft;
        meters.gauge("skywx_track_queue", queue, BlockingQueue::size);
        droppedRows = Counter.builder("skywx_track_rows_total").tag("result", "dropped").register(meters);
        writtenRows = Counter.builder("skywx_track_rows_total").tag("result", "written").register(meters);
    }

    @EventListener
    public void onSnapshot(IngestEvents.SnapshotUpdated e) {
        for (AircraftState s : e.current().states().values()) {
            if (!queue.offer(s)) {
                queue.poll();
                queue.offer(s);
                droppedRows.increment();
            }
        }
        aircraft.touch(e.current().states().values());
    }

    @Override public void start() { running = true; worker = Thread.ofVirtual().name("track-writer").start(this::loop); }
    @Override public void stop() { running = false; flush(); }
    @Override public boolean isRunning() { return running; }

    private void loop() {
        while (running) {
            try {
                AircraftState first = queue.poll(1, TimeUnit.SECONDS);
                if (first == null) continue;
                List<AircraftState> batch = new ArrayList<>(BATCH);
                batch.add(first);
                queue.drainTo(batch, BATCH - 1);
                write(batch);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return;
            } catch (Exception e) {
                log.warn("track batch failed: {}", e.toString());
                sleep(2000);
            }
        }
    }

    private void flush() {
        List<AircraftState> rest = new ArrayList<>();
        queue.drainTo(rest);
        long deadline = System.currentTimeMillis() + 10_000;
        for (int i = 0; i < rest.size() && System.currentTimeMillis() < deadline; i += BATCH) {
            try { write(rest.subList(i, Math.min(rest.size(), i + BATCH))); } catch (Exception e) { log.warn("flush failed: {}", e.toString()); }
        }
    }

    private void write(List<AircraftState> batch) {
        jdbc.batchUpdate(SQL, batch, BATCH, (ps, s) -> {
            ps.setString(1, s.hex());
            ps.setTimestamp(2, Timestamp.from(s.seenAt()));
            ps.setDouble(3, s.lon());
            ps.setDouble(4, s.lat());
            if (s.altFt() == null) ps.setNull(5, java.sql.Types.INTEGER); else ps.setInt(5, s.altFt());
            if (s.gsKt() == null) ps.setNull(6, java.sql.Types.REAL); else ps.setFloat(6, s.gsKt().floatValue());
            if (s.trackDeg() == null) ps.setNull(7, java.sql.Types.REAL); else ps.setFloat(7, s.trackDeg().floatValue());
            if (s.vrateFpm() == null) ps.setNull(8, java.sql.Types.REAL); else ps.setFloat(8, s.vrateFpm().floatValue());
            ps.setBoolean(9, s.onGround());
            ps.setString(10, s.squawk());
            ps.setString(11, s.provider());
            ps.setTimestamp(12, Timestamp.from(s.fetchedAt()));
            ps.setInt(13, s.quality());
        });
        writtenRows.increment(batch.size());
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }
}
