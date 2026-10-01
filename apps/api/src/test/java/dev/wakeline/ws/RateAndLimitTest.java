package dev.wakeline.ws;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** 슬라이딩 창 한도(20 msg / 어떤 10 s 창, 계약 §1 — WS-4)와 원자적 연결 상한(SEC-12). */
class RateAndLimitTest {
    static final long S = 1_000_000_000L;

    @Test void window_allows20Burst_thenRejectsUntilTheOldestLeavesTheWindow() {
        SlidingWindowLimiter w = new SlidingWindowLimiter(20, 10 * S);
        for (int i = 0; i < 20; i++) assertThat(w.tryAcquire(0)).isTrue();
        assertThat(w.tryAcquire(0)).isFalse();
        assertThat(w.tryAcquire(5 * S)).isFalse();          // 토큰 버킷이었다면 이미 10 개가 보충됐다
        assertThat(w.tryAcquire(10 * S - 1)).isFalse();     // 가장 오래된 것이 아직 창 안
        assertThat(w.tryAcquire(10 * S)).isTrue();          // 정확히 10 s 뒤 — 창 밖
    }

    /** 리뷰 WS-4 재현: 0 s 에 20 개, 그 뒤 0.5 s 마다 1 개 — 이전 토큰 버킷은 한 창에 약 40 개를 받아들였다. */
    @Test void window_spacedBurstAfterAFullBurst_isRejectedWithinTheSameWindow() {
        SlidingWindowLimiter w = new SlidingWindowLimiter(20, 10 * S);
        for (int i = 0; i < 20; i++) assertThat(w.tryAcquire(0)).isTrue();
        int acceptedWithin10s = 20;
        for (long t = S / 2; t < 10 * S; t += S / 2) if (w.tryAcquire(t)) acceptedWithin10s++;
        assertThat(acceptedWithin10s).isEqualTo(20);
    }

    @Test void window_neverRejectsAClientThatStaysWithin20Per10s() {
        SlidingWindowLimiter w = new SlidingWindowLimiter(20, 10 * S);
        // 10 s 창마다 정확히 20 개(창 시작에 몰아서) — 긴 시간 동안 한 번도 거절되지 않아야 한다
        for (int k = 0; k < 30; k++) for (int i = 0; i < 20; i++) assertThat(w.tryAcquire(k * 10 * S)).as("window %d msg %d", k, i).isTrue();
        // 고르게 0.5 s 마다(= 10 s 에 20 개) — 거절 없음
        SlidingWindowLimiter even = new SlidingWindowLimiter(20, 10 * S);
        for (int i = 0; i < 200; i++) assertThat(even.tryAcquire(i * (S / 2))).as("msg %d", i).isTrue();
    }

    @Test void window_anyTenSecondIntervalHoldsAtMost20AcceptedMessages() {
        SlidingWindowLimiter w = new SlidingWindowLimiter(20, 10 * S);
        java.util.Random r = new java.util.Random(7);
        List<Long> accepted = new ArrayList<>();
        long t = 0;
        for (int i = 0; i < 5_000; i++) {
            t += (long) (r.nextDouble() * 0.8 * S);
            if (w.tryAcquire(t)) accepted.add(t);
        }
        for (int i = 20; i < accepted.size(); i++)
            assertThat(accepted.get(i) - accepted.get(i - 20)).as("21 accepted within one window at %d", i).isGreaterThanOrEqualTo(10 * S);
    }

    @Test void window_rejectsBadArguments() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new SlidingWindowLimiter(0, S)).isInstanceOf(IllegalArgumentException.class);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new SlidingWindowLimiter(1, 0)).isInstanceOf(IllegalArgumentException.class);
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

    /**
     * QA-204: 메시지 상한 4 KB 는 UTF-8 바이트다(계약 v5 §G35). 정확히 4,096 바이트(3바이트 글자 섞음)는 받고, 4,097 바이트는 글자 수가 4,096 보다 훨씬
     * 적어도 1009 로 닫는다 — 예전에는 Tomcat 의 글자 상한만 있어 약 12 KB 까지 받았다.
     */
    @Test void handler_messageOver4096Utf8Bytes_closes1009EvenWithFewCharacters() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            FakeWsSession f = k.connect("s", "2.2.2.3");
            k.msg(f, "{\"type\":\"hello\",\"proto\":1}");
            String head = "{\"type\":\"ping\",\"pad\":\"", tail = "\"}";
            String exact = head + "가".repeat(1357) + "a" + tail; // 22 + 4,071 + 1 + 2 = 4,096 바이트 · 1,382 글자
            assertThat(exact.getBytes(java.nio.charset.StandardCharsets.UTF_8)).hasSize(4096);
            assertThat(WakelineWsHandler.utf8Length(exact)).isEqualTo(4096);
            int before = f.sent.size();
            k.msg(f, exact);
            assertThat(f.closedWith).as("4,096 bytes is within the limit").isNull();
            assertThat(f.sent.subList(before, f.sent.size())).anySatisfy(m -> assertThat(m).contains("\"pong\""));
            k.msg(f, head + "가".repeat(1357) + "ab" + tail); // 4,097 바이트
            assertThat(f.closedWith).isNotNull();
            assertThat(f.closedWith.getCode()).isEqualTo(1009);
            assertThat(f.closedWith.getReason()).isEqualTo("message too big");
            int after = f.sent.size();
            k.msg(f, "{\"type\":\"ping\"}"); // 닫는 중 수신은 무시
            assertThat(f.sent).hasSize(after);
        }
        // 2 · 3 · 4 바이트 글자(서로게이트 쌍)와 짝 없는 서로게이트(3)
        assertThat(WakelineWsHandler.utf8Length("aé가😀")).isEqualTo(1 + 2 + 3 + 4).isEqualTo("aé가😀".getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
        assertThat(WakelineWsHandler.utf8Length("\uD83D")).isEqualTo(3);
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
