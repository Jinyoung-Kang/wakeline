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
 *   <li>종료: 스트림 소비·WS going_away 뒤에(phase) 워커가 진행 중 배치를 끝내고 <b>스스로</b> 남은 행을 쓴다(DB 를 쓰는 스레드는 종료 때도
 *       하나 — 조사 2026-10-01: 예전에는 stop 이 2 s 기다린 뒤 다른 스레드가 flush 해 느린 쓰기와 같은 배치를 동시에 썼다). stop 요청 뒤 8 s 가
 *       지나면 새 배치를 쓰기 시작하지 않고, stop 은 최대 9 s 기다린다(lifecycle 단계 한도 10 s 안). 못 쓴 행은 dropped 로 센다. 못 쓴 행의 메시지는
 *       ACK 하지 않는다(다음 기동에서 PEL 로 다시 온다). stop 요청 뒤 실패한 쓰기는 기다리지 않고 종료 flush 가 한 번 더 쓴다. 워커가 오류(Error)로
 *       죽었으면 ERROR 한 줄을 남기고, 남은 행은 stop 이 쓴다(그때 쓰는 스레드는 stop 하나).</li>
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
    /** stop() 이 워커(진행 중 쓰기 + 마지막 flush)를 기다리는 상한 — lifecycle 단계 한도 10 s(application.yml timeout-per-shutdown-phase) 안. */
    static final long STOP_WAIT_MS = 9_000;
    /** 마지막 flush 는 stop 요청 뒤 (기다림 상한 − 이 값)이 지나면 새 배치를 쓰기 시작하지 않는다 — 마지막으로 시작한 배치가 커밋될 여유. */
    static final long LAST_BATCH_MARGIN_MS = 1_000;
    /** 정적 정보 갱신 대기열: 스냅샷(컬렉션 참조) 몇 벌만 — 더 쌓이면 가장 오래된 것을 버린다(다음 스냅샷이 같은 hex 를 다시 준다). */
    static final int STATIC_INBOX_MAX = 4;
    /**
     * 풀리지 않은 표식(= ACK 를 기다리는 항공기 메시지) 상한. 넘으면 가장 오래된 것부터 놓는다(wakeline_track_receipts_forced_total 로 센다) — DB 가
     * 오래 죽어 있을 때 표식과 PEL 이 끝없이 늘지 않게. 상한으로 놓는 것이 이미 스트림에서 지워져 PEL 로 되살릴 수 없는 메시지뿐이도록, 보존 창에 들 수
     * 있는 메시지 수 이상으로 잡는다. wakeline:aircraft 는 시간으로 자른다(MINID ~ 지금 − 2.5 h = 9,000 s, collector publisher.py — 바이트 예산은
     * 창을 줄일 뿐이다). 9,000 s 의 메시지 수를 설정의 가장 짧은 주기로 세면(수집기 코드의 상수):
     * 관심 지역 ≤ 1,801(region_poll_s 하한 5 s — runtime_settings.py REGION_POLL_RANGE_S; 기본 10 s 면 900) · 전세계 ≤ 151(하한 60 s; 기본 120 s 면 75) ·
     * focus ≤ 2,882(정기 5 s + 새 hex 의 빠른 첫 조회 — 앞 조회 2 s 뒤부터, 빠른 것끼리 5 s; 지금 상수로는 7 s 에 2번 = 2,572 지만 상수가 바뀌어도
     * 맞는 식으로 센다. 한 번에 hex ≤ 50 = 메시지 1개 — jobs/demand.py) · hot ≤ 2,408(창 30 s 마다 그때 있던 셀 ≤ 6 개가 한 번 + 새 셀의 즉시 첫 조회
     * 30 s 에 2번) · 수집기 Publisher 의 재전송 큐 ≤ 1,000(QUEUE_MAX — Redis 장애 뒤 새 ID 로 다시 XADD. 못 보낸 발행을 대신하므로 보통은 늘지
     * 않지만 보수적으로 더한다) = 8,242. 그래서 10,000.
     * 조사 2026-10-01: 예전 1,000 은 'MAXLEN ~200 보다 훨씬 크다' 가 근거였다 — 시간 트리밍 뒤로는 기본 주기의 관심 지역 · 전세계(975)만으로 여유가
     * 약 3 % 였고, focus 임대가 하나라도 있으면(5 s 마다 → 1,800 더) 스트림에 아직 있는 메시지를 놓았다. DB 장애가 길면 대개 큐 상한(50,000 행)이
     * 먼저 걸린다 — 행이 모두 넘쳐 버려진 메시지는 그때 놓인다(result=dropped 로 센다). 이 계산은 tools/contract_check.py(receipt_mark_bounds)가
     * 수집기 상수로 다시 한다 — 상수가 바뀌어 상한을 넘으면 그 검사가 실패한다.
     */
    static final int MAX_MARKS = 10_000;
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
    /** stop() 의 기다림 상한(테스트가 줄인다). */
    long stopWaitMs = STOP_WAIT_MS;
    private volatile boolean running;
    /** stop 을 요청한 시각(epoch ms, 없으면 0) — 마지막 flush 의 마감 기준. */
    private volatile long stopRequestedAtMs;
    private Thread worker;
    /** 실패해서 다시 쓸 배치(가장 오래된 행들). 워커 스레드에서만 만진다(종료 flush 도 워커가 한다). */
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

    @Override
    public void start() {
        stopRequestedAtMs = 0;
        running = true;
        worker = Thread.ofVirtual().name("track-writer").start(this::run);
    }

    /** 워커: 쓰기 루프 → 종료 flush. track_point · aircraft 를 쓰는 스레드는 이것 하나다. */
    private void run() {
        try {
            loop();
            flush();
        } catch (Error err) {
            // 예외가 아닌 오류(OOM · StackOverflowError 등)로 끝났다 — 조용히 죽지 않는다. 그 뒤 쌓이는 행은 stop 이 쓴다(쓰는 스레드가 그때는 stop 하나)
            log.error("track writer thread died ({}) — nothing writes track rows until shutdown; stop() then writes what is queued", err.toString(), err);
        }
    }

    /**
     * 워커가 진행 중 배치와 마지막 flush 를 끝내기를 최대 {@link #stopWaitMs} 기다린다 — 이 스레드는 쓰지 않는다. 그 안에 끝나지 않으면(쓰기 하나가
     * DB 에서 돌아오지 않음) 그렇다고 남기고 돌아간다: 워커는 마감 뒤 새 배치를 쓰기 시작하지 않고, 쓰지 않은 행의 메시지는 ACK 되지 않는다.
     */
    @Override
    public void stop() {
        requestStop();
        Thread w = worker;
        if (w == null) { // 시작한 적 없다 — 같이 쓰는 스레드가 없다
            flush();
            return;
        }
        try { w.join(stopWaitMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        if (w.isAlive()) {
            log.warn("track writer still busy {} ms after stop (a DB write has not returned) — shutdown continues; the writer starts no new batch and logs"
                    + " its own result, and rows it has not written keep their stream messages unacknowledged (re-processed on restart)", stopWaitMs);
            return;
        }
        // 워커는 끝났다 — 보통은 스스로 flush 했으므로 남은 것이 없다(빈 flush 는 아무것도 남기지 않는다). 오류로 죽었다면(run) 남은 행을 여기서 쓴다:
        // 쓰는 스레드는 이제 이것 하나다(리뷰 2026-10-01 — 예전에는 죽은 워커 뒤로 flush · WARN · dropped 가 없었다)
        flush();
    }

    private void requestStop() {
        if (stopRequestedAtMs == 0) stopRequestedAtMs = System.currentTimeMillis();
        running = false;
    }

    /** 같은 phase 의 순서 큐 비우기와 동시에 하도록 비동기로 멈춘다(Spring 이 콜백을 기다린다). */
    @Override
    public void stop(Runnable callback) {
        requestStop();
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
                if (!running) {
                    // stop 이 이미 요청됐다 — 기다려 다시 시도하지 않는다: 루프를 나가 곧바로 종료 flush 가 이 배치부터 쓴다(마감 안이면)
                    log.warn("track batch ({} rows) failed while stopping — the shutdown flush tries it once more before its deadline (queue {}): {}",
                            pending == null ? 0 : pending.rows().size(), queued(), e.toString());
                    continue;
                }
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
     * 종료 시(워커 — 시작한 적 없으면 stop 을 부른 스레드): 재시도 중이던 배치 + 큐를 마감(stop 요청 + 기다림 상한 − 여유) 안에서 한 번씩 순서대로
     * 쓴다. 못 쓴 행은 dropped 로 센다. 영수증은 앞에서부터 이어서 쓴 행까지만 놓는다 — 그 뒤(실패·마감)의 메시지는 ACK 하지 않아 다음 기동에서
     * 다시 처리된다.
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
        long stopAt = stopRequestedAtMs;
        long deadline = (stopAt > 0 ? stopAt : System.currentTimeMillis()) + stopWaitMs - LAST_BATCH_MARGIN_MS;
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
