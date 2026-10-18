package dev.wakeline.weather.core;

import dev.wakeline.aircraft.core.AircraftEvents;
import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.platform.support.FetchedAtGuard;
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
            Snapshot prev = snapshots.applyFocus(f, now.toEpochMilli());
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

    // ---------- 늦게 전달된 스냅샷(IM-07): 수집기 로컬 큐가 장애 뒤 원래 fetched_at 그대로 다시 보낸다 ----------

    /** 판정 시각(now)을 시험이 정하는 시계. */
    static final class MutableClock extends java.time.Clock {
        Instant now;
        MutableClock(Instant now) { this.now = now; }
        @Override public java.time.ZoneId getZone() { return java.time.ZoneOffset.UTC; }
        @Override public java.time.Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }

    static final Instant P0 = Instant.parse("2026-10-18T03:00:00Z");

    /** 36N 에서 동쪽 450 kt 등속(P0 에 경도 lon0) — 보고 위치가 dead reckoning 과 맞는 실제 궤적. */
    static AircraftState moving(String hex, double lon0, Instant seenAt) {
        double[] p = DeadReckoning.predict(36, lon0, 90, 450, (seenAt.toEpochMilli() - P0.toEpochMilli()) / 1000.0);
        return at(hex, p[0], p[1], seenAt, "adsb_lol");
    }

    /**
     * StreamConsumer.aircraft()(region · global)와 같은 길: fetched_at 단조 가드 → replaceIfNewer → SnapshotUpdated. 받아들이면 true.
     * nowMs 는 api 의 지금(이 시험들에서는 엔진 시계와 같다).
     */
    static boolean deliver(SnapshotStore store, EngineService e, long nowMs, String scope, Instant fetchedAt, AircraftState... states) {
        Map<String, AircraftState> m = new HashMap<>();
        for (AircraftState a : states) m.put(a.hex(), a);
        if (!FetchedAtGuard.newer(fetchedAt, store.current(scope).fetchedAt(), nowMs)) return false;
        Snapshot s = new Snapshot(store.nextVersion(), scope, "adsb_lol", fetchedAt, fetchedAt, "-", Map.copyOf(m));
        Snapshot prev = store.replaceIfNewer(s, nowMs);
        if (prev == null) return false;
        e.onSnapshot(new AircraftEvents.SnapshotUpdated(prev, s));
        return true;
    }

    /**
     * IM-07 재현: Redis 가 100 s 멈춘 동안 수집기는 관심 지역을 10 s 마다 조회해 로컬 큐에 두고, 회복 뒤 원래 fetched_at 그대로 순서대로 보낸다.
     * 예전에는 판정이 벽시계(now)로 위치 신선도를 봐서, 다시 온 앞쪽 스냅샷(위치 나이 91 · 81 · 71 s)마다 안에 있던 기체를 부재로 세어
     * R3 에서 LOST(signal_lost)로 닫고 R6 에서 새 id 로 다시 ENTERED 했다 — 예측도 R1 에서 지워졌다가 R5 에서 새 id 로 다시 났다.
     * 끊김 없이 관측된 한 번의 통과는 알림 하나다.
     */
    @Test void replayedSnapshotsAfterAnOutage_keepOneAlertPerPassage() {
        MutableClock clock = new MutableClock(P0.minusSeconds(30));
        SnapshotStore store = new SnapshotStore();
        EngineService e = new EngineService(store, sigmets, events::add, new SimpleMeterRegistry(), null, clock);
        var st = sigmets.replace(P0.minusSeconds(60), "awc_isigmet", Map.of("A", sig("A", P0.minusSeconds(3600), P0.plusSeconds(3 * 3600))));
        e.onSigmets(new WeatherEvents.SigmetsUpdated(st));
        double xLon = 126.5, yLon = TestData.westOfBox(37.5); // X: 경보 안 · Y: 서쪽 37.5 NM(450 kt 로 P0+5분에 진입)
        // 장애 전: 실시간 전달(수신 = fetched_at + 0.5 s, 위치 = fetched_at − 1 s)
        for (int i = -2; i <= 0; i++) {
            Instant f = P0.plusSeconds(10L * i);
            clock.now = f.plusMillis(500);
            assertThat(deliver(store, e, clock.millis(), "region", f, moving("a0000x", xLon, f.minusSeconds(1)), moving("a0000y", yLon, f.minusSeconds(1)))).isTrue();
        }
        assertThat(alertEvents()).containsExactly(AlertStateMachine.EventType.PREDICTED, AlertStateMachine.EventType.ENTERED);
        long enteredId = e.activeAlerts("observed").getFirst().id();
        long predictedId = e.activeAlerts("predicted").getFirst().id();
        // 100 s 장애 → 회복: 큐의 R1..R10(fetched P0+10 … P0+100 s)이 1 초 안에 순서대로 온다
        clock.now = P0.plusSeconds(100).plusMillis(70);
        for (int i = 1; i <= 10; i++) {
            Instant f = P0.plusSeconds(10L * i);
            clock.now = clock.now.plusMillis(10);
            assertThat(deliver(store, e, clock.millis(), "region", f, moving("a0000x", xLon, f.minusSeconds(1)), moving("a0000y", yLon, f.minusSeconds(1)))).isTrue();
        }
        // 다시 실시간
        for (int i = 11; i <= 12; i++) {
            Instant f = P0.plusSeconds(10L * i);
            clock.now = f.plusMillis(500);
            assertThat(deliver(store, e, clock.millis(), "region", f, moving("a0000x", xLon, f.minusSeconds(1)), moving("a0000y", yLon, f.minusSeconds(1)))).isTrue();
        }
        assertThat(alertEvents()).as("one passage = one alert: no LOST + re-ENTERED, no prediction cleared + re-PREDICTED")
                .containsExactly(AlertStateMachine.EventType.PREDICTED, AlertStateMachine.EventType.ENTERED);
        assertThat(e.activeAlerts("observed")).singleElement().satisfies(a -> assertThat(a.id()).isEqualTo(enteredId));
        assertThat(e.activeAlerts("predicted")).singleElement().satisfies(a -> assertThat(a.id()).isEqualTo(predictedId));
    }

    /**
     * IM-07: 선회 판정도 같은 데이터 시각 — 다시 온 스냅샷의 선회 기체를 이력에서 빼면(벽시계로 오래됐다고) 선회가 아닌 것으로 보여
     * 예측이 났다가 벽시계로 신선한 스냅샷에서 다시 지워졌다.
     */
    @Test void replayedSnapshots_turningAircraftStaysUnpredicted() {
        MutableClock clock = new MutableClock(P0.minusSeconds(30));
        SnapshotStore store = new SnapshotStore();
        EngineService e = new EngineService(store, sigmets, events::add, new SimpleMeterRegistry(), null, clock);
        e.onSigmets(new WeatherEvents.SigmetsUpdated(sigmets.replace(P0.minusSeconds(60), "awc_isigmet",
                Map.of("A", sig("A", P0.minusSeconds(3600), P0.plusSeconds(3 * 3600))))));
        double lon = TestData.westOfBox(30);
        double[] tracks = {60, 75, 90}; // 장애 전 세 관측에서 30° 선회(세 번째에 선회 판정) — 그 뒤 동쪽(경보 쪽)으로
        int before = 0;
        for (int i = -2; i <= 10; i++) {
            Instant f = P0.plusSeconds(10L * i);
            clock.now = i <= 0 ? f.plusMillis(500) : P0.plusSeconds(100).plusMillis(70 + 10L * i); // i ≥ 1: 100 s 장애 뒤 재전송
            Instant seen = f.minusSeconds(1);
            double track = i <= 0 ? tracks[i + 2] : 90;
            deliver(store, e, clock.millis(), "region", f, new AircraftState("a0000t", null, null, null, null, 36, lon + 0.002 * i, 17000, 450.0, track, 0.0,
                    false, null, seen, "adsb_lol", seen, 0, false));
            if (i == 0) {
                assertThat(e.activeAlerts("predicted")).as("turning: prediction withheld").isEmpty();
                before = alertEvents().size();
            }
        }
        assertThat(e.predictionAvailability("a0000t").reason()).isEqualTo(PredictionAvailability.TURNING);
        assertThat(alertEvents().subList(before, alertEvents().size())).as("a turning aircraft is not predicted while the replay catches up").isEmpty();
    }

    /** IM-07: 스코프 피드 끊김은 데이터 시각으로 — 모든 스코프가 함께 늦게 오면(재전송) 끊김이 아니고, 다른 스코프보다 뒤처질 때 끊김이다. */
    @Test void viewScopes_feedStaleIsMeasuredOnDataTime() {
        SnapshotStore store = new SnapshotStore();
        store.replace(new Snapshot(store.nextVersion(), "region", "adsb_lol", P0, P0, "-", Map.of()));
        store.replace(new Snapshot(store.nextVersion(), "global", "opensky", P0.plusSeconds(100), P0, "-", Map.of()));
        Instant now = P0.plusSeconds(500); // 벽시계로는 둘 다 끊김
        var view = store.view(now);
        var sc = new EngineService.ViewScopes(view, now, EngineService.dataTime(view, now));
        assertThat(sc.feedStale("region")).as("region 100 s behind global").isTrue();
        assertThat(sc.feedStale("global")).as("global is the data time").isFalse();
        assertThat(sc.feedStale("focus")).as("never received").isTrue();
        assertThat(new EngineService.ViewScopes(view, now, now).feedStale("global")).as("on wall clock").isTrue();
    }

    /**
     * IM-07: 데이터 시각으로 재도 피드는 살아 있는데 기체 위치만 멈추면(공급자가 같은 옛 위치를 계속 보고) 예전처럼 신호 소실이다 —
     * 다른 스냅샷이 데이터 시각을 올리므로 위치가 60 s 넘게 뒤처진 뒤 그 스코프의 새 스냅샷 3번에 LOST.
     */
    @Test void frozenPositionWhileTheFeedIsLive_stillClosesAsLost() {
        MutableClock clock = new MutableClock(P0.minusSeconds(30));
        SnapshotStore store = new SnapshotStore();
        EngineService e = new EngineService(store, sigmets, events::add, new SimpleMeterRegistry(), null, clock);
        e.onSigmets(new WeatherEvents.SigmetsUpdated(sigmets.replace(P0.minusSeconds(60), "awc_isigmet",
                Map.of("A", sig("A", P0.minusSeconds(3600), P0.plusSeconds(3 * 3600))))));
        for (int i = -2; i <= 12; i++) {
            Instant f = P0.plusSeconds(10L * i);
            clock.now = f.plusMillis(500);
            Instant seen = i <= 0 ? f.minusSeconds(1) : P0.minusSeconds(1); // i ≥ 1: 위치가 P0−1 s 에 멈춤
            deliver(store, e, clock.millis(), "region", f, moving("a0000x", 126.5, seen));
        }
        assertThat(alertEvents()).containsExactly(AlertStateMachine.EventType.ENTERED, AlertStateMachine.EventType.LOST);
        var lost = events.stream().filter(x -> x instanceof EngineEvents.AlertsChanged).flatMap(x -> ((EngineEvents.AlertsChanged) x).events().stream())
                .filter(x -> x.type() == AlertStateMachine.EventType.LOST).findFirst().orElseThrow().alert();
        assertThat(lost.evidence()).containsEntry("last_seen_at", P0.minusSeconds(1).toString()).containsEntry("absent_snapshots", 3);
        assertThat(lost.leftAt()).isEqualTo(P0.plusSeconds(80).plusMillis(500)); // 위치 나이 61 s(i=6) 부터 region 스냅샷 3번째(i=8), 판정 시각
    }

    /**
     * IM-07: 항공기 피드가 모두 멈추고(데이터 시각이 멈춤) SIGMET 만 계속 오면 — 열린 관측 알림은 그대로(모든 피드가 멈추면 바꾸지 않는다),
     * 멈춘 위치를 벽시계까지 전진시켜 새 예측을 만들지 않는다(진입은 데이터 시각부터 10분 안만). 예측 진입 시각이 지난 예측은 예전처럼 지운다.
     */
    @Test void aircraftFeedsStopped_sigmetRejudgement_keepsTheAlert_andPredictsNothingFromFrozenPositions() {
        MutableClock clock = new MutableClock(P0.minusSeconds(30));
        SnapshotStore store = new SnapshotStore();
        EngineService e = new EngineService(store, sigmets, events::add, new SimpleMeterRegistry(), null, clock);
        Map<String, SigmetRecord> set = Map.of("A", sig("A", P0.minusSeconds(3600), P0.plusSeconds(3 * 3600)));
        e.onSigmets(new WeatherEvents.SigmetsUpdated(sigmets.replace(P0.minusSeconds(60), "awc_isigmet", set)));
        // X: 안 · Y: 서쪽 37.5 NM(5분 뒤 진입 예측) · Z: 서쪽 120 NM(16분 — 10분 지평 밖이라 예측 없음)
        for (int i = -2; i <= 0; i++) {
            Instant f = P0.plusSeconds(10L * i);
            clock.now = f.plusMillis(500);
            deliver(store, e, clock.millis(), "region", f, moving("a0000x", 126.5, f.minusSeconds(1)), moving("a0000y", TestData.westOfBox(37.5), f.minusSeconds(1)),
                    moving("a0000z", TestData.westOfBox(120), f.minusSeconds(1)));
        }
        assertThat(alertEvents()).containsExactly(AlertStateMachine.EventType.PREDICTED, AlertStateMachine.EventType.ENTERED);
        long enteredId = e.activeAlerts("observed").getFirst().id();
        // 15분 동안 항공기 스냅샷 없음 → 새 SIGMET 세트로 재판정(벽시계로 전진하면 Z 는 7.5 NM 앞, Y 는 이미 안)
        clock.now = P0.plusSeconds(900);
        e.onSigmets(new WeatherEvents.SigmetsUpdated(sigmets.replace(P0.plusSeconds(900), "awc_isigmet", set)));
        assertThat(alertEvents()).containsExactly(AlertStateMachine.EventType.PREDICTED, AlertStateMachine.EventType.ENTERED,
                AlertStateMachine.EventType.PREDICTION_CLEARED);
        assertThat(e.activeAlerts("observed")).singleElement().satisfies(a -> assertThat(a.id()).isEqualTo(enteredId));
        assertThat(e.activeAlerts("predicted")).isEmpty();
    }

    /** 데이터 시각 = 스코프 fetched_at 최댓값(EPOCH = 받은 적 없음은 빼고), now 를 넘지 않는다. 받은 것이 없으면 now. */
    @Test void dataTime_isTheLatestScopeFetchedAt_cappedAtNow() {
        SnapshotStore store = new SnapshotStore();
        assertThat(EngineService.dataTime(store.view(P0), P0)).isEqualTo(P0);
        store.replace(new Snapshot(store.nextVersion(), "region", "adsb_lol", P0, P0, "-", Map.of()));
        store.replace(new Snapshot(store.nextVersion(), "global", "opensky", P0.plusSeconds(5), P0, "-", Map.of()));
        assertThat(EngineService.dataTime(store.view(P0.plusSeconds(100)), P0.plusSeconds(100))).isEqualTo(P0.plusSeconds(5));
        assertThat(EngineService.dataTime(store.view(P0.plusSeconds(2)), P0.plusSeconds(2))).isEqualTo(P0.plusSeconds(2));
        Snapshot f = new Snapshot(store.nextVersion(), "focus", "adsb_fi", P0.plusSeconds(30), P0, "-",
                Map.of("e00009", at("e00009", 36, 127, P0.plusSeconds(29), "adsb_fi")));
        store.applyFocus(f, P0.plusSeconds(100).toEpochMilli());
        assertThat(EngineService.dataTime(store.view(P0.plusSeconds(100)), P0.plusSeconds(100))).isEqualTo(P0.plusSeconds(30));
    }

    // ---------- 벽시계 역행(IM-08 · R1): 수집기 · api 가 같이 쓰는 호스트 시계가 실행 중 뒤로 간다 ----------

    /** 시험의 역행 폭(FetchedAtGuard.CLOCK_BACK_TOLERANCE_MS 보다 크다). */
    static final long CLOCK_BACK_S = 300;

    /** 주입 시계로 도는 엔진 — 경보 A(박스 안 36N 127E · 밖 38.5N 127E)를 판정 세트로 둔다. */
    EngineService clockSteppingEngine(MutableClock clock, SnapshotStore store) {
        EngineService e = new EngineService(store, sigmets, events::add, new SimpleMeterRegistry(), null, clock);
        e.onSigmets(new WeatherEvents.SigmetsUpdated(sigmets.replace(P0.minusSeconds(60), "awc_isigmet",
                Map.of("A", sig("A", P0.minusSeconds(3600), P0.plusSeconds(3 * 3600))))));
        return e;
    }

    /** 실시간 전달 한 번(수신 = fetched_at + 0.5 s, 위치 = fetched_at − 1 s): f = P0 + 10i − back. */
    boolean deliverAt(SnapshotStore store, EngineService e, MutableClock clock, int i, long backS, boolean inside) {
        Instant f = P0.plusSeconds(10L * i - backS);
        clock.now = f.plusMillis(500);
        return deliver(store, e, clock.millis(), "region", f, at("a0000r", inside ? 36 : 38.5, 127, f.minusSeconds(1), "adsb_lol"));
    }

    /**
     * R1: 시계가 300 s 뒤로 간 뒤 — 수집기는 공급자 시각이 수신 시각과 어긋나면 수신 시각으로 seen_at 을 매기므로 새 관측의 seen_at 도 약 300 s
     * 작다. 관심 지역 스냅샷은 fetched_at 가드가 받지만(IM-08), 예전에는 상태 기계가 seen_at 단조 비교로 이미 추적 중인 기체의 새 관측을 '같은 관측'
     * 으로 보고 약 300 s 동안 세지 않았다 — 경보 밖으로 나간 기체의 알림이 그동안 열려 있었다. 역행 뒤 바깥 관측 3회에 LEFT.
     */
    @Test void clockSteppedBack_outsideObservationsStillCloseAsLeft() {
        MutableClock clock = new MutableClock(P0.minusSeconds(30));
        SnapshotStore store = new SnapshotStore();
        EngineService e = clockSteppingEngine(clock, store);
        for (int i = -1; i <= 0; i++) assertThat(deliverAt(store, e, clock, i, 0, true)).isTrue();
        assertThat(alertEvents()).containsExactly(AlertStateMachine.EventType.ENTERED);
        for (int i = 1; i <= 3; i++) assertThat(deliverAt(store, e, clock, i, CLOCK_BACK_S, false)).as("IM-08: snapshot accepted").isTrue();
        assertThat(alertEvents()).as("three outside observations after the clock stepped back")
                .containsExactly(AlertStateMachine.EventType.ENTERED, AlertStateMachine.EventType.LEFT);
        assertThat(e.activeAlerts("observed")).isEmpty();
    }

    /** R1: 역행 직전에 안쪽 관측 1회(확정 전)였던 기체는 역행 뒤 안쪽 관측 한 번에 ENTERED — 예전에는 약 300 s 동안 확정되지 않았다. */
    @Test void clockSteppedBack_pendingTrackConfirmsOnTheNextInsideObservation() {
        MutableClock clock = new MutableClock(P0.minusSeconds(30));
        SnapshotStore store = new SnapshotStore();
        EngineService e = clockSteppingEngine(clock, store);
        assertThat(deliverAt(store, e, clock, 0, 0, true)).isTrue();
        assertThat(alertEvents()).isEmpty();
        assertThat(deliverAt(store, e, clock, 1, CLOCK_BACK_S, true)).as("IM-08: snapshot accepted").isTrue();
        assertThat(alertEvents()).containsExactly(AlertStateMachine.EventType.ENTERED);
        assertThat(deliverAt(store, e, clock, 2, CLOCK_BACK_S, true)).isTrue();
        assertThat(alertEvents()).containsExactly(AlertStateMachine.EventType.ENTERED);
        assertThat(e.activeAlerts("observed")).hasSize(1);
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
