package dev.wakeline.weather.core;

import dev.wakeline.aircraft.core.AircraftEvents;
import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.aircraft.core.SnapshotStore;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static dev.wakeline.weather.core.TestData.box;
import static org.assertj.core.api.Assertions.assertThat;

/** 엔진 통합(실시계): 스코프가 섞인 실행에서도 서로 다른 관측만 세고, SIGMET 만료는 이벤트로 알린다. */
class EngineServiceTest {
    final SnapshotStore snapshots = new SnapshotStore();
    final SigmetStore sigmets = new SigmetStore();
    final List<Object> events = new ArrayList<>();
    final EngineService engine = new EngineService(snapshots, sigmets, events::add, new SimpleMeterRegistry());

    static SigmetRecord sig(String id, Instant from, Instant to) {
        return new SigmetRecord(id, "RKRR", null, null, "1", "TS", null, 14000, 21000, from, to, box(126, 35, 128, 37), null,
                null, null, null, "RAW", "awc_isigmet", from, SigmetRecord.BASE_JSON, SigmetRecord.TOP_JSON);
    }

    static AircraftState at(String hex, double lat, double lon, Instant seenAt, String provider) {
        return new AircraftState(hex, null, null, null, null, lat, lon, 17000, 450.0, 90.0, 0.0, false, null, seenAt, provider, seenAt, 0, false);
    }

    void publish(String scope, Instant fetchedAt, AircraftState... states) {
        Map<String, AircraftState> m = new HashMap<>();
        for (AircraftState a : states) m.put(a.hex(), a);
        Snapshot s = new Snapshot(snapshots.nextVersion(), scope, scope.equals("global") ? "opensky" : "adsb_lol", fetchedAt, fetchedAt, "-", Map.copyOf(m));
        Snapshot prev = snapshots.replace(s);
        engine.onSnapshot(new AircraftEvents.SnapshotUpdated(prev, s));
    }

    List<AlertStateMachine.EventType> alertEvents() {
        return events.stream().filter(e -> e instanceof EngineEvents.AlertsChanged)
                .flatMap(e -> ((EngineEvents.AlertsChanged) e).events().stream()).map(AlertStateMachine.Event::type).toList();
    }

    /** COR-1 재현: global 기체의 단일 위치를 region 주기가 다시 판정해도 ENTERED 가 나오지 않는다. */
    @Test void singleGlobalObservation_reJudgedByRegionCycles_doesNotEnter() {
        Instant now = Instant.now();
        var st = sigmets.replace(now, "awc_isigmet", Map.of("A", sig("A", now.minusSeconds(3600), now.plusSeconds(3600))));
        engine.onSigmets(new WeatherEvents.SigmetsUpdated(st));
        publish("global", now.minusSeconds(5), at("b00001", 36, 127, now.minusSeconds(8), "opensky"));
        for (int i = 0; i < 4; i++) publish("region", now.plusMillis(i), at("c00001", 38.5, 127, now, "adsb_lol"));
        engine.onSigmets(new WeatherEvents.SigmetsUpdated(st));
        assertThat(alertEvents()).doesNotContain(AlertStateMachine.EventType.ENTERED);
        // 다음 global 관측(seen_at 이 바뀜)이 여전히 안이면 그때 확정
        publish("global", now.plusMillis(10), at("b00001", 36, 127.2, now.minusSeconds(1), "opensky"));
        assertThat(alertEvents()).containsOnlyOnce(AlertStateMachine.EventType.ENTERED);
        var active = engine.activeAlerts("observed");
        assertThat(active).hasSize(1);
        assertThat(active.getFirst().id()).isGreaterThan(System.currentTimeMillis() * 1000 - 60_000_000L);
    }

    /**
     * DH-2 재현: 관심 지역 피드가 멈춘(동결) 동안 전세계 피드가 같은 기체를 계속 보고한다. 예전에는 병합 뷰가 region 상태(오래되어 판정 불가)를
     * 골라 진입을 못 하거나 신호 소실로 닫았다. 이제 더 새 관측(global)으로 판정한다.
     */
    @Test void dh2_frozenRegion_freshGlobalObservationsAreJudged() {
        Instant now = Instant.now();
        var st = sigmets.replace(now, "awc_isigmet", Map.of("A", sig("A", now.minusSeconds(3600), now.plusSeconds(3600))));
        engine.onSigmets(new WeatherEvents.SigmetsUpdated(st));
        publish("region", now.minusSeconds(100), at("e00001", 36, 127, now.minusSeconds(100), "adsb_fi")); // 100 s 전에 멈춤(60 s 넘음)
        publish("global", now.minusSeconds(40), at("e00001", 36, 127.1, now.minusSeconds(40), "opensky"));
        publish("global", now.minusSeconds(30), at("e00001", 36, 127.2, now.minusSeconds(30), "opensky"));
        assertThat(alertEvents()).containsExactly(AlertStateMachine.EventType.ENTERED);
        for (int i = 1; i <= 4; i++) publish("global", now.minusSeconds(30 - i), at("e00001", 36, 127.2 + i * 0.01, now.minusSeconds(30 - i), "opensky"));
        assertThat(alertEvents()).containsExactly(AlertStateMachine.EventType.ENTERED); // LOST 없음
        assertThat(engine.activeAlerts("observed")).singleElement().satisfies(a -> assertThat(a.evidence()).containsEntry("provider", "opensky"));
    }

