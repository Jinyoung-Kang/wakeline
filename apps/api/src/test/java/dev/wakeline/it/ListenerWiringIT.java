package dev.wakeline.it;

import dev.wakeline.engine.EngineEvents;
import dev.wakeline.ingest.IngestEvents;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.aop.support.AopUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ApplicationEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.PayloadApplicationEvent;
import org.springframework.context.event.AbstractApplicationEventMulticaster;
import org.springframework.context.event.ApplicationListenerMethodAdapter;
import org.springframework.context.support.AbstractApplicationContext;
import org.springframework.core.ResolvableType;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;

import static java.util.Map.entry;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 파이프라인 이벤트의 리스너 배선(특성 시험 — 패키지를 옮기기 전에 지금 동작을 고정한다, 리뷰 cto-2026-10 api §5.4-1). 전체 컨텍스트의 멀티캐스터가
 * 이벤트마다 부르는 리스너(클래스#메서드)의 집합과, 순서가 결과를 바꾸는 한 곳: EngineService#onSnapshot 이 WsHub#onSnapshot 보다 먼저다 — WS 의
 * selected 가 싣는 예측 가능 여부(PredictionAvailability ← EngineService.lastTurning)가 그 스냅샷의 엔진 주기 뒤 값이어야 한다.
 * 클래스를 옮기다 @Profile 이 틀려 리스너가 빠지거나, 스캔 순서가 바뀌어 그 순서가 뒤집히면 여기서 알린다. 이름은 단순 클래스 이름이라 패키지 이동에는 그대로다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class ListenerWiringIT extends IntegrationTest {
    @Autowired ApplicationContext ctx;

    /** 이벤트 → 그 이벤트를 받는 dev.wakeline 리스너(집합 — 순서는 아래 시험이 따로 본다). */
    static final Map<Class<?>, Set<String>> EXPECTED = Map.ofEntries(
            entry(IngestEvents.SnapshotUpdated.class, Set.of("EngineService#onSnapshot", "TrackWriter#onSnapshot", "WsHub#onSnapshot")),
            entry(IngestEvents.SigmetsUpdated.class, Set.of("EngineService#onSigmets", "WsHub#onSigmets")),
            entry(IngestEvents.SigmetsExpired.class, Set.of("WsHub#onSigmetsExpired")),
            entry(IngestEvents.RadarUpdated.class, Set.of("WsHub#onRadar")),
            entry(IngestEvents.AircraftBacklog.class, Set.of("TrackWriter#onBacklog")),
            entry(IngestEvents.SigmetSetReceived.class, Set.of("SigmetRepository#onSigmetSet")),
            entry(IngestEvents.ShipsUpdated.class, Set.of("ShipWriter#onShips", "ShipFanout#onShips")),
            entry(IngestEvents.ShipsSampled.class, Set.of("ShipCoverage#onSampled")),
            entry(IngestEvents.AisGapReceived.class, Set.of("ShipWriter#onGap")),
            entry(EngineEvents.AlertsChanged.class, Set.of("AlertRepository#onAlerts", "WsHub#onAlerts")));

    /** 멀티캐스터가 이 페이로드 형의 이벤트에 부르는 리스너 — 부르는 순서 그대로, dev.wakeline 의 것만(프레임워크 리스너는 뺀다). */
    List<String> listeners(Class<?> payload) throws Exception {
        var multicaster = (AbstractApplicationEventMulticaster) ctx.getBean(AbstractApplicationContext.APPLICATION_EVENT_MULTICASTER_BEAN_NAME);
        // 발행(publishEvent)과 같은 조회 — 실제로 발행하면 엔진 · 저장 · 팬아웃이 돈다. 형만 묻는다(protected 라 반사로).
        Method get = AbstractApplicationEventMulticaster.class.getDeclaredMethod("getApplicationListeners", ApplicationEvent.class, ResolvableType.class);
        get.setAccessible(true);
        ResolvableType type = ResolvableType.forClassWithGenerics(PayloadApplicationEvent.class, payload);
        @SuppressWarnings("unchecked")
        var found = (Collection<ApplicationListener<?>>) get.invoke(multicaster, new PayloadApplicationEvent<>(ctx, "probe"), type);
        List<String> out = new ArrayList<>();
        for (ApplicationListener<?> l : found) {
            if (l instanceof ApplicationListenerMethodAdapter a) {
                String head = a.getListenerId().substring(0, a.getListenerId().indexOf('(')); // dev.wakeline.persist.TrackWriter.onSnapshot
                if (!head.startsWith("dev.wakeline.")) continue;
                String cls = head.substring(0, head.lastIndexOf('.'));
                out.add(cls.substring(cls.lastIndexOf('.') + 1) + "#" + head.substring(head.lastIndexOf('.') + 1));
            } else if (AopUtils.getTargetClass(l).getName().startsWith("dev.wakeline.")) {
                out.add(AopUtils.getTargetClass(l).getSimpleName());
            }
        }
        return out;
    }

    @Test
    void everyPipelineEventHasExactlyTheListenersItHasToday() throws Exception {
        Set<Class<?>> events = new TreeSet<>(java.util.Comparator.comparing(Class::getName));
        Stream.of(IngestEvents.class, EngineEvents.class).flatMap(c -> Stream.of(c.getDeclaredClasses())).filter(Class::isRecord).forEach(events::add);
        assertThat(events).as("every pipeline event record is listed here (a new event needs its listeners pinned)")
                .containsExactlyInAnyOrderElementsOf(EXPECTED.keySet());
        for (Class<?> e : events)
            assertThat(listeners(e)).as(e.getSimpleName()).containsExactlyInAnyOrderElementsOf(EXPECTED.get(e));
    }

    @Test
    void theEngineSeesEachSnapshotBeforeTheWsHubFansItOut() throws Exception {
        List<String> order = listeners(IngestEvents.SnapshotUpdated.class);
        assertThat(order.indexOf("EngineService#onSnapshot")).as(order.toString()).isNotNegative()
                .isLessThan(order.indexOf("WsHub#onSnapshot"));
    }
}
