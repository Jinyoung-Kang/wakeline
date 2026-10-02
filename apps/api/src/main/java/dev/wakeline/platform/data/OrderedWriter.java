package dev.wakeline.platform.data;

import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import dev.wakeline.platform.support.Receipt;
import dev.wakeline.platform.support.StreamPrerequisite;
import org.springframework.stereotype.Component;

import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 순서가 중요한 DB 쓰기의 단일 직렬 큐(가상 스레드 1개): 기동 시 정리 → SIGMET 세트 → 알림 이벤트를 받은 순서대로 쓴다(COR-15·REL-21).
 * 이전에는 배치마다 새 스레드를 띄워, 나중 배치의 LEFT/CLEARED UPDATE 가 앞 배치의 INSERT 보다 먼저 실행될 수 있었다.
 * <ul>
 *   <li>제출은 기다리지 않는다(offer). 큐(50,000)가 가득 차면 새 작업을 버리고 wakeline_persist_tasks_total{result="dropped"} 로 센다.</li>
 *   <li>일시 장애(연결 실패·풀 대기 초과·타임아웃·잠금 대기 한도)는 같은 작업을 백오프(1 s → 30 s)로 계속 재시도한다 — 뒤 작업이 앞지르지 않는다.
 *       쉬는 동안 DB 가 다시 답하면(DbRecovery — 답하지 않음 → 답함) 쉼을 끝까지 자지 않고 곧바로 다시 쓴다.</li>
 *   <li>그 밖의 오류(제약 위반 등)는 짧은 경합을 넘기도록 3회까지 재시도한 뒤 버리고 result="failed" 로 센다.</li>
 *   <li>종료: 스트림 소비·WS 가 멈춘 뒤(phase) 남은 작업을 최대 6 s 동안 한 번씩 시도하고, 못 쓴 것은 dropped 로 센다.</li>
 *   <li>영수증(API-CONC-8): 작업이 스트림 메시지의 결과면(SIGMET 세트) 쓰였거나 영구 오류로 버렸을 때 놓는다 → 그 메시지를 ACK.
 *       종료로 못 쓴 작업은 놓지 않는다 — 메시지가 PEL 에 남아 다음 기동에서 다시 처리된다. 큐가 넘쳐 버린 작업은 놓는다(지표로 센다).</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 쓰기 작업을 하지 않는다
@Component
public class OrderedWriter implements StreamPrerequisite, WriteBacklog {
    private static final Logger log = LoggerFactory.getLogger(OrderedWriter.class);
    /** 종료 순서: 스트림 소비(MAX-10) → WS going_away(MAX-100) → 이 큐·항적 flush(MAX-200) → Tomcat(MAX-1024). */
    public static final int PHASE = Integer.MAX_VALUE - 200;
    static final int QUEUE_MAX = 50_000;
    public static final int PERMANENT_ATTEMPTS = 3;
    static final long BACKOFF_START_MS = 1_000;
    static final long BACKOFF_MAX_MS = 30_000;
    /** 종료 시 비우기 마감. 소비 중지(≤5 s) + going_away + 이것(≤8 s, 항적 flush 와 동시) + Tomcat(≤10 s) 이 compose 유예 30 s 안에 든다. */
    static final long DRAIN_DEADLINE_MS = 6_000;

    /** 한 작업. kind 는 지표 태그(alert·sigmet_set·alert_reconcile …). receipt 는 이 작업이 결과를 들고 있는 스트림 메시지(없으면 NONE). */
    public interface Task {
        String kind();
        void run();
        default Receipt receipt() { return Receipt.NONE; }
    }

    public static Task task(String kind, Runnable r) {
        return task(kind, r, Receipt.NONE);
    }

    /** 영수증을 든 작업 — 호출자가 제출 전에 receipt.hold() 한다. 이 큐가 결과에 따라 놓는다. */
    public static Task task(String kind, Runnable r, Receipt receipt) {
        return new Task() {
            @Override public String kind() { return kind; }
            @Override public void run() { r.run(); }
            @Override public Receipt receipt() { return receipt; }
        };
    }

    /** 큐의 한 작업과 들어온 시각(epoch ms — 가장 오래된 미기록 작업의 나이, WriteBacklog). */
    private record Queued(Task task, long atMs) {}

    private final BlockingQueue<Queued> queue = new LinkedBlockingQueue<>(QUEUE_MAX);
    /** 워커가 쓰는 중(재시도 중 포함)인 작업이 들어온 시각, 없으면 -1. */
    private volatile long inflightAtMs = -1;
    private final MeterRegistry meters;
    private final long backoffStartMs;
    private final long backoffMaxMs;
    /** 일시 장애로 쉬는 동안 DB 가 다시 답하면 곧바로 깨운다(ADR-032 개정 — 쉼을 끝까지 자지 않는다). */
    private final DbRecovery recovery;
    private volatile boolean running;
    /** 종료 비우기의 마감(시험이 줄인다). */
    long drainDeadlineMs = DRAIN_DEADLINE_MS;
    /** 종료 후 비우기까지 끝났다 — 이후 제출은 처리될 수 없으므로 받지 않고 센다. */
    private volatile boolean stopped;
    private Thread worker;

