package dev.wakeline.qa;

import dev.wakeline.aircraft.data.AircraftRepository;
import dev.wakeline.aircraft.data.TrackWriter;
import dev.wakeline.ingest.SingleInstanceGuard;
import dev.wakeline.ingest.StreamAckFinalizer;
import dev.wakeline.ingest.StreamConsumer;
import dev.wakeline.platform.data.OrderedWriter;
import dev.wakeline.platform.support.Receipt;
import dev.wakeline.ships.core.ShipEvents;
import dev.wakeline.ships.core.ShipState;
import dev.wakeline.ships.data.ShipRepository;
import dev.wakeline.ships.data.ShipWriter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * QA-100 재현: 스트림 소비자(StreamConsumer, phase MAX-10)는 저장기 · 인스턴스 가드(phase MAX-200)보다 <b>나중에</b> 시작해야 한다(각 클래스 주석:
 * "스트림 소비·임대 작성보다 먼저 시작한다", 저장기 enqueue 의 "종료 중에는 소비가 먼저 멈추므로 실제로는 오지 않는다"). 그런데 StreamAckFinalizer
 * (phase MAX-250 — 가장 먼저 시작하는 무리)가 생성자로 StreamConsumer 에 의존하고, Spring 의 DefaultLifecycleProcessor 는 빈을 시작하기 전에 그 빈이
 * 의존하는 빈을 phase 와 상관없이 먼저 시작한다 → 소비자가 MAX-250 무리에서 시작한다. 그사이 받은 선박 메시지는 ShipWriter 가 아직 멈춰 있어
 * 행을 버리고(dropped) 영수증을 잡지 않으므로 메시지가 곧 ACK 된다 — ship_position 영구 손실(스택 B: tools/qa/qa_100_api_crash_ship_loss.sh).
 * <p>여기서는 운영과 같은 빈 클래스(생성자 주입)를 Spring 컨텍스트에 올리고, 소비자의 start() 가 불린 순간의 상태를 기록한다(실제 Redis 루프는 돌리지 않는다).
 */
class Qa100ConsumerStartsBeforeWritersTest {

    /** 소비자 자리: start() 가 불린 순간 저장기 · 가드가 돌고 있었는지 기록하고, 그때 선박 메시지 하나를 처리한 것처럼 이벤트를 낸다. */
    static final class RecordingConsumer extends StreamConsumer {
        final Map<String, Boolean> runningAtStart = new LinkedHashMap<>();
        final AtomicBoolean acked = new AtomicBoolean();
        AnnotationConfigApplicationContext ctx;
        private volatile boolean started;

        RecordingConsumer(MeterRegistry meters) {
            super(null, null, null, null, null, e -> { }, null, meters);
        }

        @Override
        public void start() {
            runningAtStart.put("TrackWriter", ctx.getBean(TrackWriter.class).isRunning());
            runningAtStart.put("ShipWriter", ctx.getBean(ShipWriter.class).isRunning());
            runningAtStart.put("OrderedWriter", ctx.getBean(OrderedWriter.class).isRunning());
            runningAtStart.put("SingleInstanceGuard", ctx.getBean(SingleInstanceGuard.class).isRunning());
            // handle() 와 같은 순서: 영수증(보유 1) → ShipsUpdated → 소비자 자신의 보유를 놓는다. 보유가 0 이 되면 ACK 대기열로 간다.
            Receipt receipt = new Receipt(() -> acked.set(true));
            ShipState s = new ShipState("440123456", 35.1, 129.05, 11.2, 181.5, null, 5, null, "epfs", Instant.now(), "fixture", "PositionReport", "A");
            ctx.publishEvent(new ShipEvents.ShipsUpdated(Instant.now(), "fixture", List.of(s), List.of(), Set.of(s.mmsi()), Set.of(), receipt));
            receipt.release();
            started = true;
        }

        @Override
        public void stop() { started = false; }

        @Override
        public boolean isRunning() { return started; }
    }

    @SuppressWarnings("unchecked")
    @Test
    void streamConsumerStartsOnlyAfterTheWritersAndTheInstanceGuard() {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        when(redis.execute(any(RedisScript.class), anyList(), any(), any())).thenReturn(2L); // 인스턴스 임대: 비어 있어 바로 잡음
        ShipRepository shipRepo = mock(ShipRepository.class);
        RecordingConsumer consumer = new RecordingConsumer(meters);

        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext()) {
            consumer.ctx = ctx;
            ctx.registerBean(MeterRegistry.class, () -> meters);
            ctx.registerBean(StringRedisTemplate.class, () -> redis);
            ctx.registerBean(JdbcTemplate.class, () -> mock(JdbcTemplate.class));
            ctx.registerBean(AircraftRepository.class, () -> mock(AircraftRepository.class));
            ctx.registerBean(ShipRepository.class, () -> shipRepo);
            ctx.registerBean("streamConsumer", StreamConsumer.class, () -> consumer);
            // 운영과 같은 클래스 · 생성자 주입(컴포넌트 스캔과 같은 의존 기록)
            ctx.registerBean(TrackWriter.class);
            ctx.registerBean(SingleInstanceGuard.class);
            ctx.registerBean(StreamAckFinalizer.class);
            ctx.registerBean(OrderedWriter.class, () -> new OrderedWriter(meters));
            ctx.registerBean(ShipWriter.class);
            ctx.refresh();

            assertThat(consumer.runningAtStart)
                    .as("저장기 · 인스턴스 가드가 소비자보다 먼저 돌고 있어야 한다(소비자 phase MAX-10 > 그들의 MAX-200). 소비자 start() 순간의 isRunning()")
                    .containsEntry("ShipWriter", true)
                    .containsEntry("TrackWriter", true)
                    .containsEntry("OrderedWriter", true)
                    .containsEntry("SingleInstanceGuard", true);
        }
    }

    @Test
    void aShipsMessageHandledAtStartupIsNotAcknowledgedWithoutItsRows() {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        when(redis.execute(any(RedisScript.class), anyList(), any(), any())).thenReturn(2L);
        ShipRepository shipRepo = mock(ShipRepository.class);
        RecordingConsumer consumer = new RecordingConsumer(meters);

        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext()) {
            consumer.ctx = ctx;
            ctx.registerBean(MeterRegistry.class, () -> meters);
            ctx.registerBean(StringRedisTemplate.class, () -> redis);
            ctx.registerBean(JdbcTemplate.class, () -> mock(JdbcTemplate.class));
            ctx.registerBean(AircraftRepository.class, () -> mock(AircraftRepository.class));
            ctx.registerBean(ShipRepository.class, () -> shipRepo);
            ctx.registerBean("streamConsumer", StreamConsumer.class, () -> consumer);
            ctx.registerBean(TrackWriter.class);
            ctx.registerBean(SingleInstanceGuard.class);
            ctx.registerBean(StreamAckFinalizer.class);
            ctx.registerBean(OrderedWriter.class, () -> new OrderedWriter(meters));
            ctx.registerBean(ShipWriter.class);
            ctx.refresh();

            double dropped = meters.get("wakeline_ship_rows_total").tag("result", "dropped").counter().count();
            assertThat(consumer.acked.get() && dropped > 0)
                    .as("기동 중 처리한 선박 메시지가 행을 쓰지 않고(dropped=%s) ACK 되었다(acked=%s) — PEL 로 다시 오지 않는 영구 손실", dropped, consumer.acked.get())
                    .isFalse();
        }
    }
}
