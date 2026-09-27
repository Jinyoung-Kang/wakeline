package dev.skywx.ws;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** 토큰 버킷(20 msg / 10 s)과 원자적 연결 상한(SEC-12). */
class RateAndLimitTest {
    static final long S = 1_000_000_000L;

    @Test void bucket_allows20Burst_thenRejects_thenRefills2PerSecond() {
        TokenBucket b = new TokenBucket(20, 10 * S, 0);
        for (int i = 0; i < 20; i++) assertThat(b.tryConsume(0)).isTrue();
        assertThat(b.tryConsume(0)).isFalse();
        assertThat(b.tryConsume(S / 4)).isFalse();       // 0.25 s → 0.5 토큰
        assertThat(b.tryConsume(S)).isTrue();            // 1 s → 2 토큰(초당 2개 = 10 s 에 20개)
        assertThat(b.tryConsume(S)).isTrue();
        assertThat(b.tryConsume(S)).isFalse();
    }

    @Test void bucket_neverRejectsClientWithin20Per10sSlidingWindow() {
        TokenBucket b = new TokenBucket(20, 10 * S, 0);
        // 10 s 창마다 정확히 20 개(창 시작에 몰아서) — 긴 시간 동안 한 번도 거절되지 않아야 한다
        for (int w = 0; w < 30; w++) for (int i = 0; i < 20; i++) assertThat(b.tryConsume(w * 10 * S)).as("window %d msg %d", w, i).isTrue();
    }

    @Test void bucket_capsAtCapacityAfterIdle() {
        TokenBucket b = new TokenBucket(20, 10 * S, 0);
        for (int i = 0; i < 20; i++) b.tryConsume(0);
        long later = 3600 * S;
        int ok = 0;
        for (int i = 0; i < 25; i++) if (b.tryConsume(later)) ok++;
        assertThat(ok).isEqualTo(20);
    }

    @Test void limiter_perIpAndTotal_andRelease() {
        ConnectionLimiter l = new ConnectionLimiter(3, 2);
        assertThat(l.tryAcquire("a")).isTrue();
        assertThat(l.tryAcquire("a")).isTrue();
        assertThat(l.tryAcquire("a")).isFalse();  // IP 상한
        assertThat(l.tryAcquire("b")).isTrue();
        assertThat(l.tryAcquire("c")).isFalse();  // 전체 상한
        l.release("a");
        assertThat(l.tryAcquire("c")).isTrue();
        l.release("zzz");                          // 예약한 적 없는 IP — 무시
        assertThat(l.total()).isEqualTo(3);
        assertThat(l.count("a")).isEqualTo(1);
    }

    @Test void limiter_concurrentHandshakes_neverExceedPerIpCap() throws Exception {
        ConnectionLimiter l = new ConnectionLimiter(200, 5);
        ExecutorService pool = Executors.newFixedThreadPool(32);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<Boolean>> fs = new ArrayList<>();
            for (int i = 0; i < 64; i++) fs.add(pool.submit(() -> { start.await(); return l.tryAcquire("10.0.0.1"); }));
            start.countDown();
            int ok = 0;
            for (Future<Boolean> f : fs) if (f.get(5, TimeUnit.SECONDS)) ok++;
            assertThat(ok).isEqualTo(5);
            assertThat(l.count("10.0.0.1")).isEqualTo(5);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test void handler_rejectsOverLimit_with1013_andReleasesOnClose() throws Exception {
        try (WsTestKit k = new WsTestKit(Runnable::run, 5_000, 200, 2)) {
            FakeWsSession a = k.connect("a", "1.1.1.1");
            FakeWsSession b = k.connect("b", "1.1.1.1");
            FakeWsSession c = k.connect("c", "1.1.1.1");
            assertThat(c.closedWith).isNotNull();
            assertThat(c.closedWith.getCode()).isEqualTo(1013);
            assertThat(a.open && b.open).isTrue();
            assertThat(a.textLimit).isEqualTo(4096);
            k.handler.afterConnectionClosed(c, c.closedWith);   // 거절한 연결은 반납하지 않는다
            assertThat(k.handler.limiter().count("1.1.1.1")).isEqualTo(2);
            k.handler.afterConnectionClosed(a, org.springframework.web.socket.CloseStatus.NORMAL);
            assertThat(k.handler.limiter().count("1.1.1.1")).isEqualTo(1);
            FakeWsSession d = k.connect("d", "1.1.1.1");
            assertThat(d.closedWith).isNull();
        }
    }

    @Test void handler_21stMessageWithin10s_closes1008RateLimit() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            FakeWsSession f = k.connect("s", "2.2.2.2");
            k.msg(f, "{\"type\":\"hello\",\"proto\":1}");
            for (int i = 0; i < 19; i++) k.msg(f, "{\"type\":\"pong\"}");
            assertThat(f.closedWith).isNull();
            k.msg(f, "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}"); // 21번째
            assertThat(f.closedWith).isNotNull();
            assertThat(f.closedWith.getCode()).isEqualTo(1008);
            assertThat(f.closedWith.getReason()).isEqualTo("rate limit");
            int before = f.sent.size();
            k.msg(f, "{\"type\":\"ping\"}");                 // 닫는 중 수신은 무시
            assertThat(f.sent).hasSize(before);
        }
    }
}
