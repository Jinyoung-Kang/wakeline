package dev.skywx.ws;

/**
 * 클라이언트 → 서버 메시지 rate limit(계약 §1: 세션당 10 s 에 20 개, 넘으면 1008 "rate limit").
 * 용량 capacity, period 마다 capacity 만큼 채워지는 토큰 버킷. 어떤 10 s 창에서도 20 개 이하로 보내는 클라이언트는
 * 절대 거절되지 않는다(버킷은 창 기준보다 관대하다) — 웹 클라이언트는 여유를 두고 16 개/10 s 로 스스로 제한한다.
 * 시간은 호출자가 넘긴다(System.nanoTime, 테스트는 가짜 시각).
 */
final class TokenBucket {
    private final double capacity;
    private final double refillPerNano;
    private double tokens;
    private long lastNanos;

    TokenBucket(int capacity, long periodNanos, long nowNanos) {
        if (capacity <= 0 || periodNanos <= 0) throw new IllegalArgumentException("capacity and period must be > 0");
        this.capacity = capacity;
        this.refillPerNano = capacity / (double) periodNanos;
        this.tokens = capacity;
        this.lastNanos = nowNanos;
    }

    /** 토큰 1개를 쓴다. @return 남아 있었으면 true, 비었으면 false(메시지 거절) */
    synchronized boolean tryConsume(long nowNanos) {
        long elapsed = nowNanos - lastNanos;
        if (elapsed > 0) {
            tokens = Math.min(capacity, tokens + elapsed * refillPerNano);
            lastNanos = nowNanos;
        }
        if (tokens >= 1.0) {
            tokens -= 1.0;
            return true;
        }
        return false;
    }
}
