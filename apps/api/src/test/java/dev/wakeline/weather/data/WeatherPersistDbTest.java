package dev.wakeline.weather.data;

import dev.wakeline.DbTestSupport;
import dev.wakeline.geo.Bbox;
import dev.wakeline.geo.GeoJson;
import dev.wakeline.platform.data.OrderedWriter;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.weather.core.Alert;
import dev.wakeline.weather.core.AlertStateMachine.Event;
import dev.wakeline.weather.core.AlertStateMachine.EventType;
import dev.wakeline.weather.core.EngineEvents;
import dev.wakeline.weather.core.SigmetRecord;
import dev.wakeline.weather.core.SigmetStore;
import dev.wakeline.weather.core.WeatherEvents;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.MultiPolygon;
import org.locationtech.jts.geom.Polygon;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 기상 저장을 실제 PostGIS + V1~V3 스키마 + 운영과 같은 DML 계정(wakeline_api)으로 검증한다: 기동 시 정리(restart), 순서 보장 저장·LOST·자연키 가드,
 * SIGMET 변경분만 쓰기·철회, 백로그 세트 · 영수증, 공항 관측 나이. PersistDbTest 에서 시험 대상 클래스(AlertRepository · SigmetRepository ·
 * AirportRepository)별로 나눴다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class WeatherPersistDbTest {
    static final Instant T0 = Instant.now().truncatedTo(ChronoUnit.SECONDS);

    JdbcClient api;
    JdbcClient admin;
    SimpleMeterRegistry meters;
    OrderedWriter writer;
    SigmetRepository sigmets;
    SigmetStore store;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        api = DbTestSupport.apiClient();
        admin = DbTestSupport.admin();
        meters = new SimpleMeterRegistry();
        writer = new OrderedWriter(meters, 10, 20);
        sigmets = new SigmetRepository(api, DbTestSupport.JSON, writer);
        store = new SigmetStore();
    }

    // ---------- 도우미 ----------

    static MultiPolygon box(double lomin, double lamin, double lomax, double lamax) {
        Polygon p = GeoJson.GF.createPolygon(new Coordinate[]{new Coordinate(lomin, lamin), new Coordinate(lomax, lamin),
                new Coordinate(lomax, lamax), new Coordinate(lomin, lamax), new Coordinate(lomin, lamin)});
        return GeoJson.GF.createMultiPolygon(new Polygon[]{p});
    }

    static SigmetRecord sig(String id, String provider, String raw, Instant from, Instant to) {
        return new SigmetRecord(id, "RKRR", "RKRR INCHEON", "RKSI", id, "ICE", "SEV", 0, null, from, to, box(126, 35, 128, 37),
                null, null, null, null, raw, provider, T0, SigmetRecord.BASE_ASSUMED_SURFACE, SigmetRecord.TOP_UNKNOWN);
    }

    static SigmetRecord fetchedAt(SigmetRecord s, Instant f) {
        return new SigmetRecord(s.id(), s.firId(), s.firName(), s.issuer(), s.seriesId(), s.hazard(), s.qualifier(), s.baseFt(), s.topFt(),
                s.validFrom(), s.validTo(), s.geometry(), s.excludedReason(), s.moveDir(), s.moveSpd(), s.chng(), s.rawText(), s.provider(), f,
                s.baseSource(), s.topSource());
    }

    /** 스트림 순서의 SIGMET 세트 한 벌(이력 저장 이벤트). */
    static WeatherEvents.SigmetSetReceived set(Instant fetched, SigmetRecord... recs) {
        return set(fetched, dev.wakeline.platform.support.Receipt.NONE, recs);
    }

    static WeatherEvents.SigmetSetReceived set(Instant fetched, dev.wakeline.platform.support.Receipt receipt, SigmetRecord... recs) {
        Map<String, SigmetRecord> m = new LinkedHashMap<>();
        for (SigmetRecord r : recs) m.put(r.id(), fetchedAt(r, fetched));
        return new WeatherEvents.SigmetSetReceived(fetched, "awc", m, receipt);
    }

    static Alert observed(long id, String hex, String sig, Instant entered) {
        return new Alert(id, "OBSERVED", hex, "KAL1", sig, "RKRR", "ICE", "SEV", entered, null, null, null, null, 18000,
                Map.of("method", "observed_point_in_polygon", "judged_at", entered.toString()), false);
    }

    static Alert predicted(long id, String hex, String sig, Instant judged, int eta) {
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("method", "dead_reckoning_10min");
        ev.put("entry", "lateral");
        ev.put("judged_at", judged.toString());
        return new Alert(id, "PREDICTED", hex, "KAL2", sig, "RKRR", "ICE", "SEV", judged, null, null, eta, judged.plusSeconds(eta), 20000, ev, true);
    }

    AlertRepository alerts() { return new AlertRepository(api, DbTestSupport.JSON, sigmets, store, writer, meters); }

    void events(AlertRepository repo, Event... evs) { repo.onAlerts(new EngineEvents.AlertsChanged(List.of(evs))); }

    Map<String, Object> alertRow(long id) {
        return admin.sql("SELECT id, hex, left_at, close_reason, eta_s, evidence::text evidence FROM alert_event WHERE id = :id").param("id", id)
                .query().listOfRows().stream().findFirst().orElse(null);
    }

    void insertAlert(long id, String hex, String sig, String kind, Instant entered, Instant left) {
        admin.sql("""
                INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, left_at, evidence) VALUES (:id, :hex, :sig, :kind, :e, :l, '{}'::jsonb)""")
                .param("id", id).param("hex", hex).param("sig", sig).param("kind", kind).param("e", Sql.ts(entered)).param("l", Sql.ts(left)).update();
    }

    Map<String, Object> sigmetRow(String id) {
        return admin.sql("SELECT id, xmin::text xmin, withdrawn_at, base_source, top_source, raw_text FROM sigmet WHERE id = :id").param("id", id)
                .query().listOfRows().stream().findFirst().orElse(null);
    }

    // ---------- 알림 ----------

    @Test
    void startupClosesOnlyRowsLeftOpenByThePreviousRun() {
        SigmetRecord s = sig("RKRR:F01", "awc_isigmet", "RAW1", T0.minusSeconds(3600), T0.plusSeconds(3600));
        sigmets.upsert(s);
        long legacyId = 1_790_507_964L;                                   // 이전 형식(epoch 초) id
        long previousRun = (System.currentTimeMillis() - 120_000) * 1000;  // 이전 실행의 시간 기반 id
        insertAlert(legacyId, "aaaaa1", s.id(), "OBSERVED", T0.minusSeconds(900), null);
        insertAlert(previousRun, "aaaaa2", s.id(), "PREDICTED", T0.minusSeconds(300), null);
        insertAlert(legacyId + 1, "aaaaa3", s.id(), "OBSERVED", T0.minusSeconds(1800), T0.minusSeconds(1200)); // 이미 닫힘

        AlertRepository repo = alerts(); // 생성자가 정리 작업을 순서 큐 맨 앞에 넣는다
        long mine = repo.idFloor() + 7;
        insertAlert(mine, "aaaaa4", s.id(), "OBSERVED", T0, null); // 이 프로세스의 행(정리보다 먼저 들어왔다고 가정)
        writer.drainNow();

        assertThat(alertRow(legacyId)).containsEntry("close_reason", "restart").extractingByKey("left_at").isNotNull();
        assertThat(alertRow(previousRun)).containsEntry("close_reason", "restart").extractingByKey("left_at").isNotNull();
        assertThat(alertRow(legacyId + 1).get("close_reason")).isNull();   // 사유 기록 전 닫힌 행은 그대로(추정해 채우지 않음)
        assertThat(alertRow(mine).get("left_at")).isNull();                // 이 실행의 알림은 건드리지 않는다
    }

    @Test
    void persistsEventsInOrderWithLostCloseReasonAndNaturalKeyGuard() {
        SigmetRecord s = sig("RKRR:F02", "awc_isigmet", "RAW2", T0.minusSeconds(3600), T0.plusSeconds(3600));
        store.replace(T0, "awc", Map.of(s.id(), s)); // DB 에는 아직 없음 — ensure 가 FK 대상 행을 쓴다
        AlertRepository repo = alerts();
        long id = repo.idFloor() + 1;
        Alert a = observed(id, "abc123", s.id(), T0.minusSeconds(60));
        Alert lost = a.closed(T0, Alert.CLOSE_SIGNAL_LOST, Map.of("absent_snapshots", 3, "scope", "region"));
        events(repo, new Event(EventType.ENTERED, a));
        events(repo, new Event(EventType.LOST, lost));

        Alert p = predicted(id + 1, "abc124", s.id(), T0.minusSeconds(30), 300);
        Map<String, Object> ev2 = new LinkedHashMap<>(p.evidence());
        ev2.put("judged_at", T0.toString());
        Alert pu = new Alert(p.id(), p.kind(), p.hex(), p.callsign(), p.sigmetId(), p.firId(), p.hazard(), p.qualifier(), p.enteredAt(), null, null,
                240, T0.plusSeconds(240), p.altFt(), ev2, true);
        events(repo, new Event(EventType.PREDICTED, p), new Event(EventType.PREDICTION_UPDATED, pu));
        events(repo, new Event(EventType.PREDICTION_CLEARED, pu.closed(T0.plusSeconds(10), Alert.CLOSE_PREDICTION_CLEARED, null)));

        // 같은 id 인데 자연키(hex)가 다른 LEFT — 다른 알림의 행을 닫으면 안 된다
        Alert other = observed(id + 2, "abc125", s.id(), T0.minusSeconds(20));
        Alert wrongKey = new Alert(other.id(), "OBSERVED", "fff999", null, s.id(), null, null, null, other.enteredAt(), T0, Alert.CLOSE_LEFT,
                null, null, null, Map.of(), false);
        events(repo, new Event(EventType.ENTERED, other), new Event(EventType.LEFT, wrongKey));

        // 정리 1 + ENTERED · LOST · PREDICTED · UPDATED · CLEARED · ENTERED · LEFT(자연키 불일치 — 오류 아님, 0행)
        assertThat(writer.drainNow()).isEqualTo(8);
        Map<String, Object> r = alertRow(id);
        assertThat(r).containsEntry("close_reason", "signal_lost");
        assertThat(Sql.toInstant(r.get("left_at"))).isEqualTo(T0);
        assertThat(String.valueOf(r.get("evidence"))).contains("absent_snapshots");
        Map<String, Object> pr = alertRow(id + 1);
        assertThat(pr).containsEntry("close_reason", "prediction_cleared").containsEntry("eta_s", 240);
        assertThat(alertRow(id + 2).get("left_at")).isNull();
        assertThat(meters.counter("wakeline_alert_persist_unmatched_total", "event", "LEFT").count()).isEqualTo(1.0);
        assertThat(sigmetRow(s.id())).isNotNull();

        var page = repo.history(T0.minusSeconds(3600), T0.plusSeconds(60), null, null, 10);
        Map<String, Object> hp = page.items().stream().filter(m -> ((Number) m.get("id")).longValue() == id + 1).findFirst().orElseThrow();
        assertThat(hp).containsEntry("close_reason", "prediction_cleared").containsEntry("eta_at", T0.plusSeconds(240));
        Map<String, Object> ho = page.items().stream().filter(m -> ((Number) m.get("id")).longValue() == id).findFirst().orElseThrow();
        assertThat(ho.get("eta_at")).isNull();
    }

    // ---------- SIGMET ----------

    @Test
    void sigmetSetsWriteOnlyChangesAndMarkWithdrawals() {
        Instant f1 = T0.minusSeconds(900), f2 = T0.minusSeconds(600), f3 = T0.minusSeconds(300);
        var a = sig("A", "awc_isigmet", "RAW-A", T0.minusSeconds(3600), T0.plusSeconds(7200));
        var b = sig("B", "awc_isigmet", "RAW-B", T0.minusSeconds(3600), T0.plusSeconds(7200));
        var us = sig("U", "awc_airsigmet", "RAW-U", T0.minusSeconds(3600), T0.plusSeconds(7200));
        sigmets.onSigmetSet(set(f1, a, b, us));
        writer.drainNow();
        String xminA = (String) sigmetRow("A").get("xmin");

        // 같은 내용, 새 수신 — 캐시가 막고(SQL 없음), 캐시가 비어 있어도 SQL 이 행을 다시 쓰지 않는다
        sigmets.onSigmetSet(set(f2, a, b, us));
        writer.drainNow();
        assertThat(sigmetRow("A").get("xmin")).isEqualTo(xminA);
        new SigmetRepository(api, DbTestSupport.JSON, writer).upsert(fetchedAt(a, f2));
        assertThat(sigmetRow("A").get("xmin")).isEqualTo(xminA);

        // f3: B 가 사라짐. 미국(airsigmet) 항목은 세트에 하나도 없음 → 그 공급자는 판단하지 않는다(U 는 철회로 표시하지 않음)
        sigmets.onSigmetSet(set(f3, a));
        writer.drainNow();
        assertThat(Sql.toInstant(sigmetRow("B").get("withdrawn_at"))).isEqualTo(f3);
        assertThat(sigmetRow("U").get("withdrawn_at")).isNull();
        assertThat(sigmetRow("A").get("withdrawn_at")).isNull();
        assertThat(sigmets.validAt(T0).stream().map(m -> m.get("id")).toList()).containsExactlyInAnyOrder("A", "U");
        assertThat(sigmets.validAt(f2).stream().map(m -> m.get("id")).toList()).contains("B"); // 철회 전 시각에는 유효

        // B 가 다시 나타나면 철회 표시를 지운다
        sigmets.onSigmetSet(set(T0, a, b));
        writer.drainNow();
        assertThat(sigmetRow("B").get("withdrawn_at")).isNull();

        // 내용이 바뀌면 쓴다
        var a2 = sig("A", "awc_isigmet", "RAW-A amended", a.validFrom(), a.validTo());
        sigmets.onSigmetSet(set(T0.plusSeconds(1), a2, b));
        writer.drainNow();
        assertThat(sigmetRow("A").get("raw_text")).isEqualTo("RAW-A amended");
    }

    /**
     * 리뷰 cto-2026-10 P4(api-review §4 P7): 재생 조회 validAt 은 {@code valid_to > :t} 를 함께 건다(인덱스 sigmet_valid 의 앞 열 — 표는 지우지 않아 자란다).
     * 그 조건은 원래 조건 {@code coalesce(withdrawn_at, valid_to) > :t} 에 이미 들어 있다 — 쓰기 길이 withdrawn_at < valid_to 를 지키므로:
     * 철회 표시(markWithdrawn)는 valid_to > 세트 시각인 행에만 withdrawn_at = 세트 시각을 쓰고, valid_to 를 바꾸는 upsert 는 늘 withdrawn_at 을 지운다.
     * 여기서는 실제 쓰기 길(onSigmetSet → persistSet: upsert · 철회 표시 · 다시 나타남 · valid_to 늘이기/줄이기)로 만든 표에서 그 불변식과,
     * 경계 시각(발효 · 만료 · 철회 ± 1 s)을 포함한 모든 시각에 validAt 이 원래 조건만으로 고른 것과 같은지 본다.
     */
    @Test
    void replayPredicateWithTheImpliedValidToBoundSelectsExactlyWhatTheOriginalPredicateSelects() {
        java.util.Random rnd = new java.util.Random(20261001);
        Instant start = T0.minus(2, ChronoUnit.DAYS);
        List<SigmetRecord> pool = new java.util.ArrayList<>();
        for (int i = 0; i < 40; i++) {
            Instant from = start.plusSeconds(rnd.nextInt(36 * 3600));
            pool.add(sig("P" + i, "awc_isigmet", "RAW-" + i, from, from.plusSeconds(3600 + rnd.nextInt(5 * 3600))));
        }
        java.util.Set<String> gone = new java.util.HashSet<>();
        for (Instant f = start; f.isBefore(T0); f = f.plusSeconds(600)) {
            List<SigmetRecord> in = new java.util.ArrayList<>();
            for (int i = 0; i < pool.size(); i++) {
                SigmetRecord s = pool.get(i);
                if (rnd.nextInt(40) == 0) { // 발표 내용이 바뀐다: 만료를 늘이거나 줄인다(이미 철회 표시가 있어도)
                    Instant to = s.validTo().plusSeconds((rnd.nextInt(7) - 3) * 1800L);
                    if (to.isAfter(s.validFrom())) pool.set(i, s = sig(s.id(), s.provider(), s.rawText(), s.validFrom(), to));
                }
                if (rnd.nextInt(30) == 0) { if (!gone.add(s.id())) gone.remove(s.id()); } // 빠졌다가(철회) 다시 나타난다
                boolean feed = !f.isBefore(s.validFrom().minusSeconds(1800)) && f.isBefore(s.validTo());
                if (feed && !gone.contains(s.id())) in.add(s);
            }
            if (in.isEmpty()) continue; // 공급자가 세트에 없으면 철회를 판단하지 않는다 — 빈 세트는 보내지 않는다
            sigmets.onSigmetSet(set(f, in.toArray(SigmetRecord[]::new)));
            writer.drainNow();
        }
        assertThat(admin.sql("SELECT count(*) FROM sigmet WHERE withdrawn_at IS NOT NULL").query(Long.class).single()).as("some withdrawals").isPositive();
        assertThat(admin.sql("SELECT count(*) FROM sigmet WHERE withdrawn_at IS NOT NULL AND withdrawn_at >= valid_to").query(Long.class).single())
                .as("the write paths keep withdrawn_at before valid_to").isZero();

        java.util.TreeSet<Instant> ats = new java.util.TreeSet<>();
        for (Instant t = start.minusSeconds(3600); t.isBefore(T0.plusSeconds(6 * 3600)); t = t.plusSeconds(600)) ats.add(t);
        for (var r : admin.sql("SELECT valid_from, valid_to, withdrawn_at FROM sigmet").query().listOfRows())
            for (String k : List.of("valid_from", "valid_to", "withdrawn_at")) {
                Instant x = Sql.toInstant(r.get(k));
                if (x != null) for (long d = -1; d <= 1; d++) ats.add(x.plusSeconds(d));
            }
        for (Instant t : ats) {
            List<Object> original = admin.sql("""
                    SELECT id FROM sigmet WHERE valid_from <= :t AND coalesce(withdrawn_at, valid_to) > :t ORDER BY fir_id, series_id""")
                    .param("t", Sql.ts(t)).query().singleColumn();
            assertThat(sigmets.validAt(t).stream().map(m -> m.get("id")).toList()).as("at %s", t).isEqualTo(original);
        }
    }

    @Test
    void oneInvalidSigmetDoesNotBlockTheRestOfTheSet() {
        var bad = sig("BAD", "awc_isigmet", "bad", T0, T0.minusSeconds(60)); // valid_to < valid_from — DB 제약 위반
        var good = sig("GOOD", "awc_isigmet", "good", T0.minusSeconds(60), T0.plusSeconds(3600));
        sigmets.onSigmetSet(set(T0, bad, good));
        writer.drainNow();
        assertThat(sigmetRow("GOOD")).isNotNull();
        assertThat(sigmetRow("BAD")).isNull();
    }

    @Test
    void legacySigmetSourcesAreStoredWithoutGuessing() {
        Instant from = T0.minusSeconds(600), to = T0.plusSeconds(3600);
        // 이전 형식(출처 없음): base 0 은 JSON 0 인지 null 인지 모른다 → unknown, base>0·top 있음 → json
        var legacyZero = new SigmetRecord("L0", "RKRR", null, null, "L0", "TS", null, 0, null, from, to, box(1, 1, 2, 2), null, null, null, null,
                "RAW", "awc_isigmet", T0);
        var legacyBand = new SigmetRecord("L1", "RKRR", null, null, "L1", "TS", null, 5000, 30000, from, to, box(1, 1, 2, 2), null, null, null, null,
                "RAW", "awc_isigmet", T0);
        sigmets.upsert(legacyZero);
        sigmets.upsert(legacyBand);
        assertThat(sigmetRow("L0")).containsEntry("base_source", "unknown").containsEntry("top_source", "unknown");
        assertThat(sigmetRow("L1")).containsEntry("base_source", "json").containsEntry("top_source", "json");
        Map<String, Object> replayed = sigmets.validAt(T0).stream().filter(m -> "L0".equals(m.get("id"))).findFirst().orElseThrow();
        assertThat(replayed.get("base_source")).isNull(); // DB 전용 'unknown' 은 API 에서 null
    }

    // ---------- 리뷰 수정(2026-09-28) ----------

    /** API-CONC-4·DH-6: 경보 종료는 close_reason sigmet_ended, API-CONC-5: 예측 갱신은 진입 고도 열도 바꾼다. */
    @Test
    void sigmetEndedClosureAndPredictionAltitudeUpdateArePersisted() {
        SigmetRecord s = sig("RKRR:F09", "awc_isigmet", "RAW9", T0.minusSeconds(3600), T0.plusSeconds(3600));
        store.replace(T0, "awc", Map.of(s.id(), s));
        AlertRepository repo = alerts();
        long id = repo.idFloor() + 1;
        Alert a = observed(id, "abc901", s.id(), T0.minusSeconds(60));
        Alert ended = a.closed(T0.minusSeconds(5), Alert.CLOSE_SIGMET_ENDED, Map.of("end_cause", "withdrawn"));
        events(repo, new Event(EventType.ENTERED, a), new Event(EventType.SIGMET_ENDED, ended));
        Alert p = predicted(id + 1, "abc902", s.id(), T0.minusSeconds(30), 300);
        Map<String, Object> ev2 = new LinkedHashMap<>(p.evidence());
        ev2.put("alt_ft_at_entry", 37000);
        Alert pu = new Alert(p.id(), p.kind(), p.hex(), p.callsign(), p.sigmetId(), p.firId(), p.hazard(), p.qualifier(), p.enteredAt(), null, null,
                200, T0.plusSeconds(200), 37000, ev2, true);
        events(repo, new Event(EventType.PREDICTED, p), new Event(EventType.PREDICTION_UPDATED, pu));
        writer.drainNow();
        assertThat(alertRow(id)).containsEntry("close_reason", "sigmet_ended");
        assertThat(Sql.toInstant(alertRow(id).get("left_at"))).isEqualTo(T0.minusSeconds(5));
        Map<String, Object> pr = admin.sql("SELECT eta_s, alt_ft_at_entry, (evidence->>'alt_ft_at_entry')::int ev_alt FROM alert_event WHERE id = :id")
                .param("id", id + 1).query().singleRow();
        assertThat(pr).containsEntry("eta_s", 200).containsEntry("alt_ft_at_entry", 37000).containsEntry("ev_alt", 37000);
        assertThat(AlertRepository.closeReason(new Event(EventType.SIGMET_ENDED, a))).isEqualTo(Alert.CLOSE_SIGMET_ENDED);
    }

    /**
     * API-CONC-1: api 가 멈춘 동안 쌓인 SIGMET 세트(백로그)도 스트림 순서대로 이력에 남는다. 그 사이 철회된 경보는 실제로 빠진 세트의 시각으로,
     * 부트스트랩이 알림 FK 로 먼저 쓴 최신 경보는 그보다 오래된 세트에 '빠졌다' 고 표시되지 않는다(first_seen 가드). 재전달된 세트는 건너뛴다.
     */
    @Test
    void backlogSigmetSetsArePersistedInStreamOrderWithRealWithdrawalTimes() {
        Instant f1 = T0.minusSeconds(1500), f2 = T0.minusSeconds(1200), f3 = T0.minusSeconds(900), f4 = T0.minusSeconds(600), f5 = T0.minusSeconds(300);
        var a = sig("A", "awc_isigmet", "RAW-A", T0.minusSeconds(3600), T0.plusSeconds(7200));
        var x = sig("X", "awc_isigmet", "RAW-X", T0.minusSeconds(1300), T0.plusSeconds(7200)); // 멈춘 동안 발표되고 철회된 경보
        var y = sig("Y", "awc_isigmet", "RAW-Y", T0.minusSeconds(400), T0.plusSeconds(7200));  // 재시작 직전 최신 세트에만 있는 경보
        var keep = sig("K", "awc_isigmet", "RAW-K", T0.minusSeconds(3600), T0.plusSeconds(7200));
        sigmets.onSigmetSet(set(f1, a, keep));           // 멈추기 전
        writer.drainNow();
        // 재시작: 부트스트랩이 최신 세트(f5)를 메모리에 적용하고, 그 세트로 생긴 알림의 FK 로 Y 를 먼저 쓴다(순서보다 앞서)
        sigmets.ensure(fetchedAt(y, f5));
        // 소비가 밀린 세트를 스트림 순서대로 준다(f5 가 마지막)
        sigmets.onSigmetSet(set(f2, a, x, keep));
        sigmets.onSigmetSet(set(f3, x, keep));           // A 철회
        sigmets.onSigmetSet(set(f3, x, keep));           // 재전달(같은 세트) — 건너뛴다
        sigmets.onSigmetSet(set(f4, keep));              // X 철회
        sigmets.onSigmetSet(set(f5, keep, y));
        writer.drainNow();
        assertThat(Sql.toInstant(sigmetRow("A").get("withdrawn_at"))).isEqualTo(f3);
        assertThat(Sql.toInstant(sigmetRow("X").get("withdrawn_at"))).isEqualTo(f4);
        assertThat(sigmetRow("Y").get("withdrawn_at")).as("Y had not appeared yet in f2..f4").isNull();
        assertThat(sigmetRow("K").get("withdrawn_at")).isNull();
        Map<String, Object> firstSeen = new LinkedHashMap<>();
        for (var r : admin.sql("SELECT id, first_seen FROM sigmet").query().listOfRows()) firstSeen.put((String) r.get("id"), Sql.toInstant(r.get("first_seen")));
        assertThat(firstSeen).containsEntry("A", f1).containsEntry("X", f2).containsEntry("Y", f5);
        // 재생: 그 시각에 유효했던 경보
        assertThat(sigmets.validAt(f2.plusSeconds(1)).stream().map(m -> m.get("id")).toList()).contains("A", "X");
        assertThat(sigmets.validAt(f3.plusSeconds(1)).stream().map(m -> m.get("id")).toList()).doesNotContain("A").contains("X");
        assertThat(sigmets.validAt(f4.plusSeconds(1)).stream().map(m -> m.get("id")).toList()).doesNotContain("A", "X");
        // 이미 저장한 세트보다 오래된 세트는 건너뛴다(이력을 과거로 되돌리지 않는다)
        sigmets.onSigmetSet(set(f2, a, x, keep));
        assertThat(writer.drainNow()).isZero();
        assertThat(Sql.toInstant(sigmetRow("A").get("withdrawn_at"))).isEqualTo(f3);
    }

    /** API-CONC-8: SIGMET 세트 메시지의 영수증은 저장이 커밋된 뒤에 풀린다. 건너뛴 재전달은 영수증을 잡지 않는다. */
    @Test
    void sigmetSetReceiptIsReleasedOnlyAfterTheSetIsPersisted() {
        var a = sig("RA", "awc_isigmet", "RAW", T0.minusSeconds(3600), T0.plusSeconds(3600));
        java.util.concurrent.atomic.AtomicInteger acked = new java.util.concurrent.atomic.AtomicInteger();
        dev.wakeline.platform.support.Receipt r = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet);
        sigmets.onSigmetSet(set(T0, r, a));
        r.release();                            // 소비자 자신의 보유
        assertThat(acked.get()).as("not acked before the DB write").isZero();
        writer.drainNow();
        assertThat(acked.get()).isEqualTo(1);
        dev.wakeline.platform.support.Receipt dup = new dev.wakeline.platform.support.Receipt(acked::incrementAndGet);
        sigmets.onSigmetSet(set(T0, dup, a));   // 재전달 — 잡지 않으므로 소비자 보유만 풀면 바로 ACK
        dup.release();
        assertThat(acked.get()).isEqualTo(2);
    }

    // ---------- 공항 ----------

    @Test
    void airportsCarryObservationAgeStaleAndCeilingState() {
        admin.sql("""
                INSERT INTO airport (icao, name, geom, watched) VALUES
                  ('RKSI', 'Incheon', ST_SetSRID(ST_MakePoint(126.45, 37.46), 4326), true),
                  ('RKSS', 'Gimpo', ST_SetSRID(ST_MakePoint(126.79, 37.56), 4326), true)""").update();
        admin.sql("""
                INSERT INTO metar_obs (icao, obs_time, raw, ceiling_state, flight_cat, flight_cat_source, provider, fetched_at)
                VALUES ('RKSI', now() - interval '3 hours', 'RKSI ...', 'unknown', NULL, NULL, 'awc', now())""").update();
        admin.sql("""
                INSERT INTO metar_obs (icao, obs_time, raw, vis_sm, vis_raw, ceiling_state, flight_cat, flight_cat_source, provider, fetched_at)
                VALUES ('RKSS', now() - interval '4 hours', 'RKSS ... 6+SM', 6.0, '6+', 'none', 'VFR', 'awc', 'awc', now())""").update();
        // DH-7: 이력에도 원문 시정(vis_raw)을 싣는다 — '6+'(6 SM 이상)가 '6' 으로 보이지 않게
        Map<String, Object> wx = new AirportRepository(api).wx("RKSS");
        @SuppressWarnings("unchecked") List<Map<String, Object>> history = (List<Map<String, Object>>) wx.get("history");
        assertThat(history.getFirst()).containsEntry("vis_raw", "6+");
        assertThat(((Number) history.getFirst().get("vis_sm")).doubleValue()).isEqualTo(6.0);
        admin.sql("DELETE FROM metar_obs WHERE icao = 'RKSS'").update();
        var rows = new AirportRepository(api).withLatestMetar(Bbox.world(), true);
        Map<String, Object> rksi = rows.stream().filter(r -> "RKSI".equals(r.get("icao"))).findFirst().orElseThrow();
        Map<String, Object> rkss = rows.stream().filter(r -> "RKSS".equals(r.get("icao"))).findFirst().orElseThrow();
        assertThat((Long) rksi.get("obs_age_s")).isBetween(10_700L, 10_900L);
        assertThat(rksi).containsEntry("stale", true).containsEntry("ceiling_state", "unknown");
        assertThat(rksi.get("flight_cat")).isNull();
        assertThat(rkss.get("obs_age_s")).isNull();
        assertThat(rkss.get("stale")).isNull();
        // 카테고리가 있는데 출처가 없으면(또는 반대) 저장되지 않는다
        assertThatThrownBy(() -> admin.sql("""
                INSERT INTO metar_obs (icao, obs_time, raw, flight_cat, flight_cat_source, provider, fetched_at)
                VALUES ('RKSS', now(), 'x', 'VFR', NULL, 'awc', now())""").update()).hasMessageContaining("metar_obs_flight_cat_needs_source");
    }
}
