package dev.wakeline.weather.core;

import java.util.function.LongSupplier;

/**
 * 알림 id: epochMillis × 1000 + 카운터(같은 ms 안 순번), 프로세스 안에서 단조 증가.
 * 재시작 후에도 이전 실행의 id 와 겹치지 않는다 — 벽시계가 재시작을 사이에 두고 뒤로 가지 않고, 이전 실행이 ms 당 1,000건 넘게 앞서 나가지 않는 한
 * (실측 수십 건/s). 예외(IM-40): 재시작을 사이에 두고 시계가 Δ 만큼 뒤로 가면(VM 시계 보정 등) 새 실행의 id 가 Δ 동안 이전 실행의 id 범위 안에
 * 든다. 정확히 같은 id 가 나오면 그 알림의 INSERT 는 기본 키 충돌(영구 오류)로 3회 뒤 버려진다(확률은 매우 낮다). 기동 정리(AlertRepository)는
 * id 가 아니라 순서 큐의 순서로 이전 실행의 열린 행을 가르므로 이 예외와 상관없이 닫는다.
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
