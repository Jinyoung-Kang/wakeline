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

import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.TimeUnit;

/**
 * 항적 배치 저장 + 항공기 정적 정보(aircraft) 갱신 — 둘 다 이 가상 스레드에서만 DB 를 쓴다. 이벤트 리스너는 큐에 넣기만 한다
 * (스트림 소비 스레드·WS 팬아웃이 DB 를 기다리지 않는다, PERF-1·REL-9).
 * <ul>
 *   <li>큐 상한 50,000행 — 넘치면 오래된 것부터 버리고 skywx_track_rows_total{result="dropped"} 로 센다(5.1절 DB 느림).</li>
 *   <li>배치 실패(REL-10): 버리지 않는다. 일시 장애(연결·풀 대기·타임아웃)는 같은 배치를 백오프(2 s → 30 s)로 재시도하고, 그동안
 *       새 행은 큐에 쌓인다(넘치면 위 규칙). 영구 오류(데이터·제약·권한, SQLState 22·23·42)는 3회 시도 뒤 버리고 result="failed" 로 센다.</li>
 *   <li>종료: 스트림 소비·WS going_away 뒤에(phase) 남은 행을 최대 6 s 동안 쓰고, 못 쓴 행은 dropped 로 센다.</li>
 * </ul>
 * (hex, ts) PK 에 ON CONFLICT DO NOTHING 이라 재처리·재시도로 같은 행이 와도 중복되지 않는다.
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 웹·소비자·잡을 띄우지 않는다
@Component
public class TrackWriter implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(TrackWriter.class);
    static final int QUEUE_MAX = 50_000;
    static final int BATCH = 2_000;
    static final int PERMANENT_ATTEMPTS = 3;
    static final long BACKOFF_START_MS = 2_000;
    static final long BACKOFF_MAX_MS = 30_000;
    /** 종료 flush 마감 — 워커 정지 대기(≤2 s)와 합쳐 lifecycle 단계 한도(10 s) 안에 끝난다. */
    static final long FLUSH_DEADLINE_MS = 6_000;
    /** 정적 정보 갱신 대기열: 스냅샷(컬렉션 참조) 몇 벌만 — 더 쌓이면 가장 오래된 것을 버린다(다음 스냅샷이 같은 hex 를 다시 준다). */
    static final int STATIC_INBOX_MAX = 4;
    static final long STATIC_BACKOFF_MS = 30_000;
    private static final String SQL = """
            INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, vrate_fpm, on_ground, squawk, provider, fetched_at, quality)
            VALUES (?, ?, ST_SetSRID(ST_MakePoint(?, ?), 4326), ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (hex, ts) DO NOTHING""";

    private final JdbcTemplate jdbc;
    private final AircraftRepository aircraft;
    private final BlockingQueue<AircraftState> queue = new ArrayBlockingQueue<>(QUEUE_MAX);
    private final LinkedBlockingDeque<Collection<AircraftState>> staticInbox = new LinkedBlockingDeque<>();
    private final Counter droppedRows;
    private final Counter failedRows;
    private final Counter writtenRows;
    private final Counter staticRows;
    private volatile boolean running;
    private Thread worker;
    /** 실패해서 다시 쓸 배치(가장 오래된 행들). 워커 스레드에서만 만진다. */
    private volatile List<AircraftState> pending;
    private long staticRetryAtMs;
    private final long backoffStartMs;
    private final long backoffMaxMs;

    @org.springframework.beans.factory.annotation.Autowired
    public TrackWriter(JdbcTemplate jdbc, AircraftRepository aircraft, MeterRegistry meters) {
        this(jdbc, aircraft, meters, BACKOFF_START_MS, BACKOFF_MAX_MS);
    }

    /** 테스트용: 재시도 간격을 줄여 쓴다. */
    TrackWriter(JdbcTemplate jdbc, AircraftRepository aircraft, MeterRegistry meters, long backoffStartMs, long backoffMaxMs) {
        this.backoffStartMs = backoffStartMs;
        this.backoffMaxMs = backoffMaxMs;
        this.jdbc = jdbc;
        this.aircraft = aircraft;
        meters.gauge("skywx_track_queue", queue, BlockingQueue::size);
        droppedRows = Counter.builder("skywx_track_rows_total").tag("result", "dropped").register(meters);
        failedRows = Counter.builder("skywx_track_rows_total").tag("result", "failed").register(meters);
        writtenRows = Counter.builder("skywx_track_rows_total").tag("result", "written").register(meters);
        staticRows = Counter.builder("skywx_aircraft_static_rows_total").register(meters);
    }

    @EventListener
    public void onSnapshot(IngestEvents.SnapshotUpdated e) {
        enqueue(e.current().states().values());
    }

    /** 재시작·재시도로 밀린 백로그(실시간 상태엔 반영하지 않은 과거 엔트리)도 항적으로는 이어서 저장한다(REL-8). */
    @EventListener
    public void onBacklog(IngestEvents.AircraftBacklog e) {
        enqueue(e.states());
    }

    void enqueue(Collection<AircraftState> states) {
        if (!running) {
            // 종료 뒤에 들어온 행은 쓸 스레드가 없다 — 조용히 잃지 않고 센다
            droppedRows.increment(states.size());
            return;
        }
        for (AircraftState s : states) {
            if (!queue.offer(s)) {
                queue.poll();
                queue.offer(s);
                droppedRows.increment();
            }
        }
        while (staticInbox.size() >= STATIC_INBOX_MAX) staticInbox.pollFirst();
        staticInbox.offerLast(states);
    }

    @Override public void start() { running = true; worker = Thread.ofVirtual().name("track-writer").start(this::loop); }

    @Override
    public void stop() {
        running = false;
        if (worker != null) {
            try { worker.join(2_000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
        flush();
    }

    /** 같은 phase 의 순서 큐 비우기와 동시에 하도록 비동기로 멈춘다(Spring 이 콜백을 기다린다). */
    @Override
    public void stop(Runnable callback) {
        running = false;
        Thread.ofVirtual().name("track-writer-stop").start(() -> {
            try { stop(); } finally { callback.run(); }
        });
    }

    @Override public boolean isRunning() { return running; }

    /** 종료 순서: 스트림 소비(MAX-10) → WS going_away(MAX-100) → 항적 flush(MAX-200). 높은 phase 가 먼저 멈춘다. */
    @Override public int getPhase() { return OrderedWriter.PHASE; }

    private void loop() {
        long backoff = backoffStartMs;
        int permanentFailures = 0;
        while (running) {
            try {
                if (pending == null) {
                    AircraftState first = queue.poll(1, TimeUnit.SECONDS);
                    if (first != null) {
                        List<AircraftState> batch = new ArrayList<>(BATCH);
                        batch.add(first);
                        queue.drainTo(batch, BATCH - 1);
                        pending = batch;
                    }
                }
                if (pending != null) {
                    write(pending);
                    pending = null;
                    backoff = backoffStartMs;
                    permanentFailures = 0;
                }
                touchStatic();
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return;
            } catch (RuntimeException e) {
                if (!isPermanent(e)) {
                    log.warn("track batch ({} rows) failed, retry in {} ms (queue {}): {}", pending == null ? 0 : pending.size(), backoff, queue.size(), e.toString());
                } else if (++permanentFailures >= PERMANENT_ATTEMPTS) {
                    int n = pending == null ? 0 : pending.size();
                    failedRows.increment(n);
                    log.warn("track batch ({} rows) failed permanently after {} attempts, dropped: {}", n, permanentFailures, e.toString());
                    pending = null;
                    permanentFailures = 0;
                    backoff = backoffStartMs;
                    continue;
                } else {
                    log.info("track batch failed (attempt {}/{}), retry in {} ms: {}", permanentFailures, PERMANENT_ATTEMPTS, backoff, e.toString());
                }
                sleepWhileRunning(backoff);
                backoff = Math.min(backoffMaxMs, backoff * 2);
            }
        }
    }

    /** 정적 정보: 대기 중인 스냅샷들을 hex 당 마지막 상태로 합쳐 한 번에 쓴다. 실패하면 30 s 동안 쉬고(DB 장애 중 헛도는 요청 방지) 다음 스냅샷에 다시. */
    private void touchStatic() {
        if (staticInbox.isEmpty() || System.currentTimeMillis() < staticRetryAtMs) return;
        Map<String, AircraftState> latest = new LinkedHashMap<>();
        Collection<AircraftState> c;
        while ((c = staticInbox.pollFirst()) != null) for (AircraftState s : c) latest.put(s.hex(), s);
        try {
            staticRows.increment(aircraft.touch(latest.values()));
        } catch (RuntimeException e) {
            staticRetryAtMs = System.currentTimeMillis() + STATIC_BACKOFF_MS;
            log.warn("aircraft static upsert failed ({} aircraft), retry after {} s: {}", latest.size(), STATIC_BACKOFF_MS / 1000, e.toString());
        }
    }

    /** 종료 시: 재시도 중이던 배치 + 큐를 마감 안에서 한 번씩 쓴다. 못 쓴 행은 dropped 로 센다. */
    void flush() {
        List<AircraftState> rest = new ArrayList<>();
        if (pending != null) rest.addAll(pending);
        pending = null;
        queue.drainTo(rest);
        long deadline = System.currentTimeMillis() + FLUSH_DEADLINE_MS;
        int written = 0;
        for (int i = 0; i < rest.size(); i += BATCH) {
            List<AircraftState> b = rest.subList(i, Math.min(rest.size(), i + BATCH));
            if (System.currentTimeMillis() > deadline) break;
            try {
                write(b);
                written += b.size();
            } catch (RuntimeException e) {
                log.warn("flush failed: {}", e.toString());
            }
        }
        int lost = rest.size() - written;
        if (lost > 0) {
            droppedRows.increment(lost);
            log.warn("track flush on shutdown: {} rows written, {} rows dropped", written, lost);
        } else if (written > 0) {
            log.info("track flush on shutdown: {} rows written", written);
        }
    }

    void write(List<AircraftState> batch) {
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

    /**
     * 재시도해도 같은 결과인 오류: SQLState 22(데이터)·23(제약 — 파티션 없음 포함)·42(문법·권한). 파티션 없음은 3회 재시도 사이에
     * ensurePartitions 가 만들 수 있어 바로 버리지 않는다. 연결·자원 오류는 일시 장애로 본다.
     */
    static boolean isPermanent(Throwable e) {
        if (OrderedWriter.isTransient(e)) return false;
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause()) {
            if (c instanceof SQLException s && s.getSQLState() != null) {
                String st = s.getSQLState();
                return st.startsWith("22") || st.startsWith("23") || st.startsWith("42");
            }
        }
        return false;
    }

    int queued() { return queue.size(); }

    private void sleepWhileRunning(long ms) {
        long until = System.currentTimeMillis() + ms;
        while (running && System.currentTimeMillis() < until) {
            try { Thread.sleep(Math.min(100, Math.max(1, until - System.currentTimeMillis()))); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
        }
    }
}
