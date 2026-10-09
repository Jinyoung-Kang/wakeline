package dev.wakeline.airspace;

import dev.wakeline.aircraft.core.AircraftEvents;
import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.airspace.core.AirspaceEdition;
import dev.wakeline.airspace.core.AirspaceLookup;
import dev.wakeline.airspace.core.AirspaceRecord;
import dev.wakeline.airspace.core.AirspaceStore;
import dev.wakeline.airspace.core.AirspaceZones;
import dev.wakeline.geo.GeoJson;
import dev.wakeline.weather.core.Alert;
import dev.wakeline.weather.core.AlertStateMachine;
import dev.wakeline.weather.core.AlertStateMachine.EventType;
import dev.wakeline.weather.core.EngineEvents;
import dev.wakeline.weather.core.EngineService;
import dev.wakeline.weather.core.SigmetStore;
import dev.wakeline.weather.core.ZoneSource;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Geometry;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 공역 진입 판정(SPEC F2 · ADR-035 · 계약 v5 §G48) — SIGMET 과 같은 엔진 코드의 두 번째 상태 머신. 판정 대상 · 수준(금지 · 원전 · 안보 = 알림,
 * 제한 = 정보, 고도 기준을 비교할 수 없으면 판정 안 함) · 고도 비교(FL · 해면 · 무제한) · 근거(한계 · 가정 · 차수 · 고도 경계 근처) · 모드(off · shadow · on) ·
 * 차수 교체 · 판정 끔의 구역 종료 · 항공기 카드의 '들어 있는 공역'.
 */
class AirspaceJudgementTest {
    static Geometry box(double lon, double lat, double w, double h) {
        return GeoJson.GF.createPolygon(new Coordinate[]{new Coordinate(lon, lat), new Coordinate(lon + w, lat), new Coordinate(lon + w, lat + h),
                new Coordinate(lon, lat + h), new Coordinate(lon, lat)});
    }

    static AirspaceRecord rec(long id, String cat, String ident, AirspaceRecord.Limit lo, AirspaceRecord.Limit hi, Geometry g) {
        return new AirspaceRecord(id, cat, "종류 " + cat, "통제공역 / " + cat, null, ident, "시험 " + ident, null, null, g == null ? "line" : "polygon", lo, hi, g, null);
    }

    static final AirspaceRecord.Limit SFC = new AirspaceRecord.Limit(0, "SFC", "Ground");
    static final AirspaceRecord P = rec(1, "prohibited", "RK P99", SFC, new AirspaceRecord.Limit(null, "UNL", "Unlimited"), box(132.0, 36.0, 0.2, 0.2));
    static final AirspaceRecord NUC = rec(2, "nuclear", "P99A", SFC, new AirspaceRecord.Limit(10_000, "FL", "100 FL ALT"), box(132.5, 37.0, 0.1, 0.1));
    static final AirspaceRecord R180 = rec(3, "restricted", "RK R991", SFC, new AirspaceRecord.Limit(18_000, "FL", "180 Flight Level Altitude"), box(132.3, 36.0, 0.3, 0.3));
    static final AirspaceRecord RUNK = rec(4, "restricted", "RK R993", new AirspaceRecord.Limit(null, "UNKNOWN", "Feet"), new AirspaceRecord.Limit(null, "UNKNOWN", "Feet"), box(133.0, 36.0, 0.1, 0.1));
    static final AirspaceRecord D = rec(5, "danger", "RK D999", SFC, new AirspaceRecord.Limit(2_000, "AGL", "2000 Feet Height"), box(132.0, 36.5, 0.3, 0.3));
    static final AirspaceRecord MOA = rec(6, "moa", "MOA 99", new AirspaceRecord.Limit(3_000, "MSL", "3000 Feet Altitude"), new AirspaceRecord.Limit(15_000, "FL", "150"), box(131.5, 37.6, 0.3, 0.3));

    static AirspaceStore.Snapshot snap(long editionId, AirspaceRecord... rs) {
        return new AirspaceStore.Snapshot(new AirspaceEdition(editionId, "합성 " + editionId + "차", null, String.valueOf(editionId).repeat(64), Instant.EPOCH), List.of(rs));
    }

    final SnapshotStore snapshots = new SnapshotStore();
    final AirspaceStore store = new AirspaceStore();
    final AirspaceZones zones = new AirspaceZones(store);
    final List<Object> events = new ArrayList<>();
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    final EngineService engine = new EngineService(snapshots, new SigmetStore(), events::add, meters, zones);
    long seq;

    AircraftState at(String hex, double lat, double lon, Integer alt, Instant seen) {
        return new AircraftState(hex, "TST", null, null, null, lat, lon, alt, 450.0, 90.0, 0.0, false, null, seen, "adsb_fi", seen, 0, false);
    }

