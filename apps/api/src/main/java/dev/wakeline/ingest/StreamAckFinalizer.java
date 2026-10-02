package dev.wakeline.ingest;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/**
 * 종료 마지막 단계의 ACK(API-CONC-8). 종료 순서는 스트림 소비 중지(MAX-10) → WS going_away(MAX-100) → 항적·순서 큐 flush(MAX-200) →
 * 이것(MAX-250). flush 가 커밋한 메시지의 영수증이 풀려 ACK 대기열에 들어간 뒤 한 번 보낸다 — 그러지 않으면 정상 종료 때마다
 * 마지막 몇 건이 PEL 에 남아 다음 기동에서 중복 처리된다(멱등이라 무해하지만 불필요). 못 쓴 행의 메시지는 ACK 하지 않는다(재처리 대상).
 * <p>
 * 소비자는 {@link ObjectProvider} 로 늦게 찾는다 — 생성자로 받으면 Spring lifecycle 처리기가 의존을 phase 보다 앞세워, 가장 먼저 시작하는 이 빈이
 * 소비자를 저장기 · 인스턴스 가드보다 먼저 시작시키고(QA-100 — 기동 때 선박 행 영구 손실) 종료 때는 소비자보다 먼저(저장기 flush 전에) 멈춘다
 * (QA-105). 이 빈은 lifecycle 빈에 의존하지 않는다 — LifecycleOrderIT 가 실제 컨텍스트에서 지킨다.
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class StreamAckFinalizer implements SmartLifecycle {
    public static final int PHASE = Integer.MAX_VALUE - 250;
    private final ObjectProvider<StreamConsumer> consumer;
    private volatile boolean running;

    public StreamAckFinalizer(ObjectProvider<StreamConsumer> consumer) { this.consumer = consumer; }

    @Override public void start() { running = true; }

    @Override
    public void stop() {
        running = false;
        StreamConsumer c = consumer.getIfAvailable();
        if (c != null) c.flushAcksQuietly();
    }

    @Override public boolean isRunning() { return running; }
    @Override public int getPhase() { return PHASE; }
}
