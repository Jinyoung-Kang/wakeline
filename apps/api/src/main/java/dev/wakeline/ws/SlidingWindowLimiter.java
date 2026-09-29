package dev.wakeline.ws;

/**
 * 클라이언트 → 서버 메시지 한도(계약 §1: 세션당 어떤 10 s 창에서도 20 개, 넘으면 1008 "rate limit") — 계약을 글자 그대로 구현한
 * 슬라이딩 창 기록(WS-4). 최근에 받아들인 max 개의 시각을 고리(ring)에 두고, 새 메시지가 오면 그중 가장 오래된 것(곧 덮어쓸 칸)이
 * window 보다 최근이면 거절한다 — 즉 어떤 길이 window 의 구간에도 받아들인 메시지는 max 개를 넘지 않는다.
 * <ul>
 *   <li>이전 토큰 버킷(용량 20, 초당 2 개 보충)은 20 개를 몰아 보낸 뒤 0.5 s 마다 1 개씩 더 보내면 한 창에 약 40 개를 받아들였다.</li>
 *   <li>거절한 메시지는 기록하지 않는다(거절은 곧 연결 종료이므로 의미도 없다).</li>
 *   <li>메모리는 세션당 long max 개(20 × 8 B) — 상수. 웹 클라이언트는 여유를 두고 16 개/10 s 로 스스로 제한한다(SendBudget).</li>
 * </ul>
 * 시간은 호출자가 넘긴다(System.nanoTime, 테스트는 가짜 시각). 한 세션의 수신은 컨테이너가 순서대로 부르지만, 방어적으로 동기화한다.
 */
final class SlidingWindowLimiter {
    private final long[] accepted;
    private final long windowNanos;
    /** 다음에 쓸 칸 = 받아들인 것 중 가장 오래된 것(가득 찬 뒤). */
    private int next;
    private int count;

    SlidingWindowLimiter(int max, long windowNanos) {
        if (max <= 0 || windowNanos <= 0) throw new IllegalArgumentException("max and window must be > 0");
        this.accepted = new long[max];
        this.windowNanos = windowNanos;
    }

    /** @return 받아들이면 true(기록한다), 창 안에 이미 max 개가 있으면 false */
    synchronized boolean tryAcquire(long nowNanos) {
        if (count == accepted.length) {
            long oldest = accepted[next];
            if (nowNanos - oldest < windowNanos) return false; // nanoTime 은 차이로만 비교한다(넘침 안전)
        } else {
            count++;
        }
        accepted[next] = nowNanos;
        next = (next + 1) % accepted.length;
        return true;
    }

    /** 지금 {@link #tryAcquire} 하면 받아들일까(기록하지 않는다) — 한도 여러 개를 모두 확인한 뒤에만 기록할 때. */
    synchronized boolean available(long nowNanos) {
        return count < accepted.length || nowNanos - accepted[next] >= windowNanos;
    }

    /** 창 안에 받아들인 것이 하나도 없다(가장 최근 것도 window 보다 오래됐다) — 표에서 치워도 한도가 풀리지 않는다. */
    synchronized boolean idle(long nowNanos) {
        if (count == 0) return true;
        int newest = (next - 1 + accepted.length) % accepted.length;
        return nowNanos - accepted[newest] >= windowNanos;
    }
}
