package dev.wakeline.platform.config;

import dev.wakeline.platform.support.PipelineEvent;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.context.ApplicationEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.PayloadApplicationEvent;
import org.springframework.context.event.SimpleApplicationEventMulticaster;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * 수집 파이프라인 이벤트(페이로드가 {@link PipelineEvent} — IngestEvents·EngineEvents 의 record)의 리스너를 서로 격리하는 멀티캐스터(API-CONC-2).
 * <p>
 * Spring 기본 멀티캐스터는 리스너 하나가 예외를 던지면 그 이벤트의 나머지 리스너를 부르지 않고 예외를 발행자에게 돌려준다. 발행자는
 * 스트림 소비 스레드라서, 예를 들어 엔진이 던지면 ① 뒤의 항적 저장·WS 팬아웃이 건너뛰어지고 ② 멀쩡한 메시지가 DLQ 로 갔다.
 * 여기서는 파이프라인 이벤트에 한해 리스너마다 예외를 잡아 기록하고(wakeline_event_listener_errors_total{event,listener}) 다음 리스너로 간다.
 * 그 밖의 이벤트(기동·종료·컨텍스트 이벤트 등)는 기본 동작 그대로다 — 기동 중 리스너 실패를 숨기지 않는다.
 * Error(예: OutOfMemoryError)는 잡지 않는다.
 */
public class PipelineEventMulticaster extends SimpleApplicationEventMulticaster {
    private static final Logger log = LoggerFactory.getLogger(PipelineEventMulticaster.class);
    private final Supplier<MeterRegistry> meters;
    private final Map<String, Long> lastLogMs = new ConcurrentHashMap<>();

    public PipelineEventMulticaster(BeanFactory beanFactory, Supplier<MeterRegistry> meters) {
        super(beanFactory);
        this.meters = meters;
    }

    /** 이 이벤트가 수집 파이프라인 이벤트(스트림 소비·엔진이 발행 — 페이로드에 {@link PipelineEvent} 표시)인가. */
    static boolean isPipelineEvent(ApplicationEvent event) {
        return event instanceof PayloadApplicationEvent<?> p && p.getPayload() instanceof PipelineEvent;
    }

    @Override
    protected void invokeListener(ApplicationListener<?> listener, ApplicationEvent event) {
        if (!isPipelineEvent(event)) {
            super.invokeListener(listener, event);
            return;
        }
        try {
            super.invokeListener(listener, event);
        } catch (RuntimeException e) {
            String ev = ((PayloadApplicationEvent<?>) event).getPayload().getClass().getSimpleName();
            String who = listenerName(listener);
            MeterRegistry m = meters.get();
            if (m != null) Counter.builder("wakeline_event_listener_errors_total").tag("event", ev).tag("listener", who)
                    .description("파이프라인 이벤트 리스너 예외(다른 리스너는 계속 받는다)").register(m).increment();
            long now = System.currentTimeMillis();
            Long last = lastLogMs.get(ev + "/" + who);
            if (last == null || now - last > 60_000) { // 같은 실패가 주기마다 반복되면 스택은 1분에 한 번만
                lastLogMs.put(ev + "/" + who, now);
                log.error("listener {} failed on {} — other listeners still run: {}", who, ev, e.toString(), e);
            } else {
                log.warn("listener {} failed on {}: {}", who, ev, e.toString());
            }
        }
    }

    /** @EventListener 메서드면 "클래스#메서드", 아니면 리스너 클래스 이름. 지표 태그라서 짧고 유한해야 한다. */
    static String listenerName(ApplicationListener<?> listener) {
        if (listener instanceof org.springframework.context.event.ApplicationListenerMethodAdapter a) {
            String id = a.getListenerId(); // 예: dev.wakeline.aircraft.data.TrackWriter.onSnapshot(dev.wakeline.aircraft.core.AircraftEvents$SnapshotUpdated)
            int paren = id.indexOf('(');
            String head = paren < 0 ? id : id.substring(0, paren);
            int dot = head.lastIndexOf('.');
            int cls = dot < 0 ? -1 : head.lastIndexOf('.', dot - 1);
            return cls < 0 ? head : head.substring(cls + 1).replace('.', '#');
        }
        return listener.getClass().getSimpleName();
    }
}
