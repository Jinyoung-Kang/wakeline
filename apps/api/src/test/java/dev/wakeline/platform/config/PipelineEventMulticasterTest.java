package dev.wakeline.platform.config;

import dev.wakeline.platform.support.PipelineEvent;
import dev.wakeline.ships.core.ShipEvents;
import dev.wakeline.weather.core.RadarStore;
import dev.wakeline.weather.core.WeatherEvents;
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

    static final WeatherEvents.RadarUpdated RADAR = new WeatherEvents.RadarUpdated(new RadarStore.Frames("h", 1, List.of(), Instant.EPOCH, "x"));

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

    /**
     * 리뷰(2026-09-30): 선박 저장기가 스트림 소비 스레드에서 알리는 '고른 60 s 표본'(관측 수신 격자가 센다 — ADR-027)은 ShipWriter 안의 이벤트라 격리 대상이
     * 아니었다 — 격자 리스너의 예외가 ShipWriter#onShips 로 새어 저장기 실패로 세졌다. 이제 파이프라인 이벤트(ShipEvents.ShipsSampled)라 그 리스너에 가둔다.
     * 수정 전 실패(그런 이벤트가 없었다 — 컴파일 실패).
     */
    @Test
    void theWritersSampledPositionsArePipelineEvents_aFailingCoverageListenerIsContained() {
        ShipEvents.ShipsSampled sampled = new ShipEvents.ShipsSampled(List.of());
        assertThat(PipelineEventMulticaster.isPipelineEvent(new PayloadApplicationEvent<>(this, sampled))).isTrue();
        m.addApplicationListener((ApplicationListener<PayloadApplicationEvent<?>>) e -> { calls.add("coverage"); throw new IllegalStateException("grid bug"); });
        m.addApplicationListener((ApplicationListener<PayloadApplicationEvent<?>>) e -> calls.add("other"));
        m.multicastEvent(new PayloadApplicationEvent<>(this, sampled));
        assertThat(calls).containsExactly("coverage", "other");
        assertThat(meters.find("wakeline_event_listener_errors_total").tag("event", "ShipsSampled").counter().count()).isEqualTo(1.0);
    }

    record Marked(String v) implements PipelineEvent {}
    record Unmarked(String v) {}

    /**
     * 격리 기준은 표시(PipelineEvent)다 — 페이로드를 감싼 클래스가 아니다(리뷰 cto-2026-10 api §2.5-1: 이벤트 묶음을 기능별로 나눠도 격리가 따라간다).
     * 표시가 있으면 어디에 있든 격리되고, 표시가 없으면 기본 동작(첫 예외가 발행자로)이다.
     */
    @Test
    void theMarkerDecides_notTheEnclosingClass() {
        assertThat(PipelineEventMulticaster.isPipelineEvent(new PayloadApplicationEvent<>(this, new Marked("x")))).isTrue();
        assertThat(PipelineEventMulticaster.isPipelineEvent(new PayloadApplicationEvent<>(this, new Unmarked("x")))).isFalse();
        m.addApplicationListener((ApplicationListener<PayloadApplicationEvent<?>>) e -> { calls.add("first"); throw new IllegalStateException("boom"); });
        m.addApplicationListener((ApplicationListener<PayloadApplicationEvent<?>>) e -> calls.add("second"));
        m.multicastEvent(new PayloadApplicationEvent<>(this, new Marked("x")));
        assertThat(calls).containsExactly("first", "second");
        assertThatThrownBy(() -> m.multicastEvent(new PayloadApplicationEvent<>(this, new Unmarked("x")))).hasMessage("boom");
    }

    static class Target {
        @EventListener
        public void onRadar(WeatherEvents.RadarUpdated e) { }
    }

    @Test
    void listenerNamesAreShortAndBounded() throws Exception {
        var adapter = new ApplicationListenerMethodAdapter("t", Target.class, Target.class.getMethod("onRadar", WeatherEvents.RadarUpdated.class));
        assertThat(PipelineEventMulticaster.listenerName(adapter)).isEqualTo("PipelineEventMulticasterTest$Target#onRadar");
        ApplicationListener<PayloadApplicationEvent<?>> plain = e -> { };
        assertThat(PipelineEventMulticaster.listenerName(plain)).isNotBlank();
    }
}
