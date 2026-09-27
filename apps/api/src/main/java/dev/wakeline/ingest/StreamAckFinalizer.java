package dev.wakeline.ingest;

import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/**
 * 종료 마지막 단계의 ACK(API-CONC-8). 종료 순서는 스트림 소비 중지(MAX-10) → WS going_away(MAX-100) → 항적·순서 큐 flush(MAX-200) →
 * 이것(MAX-250). flush 가 커밋한 메시지의 영수증이 풀려 ACK 대기열에 들어간 뒤 한 번 보낸다 — 그러지 않으면 정상 종료 때마다
 * 마지막 몇 건이 PEL 에 남아 다음 기동에서 중복 처리된다(멱등이라 무해하지만 불필요). 못 쓴 행의 메시지는 ACK 하지 않는다(재처리 대상).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class StreamAckFinalizer implements SmartLifecycle {
    public static final int PHASE = Integer.MAX_VALUE - 250;
    private final StreamConsumer consumer;
    private volatile boolean running;

    public StreamAckFinalizer(StreamConsumer consumer) { this.consumer = consumer; }

    @Override public void start() { running = true; }

    @Override
    public void stop() {
        running = false;
        consumer.flushAcksQuietly();
    }

    @Override public boolean isRunning() { return running; }
    @Override public int getPhase() { return PHASE; }
}
