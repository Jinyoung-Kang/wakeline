package dev.wakeline.ingest;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * 스트림 메시지 한 건의 '처리 완료' 영수증 — XACK 시점을 정한다(API-CONC-8).
 * <p>
 * 소비자는 메시지마다 영수증을 만들어(보유 1) 이벤트에 실어 보내고, 동기 리스너가 다 돈 뒤 자기 보유를 놓는다. 결과를 비동기로
 * 저장하는 리스너(TrackWriter·SigmetRepository)는 큐에 넣기 전에 {@link #hold()} 하고, 그 행이 DB 에 커밋되었거나(또는 다시 시도해도
 * 소용없어 버렸을 때 — 버린 것은 지표로 센다) {@link #release()} 한다. 보유가 0 이 되는 순간 한 번 onDurable 이 불리고, 소비자가
 * 그 메시지를 XACK 한다. 그 전에 프로세스가 죽으면 메시지는 PEL 에 남아 재시작 때 다시 처리된다(행 쓰기는 멱등 — at-least-once).
 * <p>
 * {@link #NONE}: 추적하지 않는 영수증(부트스트랩·테스트) — hold/release 가 아무것도 하지 않는다.
 */
public final class Receipt {
    public static final Receipt NONE = new Receipt(null);

    private final AtomicInteger holds = new AtomicInteger(1);
    private final Runnable onDurable;

    /** @param onDurable 마지막 보유가 풀릴 때 한 번 부른다(가볍게 — 보통 ACK 대기열에 넣기만) */
    public Receipt(Runnable onDurable) { this.onDurable = onDurable; }

    public boolean tracked() { return this != NONE; }

    /** 비동기 작업 하나가 이 메시지의 결과를 들고 간다. */
    public Receipt hold() {
        if (tracked()) holds.incrementAndGet();
        return this;
    }

    /** 들고 간 결과가 durable 해졌다(또는 영구히 버렸다). 마지막이면 onDurable. 짝이 맞지 않는 release 는 무시한다. */
    public void release() {
        if (!tracked()) return;
        int n = holds.decrementAndGet();
        if (n == 0) onDurable.run();
        else if (n < 0) holds.set(0);
    }

    /** 남은 보유 수(테스트·지표용). */
    public int holds() { return tracked() ? holds.get() : 0; }
}
