package dev.wakeline.persist;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.Receipt;
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
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 항적 배치 저장 + 항공기 정적 정보(aircraft) 갱신 — 둘 다 이 가상 스레드에서만 DB 를 쓴다. 이벤트 리스너는 큐에 넣기만 한다
 * (스트림 소비 스레드·WS 팬아웃이 DB 를 기다리지 않는다, PERF-1·REL-9).
 * <ul>
 *   <li>큐 상한 50,000행 — 넘치면 오래된 것부터 버리고 wakeline_track_rows_total{result="dropped"} 로 센다(5.1절 DB 느림).</li>
 *   <li>배치 실패(REL-10): 버리지 않는다. 일시 장애(연결·풀 대기·타임아웃)는 같은 배치를 백오프(2 s → 30 s)로 재시도하고, 그동안
 *       새 행은 큐에 쌓인다(넘치면 위 규칙). 영구 오류(카디널리티·데이터·제약·권한, SQLState 21·22·23·42)는 3회 시도 뒤 버리고 result="failed" 로 센다.</li>
 *   <li>at-least-once(API-CONC-8): 메시지마다 그 메시지의 마지막 행 번호(seq)에 표식(영수증)을 단다. 행은 들어온 순서대로 큐를 떠나고
 *       (배치 또는 넘침으로 버림), 배치는 한 번에 하나씩 끝나므로 "여기까지의 행은 모두 끝났다"(resolvedUpTo)를 셀 수 있다. 표식의 seq 가
 *       그 안에 들면 영수증을 놓는다 → 스트림 메시지 ACK. 커밋 전에 프로세스가 죽으면 ACK 되지 않은 메시지가 PEL 에 남아 재처리된다.
 *       넘침으로 버린 행·영구 오류 행은 '끝난' 것으로 친다(되살릴 수 없다 — 지표로 센다).</li>
 *   <li>종료: 스트림 소비·WS going_away 뒤에(phase) 남은 행을 최대 6 s 동안 쓰고, 못 쓴 행은 dropped 로 센다. 못 쓴 행의 메시지는
 *       ACK 하지 않는다(다음 기동에서 PEL 로 다시 온다).</li>
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
    /**
     * 풀리지 않은 표식(= ACK 를 기다리는 메시지) 상한. 스트림 보존(MAXLEN ~200, 항공기·SIGMET·레이더 합쳐)보다 훨씬 크다 — 이보다 오래된
     * 메시지는 스트림에서 이미 지워져 PEL 로 되살릴 수 없으므로, DB 가 오래 죽어 있을 때 표식이 끝없이 쌓이지 않게 가장 오래된 것부터 놓는다
     * (wakeline_track_receipts_forced_total 로 센다).
     */
    static final int MAX_MARKS = 1_000;
    static final long STATIC_BACKOFF_MS = 30_000;
    private static final String SQL = """
            INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, vrate_fpm, on_ground, squawk, provider, fetched_at, quality)
            VALUES (?, ?, ST_SetSRID(ST_MakePoint(?, ?), 4326), ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (hex, ts) DO NOTHING""";

    /** 큐의 한 행: 들어온 순서 번호(1부터)와 상태. */
    record Row(long seq, AircraftState state) {}

    /** 메시지 표식: 그 메시지의 마지막 행 번호까지 끝나면 영수증을 놓는다. */
    private record Mark(long seq, Receipt receipt) {}

    /** 쓰는 중(또는 재시도 중)인 배치. 워커 스레드만 바꾼다(읽기는 lock 안에서). */
    private record Batch(long firstSeq, long lastSeq, List<AircraftState> rows) {}

    private final JdbcTemplate jdbc;
    private final AircraftRepository aircraft;
    // ---- lock 으로 보호: 큐 · 순서 번호 · 표식 · 진행 중 배치 범위 ----
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition notEmpty = lock.newCondition();
    private final ArrayDeque<Row> queue = new ArrayDeque<>();
    private final ArrayDeque<Mark> marks = new ArrayDeque<>();
    private long nextSeq = 1;
    /** 큐를 떠난(배치로 가져갔거나 넘쳐 버린) 마지막 행 번호. 행은 번호 순서대로 떠난다. */
    private long left;
    /** 진행 중 배치의 첫 행 번호, 없으면 0. 그 앞까지는 끝났다. */
    private long outstandingFrom;
    // ----
    private final LinkedBlockingDeque<Collection<AircraftState>> staticInbox = new LinkedBlockingDeque<>();
    private final Counter droppedRows;
    private final Counter failedRows;
    private final Counter writtenRows;
    private final Counter staticRows;
    private final Counter forcedReceipts;
    private volatile boolean running;
    private Thread worker;
    /** 실패해서 다시 쓸 배치(가장 오래된 행들). 워커 스레드에서만 만진다(종료 flush 는 워커가 멈춘 뒤). */
    private volatile Batch pending;
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
        meters.gauge("wakeline_track_queue", this, TrackWriter::queued);
        droppedRows = Counter.builder("wakeline_track_rows_total").tag("result", "dropped").register(meters);
        failedRows = Counter.builder("wakeline_track_rows_total").tag("result", "failed").register(meters);
        writtenRows = Counter.builder("wakeline_track_rows_total").tag("result", "written").register(meters);
        staticRows = Counter.builder("wakeline_aircraft_static_rows_total").register(meters);
        forcedReceipts = Counter.builder("wakeline_track_receipts_forced_total")
                .description("행이 durable 해지기 전에 상한 때문에 놓은 메시지 영수증(스트림 보존보다 오래된 것)").register(meters);
    }

    @EventListener
    public void onSnapshot(IngestEvents.SnapshotUpdated e) {
        enqueue(e.current().states().values(), e.receipt());
    }

    /** 재시작·재시도로 밀린 백로그(실시간 상태엔 반영하지 않은 과거 엔트리)도 항적으로는 이어서 저장한다(REL-8). */
    @EventListener
    public void onBacklog(IngestEvents.AircraftBacklog e) {
        enqueue(e.states(), e.receipt());
    }

    void enqueue(Collection<AircraftState> states) { enqueue(states, Receipt.NONE); }

    /**
     * 행을 큐에 넣는다(스트림 소비 스레드 — DB 를 기다리지 않는다). 영수증이 있으면 이 메시지의 마지막 행에 표식을 단다.
     * 종료 뒤에 들어온 행은 쓸 스레드가 없다 — 조용히 잃지 않고 dropped 로 센다(영수증은 잡지 않으므로 그 메시지는 곧 ACK 된다:
     * 종료 중에는 소비가 먼저 멈추므로 실제로는 오지 않는다).
     */
    void enqueue(Collection<AircraftState> states, Receipt receipt) {
        if (!running) {
            droppedRows.increment(states.size());
            return;
        }
        if (states.isEmpty()) return;
        List<Receipt> done;
        int dropped = 0, forced = 0;
        lock.lock();
        try {
            for (AircraftState s : states) {
                if (queue.size() >= QUEUE_MAX) {
                    Row old = queue.pollFirst();
                    left = Math.max(left, old.seq());
                    dropped++;
                }
                queue.addLast(new Row(nextSeq++, s));
            }
            if (receipt.tracked()) {
                receipt.hold();
                marks.addLast(new Mark(nextSeq - 1, receipt));
            }
            done = new ArrayList<>(dropped > 0 ? takeResolvedMarks() : List.of());
            while (marks.size() > MAX_MARKS) { // 오래 막혀 있다 — 스트림에서도 이미 지워진 메시지다
                done.add(marks.pollFirst().receipt());
                forced++;
            }
            notEmpty.signal();
        } finally {
            lock.unlock();
        }
        if (dropped > 0) droppedRows.increment(dropped);
        if (forced > 0) forcedReceipts.increment(forced);
        done.forEach(Receipt::release);
        while (staticInbox.size() >= STATIC_INBOX_MAX) staticInbox.pollFirst();
        staticInbox.offerLast(states);
    }

    /** lock 안에서: 모든 행이 끝난 표식을 꺼낸다(놓기는 lock 밖에서). */
    private List<Receipt> takeResolvedMarks() {
        long resolvedUpTo = outstandingFrom > 0 ? outstandingFrom - 1 : left;
        List<Receipt> out = null;
        while (!marks.isEmpty() && marks.peekFirst().seq() <= resolvedUpTo) {
            if (out == null) out = new ArrayList<>();
            out.add(marks.pollFirst().receipt());
        }
        return out == null ? List.of() : out;
    }

    /** 워커: 최대 1 s 기다려 한 배치를 꺼낸다. 없으면 null. */
    private Batch nextBatch() throws InterruptedException {
        lock.lock();
        try {
            if (queue.isEmpty()) notEmpty.await(1, TimeUnit.SECONDS);
            if (queue.isEmpty()) return null;
            List<AircraftState> rows = new ArrayList<>(Math.min(BATCH, queue.size()));
            long first = queue.peekFirst().seq(), last = first;
            while (rows.size() < BATCH && !queue.isEmpty()) {
                Row r = queue.pollFirst();
                rows.add(r.state());
                last = r.seq();
            }
            left = Math.max(left, last);
            outstandingFrom = first;
            return new Batch(first, last, rows);
        } finally {
            lock.unlock();
        }
    }

    /** 워커: 진행 중 배치가 끝났다(커밋 또는 영구 실패) — 그 덕에 끝난 표식의 영수증을 놓는다. */
    private void batchResolved() {
        List<Receipt> done;
        lock.lock();
        try {
            outstandingFrom = 0;
            done = takeResolvedMarks();
        } finally {
            lock.unlock();
        }
        done.forEach(Receipt::release);
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

    /** 종료 순서: 스트림 소비(MAX-10) → WS going_away(MAX-100) → 항적 flush(MAX-200) → 마지막 ACK(MAX-250). 높은 phase 가 먼저 멈춘다. */
    @Override public int getPhase() { return OrderedWriter.PHASE; }

    private void loop() {
        long backoff = backoffStartMs;
        int permanentFailures = 0;
        while (running) {
            try {
                if (pending == null) pending = nextBatch();
                if (pending != null) {
                    write(pending.rows());
                    pending = null;
                    batchResolved();
                    backoff = backoffStartMs;
                    permanentFailures = 0;
                }
                touchStatic();
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                return;
            } catch (RuntimeException e) {
                if (!isPermanent(e)) {
                    log.warn("track batch ({} rows) failed, retry in {} ms (queue {}): {}", pending == null ? 0 : pending.rows().size(), backoff, queued(), e.toString());
                } else if (++permanentFailures >= PERMANENT_ATTEMPTS) {
                    int n = pending == null ? 0 : pending.rows().size();
                    failedRows.increment(n);
                    log.warn("track batch ({} rows) failed permanently after {} attempts, dropped: {}", n, permanentFailures, e.toString());
                    pending = null;
                    batchResolved(); // 다시 처리해도 같은 결과 — 그 메시지들은 ACK(failed 로 셌다)
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

    /**
     * 종료 시: 재시도 중이던 배치 + 큐를 마감 안에서 한 번씩 순서대로 쓴다. 못 쓴 행은 dropped 로 센다.
     * 영수증은 앞에서부터 이어서 쓴 행까지만 놓는다 — 그 뒤(실패·마감)의 메시지는 ACK 하지 않아 다음 기동에서 다시 처리된다.
     */
    void flush() {
        List<Batch> rest = new ArrayList<>();
        Batch p = pending;
        pending = null;
        if (p != null) rest.add(p);
        Batch b;
        try {
            while ((b = drainForFlush()) != null) rest.add(b);
        } catch (RuntimeException e) {
            log.warn("flush drain failed: {}", e.toString());
        }
        long deadline = System.currentTimeMillis() + FLUSH_DEADLINE_MS;
        int written = 0, total = 0;
        boolean contiguous = true;
        for (Batch x : rest) {
            total += x.rows().size();
            if (!contiguous || System.currentTimeMillis() > deadline) { contiguous = false; continue; }
            try {
                write(x.rows());
                written += x.rows().size();
                lock.lock();
                try { outstandingFrom = 0; left = Math.max(left, x.lastSeq()); } finally { lock.unlock(); }
                releaseUpTo(x.lastSeq());
            } catch (RuntimeException e) {
                contiguous = false;
                log.warn("flush failed: {}", e.toString());
            }
        }
        int lost = total - written;
        if (lost > 0) {
            droppedRows.increment(lost);
            log.warn("track flush on shutdown: {} rows written, {} rows dropped (their stream messages stay pending and are re-processed on restart)", written, lost);
        } else if (written > 0) {
            log.info("track flush on shutdown: {} rows written", written);
        }
    }

    /** 종료 flush 용: 큐에서 한 배치(기다리지 않음). */
    private Batch drainForFlush() {
        lock.lock();
        try {
            if (queue.isEmpty()) return null;
            List<AircraftState> rows = new ArrayList<>(Math.min(BATCH, queue.size()));
            long first = queue.peekFirst().seq(), last = first;
            while (rows.size() < BATCH && !queue.isEmpty()) {
                Row r = queue.pollFirst();
                rows.add(r.state());
                last = r.seq();
            }
            return new Batch(first, last, rows);
        } finally {
            lock.unlock();
        }
    }

    private void releaseUpTo(long seq) {
        List<Receipt> done = new ArrayList<>();
        lock.lock();
        try {
            while (!marks.isEmpty() && marks.peekFirst().seq() <= seq) done.add(marks.pollFirst().receipt());
        } finally {
            lock.unlock();
        }
        done.forEach(Receipt::release);
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
     * 재시도해도 같은 결과인 오류: SQLState 21(카디널리티 — 한 문장이 같은 행을 두 번 upsert)·22(데이터)·23(제약 — 파티션 없음 포함)·
     * 42(문법·권한). 파티션 없음은 3회 재시도 사이에 ensurePartitions 가 만들 수 있어 바로 버리지 않는다. 연결·자원 오류는 일시 장애로 본다.
     */
    static boolean isPermanent(Throwable e) {
        if (OrderedWriter.isTransient(e)) return false;
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause()) {
            if (c instanceof SQLException s && s.getSQLState() != null) {
                String st = s.getSQLState();
                return st.startsWith("21") || st.startsWith("22") || st.startsWith("23") || st.startsWith("42");
            }
        }
        return false;
    }

    int queued() {
        lock.lock();
        try { return queue.size(); } finally { lock.unlock(); }
    }

    /** 아직 영수증을 놓지 않은 메시지 수(테스트·지표용). */
    int pendingMarks() {
        lock.lock();
        try { return marks.size(); } finally { lock.unlock(); }
    }

    private void sleepWhileRunning(long ms) {
        long until = System.currentTimeMillis() + ms;
        while (running && System.currentTimeMillis() < until) {
            try { Thread.sleep(Math.min(100, Math.max(1, until - System.currentTimeMillis()))); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
        }
    }
}
