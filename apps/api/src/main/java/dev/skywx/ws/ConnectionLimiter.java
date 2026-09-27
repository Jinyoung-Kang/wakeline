package dev.skywx.ws;

import java.util.HashMap;
import java.util.Map;

/**
 * WS 연결 상한(전체·IP별)의 원자적 예약(SEC-12). 검사와 증가를 한 임계 구역에서 하므로 동시 핸드셰이크가 상한을 넘지 못한다.
 * 예약은 연결이 성립한 뒤(afterConnectionEstablished) 하고, 예약한 연결만 닫힐 때(afterConnectionClosed) 반납한다.
 */
final class ConnectionLimiter {
    private final int maxTotal;
    private final int maxPerIp;
    private int total;
    private final Map<String, Integer> perIp = new HashMap<>();

    ConnectionLimiter(int maxTotal, int maxPerIp) {
        this.maxTotal = maxTotal;
        this.maxPerIp = maxPerIp;
    }

    /** @return 자리가 있어 예약했으면 true */
    synchronized boolean tryAcquire(String ip) {
        if (total >= maxTotal) return false;
        int n = perIp.getOrDefault(ip, 0);
        if (n >= maxPerIp) return false;
        total++;
        perIp.put(ip, n + 1);
        return true;
    }

    /** tryAcquire 가 true 였던 연결에 대해 정확히 한 번 호출한다. */
    synchronized void release(String ip) {
        Integer n = perIp.get(ip);
        if (n == null) return; // 예약하지 않은 IP — 무시(이중 반납 방지)
        total--;
        if (n <= 1) perIp.remove(ip);
        else perIp.put(ip, n - 1);
    }

    synchronized int total() { return total; }

    synchronized int count(String ip) { return perIp.getOrDefault(ip, 0); }
}
