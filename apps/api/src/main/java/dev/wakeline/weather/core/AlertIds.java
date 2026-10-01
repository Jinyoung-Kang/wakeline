package dev.wakeline.weather.core;

import java.util.function.LongSupplier;

/**
 * 알림 id: epochMillis × 1000 + 카운터(같은 ms 안 순번), 프로세스 안에서 단조 증가.
 * 재시작 후에도 이전 실행의 id 와 겹치지 않는다 — 이전 실행이 ms 당 1,000건 넘게 앞서 나가지 않는 한(실측 수십 건/s).
 * 이전 형식(epoch 초 ≈ 1.79e9)보다 항상 커서 id DESC 정렬·커서 페이지가 유지되고, JS Number 안전 범위(9.0e15) 안이다(2255년까지).
 */
public final class AlertIds {
    private final LongSupplier clockMillis;
    private long last;

    public AlertIds(LongSupplier clockMillis) { this.clockMillis = clockMillis; }

    public synchronized long next() {
        long base = clockMillis.getAsLong() * 1000;
        last = Math.max(last + 1, base);
        return last;
    }
}
