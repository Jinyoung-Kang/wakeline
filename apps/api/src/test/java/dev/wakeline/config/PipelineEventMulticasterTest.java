package dev.wakeline.config;

import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.RadarStore;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.context.ApplicationListener;
import org.springframework.context.PayloadApplicationEvent;
import org.springframework.context.event.ApplicationListenerMethodAdapter;
import org.springframework.context.event.EventListener;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** API-CONC-2: 파이프라인 이벤트의 리스너 예외는 그 리스너에 가둔다 — 다른 리스너는 계속 받고, 발행자(스트림 소비)로 새지 않는다. */
class PipelineEventMulticasterTest {
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    final PipelineEventMulticaster m = new PipelineEventMulticaster(new DefaultListableBeanFactory(), () -> meters);
    final List<String> calls = new ArrayList<>();

    static final IngestEvents.RadarUpdated RADAR = new IngestEvents.RadarUpdated(new RadarStore.Frames("h", 1, List.of(), Instant.EPOCH, "x"));

    @Test
    void failingListenerDoesNotSkipTheOthers() {
        m.addApplicationListener((ApplicationListener<PayloadApplicationEvent<?>>) e -> { calls.add("engine"); throw new IllegalStateException("boom"); });
        m.addApplicationListener((ApplicationListener<PayloadApplicationEvent<?>>) e -> calls.add("track-writer"));
        m.addApplicationListener((ApplicationListener<PayloadApplicationEvent<?>>) e -> calls.add("ws-hub"));
        m.multicastEvent(new PayloadApplicationEvent<>(this, RADAR));
        m.multicastEvent(new PayloadApplicationEvent<>(this, RADAR));
        assertThat(calls).containsExactly("engine", "track-writer", "ws-hub", "engine", "track-writer", "ws-hub");
        assertThat(meters.find("wakeline_event_listener_errors_total").tag("event", "RadarUpdated").counter().count()).isEqualTo(2.0);
    }

    @Test
    void otherEventsKeepTheDefaultFailFastBehaviour() {
        m.addApplicationListener((ApplicationListener<PayloadApplicationEvent<?>>) e -> { throw new IllegalStateException("startup listener failed"); });
        assertThatThrownBy(() -> m.multicastEvent(new PayloadApplicationEvent<>(this, "not a pipeline event")))
                .isInstanceOf(IllegalStateException.class).hasMessage("startup listener failed");
        assertThat(PipelineEventMulticaster.isPipelineEvent(new PayloadApplicationEvent<>(this, RADAR))).isTrue();
        assertThat(PipelineEventMulticaster.isPipelineEvent(new PayloadApplicationEvent<>(this, "x"))).isFalse();
    }

    static class Target {
        @EventListener
        public void onRadar(IngestEvents.RadarUpdated e) { }
    }

    @Test
    void listenerNamesAreShortAndBounded() throws Exception {
        var adapter = new ApplicationListenerMethodAdapter("t", Target.class, Target.class.getMethod("onRadar", IngestEvents.RadarUpdated.class));
        assertThat(PipelineEventMulticaster.listenerName(adapter)).isEqualTo("PipelineEventMulticasterTest$Target#onRadar");
        ApplicationListener<PayloadApplicationEvent<?>> plain = e -> { };
        assertThat(PipelineEventMulticaster.listenerName(plain)).isNotBlank();
    }
}