    /** 같은 기체의 서로 다른 관측(seen_at 이 바뀜)을 n 번 */
    void observe(int n, AircraftState... states) {
        for (int i = 0; i < n; i++) {
            Instant seen = Instant.now().minusSeconds(n - i);
            Map<String, AircraftState> m = new HashMap<>();
            for (AircraftState a : states) m.put(a.hex(), at(a.hex(), a.lat(), a.lon() + (seq++ % 5) * 1e-4, a.altFt(), seen));
            Snapshot s = new Snapshot(snapshots.nextVersion(), "region", "adsb_fi", seen, seen, "-", Map.copyOf(m));
            Snapshot prev = snapshots.replace(s);
            engine.onSnapshot(new AircraftEvents.SnapshotUpdated(prev, s));
        }
    }

    List<AlertStateMachine.Event> published() {
        return events.stream().filter(e -> e instanceof EngineEvents.AlertsChanged).flatMap(e -> ((EngineEvents.AlertsChanged) e).events().stream()).toList();
    }

    double counted(String mode, String event) {
        var c = meters.find("wakeline_zone_events_total").tag("mode", mode).tag("event", event).counters();
        return c.stream().mapToDouble(x -> x.count()).sum();
    }

    @Test
    void onlyJudgedCategoriesWithAComparableBandBecomeZones_atTheirLevel() {
        store.replace(snap(7, P, NUC, R180, RUNK, D, MOA, rec(8, "route", "Z999", SFC, SFC, null)));
        assertThat(zones.version()).isEqualTo(7);
        assertThat(zones.zones()).extracting(z -> z.record().ident() + "=" + z.level())
                .containsExactly("RK P99=alert", "P99A=alert", "RK R991=info");
        assertThat(zones.skipped()).isEqualTo(Map.of("no_vertical", 1)); // 기준 모름의 제한구역(위험구역 · 군작전 · 항로는 판정 종류가 아니다)
        assertThat(zones.zone("1").judgedTopFt()).isNull();
        assertThat(zones.zone("2").judgedTopFt()).isEqualTo(10_000);
        assertThat(zones.set().ended("1", null, Instant.now())).isNull();
        assertThat(zones.set().ended("99", null, Instant.now()).cause()).isEqualTo("edition_replaced");
        store.replace(AirspaceStore.Snapshot.EMPTY);
        assertThat(zones.version()).isZero();
        assertThat(zones.zones()).isEmpty();
    }

    @Test
    void onMode_entersAfterTwoObservations_withAirspaceEvidence_andRespectsTheBand() {
        store.replace(snap(7, P, R180, NUC));
        zones.setMode(ZoneSource.MODE_ON);
        observe(2, at("a00001", 36.1, 132.1, 15_000, null),      // 금지구역 안(지면 – 무제한)
                at("a00002", 36.1, 132.45, 25_000, null),            // 제한구역 위(FL250 > FL180) — 진입 아님
                at("a00003", 36.1, 132.45, 10_000, null),            // 제한구역 안 — 정보
                at("a00004", 37.05, 132.55, 9_800, null));           // 원전 상한 FL100 바로 아래 — 고도 경계 근처
        Map<String, Alert> entered = new HashMap<>();
        for (var e : published()) if (e.type() == EventType.ENTERED) entered.put(e.alert().hex(), e.alert());
        assertThat(entered).containsOnlyKeys("a00001", "a00003", "a00004");
        Alert p = entered.get("a00001");
        assertThat(p.zoneType()).isEqualTo("airspace");
        assertThat(p.level()).isEqualTo("alert");
        assertThat(p.sigmetId()).isNull();
        assertThat(p.airspace()).containsEntry("id", 1L).containsEntry("label", "RK P99").containsEntry("edition", "합성 7차").containsEntry("category", "prohibited");
        assertThat(p.evidence()).containsEntry("assumption", "pressure_altitude_as_msl").containsEntry("top_unlimited", true)
                .containsEntry("edition", "합성 7차").containsEntry("edition_id", 7L).containsEntry("method", "observed_point_in_polygon")
                .doesNotContainKey("valid_from").doesNotContainKey("altitude_uncertain");
        assertThat(p.evidence().get("band_ft")).isEqualTo(java.util.Arrays.asList(0, null));
        assertThat(entered.get("a00003").level()).isEqualTo("info");
        assertThat(entered.get("a00004").evidence()).containsEntry("altitude_uncertain", true);
        assertThat(engine.activeAlerts("observed")).extracting(Alert::hex).containsExactlyInAnyOrder("a00001", "a00003", "a00004");
        // 금지구역 안에서 동쪽으로 나는 a00001 은 10분 안에 FL180 제한구역(132.3E)에 들어간다 — 예측(추정)
        assertThat(engine.activeAlerts("predicted")).singleElement().satisfies(a -> {
            assertThat(a.hex()).isEqualTo("a00001");
            assertThat(a.airspace()).containsEntry("label", "RK R991");
            assertThat(a.estimated()).isTrue();
        });
    }

