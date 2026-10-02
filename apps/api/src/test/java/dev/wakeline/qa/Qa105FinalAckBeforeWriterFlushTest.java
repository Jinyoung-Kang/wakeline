package dev.wakeline.qa;

import dev.wakeline.aircraft.data.AircraftRepository;
import dev.wakeline.aircraft.data.TrackWriter;
import dev.wakeline.ingest.SingleInstanceGuard;
import dev.wakeline.ingest.StreamAckFinalizer;
import dev.wakeline.ingest.StreamConsumer;
import dev.wakeline.platform.data.OrderedWriter;
import dev.wakeline.ships.data.ShipRepository;
import dev.wakeline.ships.data.ShipWriter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * QA-105 재현: 종료 마지막 ACK(StreamAckFinalizer, phase MAX-250 — 클래스 주석: "항적·순서 큐 flush(MAX-200) → 이것(MAX-250)")는 저장기의 종료 flush 가
 * 영수증을 놓은 <b>뒤</b>에 보내야 한다. 그런데 Finalizer 가 StreamConsumer 에 의존하므로 Spring 은 소비자(MAX-10)를 멈추기 전에 그에 의존하는 Finalizer 를
 * 먼저 멈춘다 — 마지막 ACK 가 종료 맨 앞(저장기가 아직 돌 때)에 나가고, flush 가 놓은 영수증은 ACK 되지 않아 다음 기동에서 PEL 로 다시 처리된다
 * (QA-100 과 같은 원인 — 의존이 phase 를 이긴다). 스택 B: 정상 종료(docker stop) 뒤 기동마다 "re-processed 1 pending messages on wakeline:ships".
 */
class Qa105FinalAckBeforeWriterFlushTest {

    static final class Consumer extends StreamConsumer {
        final List<String> finalAckSawRunning = new ArrayList<>();
        AnnotationConfigApplicationContext ctx;
        private volatile boolean started;

        Consumer(MeterRegistry meters) { super(null, null, null, null, null, e -> { }, null, meters); }

        @Override public void start() { started = true; }
        @Override public void stop() { started = false; }
        @Override public boolean isRunning() { return started; }

        /** StreamAckFinalizer.stop() 이 부르는 마지막 ACK — 그 순간 아직 돌고 있는(종료 flush 전) 저장기를 적는다. */
        @Override
        public void flushAcksQuietly() {
            if (ctx.getBean(ShipWriter.class).isRunning()) finalAckSawRunning.add("ShipWriter");
            if (ctx.getBean(TrackWriter.class).isRunning()) finalAckSawRunning.add("TrackWriter");
            if (ctx.getBean(OrderedWriter.class).isRunning()) finalAckSawRunning.add("OrderedWriter");
        }
    }

    @SuppressWarnings("unchecked")
    @Test
    void theFinalAckIsSentAfterTheWritersHaveFlushed() {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        when(redis.execute(any(RedisScript.class), anyList(), any(), any())).thenReturn(2L);
        Consumer consumer = new Consumer(meters);
        AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext();
        consumer.ctx = ctx;
        ctx.registerBean(MeterRegistry.class, () -> meters);
        ctx.registerBean(StringRedisTemplate.class, () -> redis);
        ctx.registerBean(JdbcTemplate.class, () -> mock(JdbcTemplate.class));
        ctx.registerBean(AircraftRepository.class, () -> mock(AircraftRepository.class));
        ctx.registerBean(ShipRepository.class, () -> mock(ShipRepository.class));
        ctx.registerBean("streamConsumer", StreamConsumer.class, () -> consumer);
        ctx.registerBean(TrackWriter.class);
        ctx.registerBean(SingleInstanceGuard.class);
        ctx.registerBean(StreamAckFinalizer.class);
        ctx.registerBean(OrderedWriter.class, () -> new OrderedWriter(meters));
        ctx.registerBean(ShipWriter.class);
        ctx.refresh();
        ctx.close();
        assertThat(consumer.finalAckSawRunning)
                .as("마지막 ACK(StreamAckFinalizer.stop) 순간 아직 멈추지(종료 flush 하지) 않은 저장기 — 없어야 한다")
                .isEmpty();
    }
}
