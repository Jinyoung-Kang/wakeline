package dev.skywx.persist;

import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.NonTransientDataAccessResourceException;
import org.springframework.dao.RecoverableDataAccessException;
import org.springframework.dao.TransientDataAccessException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.CannotCreateTransactionException;

import java.sql.SQLException;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 순서가 중요한 DB 쓰기의 단일 직렬 큐(가상 스레드 1개): 기동 시 정리 → SIGMET 세트 → 알림 이벤트를 받은 순서대로 쓴다(COR-15·REL-21).
 * 이전에는 배치마다 새 스레드를 띄워, 나중 배치의 LEFT/CLEARED UPDATE 가 앞 배치의 INSERT 보다 먼저 실행될 수 있었다.
 * <ul>
 *   <li>제출은 기다리지 않는다(offer). 큐(50,000)가 가득 차면 새 작업을 버리고 skywx_persist_tasks_total{result="dropped"} 로 센다.</li>
 *   <li>일시 장애(연결 실패·풀 대기 초과·타임아웃)는 같은 작업을 백오프(1 s → 30 s)로 계속 재시도한다 — 뒤 작업이 앞지르지 않는다.</li>
 *   <li>그 밖의 오류(제약 위반 등)는 짧은 경합을 넘기도록 3회까지 재시도한 뒤 버리고 result="failed" 로 센다.</li>
 *   <li>종료: 스트림 소비·WS 가 멈춘 뒤(phase) 남은 작업을 최대 6 s 동안 한 번씩 시도하고, 못 쓴 것은 dropped 로 센다.</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 쓰기 작업을 하지 않는다
