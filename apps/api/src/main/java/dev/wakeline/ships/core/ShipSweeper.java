package dev.wakeline.ships.core;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.Set;

/**
 * 선박 상태의 주기 작업(ADR-014): 실시간 목록 만료(30 s) — 스케줄러 스레드라 스트림 소비·WS 를 막지 않는다. 수집기 상태 해시 읽기(5 s)는
 * {@link AisStatusReader}.
 * 만료로 빠진 선박은 ShipsUpdated(removed)로 알린다(WS 가 diff·격자에서 뺀다). 수신이 끊긴 동안은 빼지 않는다({@link AisStatus#freeze} —
 * 수신 상태를 모르면 전체, 구역 정보가 있으면 끊긴 구역의 상자 안만, 계약 v4 §D).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class ShipSweeper {
    private final ShipStore store;
    private final AisStatus ais;
    private final ApplicationEventPublisher events;
    private final Counter expired;
    private volatile boolean inputDown;

    public ShipSweeper(ShipStore store, AisStatus ais, ApplicationEventPublisher events, MeterRegistry meters) {
        this.store = store;
        this.ais = ais;
        this.events = events;
        this.expired = Counter.builder("wakeline_ships_expired_total").description("수신 정상 시간 30분 동안 보고가 없어 실시간 목록에서 뺀 선박").register(meters);
        Gauge.builder("wakeline_ships_live", store, s -> s.view().size()).description("실시간 목록의 선박 수").register(meters);
        Gauge.builder("wakeline_ship_statics", store, ShipStore::staticCount).description("메모리의 선박 정적 정보 수").register(meters);
        Gauge.builder("wakeline_ais_input_down", this, s -> s.inputDown ? 1 : 0)
                .description("AIS 수신이 끊겼거나 확인할 수 없는 곳이 있음(1, 전체 또는 일부 구역) — 그곳 선박의 만료를 멈춘다").register(meters);
    }

    @Scheduled(initialDelay = 30_000, fixedDelay = 30_000)
    public void sweep() { sweep(System.currentTimeMillis()); }

    ShipStore.Change sweep(long nowMs) {
        ShipStore.Freeze freeze = ais.freeze(nowMs);
        inputDown = freeze.any();
        ShipStore.Change c = store.expire(nowMs, freeze);
        if (!c.removed().isEmpty()) {
            expired.increment(c.removed().size());
            events.publishEvent(ShipEvents.ShipsUpdated.liveOnly(Set.of(), c.removed()));
        }
        return c;
    }
}
