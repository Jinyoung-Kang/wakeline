package dev.wakeline.ws;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 세션별 직렬 실행기(액터 우편함). 한 세션에 대한 전송·전송 상태 변경은 모두 여기로 들어와 한 번에 하나씩, 들어온 순서대로 실행된다.
 * - 스트림 소비·엔진 스레드는 offer 만 하고 곧바로 돌아간다(전송을 기다리지 않는다, REL-2/PERF-3).
 * - 한 세션의 전송은 항상 한 스레드만 하므로 seq·알림 버전 순서가 보장되고, Tomcat 의 블로킹 전송 시간 제한(5 s)이 그대로 적용된다.
 * - 드레인은 주어진 실행기(운영: 가상 스레드)에서 돈다. 느린 세션은 자기 가상 스레드만 막는다.
 * 큐 길이는 호출자가 묶는다(작업 종류별 단일 비행 플래그 + 수신 rate limit) — 여기서는 제한하지 않는다.
 */
final class SerialOutbox {
    private static final Logger log = LoggerFactory.getLogger(SerialOutbox.class);

    private final Executor executor;
    private final ConcurrentLinkedQueue<Runnable> queue = new ConcurrentLinkedQueue<>();
    private final AtomicBoolean running = new AtomicBoolean();
    private volatile boolean closed;

    SerialOutbox(Executor executor) {
        this.executor = executor;
    }

    /** @return 받아들였으면 true(닫힌 우편함은 버린다) */
    boolean offer(Runnable task) {
        if (closed) return false;
        queue.add(task);
        trySchedule();
        return true;
    }

    private void trySchedule() {
        if (queue.isEmpty() || !running.compareAndSet(false, true)) return;
        try {
            executor.execute(this::drain);
        } catch (RejectedExecutionException e) { // 종료 중
            running.set(false);
            close();
        }
    }

    private void drain() {
        try {
            Runnable r;
            while (!closed && (r = queue.poll()) != null) {
                try {
                    r.run();
                } catch (RuntimeException e) {
                    log.debug("ws outbox task failed: {}", e.toString());
                }
            }
        } finally {
            running.set(false);
            if (closed) queue.clear();
            else trySchedule(); // running 해제와 offer 사이에 들어온 작업
        }
    }

    void close() {
        closed = true;
        queue.clear();
    }

    boolean isClosed() { return closed; }

    /** 대기 중인 작업 수(실행 중인 것 제외) — 테스트·지표용 */
    int pending() { return queue.size(); }

    /** 실행 중이거나 대기 중인 작업이 있는가 */
    boolean busy() { return running.get() || !queue.isEmpty(); }
}
