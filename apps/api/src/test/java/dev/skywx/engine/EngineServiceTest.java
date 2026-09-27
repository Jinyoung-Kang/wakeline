package dev.skywx.engine;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.SigmetRecord;
import dev.skywx.ingest.IngestEvents;
import dev.skywx.ingest.SigmetStore;
import dev.skywx.ingest.Snapshot;
import dev.skywx.ingest.SnapshotStore;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static dev.skywx.engine.TestData.box;
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
        engine.onSnapshot(new IngestEvents.SnapshotUpdated(prev, s));
    }

    List<AlertStateMachine.EventType> alertEvents() {
        return events.stream().filter(e -> e instanceof EngineEvents.AlertsChanged)
                .flatMap(e -> ((EngineEvents.AlertsChanged) e).events().stream()).map(AlertStateMachine.Event::type).toList();
    }

    /** COR-1 재현: global 기체의 단일 위치를 region 주기가 다시 판정해도 ENTERED 가 나오지 않는다. */
    @Test void singleGlobalObservation_reJudgedByRegionCycles_doesNotEnter() {
        Instant now = Instant.now();
        var st = sigmets.replace(now, "awc_isigmet", Map.of("A", sig("A", now.minusSeconds(3600), now.plusSeconds(3600))));
        engine.onSigmets(new IngestEvents.SigmetsUpdated(st));
        publish("global", now.minusSeconds(5), at("b00001", 36, 127, now.minusSeconds(8), "opensky"));
        for (int i = 0; i < 4; i++) publish("region", now.plusMillis(i), at("c00001", 38.5, 127, now, "adsb_lol"));
        engine.onSigmets(new IngestEvents.SigmetsUpdated(st));
        assertThat(alertEvents()).doesNotContain(AlertStateMachine.EventType.ENTERED);
        // 다음 global 관측(seen_at 이 바뀜)이 여전히 안이면 그때 확정
        publish("global", now.plusMillis(10), at("b00001", 36, 127.2, now.minusSeconds(1), "opensky"));
        assertThat(alertEvents()).containsOnlyOnce(AlertStateMachine.EventType.ENTERED);
        var active = engine.activeAlerts("observed");
        assertThat(active).hasSize(1);
        assertThat(active.getFirst().id()).isGreaterThan(System.currentTimeMillis() * 1000 - 60_000_000L);
    }

    @Test void expiryRebuild_publishesSigmetsExpired_withNewVersion() throws Exception {
        Instant now = Instant.now();
        var st = sigmets.replace(now, "awc_isigmet", Map.of(
                "SHORT", sig("SHORT", now.minusSeconds(3600), now.plusMillis(200)),
                "LONG", sig("LONG", now.minusSeconds(3600), now.plusSeconds(3600))));
        engine.onSigmets(new IngestEvents.SigmetsUpdated(st));
        engine.rebuildForExpiry();
        assertThat(events).noneMatch(e -> e instanceof IngestEvents.SigmetsExpired);
        Thread.sleep(300);
        engine.rebuildForExpiry();
        var ex = events.stream().filter(e -> e instanceof IngestEvents.SigmetsExpired).map(e -> (IngestEvents.SigmetsExpired) e).toList();
        assertThat(ex).hasSize(1);
        assertThat(ex.getFirst().expiredIds()).containsExactly("SHORT");
        assertThat(ex.getFirst().state().version()).isGreaterThan(st.version());
        assertThat(sigmets.state().version()).isEqualTo(ex.getFirst().state().version());
        assertThat(engine.indexSize()).isEqualTo(1);
        engine.rebuildForExpiry(); // 바뀐 것 없음 → 다시 알리지 않는다
        assertThat(events.stream().filter(e -> e instanceof IngestEvents.SigmetsExpired)).hasSize(1);
    }

    @Test void predictionAvailability_forSelectedAircraft() {
        Instant now = Instant.now();
        publish("region", now, at("d00001", 36, 125, now, "adsb_lol"), at("d00002", 36, 125, now.minusSeconds(120), "adsb_lol"));
        assertThat(engine.predictionAvailability("d00001")).isEqualTo(PredictionAvailability.AVAILABLE);
        assertThat(engine.predictionAvailability("d00002").reason()).isEqualTo(PredictionAvailability.STALE);
        assertThat(engine.predictionAvailability("ffffff")).isEqualTo(new PredictionAvailability(false, null));
    }
}