@Component
public class OrderedWriter implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(OrderedWriter.class);
    /** 종료 순서: 스트림 소비(MAX-10) → WS going_away(MAX-100) → 이 큐·항적 flush(MAX-200) → Tomcat(MAX-1024). */
    public static final int PHASE = Integer.MAX_VALUE - 200;
    static final int QUEUE_MAX = 50_000;
    static final int PERMANENT_ATTEMPTS = 3;
    static final long BACKOFF_START_MS = 1_000;
    static final long BACKOFF_MAX_MS = 30_000;
    /** 종료 시 비우기 마감. 소비 중지(≤5 s) + going_away + 이것(≤8 s, 항적 flush 와 동시) + Tomcat(≤10 s) 이 compose 유예 30 s 안에 든다. */
    static final long DRAIN_DEADLINE_MS = 6_000;

    /** 한 작업. kind 는 지표 태그(alert·sigmet_set·alert_reconcile …). */
    public interface Task {
        String kind();
        void run();
    }

    public static Task task(String kind, Runnable r) {
        return new Task() {
            @Override public String kind() { return kind; }
            @Override public void run() { r.run(); }
        };
    }

    private final BlockingQueue<Task> queue = new LinkedBlockingQueue<>(QUEUE_MAX);
    private final MeterRegistry meters;
    private final long backoffStartMs;
    private final long backoffMaxMs;
    private volatile boolean running;
    /** 종료 후 비우기까지 끝났다 — 이후 제출은 처리될 수 없으므로 받지 않고 센다. */
    private volatile boolean stopped;
    private Thread worker;

    @org.springframework.beans.factory.annotation.Autowired
    public OrderedWriter(MeterRegistry meters) {
        this(meters, BACKOFF_START_MS, BACKOFF_MAX_MS);
    }

    /** 테스트용: 재시도 간격을 줄여 쓴다. */
    OrderedWriter(MeterRegistry meters, long backoffStartMs, long backoffMaxMs) {
        this.meters = meters;
        this.backoffStartMs = backoffStartMs;
        this.backoffMaxMs = backoffMaxMs;
        meters.gauge("skywx_persist_queue", queue, BlockingQueue::size);
    }

    /** 순서대로 쓰도록 넣는다. 가득 찼거나 이미 종료했으면 false(버린 것으로 센다). */
    public boolean submit(Task t) {
        if (stopped) {
            count(t.kind(), "dropped");
            return false;
        }
        if (queue.offer(t)) return true;
        count(t.kind(), "dropped");
        log.warn("persist queue full ({}), dropped {} task", QUEUE_MAX, t.kind());
        return false;
    }

    public int pending() { return queue.size(); }

    /** 테스트용: 워커 없이 호출 스레드에서 큐를 순서대로 비운다(시작 전 상태에서 — 일시 장애는 재시도하지 않고 버린다). */
    int drainNow() {
        int n = 0;
        Task t;
        while ((t = queue.poll()) != null) if (runWithRetry(t)) n++;
        return n;
    }

    @Override
    public void start() {
        running = true;
        worker = Thread.ofVirtual().name("ordered-db-writer").start(this::loop);
    }

    @Override
    public void stop() {
        running = false;
        if (worker != null) {
            try { worker.join(DRAIN_DEADLINE_MS + 2_000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
    }

    /** 같은 phase 의 TrackWriter flush 와 동시에 비우도록 비동기로 멈춘다(Spring 이 콜백을 기다린다). */
    @Override
    public void stop(Runnable callback) {
        running = false;
        Thread.ofVirtual().name("ordered-db-writer-stop").start(() -> {
            try { stop(); } finally { callback.run(); }
        });
    }

    @Override public boolean isRunning() { return running; }
    @Override public int getPhase() { return PHASE; }

    private void loop() {
        while (running) {
            Task t;
            try {
                t = queue.poll(500, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            if (t != null) runWithRetry(t);
        }
        drain();
        stopped = true;
        drain(); // stopped 로 바뀌기 직전에 들어온 것까지
    }

    /** 성공하거나, 영구 오류로 버리거나, 종료가 시작될 때까지. @return 썼으면 true */
    boolean runWithRetry(Task t) {
        long backoff = backoffStartMs;
        int permanentFailures = 0;
        while (true) {
            try {
                t.run();
                count(t.kind(), "ok");
                return true;
            } catch (RuntimeException e) {
                boolean transientError = isTransient(e);
                if (!transientError && ++permanentFailures >= PERMANENT_ATTEMPTS) {
                    count(t.kind(), "failed");
                    log.warn("{} persist failed permanently after {} attempts, dropped: {}", t.kind(), permanentFailures, e.toString());
                    return false;
                }
                if (!running) {
                    // 종료 중: 재시도하지 않는다 — drain 이 남은 것과 함께 센다
                    count(t.kind(), "dropped");
                    log.warn("{} persist failed during shutdown, dropped: {}", t.kind(), e.toString());
                    return false;
                }
                if (transientError) log.warn("{} persist failed (data store unavailable), retry in {} ms: {}", t.kind(), backoff, e.toString());
                else log.info("{} persist failed (attempt {}/{}), retry in {} ms: {}", t.kind(), permanentFailures, PERMANENT_ATTEMPTS, backoff, e.toString());
                sleepWhileRunning(backoff);
                backoff = Math.min(backoffMaxMs, backoff * 2);
            }
        }
    }

    /** 종료 시 남은 작업을 한 번씩 시도한다(마감 6 s). 못 쓴 것은 dropped 로 센다. */
    private void drain() {
        long deadline = System.currentTimeMillis() + DRAIN_DEADLINE_MS;
        int written = 0, dropped = 0;
        Task t;
        while ((t = queue.poll()) != null) {
            if (System.currentTimeMillis() > deadline) {
                count(t.kind(), "dropped");
                dropped++;
                continue;
            }
            try {
                t.run();
                count(t.kind(), "ok");
                written++;
            } catch (RuntimeException e) {
                count(t.kind(), "dropped");
                dropped++;
            }
        }
        if (written + dropped > 0) log.info("persist queue drained on shutdown: {} written, {} dropped", written, dropped);
    }

    private void sleepWhileRunning(long ms) {
        long until = System.currentTimeMillis() + ms;
        while (running && System.currentTimeMillis() < until) {
            try { Thread.sleep(Math.min(100, Math.max(1, until - System.currentTimeMillis()))); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
        }
    }

    private void count(String kind, String result) {
        meters.counter("skywx_persist_tasks_total", "kind", kind, "result", result).increment();
    }

    /**
     * 기다리면 나을 오류인가: 연결 실패·풀 대기 초과·타임아웃·교착/직렬화 실패, 또는 SQLState 08(연결)·53(자원 부족)·57P(관리자 종료)·40(롤백).
     * 제약 위반·권한·문법 오류는 기다려도 같다.
     */
    static boolean isTransient(Throwable e) {
        if (e instanceof DataAccessResourceFailureException || e instanceof NonTransientDataAccessResourceException
                || e instanceof TransientDataAccessException || e instanceof RecoverableDataAccessException
                || e instanceof CannotCreateTransactionException) return true;
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause()) {
            if (c instanceof SQLException s && s.getSQLState() != null) {
                String st = s.getSQLState();
                if (st.startsWith("08") || st.startsWith("53") || st.startsWith("57P") || st.startsWith("40")) return true;
            }
        }
        return false;
    }
}