    @Test
    void shadowMode_countsButNeitherPublishesNorListsAlerts() {
        store.replace(snap(7, P));
        zones.setMode(ZoneSource.MODE_SHADOW);
        observe(2, at("b00001", 36.1, 132.1, 15_000, null));
        assertThat(published()).isEmpty();
        assertThat(engine.activeAlerts(null)).isEmpty();
        assertThat(counted("shadow", "ENTERED")).isEqualTo(1.0);
        zones.setMode(ZoneSource.MODE_OFF);
        observe(3, at("b00001", 36.1, 132.1, 15_000, null));
        assertThat(published()).isEmpty();
        assertThat(counted("shadow", "ENTERED")).isEqualTo(1.0);
    }

    @Test
    void leavingOnClosesOpenAirspaceAlertsAsZoneEnded_andAnEditionChangeEndsZonesThatAreGone() {
        store.replace(snap(7, P, R180));
        zones.setMode(ZoneSource.MODE_ON);
        observe(2, at("c00001", 36.1, 132.1, 15_000, null), at("c00002", 36.1, 132.45, 10_000, null));
        assertThat(published()).filteredOn(e -> e.type() == EventType.ENTERED).extracting(e -> e.alert().hex()).containsExactlyInAnyOrder("c00001", "c00002");
        events.clear();

        store.replace(snap(8, R180)); // 새 차수에는 금지구역 P 가 없다
        observe(1, at("c00001", 36.1, 132.1, 15_000, null), at("c00002", 36.1, 132.45, 10_000, null));
        var ended = published().stream().filter(e -> e.type() == EventType.ZONE_ENDED).toList();
        assertThat(ended).singleElement().satisfies(e -> {
            assertThat(e.alert().hex()).isEqualTo("c00001");
            assertThat(e.alert().closeReason()).isEqualTo(Alert.CLOSE_ZONE_ENDED);
            assertThat(e.alert().evidence()).containsEntry("end_cause", "edition_replaced");
        });
        events.clear();

        zones.setMode(ZoneSource.MODE_SHADOW);
        observe(1, at("c00002", 36.1, 132.45, 10_000, null));
        assertThat(published()).filteredOn(e -> e.type() == EventType.ZONE_ENDED).singleElement().satisfies(e -> {
            assertThat(e.alert().hex()).isEqualTo("c00002");
            assertThat(e.alert().evidence()).containsEntry("end_cause", EngineService.END_JUDGING_OFF);
        });
        assertThat(published()).extracting(AlertStateMachine.Event::type).containsOnly(EventType.ZONE_ENDED, EventType.PREDICTION_CLEARED);
        assertThat(engine.activeAlerts(null)).isEmpty();
    }

    @Test
    void predictsAnEntryWithinTenMinutes() {
        store.replace(snap(7, P));
        zones.setMode(ZoneSource.MODE_ON);
        observe(2, at("d00001", 36.1, 131.95, 15_000, null)); // 서쪽 약 2.4 NM, 동쪽으로 450 kt
        assertThat(published()).anySatisfy(e -> {
            assertThat(e.type()).isEqualTo(EventType.PREDICTED);
            assertThat(e.alert().zoneType()).isEqualTo("airspace");
            assertThat(e.alert().evidence()).containsEntry("method", "dead_reckoning_10min").containsEntry("edition", "합성 7차");
        });
    }

    @Test
    void aircraftCardLookup_listsJudgedAndDangerAreas_withTheVerticalVerdict() {
        AirspaceLookup lookup = new AirspaceLookup(store);
        assertThat(lookup.inside(36.1, 132.1, 15_000)).isNull(); // 차수 없음 = 모름
        store.replace(snap(7, P, R180, D, MOA));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items = (List<Map<String, Object>>) lookup.inside(36.55, 132.1, 30_000).get("items");
        assertThat(items).singleElement().satisfies(m -> {   // 위험구역(지면 기준) — 고도 판정 안 함, 수평만
            assertThat(m).containsEntry("label", "RK D999").containsEntry("vertical", "not_judged").doesNotContainKey("level");
        });
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> overR = (List<Map<String, Object>>) lookup.inside(36.1, 132.45, 25_000).get("items");
        assertThat(overR).isEmpty(); // FL250 은 FL180 제한구역 위
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> inP = (List<Map<String, Object>>) lookup.inside(36.1, 132.1, null).get("items");
        assertThat(inP).singleElement().satisfies(m -> assertThat(m).containsEntry("vertical", "unknown").containsEntry("level", "alert"));
        assertThat(lookup.inside(36.1, 132.1, 15_000)).containsEntry("edition", "합성 7차");
    }
}