    /** focus(집중 추적) 관측도 병합 뷰로 판정된다 — 관심 지역·전세계에 없는 기체도 5 s 관측으로 진입이 확정된다. */
    @Test void focusObservations_areJudgedLikeRegion() {
        Instant now = Instant.now();
        var st = sigmets.replace(now, "awc_isigmet", Map.of("A", sig("A", now.minusSeconds(3600), now.plusSeconds(3600))));
        engine.onSigmets(new WeatherEvents.SigmetsUpdated(st));
        for (int i = 0; i < 2; i++) {
            Snapshot f = new Snapshot(snapshots.nextVersion(), "focus", "adsb_fi", now.minusSeconds(10 - 5L * i), now, "-",
                    Map.of("e00002", at("e00002", 36, 127 + i * 0.01, now.minusSeconds(10 - 5L * i), "adsb_fi")));
            Snapshot prev = snapshots.applyFocus(f);
            engine.onSnapshot(new AircraftEvents.SnapshotUpdated(prev, f));
        }
        assertThat(alertEvents()).containsExactly(AlertStateMachine.EventType.ENTERED);
    }

    @Test void expiryRebuild_publishesSigmetsExpired_withNewVersion() throws Exception {
        Instant now = Instant.now();
        var st = sigmets.replace(now, "awc_isigmet", Map.of(
                "SHORT", sig("SHORT", now.minusSeconds(3600), now.plusMillis(200)),
                "LONG", sig("LONG", now.minusSeconds(3600), now.plusSeconds(3600))));
        engine.onSigmets(new WeatherEvents.SigmetsUpdated(st));
        engine.rebuildForExpiry();
        assertThat(events).noneMatch(e -> e instanceof WeatherEvents.SigmetsExpired);
        Thread.sleep(300);
        engine.rebuildForExpiry();
        var ex = events.stream().filter(e -> e instanceof WeatherEvents.SigmetsExpired).map(e -> (WeatherEvents.SigmetsExpired) e).toList();
        assertThat(ex).hasSize(1);
        assertThat(ex.getFirst().expiredIds()).containsExactly("SHORT");
        assertThat(ex.getFirst().state().version()).isGreaterThan(st.version());
        assertThat(sigmets.state().version()).isEqualTo(ex.getFirst().state().version());
        assertThat(engine.indexSize()).isEqualTo(1);
        engine.rebuildForExpiry(); // 바뀐 것 없음 → 다시 알리지 않는다
        assertThat(events.stream().filter(e -> e instanceof WeatherEvents.SigmetsExpired)).hasSize(1);
    }

    @Test void predictionAvailability_forSelectedAircraft() {
        Instant now = Instant.now();
        publish("region", now, at("d00001", 36, 125, now, "adsb_lol"), at("d00002", 36, 125, now.minusSeconds(120), "adsb_lol"));
        assertThat(engine.predictionAvailability("d00001")).isEqualTo(PredictionAvailability.AVAILABLE);
        assertThat(engine.predictionAvailability("d00002").reason()).isEqualTo(PredictionAvailability.STALE);
        assertThat(engine.predictionAvailability("ffffff")).isEqualTo(new PredictionAvailability(false, null));
    }