    @org.springframework.beans.factory.annotation.Autowired
    public OrderedWriter(MeterRegistry meters, DbRecovery recovery) {
        this(meters, BACKOFF_START_MS, BACKOFF_MAX_MS, recovery);
    }

    /** 테스트용: 재시도 간격을 줄여 쓴다(DB 회복 확인 없이 — 쉼을 끝까지 잔다). */
    public OrderedWriter(MeterRegistry meters, long backoffStartMs, long backoffMaxMs) {
        this(meters, backoffStartMs, backoffMaxMs, DbRecovery.none());
    }

    /** 테스트용: DB 회복 확인을 바꿔 쓴다. */
    public OrderedWriter(MeterRegistry meters, long backoffStartMs, long backoffMaxMs, DbRecovery recovery) {
        this.recovery = recovery;
        this.meters = meters;
        this.backoffStartMs = backoffStartMs;
        this.backoffMaxMs = backoffMaxMs;
        meters.gauge("wakeline_persist_queue", queue, BlockingQueue::size);
        WriteBacklog.gauge(this, meters);
    }

    /** 순서대로 쓰도록 넣는다. 가득 찼거나 이미 종료했으면 false(버린 것으로 센다). */
    public boolean submit(Task t) {
        if (stopped) {
            count(t.kind(), "dropped"); // 영수증은 놓지 않는다 — 다음 기동에서 다시 처리된다
            return false;
        }
        if (queue.offer(new Queued(t, System.currentTimeMillis()))) return true;
        count(t.kind(), "dropped");
        log.warn("persist queue full ({}), dropped {} task", QUEUE_MAX, t.kind());
        t.receipt().release(); // 넘침: 되살릴 방법이 없다 — 센 뒤 ACK(PEL 이 끝없이 자라지 않게)
        return false;
    }

    public int pending() { return queue.size(); }

    @Override public String writerName() { return "ordered"; }

    /** 아직 쓰지 못한 작업 중 가장 오래된 것이 들어온 시각(쓰는 중 · 재시도 중인 작업, 없으면 큐의 맨 앞), 없으면 -1. */
    @Override
    public long oldestPendingAtMs() {
        long in = inflightAtMs;
        if (in >= 0) return in;
        Queued head = queue.peek();
        return head == null ? -1 : head.atMs();
    }

    /** 테스트용: 워커 없이 호출 스레드에서 큐를 순서대로 비운다(시작 전 상태에서 — 일시 장애는 재시도하지 않고 버린다). */
    public int drainNow() {
        int n = 0;
        Queued q;
        while ((q = queue.poll()) != null) if (runWithRetry(q.task())) n++;
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
            try { worker.join(drainDeadlineMs + 2_000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
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
            Queued q;
            try {
                q = queue.poll(500, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            if (q == null) continue;
            inflightAtMs = q.atMs();
            try {
                runWithRetry(q.task());
            } finally {
                inflightAtMs = -1;
            }
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
                t.receipt().release();
                return true;
            } catch (RuntimeException e) {
                boolean transientError = DbErrors.isTransient(e);
                if (!transientError && ++permanentFailures >= PERMANENT_ATTEMPTS) {
                    count(t.kind(), "failed");
                    log.warn("{} persist failed permanently after {} attempts, dropped: {}", t.kind(), permanentFailures, e.toString());
                    t.receipt().release(); // 다시 처리해도 같은 결과 — ACK 하고 failed 로 센다
                    return false;
                }
                if (!running) {
                    // 종료 중: 재시도하지 않는다 — drain 이 남은 것과 함께 센다
                    count(t.kind(), "dropped");
                    log.warn("{} persist failed during shutdown, dropped: {}", t.kind(), e.toString());
                    return false;
                }
                if (transientError) log.warn("{} persist failed (transient error), retry in {} ms: {}", t.kind(), backoff, e.toString());
                else log.info("{} persist failed (attempt {}/{}), retry in {} ms: {}", t.kind(), permanentFailures, PERMANENT_ATTEMPTS, backoff, e.toString());
                if (transientError) recovery.pause(backoff, () -> running); // DB 가 다시 답하면 일찍 깬다
                else sleepWhileRunning(backoff);
                backoff = Math.min(backoffMaxMs, backoff * 2);
            }
        }
    }

    /** 종료 시 남은 작업을 한 번씩 시도한다(마감 6 s). 못 쓴 것은 dropped 로 센다. */
    private void drain() {
        long deadline = System.currentTimeMillis() + drainDeadlineMs;
        int written = 0, dropped = 0;
        Queued q;
        while ((q = queue.poll()) != null) {
            Task t = q.task();
            if (System.currentTimeMillis() > deadline) {
                count(t.kind(), "dropped");
                dropped++;
                continue;
            }
            try {
                t.run();
                count(t.kind(), "ok");
                t.receipt().release();
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
        meters.counter("wakeline_persist_tasks_total", "kind", kind, "result", result).increment();
    }
}
