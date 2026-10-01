package dev.wakeline.platform.data;

import dev.wakeline.DbTestSupport;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 순서 큐(OrderedWriter)를 실제 PostGIS + 운영과 같은 DML 계정(wakeline_api)으로: 영구 오류는 3번 뒤 버리고 세며, 영수증은 성공 · 영구 오류 때 놓고
 * 종료 뒤 제출은 놓지 않는다. PersistDbTest 에서 시험 대상 클래스별로 나눴다(OrderedWriter 는 platform.data).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class OrderedWriterDbTest {
    JdbcClient api;
    SimpleMeterRegistry meters;
    OrderedWriter writer;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        api = DbTestSupport.apiClient();
        meters = new SimpleMeterRegistry();
        writer = new OrderedWriter(meters, 10, 20);
    }

    @Test
    void writerRetriesPermanentFailureThreeTimesThenDropsAndCounts() throws Exception {
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        writer.submit(OrderedWriter.task("probe", () -> {
            calls.incrementAndGet();
            // FK 대상 SIGMET 이 없음(23503) — 짧은 경합이면 재시도 사이에 생기지만, 끝내 없으면 버리고 센다
            api.sql("INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, evidence) VALUES (1, 'aaaaaa', 'NO-SUCH-SIGMET', 'OBSERVED', now(), '{}'::jsonb)").update();
        }));
        writer.start();
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline
                && meters.counter("wakeline_persist_tasks_total", "kind", "probe", "result", "failed").count() < 1) Thread.sleep(10);
        writer.stop();
        assertThat(calls.get()).isEqualTo(OrderedWriter.PERMANENT_ATTEMPTS);
        assertThat(meters.counter("wakeline_persist_tasks_total", "kind", "probe", "result", "failed").count()).isEqualTo(1.0);
    }

    /** OrderedWriter: 영구 오류로 버린 작업은 영수증을 놓고(ACK), 종료 뒤 제출은 놓지 않는다(다음 기동에서 재처리). */
    @Test
    void orderedWriterReleasesReceiptsOnSuccessAndPermanentFailureButNotAfterShutdown() throws Exception {
        java.util.concurrent.atomic.AtomicInteger acked = new java.util.concurrent.atomic.AtomicInteger();
        dev.wakeline.platform.support.Receipt ok = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet).hold();
        dev.wakeline.platform.support.Receipt bad = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet).hold();
        writer.start();
        writer.submit(OrderedWriter.task("probe_ok", () -> { }, ok));
        writer.submit(OrderedWriter.task("probe_bad", () -> api.sql("SELECT 1/0").query(Integer.class).single(), bad)); // 22012 — 영구 오류
        ok.release(); bad.release();
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline && acked.get() < 2) Thread.sleep(10);
        assertThat(acked.get()).isEqualTo(2);
        assertThat(meters.counter("wakeline_persist_tasks_total", "kind", "probe_bad", "result", "failed").count()).isEqualTo(1.0);
        writer.stop();
        dev.wakeline.platform.support.Receipt late = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet).hold();
        assertThat(writer.submit(OrderedWriter.task("probe_late", () -> { }, late))).isFalse();
        late.release();
        assertThat(acked.get()).isEqualTo(2);
        assertThat(late.holds()).isEqualTo(1); // 다음 기동에서 다시 처리되도록 ACK 하지 않는다
    }
}