    /** DH-6: 유효시간 만료 점검이 새 스냅샷 없이도(피드 장애 중) 만료된 경보의 알림을 SIGMET_ENDED 로 닫는다 — LEFT 가 아니다. */
    @Test void expiryCheck_closesAlertsOfExpiredSigmets_withoutNewSnapshots() throws Exception {
        Instant now = Instant.now();
        var st = sigmets.replace(now, "awc_isigmet", Map.of("E", sig("E", now.minusSeconds(3600), now.plusMillis(1_500))));
        engine.onSigmets(new WeatherEvents.SigmetsUpdated(st));
        publish("region", now, at("e00001", 36, 127, now.minusSeconds(2), "adsb_lol"));
        publish("region", now.plusMillis(1), at("e00001", 36, 127.01, now.minusSeconds(1), "adsb_lol"));
        assertThat(alertEvents()).containsExactly(AlertStateMachine.EventType.ENTERED);
        Thread.sleep(1_700);
        engine.rebuildForExpiry(); // 스냅샷 없음 — 만료 점검만
        assertThat(alertEvents()).containsExactly(AlertStateMachine.EventType.ENTERED, AlertStateMachine.EventType.SIGMET_ENDED);
        var ended = events.stream().filter(e -> e instanceof EngineEvents.AlertsChanged).flatMap(e -> ((EngineEvents.AlertsChanged) e).events().stream())
                .filter(e -> e.type() == AlertStateMachine.EventType.SIGMET_ENDED).findFirst().orElseThrow().alert();
        assertThat(ended.closeReason()).isEqualTo(dev.wakeline.weather.core.Alert.CLOSE_SIGMET_ENDED);
        assertThat(ended.leftAt()).isEqualTo(now.plusMillis(1_500));
        assertThat(ended.evidence()).containsEntry("end_cause", "expired");
        assertThat(engine.activeAlerts("observed")).isEmpty();
    }

    /** API-CONC-4: 새 세트에서 빠진(철회·대체) 경보의 알림은 세트 수신 즉시 SIGMET_ENDED(withdrawn) — 바깥 관측 3회를 기다려 LEFT 로 닫지 않는다. */
    @Test void withdrawnSigmet_closesAlertOnTheNextSet() {
        Instant now = Instant.now();
        var st = sigmets.replace(now, "awc_isigmet", Map.of("W", sig("W", now.minusSeconds(3600), now.plusSeconds(3600)),
                "K", sig("K", now.minusSeconds(3600), now.plusSeconds(3600))));
        engine.onSigmets(new WeatherEvents.SigmetsUpdated(st));
        publish("region", now, at("e00002", 36, 127, now.minusSeconds(2), "adsb_lol"));
        publish("region", now.plusMillis(1), at("e00002", 36, 127.01, now.minusSeconds(1), "adsb_lol"));
        assertThat(engine.activeAlerts("observed")).hasSize(2); // W 와 K 는 같은 폴리곤
        Instant f2 = now.plusMillis(5);
        var st2 = sigmets.replace(f2, "awc_isigmet", Map.of("K", sig("K", now.minusSeconds(3600), now.plusSeconds(3600))));
        engine.onSigmets(new WeatherEvents.SigmetsUpdated(st2));
        var ended = events.stream().filter(e -> e instanceof EngineEvents.AlertsChanged).flatMap(e -> ((EngineEvents.AlertsChanged) e).events().stream())
                .filter(e -> e.type() == AlertStateMachine.EventType.SIGMET_ENDED).toList();
        assertThat(ended).singleElement().satisfies(e -> {
            assertThat(e.alert().sigmetId()).isEqualTo("W");
            assertThat(e.alert().evidence()).containsEntry("end_cause", "withdrawn");
        });
        assertThat(engine.activeAlerts("observed")).extracting(dev.wakeline.weather.core.Alert::sigmetId).containsExactly("K");
    }

    /** API-CONC-2: 판정 주기의 예외는 엔진 안에서 가둔다 — 이벤트 발행자(스트림 소비)로 새지 않고, 세고, 다음 주기는 정상. */
    @Test void cycleFailure_isContainedAndCounted() {
        java.util.concurrent.atomic.AtomicBoolean explode = new java.util.concurrent.atomic.AtomicBoolean(true);
        SnapshotStore flaky = new SnapshotStore() {
            @Override public View view(Instant now) {
                if (explode.get()) throw new IllegalStateException("TopologyException: side location conflict");
                return super.view(now);
            }
        };
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        EngineService e = new EngineService(flaky, sigmets, events::add, meters);
        Instant now = Instant.now();
        org.assertj.core.api.Assertions.assertThatCode(() -> e.onSnapshot(new AircraftEvents.SnapshotUpdated(Snapshot.empty("region"), Snapshot.empty("region"))))
                .doesNotThrowAnyException();
        org.assertj.core.api.Assertions.assertThatCode(() -> e.onSigmets(new WeatherEvents.SigmetsUpdated(sigmets.replace(now, "awc_isigmet", Map.of()))))
                .doesNotThrowAnyException();
        assertThat(meters.counter("wakeline_engine_errors_total").count()).isEqualTo(2.0);
        explode.set(false);
        e.onSnapshot(new AircraftEvents.SnapshotUpdated(Snapshot.empty("region"), Snapshot.empty("region")));
        assertThat(meters.counter("wakeline_engine_errors_total").count()).isEqualTo(2.0);
    }
}
