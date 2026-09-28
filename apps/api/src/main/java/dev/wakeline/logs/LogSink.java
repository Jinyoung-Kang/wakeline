package dev.wakeline.logs;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.SmartLifecycle;
import org.springframework.data.redis.connection.RedisStreamCommands.XAddOptions;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;

/**
 * 시스템 로그 싱크(계약 v5 §C2, ADR-018): 이 프로세스의 WARN·ERROR 를 가려서 Redis 스트림 {@value #STREAM} 에, 브라우저 오류(§C6)는
 * 따로 자르는 {@value #CLIENT_STREAM} 에 싣는다(§G2 — {@link LogStream}: 익명 입력이 서버 오류를 밀어내지 못하게).
 * <ul>
 *   <li>등록: 기동 때 logback 루트 로거에 {@link SinkAppender} 를 붙인다(설정 파일 없이 코드로). 로그 싱크 자신의 로그
 *       (dev.wakeline.logs.*)와 싱크 스레드에서 난 로그는 싣지 않는다 — 재귀 금지, 표준 출력에만 남는다.</li>
 *   <li>억제: 같은 지문(fp)은 {@value #SUPPRESS_WINDOW_MS} ms 에 1건만 싣고, 그사이 억제한 수는 그 fp 의 다음 항목 suppressed 에 싣는다.</li>
 *   <li>대기열: {@value #QUEUE_MAX}건 · 2 MiB 상한 — 넘으면 오래된 것부터 버리고 센다(result="dropped"). 앱 스레드는 대기열에 넣기만 한다
 *       (짧은 잠금 하나, Redis 를 기다리지 않는다). 두 스트림이 한 대기열을 쓴다 — Redis 장애 동안에는 브라우저 오류를 받지 않으므로
 *       (ClientErrorController: 제한기가 Redis 에 닿지 않으면 503) 익명 입력이 대기열의 서버 오류를 밀어내지 못한다.</li>
 *   <li>보내기: 가상 스레드 하나가 1 s 마다 또는 {@value #BATCH}건이 모이면 항목마다 제 스트림으로 {@code XADD wakeline:logs MAXLEN ~ 3000 * e <json>}
 *       · {@code XADD wakeline:logs:client MAXLEN ~ 1000 * e <json>}.
 *       Redis 가 안 되면 대기열에 남겨 두고 1 → 30 s 지수 백오프로 다시 보낸다(보내지 못한 항목은 대기열 맨 앞으로 — 순서 유지).</li>
 *   <li>지표: wakeline_log_events_total{result=sent|dropped|suppressed} · wakeline_log_queue(지금 대기 수) — 운영 pipeline 에도 싣는다.</li>
 *   <li>종료: 앱 구성 요소·웹 서버가 멈춘 뒤(낮은 phase) 한 번 더 보내 보고, 남은 것은 dropped 로 센다. Redis 연결은 그 뒤에 닫힌다.</li>
 * </ul>
 * wakeline.logs.sink-enabled=false(되돌리기, ADR-018)면 등록·보내기를 하지 않는다 — 브라우저 오류 수집도 받지 않는다(503).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class LogSink implements SmartLifecycle, DisposableBean {
    private static final org.slf4j.Logger log = LoggerFactory.getLogger(LogSink.class);
    public static final String STREAM = "wakeline:logs";
    public static final long MAXLEN = 3000;
    /** 브라우저 오류 스트림(계약 v5 §G2). */
    public static final String CLIENT_STREAM = "wakeline:logs:client";
    public static final long CLIENT_MAXLEN = 1000;
    static final int QUEUE_MAX = 500;
    static final long QUEUE_MAX_BYTES = 2L * 1024 * 1024;
    static final int BATCH = 50;
    static final long FLUSH_INTERVAL_MS = 1_000;
    static final long BACKOFF_START_MS = 1_000;
    static final long BACKOFF_MAX_MS = 30_000;
    static final long SUPPRESS_WINDOW_MS = 10_000;
    /** 억제 상태를 기억하는 지문 수 상한(넘으면 창이 지난 것부터 잊는다). */
    static final int SUPPRESS_TRACK_MAX = 2_000;
    /** 종료 때 마지막 보내기 마감. */
    static final long STOP_FLUSH_MS = 2_000;
    /**
     * 종료 순서: 스트림 소비(MAX-10) … 마지막 ACK(MAX-250) → 웹 서버 graceful(MAX-1024) · 정지(MAX-2048) → 이 싱크(MAX-4096) → Redis 연결(0).
     * 앞 단계의 종료 오류까지 싣고, 연결이 닫히기 전에 보낸다. 시작은 거꾸로(Redis 뒤, 앱 구성 요소 앞).
     */
    public static final int PHASE = Integer.MAX_VALUE - 4096;

    /** XADD 한 건(스트림 · 트림은 stream 이 정한다). 실패하면 예외를 던진다. */
    @FunctionalInterface
    public interface Writer { void xadd(LogStream stream, String json); }

    /** 억제를 통과한 뒤에만 부른다 — 스택 가림·직렬화 같은 비싼 일은 여기서(억제된 로그 폭주에 CPU 를 쓰지 않게). */
    @FunctionalInterface
    public interface Body { String json(String fp, int suppressed); }

    public enum Offer { QUEUED, SUPPRESSED, DISABLED }

    private record Entry(LogStream stream, String json, int bytes) {}

    private final Writer writer;
    private final boolean enabled;
    private final LongSupplier clock;
    private final LoggerContext logback;
    private final long flushIntervalMs;
    private final long backoffStartMs;
    private final long backoffMaxMs;
    private final String instance;
    private final SinkAppender appender;
    private final Counter sent;
    private final Counter dropped;
    private final Counter suppressed;
    // ---- lock 으로 보호 ----
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition wake = lock.newCondition();
    private final ArrayDeque<Entry> queue = new ArrayDeque<>();
    private long queuedBytes;
    // ----
    /** fp → {마지막으로 실은 시각 ms, 그 뒤 억제한 수}. 자체 잠금. */
    private final Map<String, long[]> fps = new HashMap<>();
    private volatile boolean running;
    private volatile Thread flusher;
    private volatile boolean failing;

    @Autowired
    public LogSink(StringRedisTemplate redis, MeterRegistry meters,
                   @Value("${wakeline.logs.sink-enabled:true}") boolean enabled,
                   @Value("${spring.datasource.password:}") String dbPassword,
                   @Value("${spring.data.redis.password:}") String redisPassword) {
        this(redisWriter(redis), meters, enabled, System::currentTimeMillis, (LoggerContext) LoggerFactory.getILoggerFactory(),
                FLUSH_INTERVAL_MS, BACKOFF_START_MS, BACKOFF_MAX_MS);
        // §C5: 설정 비밀값은 값으로도 가린다(모양 규칙이 못 잡는 곳 — 예: 드라이버가 비밀번호를 메시지에 되돌려 줄 때). 6자 미만은 무시된다
        LogMasker.registerSecrets(dbPassword, redisPassword);
        if (enabled) attach(); // 기동 중 경고(빈 생성 이후)도 싣도록 곧바로 — 보내기는 start() 부터, 그 전 항목은 대기열에서 기다린다
    }

    /** 시험용: XADD · 시계 · logback 컨텍스트 · 주기를 바꿔 끼운다. 붙이기는 {@link #attach()} / {@link #start()}. */
    LogSink(Writer writer, MeterRegistry meters, boolean enabled, LongSupplier clock, LoggerContext logback,
            long flushIntervalMs, long backoffStartMs, long backoffMaxMs) {
        this.writer = writer;
        this.enabled = enabled;
        this.clock = clock;
        this.logback = logback;
        this.flushIntervalMs = flushIntervalMs;
        this.backoffStartMs = backoffStartMs;
        this.backoffMaxMs = backoffMaxMs;
        this.instance = instanceName();
        this.appender = new SinkAppender(this);
        this.appender.setContext(logback);
        sent = Counter.builder("wakeline_log_events_total").tag("result", "sent")
                .description("시스템 로그 항목: wakeline:logs(서버) · wakeline:logs:client(브라우저 오류)에 실은 수").register(meters);
        dropped = Counter.builder("wakeline_log_events_total").tag("result", "dropped")
                .description("시스템 로그 항목: 대기열 상한·종료로 버린 수").register(meters);
        suppressed = Counter.builder("wakeline_log_events_total").tag("result", "suppressed")
                .description("시스템 로그 항목: 같은 지문 10 s 억제로 싣지 않은 수").register(meters);
        meters.gauge("wakeline_log_queue", this, LogSink::queued);
    }

    /** 서버 로그 스트림의 XADD … MAXLEN ~ 3000(근사 트림 — Redis 가 내부 노드 단위로 자른다). */
    static final XAddOptions XADD_OPTIONS = LogStream.SERVER.xaddOptions();

    /** api 기본 Redis 연결(끊겨 있으면 곧바로 실패, 명령 한도 3 s — RedisConfig)로 XADD — 서버 로그 MAXLEN ~ 3000, 브라우저 오류 MAXLEN ~ 1000. */
    public static Writer redisWriter(StringRedisTemplate redis) {
        return (stream, json) -> redis.opsForStream().add(MapRecord.create(stream.key(), Map.of("e", json)), stream.xaddOptions());
    }

    public boolean enabled() { return enabled; }

    /** 항목의 instance: 호스트명(컨테이너 id):pid, 64자 이하. */
    public String instance() { return instance; }

    static String instanceName() {
        String host = System.getenv("HOSTNAME");
        if (host == null || host.isBlank()) {
            try {
                host = InetAddress.getLocalHost().getHostName();
            } catch (Exception e) {
                host = "api";
            }
        }
        String pid = ":" + ProcessHandle.current().pid();
        return LogMasker.cut(host, Math.max(1, LogEvents.INSTANCE_MAX - pid.length())) + pid;
    }

    // ---------------------------------------------------------------- 앱 스레드 쪽(막지 않는다)

    /** logback 이벤트(WARN 이상 — {@link SinkAppender} 가 거른 뒤). */
    void accept(ILoggingEvent e) {
        String msg = LogMasker.maskAll(e.getFormattedMessage());
        IThrowableProxy tp = e.getThrowableProxy();
        submit("api", e.getLoggerName(), tp == null ? null : tp.getClassName(), msg,
                (fp, n) -> LogEvents.serialize(LogEvents.fromLogback(e, instance, msg), fp, n));
    }

    /** 서버 로그 스트림으로 {@link #submit(LogStream, String, String, String, String, Body)}. */
    public Offer submit(String service, String logger, String exceptionType, String maskedMessage, Body body) {
        return submit(LogStream.SERVER, service, logger, exceptionType, maskedMessage, body);
    }

    /**
     * 지문을 구해 억제 여부를 정하고, 통과하면 body 로 항목을 만들어 대기열에 넣는다(보낼 때 stream 으로).
     * @param maskedMessage 가린 메시지(지문의 메시지 틀 재료)
     */
    public Offer submit(LogStream stream, String service, String logger, String exceptionType, String maskedMessage, Body body) {
        if (!enabled) return Offer.DISABLED;
        String fp = LogEvents.fingerprint(service, logger, exceptionType, maskedMessage);
        Integer n = admit(fp, clock.getAsLong());
        if (n == null) {
            suppressed.increment();
            return Offer.SUPPRESSED;
        }
        enqueue(stream, body.json(fp, n));
        return Offer.QUEUED;
    }

    /** @return 실어도 되면 직전 전송 뒤 억제한 수, 억제해야 하면 null */
    Integer admit(String fp, long now) {
        synchronized (fps) {
            long[] s = fps.get(fp);
            if (s != null && now - s[0] < SUPPRESS_WINDOW_MS) {
                s[1]++;
                return null;
            }
            int n = s == null ? 0 : (int) Math.min(Integer.MAX_VALUE, s[1]);
            if (s == null && fps.size() >= SUPPRESS_TRACK_MAX) forget(now);
            fps.put(fp, new long[]{now, 0});
            return n;
        }
    }

    /** 창이 지난 지문을 잊는다 — 억제 수가 없는 것부터. 그래도 가득이면 가장 오래전에 실은 것 하나를 더 잊는다. */
    private void forget(long now) {
        fps.values().removeIf(s -> now - s[0] >= SUPPRESS_WINDOW_MS && s[1] == 0);
        if (fps.size() < SUPPRESS_TRACK_MAX) return;
        fps.values().removeIf(s -> now - s[0] >= SUPPRESS_WINDOW_MS);
        if (fps.size() < SUPPRESS_TRACK_MAX) return;
        String oldest = null;
        long t = Long.MAX_VALUE;
        for (var e : fps.entrySet()) if (e.getValue()[0] < t) { t = e.getValue()[0]; oldest = e.getKey(); }
        fps.remove(oldest);
    }

    /** 서버 로그 스트림으로 {@link #enqueue(LogStream, String)}. */
    void enqueue(String json) { enqueue(LogStream.SERVER, json); }

    /** 대기열 끝에 넣는다. 상한을 넘으면 오래된 것부터 버리고 센다. */
    void enqueue(LogStream stream, String json) {
        Entry e = new Entry(stream, json, json.getBytes(StandardCharsets.UTF_8).length);
        int drop;
        boolean full;
        lock.lock();
        try {
            queue.addLast(e);
            queuedBytes += e.bytes();
            drop = trim();
            full = queue.size() >= BATCH;
            if (full) wake.signal();
        } finally {
            lock.unlock();
        }
        if (drop > 0) dropped.increment(drop);
    }

    /** lock 안에서: 상한까지 오래된 것부터 버린다. @return 버린 수 */
    private int trim() {
        int n = 0;
        while (queue.size() > QUEUE_MAX || queuedBytes > QUEUE_MAX_BYTES) {
            Entry old = queue.pollFirst();
            if (old == null) break;
            queuedBytes -= old.bytes();
            n++;
        }
        return n;
    }

    public int queued() {
        lock.lock();
        try { return queue.size(); } finally { lock.unlock(); }
    }

    long queuedBytes() {
        lock.lock();
        try { return queuedBytes; } finally { lock.unlock(); }
    }

    /** 시험용: 가장 오래된 대기 항목. */
    String peekOldest() {
        lock.lock();
        try { return queue.isEmpty() ? null : queue.peekFirst().json(); } finally { lock.unlock(); }
    }

    boolean isFlusherThread() { return Thread.currentThread() == flusher; }

    /** 시험용: 이 스레드를 싱크 스레드로 친다. */
    void flusherForTest(Thread t) { flusher = t; }

    // ---------------------------------------------------------------- 등록

    /** 루트 로거에 붙인다(이미 붙어 있으면 그대로). logback 이 다시 초기화되어 떨어졌으면 다시 붙인다. */
    void attach() {
        Logger root = logback.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        if (!appender.isStarted()) appender.start();
        if (!root.isAttached(appender)) root.addAppender(appender);
    }

    void detach() {
        logback.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME).detachAppender(appender);
        appender.stop();
    }

    boolean isAttached() { return appender.isStarted() && logback.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME).isAttached(appender); }

    // ---------------------------------------------------------------- 보내는 스레드

    @Override
    public void start() {
        if (!enabled || running) return;
        attach();
        running = true;
        flusher = Thread.ofVirtual().name("log-sink").start(this::loop);
    }

    @Override
    public void stop() {
        running = false;
        Thread t = flusher;
        if (t != null) {
            lock.lock();
            try { wake.signalAll(); } finally { lock.unlock(); }
            t.interrupt();
            try { t.join(STOP_FLUSH_MS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
        detach();
        // 마지막으로 한 번 더(대기열이 크면 마감까지). 못 보낸 것은 버린 것으로 센다
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(STOP_FLUSH_MS);
        while (System.nanoTime() < deadline && flushOnce() && queued() > 0) { /* 다음 묶음 */ }
        int left;
        lock.lock();
        try {
            left = queue.size();
            queue.clear();
            queuedBytes = 0;
        } finally {
            lock.unlock();
        }
        if (left > 0) {
            dropped.increment(left);
            log.warn("log sink stopped with {} unsent entries (counted as dropped)", left);
        }
    }

    @Override public boolean isRunning() { return running; }

    @Override public int getPhase() { return PHASE; }

    /** 시작하지 못한 채 컨텍스트가 닫혀도 루트 로거에서 떼어 낸다. */
    @Override
    public void destroy() {
        if (running) stop();
        else detach();
    }

    static long nextBackoff(long current, long max) { return Math.min(max, current * 2); }

    private void loop() {
        long backoff = backoffStartMs;
        while (running) {
            try {
                waitForWork();
                if (!running) return;
                attach(); // logback 재초기화로 떨어졌으면 다시 붙는다
                if (flushOnce()) {
                    backoff = backoffStartMs;
                } else {
                    Thread.sleep(backoff);
                    backoff = nextBackoff(backoff, backoffMaxMs);
                }
            } catch (InterruptedException e) {
                if (!running) return;
            } catch (RuntimeException e) {
                System.err.println("log sink loop error: " + e); // 재귀 금지 — 표준 오류에만
            }
        }
    }

    /** 다음 주기까지 또는 {@value #BATCH}건이 모일 때까지 기다린다. */
    private void waitForWork() throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(flushIntervalMs);
        lock.lock();
        try {
            long left;
            while (running && queue.size() < BATCH && (left = until - System.nanoTime()) > 0) wake.awaitNanos(left);
        } finally {
            lock.unlock();
        }
    }

    /**
     * 지금 대기열의 항목을 {@value #BATCH}건씩 보낸다. 실패하면 보내지 못한 항목을 순서대로 대기열 맨 앞에 되돌리고(상한 적용) false.
     * @return 모두 보냈으면(또는 보낼 것이 없으면) true
     */
    boolean flushOnce() {
        while (true) {
            List<Entry> batch = new ArrayList<>(BATCH);
            lock.lock();
            try {
                for (int i = 0; i < BATCH && !queue.isEmpty(); i++) {
                    Entry e = queue.pollFirst();
                    queuedBytes -= e.bytes();
                    batch.add(e);
                }
            } finally {
                lock.unlock();
            }
            if (batch.isEmpty()) {
                recovered();
                return true;
            }
            Iterator<Entry> it = batch.iterator();
            while (it.hasNext()) {
                Entry e = it.next();
                try {
                    writer.xadd(e.stream(), e.json());
                    sent.increment();
                    it.remove();
                } catch (RuntimeException ex) {
                    requeue(batch);
                    if (!failing) {
                        failing = true;
                        log.warn("log sink: XADD {} failed, keeping {} entries queued and retrying with backoff: {}", e.stream().key(), queued(), ex.toString());
                    }
                    return false;
                }
            }
        }
    }

    private void recovered() {
        if (failing) {
            failing = false;
            log.info("log sink: XADD {} works again", STREAM + " / " + CLIENT_STREAM);
        }
    }

    /** 보내지 못한 항목(오래된 순)을 대기열 맨 앞으로 되돌린다. 상한을 넘으면 오래된 것부터 버린다. */
    private void requeue(List<Entry> unsent) {
        int drop;
        lock.lock();
        try {
            for (int i = unsent.size() - 1; i >= 0; i--) {
                Entry e = unsent.get(i);
                queue.addFirst(e);
                queuedBytes += e.bytes();
            }
            drop = trim();
        } finally {
            lock.unlock();
        }
        if (drop > 0) dropped.increment(drop);
    }
}
