package dev.wakeline.persist;

import dev.wakeline.DbTestSupport;
import dev.wakeline.config.AppProperties;
import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.Alert;
import dev.wakeline.domain.Bbox;
import dev.wakeline.domain.GeoJson;
import dev.wakeline.domain.SigmetRecord;
import dev.wakeline.engine.AlertStateMachine.Event;
import dev.wakeline.engine.AlertStateMachine.EventType;
import dev.wakeline.engine.EngineEvents;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.SigmetStore;
import dev.wakeline.ops.RegionSettings;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.MultiPolygon;
import org.locationtech.jts.geom.Polygon;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 영속 계층을 실제 PostGIS + V1~V3 스키마 + 운영과 같은 DML 계정(wakeline_api)으로 검증한다.
 * 기동 시 정리(restart), 순서 보장 저장·LOST·자연키 가드, SIGMET 변경분만 쓰기·철회, aircraft 한 문장 upsert,
 * 통계 규칙·따라잡기, 재생 출처·레이더, 공항 관측 나이.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class PersistDbTest {
    static final Instant T0 = Instant.now().truncatedTo(ChronoUnit.SECONDS);
    static final AppProperties PROPS = new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30,
            120, List.of("http://localhost:8700"));

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
    static IngestEvents.SigmetSetReceived set(Instant fetched, SigmetRecord... recs) {
        return set(fetched, dev.wakeline.ingest.Receipt.NONE, recs);
    }

    static IngestEvents.SigmetSetReceived set(Instant fetched, dev.wakeline.ingest.Receipt receipt, SigmetRecord... recs) {
        Map<String, SigmetRecord> m = new LinkedHashMap<>();
        for (SigmetRecord r : recs) m.put(r.id(), fetchedAt(r, fetched));
        return new IngestEvents.SigmetSetReceived(fetched, "awc", m, receipt);
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

    static AircraftState ac(String hex, double lat, double lon, Instant seen, String reg) {
        return new AircraftState(hex, "TST1", reg, null, null, lat, lon, 30000, 450.0, 90.0, 0.0, false, "1200", seen, "adsb_lol", seen, 0, false);
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

    RegionSettings region() { return new RegionSettings(new StringRedisTemplate(), api, DbTestSupport.JSON, PROPS); }

    void trackPoint(String hex, Instant ts, double lat, double lon) {
        admin.sql("""
                INSERT INTO track_point (hex, ts, geom, alt_ft, provider, fetched_at)
                VALUES (:h, :t, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), 30000, 'adsb_lol', :t)""")
                .param("h", hex).param("t", Sql.ts(ts)).param("lat", lat).param("lon", lon).update();
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
        assertThat(TrackRepository.toInstant(r.get("left_at"))).isEqualTo(T0);
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

    @Test
    void writerRetriesPermanentFailureThreeTimesThenDropsAndCounts() throws Exception {
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        writer.submit(OrderedWriter.task("probe", () -> {
            calls.incrementAndGet();
            // FK 대상 SIGMET 이 없음(23503) — 짧은 경합이면 재시도 사이에 생기지만, 끝내 없으면 버리고 센다
            api.sql("INSERT INTO alert_event (id, hex, sigmet_id, kind, entered_at, evidence) VALUES (1, 'aaaaaa', 'NO-SUCH-SIGMET', 'OBSERVED', now(), '{}'::jsonb)").update();
        }));
        writer.start();
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline
                && meters.counter("wakeline_persist_tasks_total", "kind", "probe", "result", "failed").count() < 1) Thread.sleep(10);
        writer.stop();
        assertThat(calls.get()).isEqualTo(OrderedWriter.PERMANENT_ATTEMPTS);
        assertThat(meters.counter("wakeline_persist_tasks_total", "kind", "probe", "result", "failed").count()).isEqualTo(1.0);
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
        assertThat(TrackRepository.toInstant(sigmetRow("B").get("withdrawn_at"))).isEqualTo(f3);
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

    // ---------- aircraft · 항적 ----------

    @Test
    void aircraftStaticUpsertWritesOnlyNewOrChangedRowsInBulk() {
        AircraftRepository repo = new AircraftRepository(api, DbTestSupport.JSON);
        List<AircraftState> many = new ArrayList<>();
        for (int i = 0; i < 6_000; i++) many.add(ac(String.format("%06x", i + 1), 36, 127, T0, null));
        assertThat(repo.touch(many)).isEqualTo(6_000);
        assertThat(admin.sql("SELECT count(*) FROM aircraft").query(Long.class).single()).isEqualTo(6_000L);
        assertThat(repo.touch(many)).isZero(); // 1분 안에 같은 내용 — 쓰지 않는다

        assertThat(repo.touch(List.of(ac("000001", 36, 127, T0.plusSeconds(5), "HL7777")))).isEqualTo(1); // 등록기호가 새로 알려짐
        assertThat(repo.touch(List.of(ac("000001", 36, 127, T0.plusSeconds(6), null)))).isZero();          // 모르는 값은 변화가 아니다
        Map<String, Object> row = repo.find("000001");
        assertThat(row).containsEntry("registration", "HL7777").containsEntry("last_seen", T0.plusSeconds(5));
    }

    @Test
    void trackWriterRunsOffTheCallerThreadAndFlushesOnStop() throws Exception {
        AircraftRepository repo = new AircraftRepository(api, DbTestSupport.JSON);
        TrackWriter tw = new TrackWriter(DbTestSupport.apiJdbc(), repo, meters, 10, 20);
        tw.start();
        Instant seen = Instant.now().minusSeconds(30);
        var states = Map.of("aaa001", ac("aaa001", 36, 127, seen, "HL1"), "aaa002", ac("aaa002", 36.1, 127.1, seen, null));
        var snap = new dev.wakeline.ingest.Snapshot(1, "region", "adsb_lol", seen, seen, "-", states);
        tw.onSnapshot(new IngestEvents.SnapshotUpdated(dev.wakeline.ingest.Snapshot.empty("region"), snap));
        tw.onBacklog(new IngestEvents.AircraftBacklog("region", seen.minusSeconds(10),
                List.of(ac("aaa003", 36.2, 127.2, seen.minusSeconds(10), null))));
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline
                && admin.sql("SELECT count(*) FROM aircraft").query(Long.class).single() < 3) Thread.sleep(50);
        tw.stop();
        assertThat(admin.sql("SELECT count(*) FROM track_point WHERE hex IN ('aaa001','aaa002','aaa003')").query(Long.class).single()).isEqualTo(3L);
        assertThat(admin.sql("SELECT count(*) FROM aircraft").query(Long.class).single()).isEqualTo(3L);
        tw.write(List.of(states.get("aaa001"))); // 같은 (hex, ts) 재기록은 중복되지 않는다
        assertThat(admin.sql("SELECT count(*) FROM track_point WHERE hex = 'aaa001'").query(Long.class).single()).isEqualTo(1L);
        assertThat(meters.counter("wakeline_track_rows_total", "result", "dropped").count()).isZero();
    }

    @Test
    void trackBatchSurvivesATransientOutageWithoutLosingRows() throws Exception {
        java.util.concurrent.atomic.AtomicInteger outage = new java.util.concurrent.atomic.AtomicInteger(3);
        javax.sql.DataSource flaky = new org.springframework.jdbc.datasource.DelegatingDataSource(DbTestSupport.apiDataSource()) {
            @Override public java.sql.Connection getConnection() throws java.sql.SQLException {
                if (outage.getAndDecrement() > 0) throw new java.sql.SQLTransientConnectionException("pool timeout");
                return super.getConnection();
            }
        };
        TrackWriter tw = new TrackWriter(new org.springframework.jdbc.core.JdbcTemplate(flaky),
                new AircraftRepository(JdbcClient.create(flaky), DbTestSupport.JSON), meters, 10, 20);
        tw.start();
        Instant seen = Instant.now().minusSeconds(20);
        tw.enqueue(List.of(ac("f00001", 36, 127, seen, null), ac("f00002", 36, 127, seen, null)));
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline
                && admin.sql("SELECT count(*) FROM track_point WHERE hex LIKE 'f0000%'").query(Long.class).single() < 2) Thread.sleep(20);
        tw.stop();
        // 이전에는 실패한 배치를 버리고 dropped 도 세지 않았다(REL-10)
        assertThat(admin.sql("SELECT count(*) FROM track_point WHERE hex LIKE 'f0000%'").query(Long.class).single()).isEqualTo(2L);
        assertThat(meters.counter("wakeline_track_rows_total", "result", "written").count()).isEqualTo(2.0);
        assertThat(meters.counter("wakeline_track_rows_total", "result", "dropped").count()).isZero();
    }

    @Test
    void permanentlyRejectedTrackRowsAreCountedAsFailed() throws Exception {
        TrackWriter tw = new TrackWriter(DbTestSupport.apiJdbc(), new AircraftRepository(api, DbTestSupport.JSON), meters, 5, 10);
        tw.start();
        java.util.concurrent.atomic.AtomicInteger acked = new java.util.concurrent.atomic.AtomicInteger();
        dev.wakeline.ingest.Receipt r = new dev.wakeline.ingest.Receipt(acked::incrementAndGet);
        tw.enqueue(List.of(ac("f10001", 36, 127, Instant.parse("2001-01-01T00:00:00Z"), null)), r); // 파티션 없음(23514)
        r.release();
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline && meters.counter("wakeline_track_rows_total", "result", "failed").count() < 1) Thread.sleep(20);
        tw.stop();
        assertThat(meters.counter("wakeline_track_rows_total", "result", "failed").count()).isEqualTo(1.0);
        assertThat(meters.counter("wakeline_track_rows_total", "result", "written").count()).isZero();
        assertThat(acked.get()).as("re-processing cannot fix a permanent error — the message is acknowledged").isEqualTo(1);
    }

    // ---------- 통계 · 요약 ----------

    @Test
    void dailyStatsCountRegionTrafficIssueDaySigmetsAndHonestDwell() {
        LocalDate day = MaintenanceJobs.today().minusDays(1); // KST 날짜(계약 v5 §G19)
        Instant d0 = day.atStartOfDay(MaintenanceJobs.DAY_ZONE).toInstant();
        DbTestSupport.ensureTrackPartitions(d0, d0.plusSeconds(26 * 3600));
        sigmets.upsert(sig("X", "awc_isigmet", "X", d0.plusSeconds(20 * 3600), d0.plusSeconds(26 * 3600)));  // 그날 발표, 다음날까지
        sigmets.upsert(sig("Y", "awc_isigmet", "Y", d0.minusSeconds(2 * 3600), d0.plusSeconds(4 * 3600)));   // 전날 발표 → 그날 세지 않는다
        insertAlert(1, "b00001", "X", "OBSERVED", d0.plusSeconds(3600), d0.plusSeconds(3600 + 600));
        admin.sql("UPDATE alert_event SET close_reason = 'left' WHERE id = 1").update();
        insertAlert(2, "b00002", "X", "OBSERVED", d0.plusSeconds(3600), d0.plusSeconds(3600 + 60));
        admin.sql("UPDATE alert_event SET close_reason = 'signal_lost' WHERE id = 2").update();
        insertAlert(3, "b00003", "X", "OBSERVED", d0.plusSeconds(3600), d0.plusSeconds(3600 + 5));
        admin.sql("UPDATE alert_event SET close_reason = 'restart' WHERE id = 3").update();
        // DH-5·API-CONC-3: 사유 미기록(NULL)·경보 종료(sigmet_ended)·만료 뒤에 닫힌 옛 left 는 확인된 이탈이 아니다 — 평균에서 뺀다
        insertAlert(4, "b00004", "X", "OBSERVED", d0.plusSeconds(3600), d0.plusSeconds(3600 + 2000));
        insertAlert(5, "b00005", "X", "OBSERVED", d0.plusSeconds(3600), d0.plusSeconds(3600 + 3000));
        admin.sql("UPDATE alert_event SET close_reason = 'sigmet_ended' WHERE id = 5").update();
        insertAlert(6, "b00006", "X", "OBSERVED", d0.plusSeconds(3600), d0.plusSeconds(3600 + 4000));
        admin.sql("UPDATE alert_event SET close_reason = 'left', evidence = '{\"sigmet_expired\": true}'::jsonb WHERE id = 6").update();
        trackPoint("c00001", d0.plusSeconds(3600 + 30), 36.5, 127.8);   // 관심 지역 안
        trackPoint("c00002", d0.plusSeconds(3600 + 30), 0.5, 10.0);     // 전세계 표본 — 세지 않는다
        MaintenanceJobs jobs = new MaintenanceJobs(api, PROPS, region(), DbTestSupport.apiTx());

        jobs.aggregateDay(day);
        Map<String, Object> stats = new LinkedHashMap<>();
        for (var r : api.sql("SELECT metric || ':' || dim k, value FROM stats_daily WHERE day = :d").param("d", day).query().listOfRows())
            stats.put(String.valueOf(r.get("k")), ((Number) r.get("value")).doubleValue());
        assertThat(stats).containsEntry("sigmet_by_fir:RKRR", 1.0).containsEntry("traffic_by_hour:01", 1.0)
                .containsEntry("alert_dwell_avg_s:OBSERVED", 600.0).containsEntry("alerts_by_kind:OBSERVED", 6.0)
                .containsEntry("traffic_region:center_lat", 36.5).containsEntry("traffic_region:radius_nm", 250.0);
        var traffic = new StatsRepository(api).traffic(day);
        assertThat(traffic.region()).containsEntry("radius_nm", 250).containsEntry("center", List.of(36.5, 127.8));
        // DH-10: 집계가 실제로 센 사각형(같은 식으로 결정적으로 복원)
        var bb = new RegionSettings.Region(36.5, 127.8, 250).bbox();
        assertThat(traffic.region()).containsEntry("bbox", List.of(bb.lomin(), bb.lamin(), bb.lomax(), bb.lamax()));
        assertThat(new StatsRepository(api).traffic(day.minusDays(30)).region()).isNull(); // 지역 기록 없는 날 — 범위를 단정하지 않는다

        // 완료된(이탈) OBSERVED 가 없는 날: 체류 행을 만들지 않는다(0 을 지어내지 않는다)
        jobs.aggregateDay(day.minusDays(1));
        assertThat(api.sql("SELECT count(*) FROM stats_daily WHERE day = :d AND metric = 'alert_dwell_avg_s'").param("d", day.minusDays(1))
                .query(Long.class).single()).isZero();
        jobs.aggregateDay(day); // 멱등
        assertThat(api.sql("SELECT count(*) FROM stats_daily WHERE day = :d").param("d", day).query(Long.class).single())
                .isEqualTo((long) stats.size());
    }

    @Test
    void catchUpFillsOnlyMissingSummaryHoursAndStatsDays() {
        Instant now = Instant.now();
        Instant h2 = now.truncatedTo(ChronoUnit.HOURS).minus(2, ChronoUnit.HOURS);
        Instant h3 = h2.minus(1, ChronoUnit.HOURS);
        trackPoint("d00001", h2.plusSeconds(600), 36.5, 127.8);
        trackPoint("d00002", h3.plusSeconds(600), 36.5, 127.8);
        MaintenanceJobs jobs = new MaintenanceJobs(api, PROPS, region(), DbTestSupport.apiTx());
        jobs.summarizeHour(h3); // 이미 요약된 시간
        long before = admin.sql("SELECT count(*) FROM track_point_1m").query(Long.class).single();

        assertThat(jobs.catchUpSummaries(now)).containsExactly(h2);
        assertThat(admin.sql("SELECT count(*) FROM track_point_1m").query(Long.class).single()).isEqualTo(before + 1);
        assertThat(jobs.catchUpSummaries(now)).isEmpty(); // 멱등

        LocalDate today = MaintenanceJobs.today();
        // 이미 집계를 마친 날(R-46: 계열마다 완료 표식) — 따라잡기가 다시 세지 않는다
        admin.sql("INSERT INTO stats_daily (day, metric, dim, value) VALUES (:d, 'alerts_by_kind', 'OBSERVED', 1), "
                + "(:d, 'aggregated_at', 'sigmet', 1), (:d, 'aggregated_at', 'traffic', 1), (:d, 'aggregated_at', 'alerts', 1)").param("d", today.minusDays(2)).update();
        List<LocalDate> done = jobs.catchUpStats(today);
        assertThat(done).hasSize(MaintenanceJobs.CATCH_UP_DAYS - 1).doesNotContain(today.minusDays(2)).contains(today.minusDays(1), today.minusDays(7));
        assertThat(admin.sql("SELECT value FROM stats_daily WHERE day = :d AND metric = 'alerts_by_kind'").param("d", today.minusDays(2)).query(Long.class).single()).isEqualTo(1L);
    }

    @Test
    void retentionCanDeleteCollectorTables() {
        admin.sql("INSERT INTO radar_frame (frame_time, host, path, fetched_at) VALUES (now() - interval '8 days', 'h', '/p', now())").update();
        admin.sql("INSERT INTO ingest_run (job, provider, started_at, status) VALUES ('x', 'y', now() - interval '31 days', 'ok')").update();
        new MaintenanceJobs(api, PROPS, region(), DbTestSupport.apiTx()).dropOldPartitions();
        assertThat(admin.sql("SELECT count(*) FROM radar_frame").query(Long.class).single()).isZero();
        assertThat(admin.sql("SELECT count(*) FROM ingest_run").query(Long.class).single()).isZero();
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
        assertThat(TrackRepository.toInstant(alertRow(id).get("left_at"))).isEqualTo(T0.minusSeconds(5));
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
        assertThat(TrackRepository.toInstant(sigmetRow("A").get("withdrawn_at"))).isEqualTo(f3);
        assertThat(TrackRepository.toInstant(sigmetRow("X").get("withdrawn_at"))).isEqualTo(f4);
        assertThat(sigmetRow("Y").get("withdrawn_at")).as("Y had not appeared yet in f2..f4").isNull();
        assertThat(sigmetRow("K").get("withdrawn_at")).isNull();
        Map<String, Object> firstSeen = new LinkedHashMap<>();
        for (var r : admin.sql("SELECT id, first_seen FROM sigmet").query().listOfRows()) firstSeen.put((String) r.get("id"), TrackRepository.toInstant(r.get("first_seen")));
        assertThat(firstSeen).containsEntry("A", f1).containsEntry("X", f2).containsEntry("Y", f5);
        // 재생: 그 시각에 유효했던 경보
        assertThat(sigmets.validAt(f2.plusSeconds(1)).stream().map(m -> m.get("id")).toList()).contains("A", "X");
        assertThat(sigmets.validAt(f3.plusSeconds(1)).stream().map(m -> m.get("id")).toList()).doesNotContain("A").contains("X");
        assertThat(sigmets.validAt(f4.plusSeconds(1)).stream().map(m -> m.get("id")).toList()).doesNotContain("A", "X");
        // 이미 저장한 세트보다 오래된 세트는 건너뛴다(이력을 과거로 되돌리지 않는다)
        sigmets.onSigmetSet(set(f2, a, x, keep));
        assertThat(writer.drainNow()).isZero();
        assertThat(TrackRepository.toInstant(sigmetRow("A").get("withdrawn_at"))).isEqualTo(f3);
    }

    /** API-CONC-8: SIGMET 세트 메시지의 영수증은 저장이 커밋된 뒤에 풀린다. 건너뛴 재전달은 영수증을 잡지 않는다. */
    @Test
    void sigmetSetReceiptIsReleasedOnlyAfterTheSetIsPersisted() {
        var a = sig("RA", "awc_isigmet", "RAW", T0.minusSeconds(3600), T0.plusSeconds(3600));
        java.util.concurrent.atomic.AtomicInteger acked = new java.util.concurrent.atomic.AtomicInteger();
        dev.wakeline.ingest.Receipt r = new dev.wakeline.ingest.Receipt(acked::incrementAndGet);
        sigmets.onSigmetSet(set(T0, r, a));
        r.release();                            // 소비자 자신의 보유
        assertThat(acked.get()).as("not acked before the DB write").isZero();
        writer.drainNow();
        assertThat(acked.get()).isEqualTo(1);
        dev.wakeline.ingest.Receipt dup = new dev.wakeline.ingest.Receipt(acked::incrementAndGet);
        sigmets.onSigmetSet(set(T0, dup, a));   // 재전달 — 잡지 않으므로 소비자 보유만 풀면 바로 ACK
        dup.release();
        assertThat(acked.get()).isEqualTo(2);
    }

    /** API-CONC-8: 항적 메시지의 영수증은 그 행이 커밋된 뒤에만 풀린다 — DB 장애 중에는 ACK 되지 않고, 종료 때 못 쓴 메시지는 끝까지 ACK 되지 않는다. */
    @Test
    void trackReceiptsAreReleasedOnlyAfterTheirRowsAreDurable() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean down = new java.util.concurrent.atomic.AtomicBoolean(true);
        javax.sql.DataSource flaky = new org.springframework.jdbc.datasource.DelegatingDataSource(DbTestSupport.apiDataSource()) {
            @Override public java.sql.Connection getConnection() throws java.sql.SQLException {
                if (down.get()) throw new java.sql.SQLTransientConnectionException("db down");
                return super.getConnection();
            }
        };
        TrackWriter tw = new TrackWriter(new org.springframework.jdbc.core.JdbcTemplate(flaky), new AircraftRepository(JdbcClient.create(flaky), DbTestSupport.JSON), meters, 10, 20);
        tw.start();
        Instant seen = Instant.now().minusSeconds(20);
        java.util.concurrent.atomic.AtomicInteger acked = new java.util.concurrent.atomic.AtomicInteger();
        dev.wakeline.ingest.Receipt m1 = new dev.wakeline.ingest.Receipt(acked::incrementAndGet);
        dev.wakeline.ingest.Receipt m2 = new dev.wakeline.ingest.Receipt(acked::incrementAndGet);
        dev.wakeline.ingest.Receipt empty = new dev.wakeline.ingest.Receipt(acked::incrementAndGet);
        tw.enqueue(List.of(ac("f20001", 36, 127, seen, null), ac("f20002", 36, 127, seen, null)), m1);
        tw.enqueue(List.of(ac("f20003", 36, 127, seen, null)), m2);
        tw.enqueue(List.of(), empty);
        m1.release(); m2.release(); empty.release(); // 소비자 자신의 보유
        assertThat(acked.get()).as("a message with no rows is acked at once").isEqualTo(1);
        Thread.sleep(200);                       // 배치가 재시도 중(DB 장애)
        assertThat(acked.get()).as("nothing acked while the rows are not durable").isEqualTo(1);
        assertThat(tw.pendingMarks()).isEqualTo(2);
        down.set(false);                         // DB 복구 → 커밋 → ACK
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline && acked.get() < 3) Thread.sleep(20);
        assertThat(acked.get()).isEqualTo(3);
        assertThat(admin.sql("SELECT count(*) FROM track_point WHERE hex LIKE 'f2000%'").query(Long.class).single()).isEqualTo(3L);

        // 종료 때 DB 가 다시 죽어 있으면: 못 쓴 행의 메시지는 ACK 하지 않는다(다음 기동에서 PEL 로 다시 온다)
        down.set(true);
        dev.wakeline.ingest.Receipt m3 = new dev.wakeline.ingest.Receipt(acked::incrementAndGet);
        tw.enqueue(List.of(ac("f20004", 36, 127, seen, null)), m3);
        m3.release();
        tw.stop();
        assertThat(acked.get()).isEqualTo(3);
        assertThat(meters.counter("wakeline_track_rows_total", "result", "dropped").count()).isEqualTo(1.0);
    }

    /** 큐가 넘쳐 버린 행의 메시지는(되살릴 수 없으므로) 센 뒤 ACK 된다 — PEL 이 끝없이 자라지 않게. 진행 중 배치보다 먼저 풀리지는 않는다. */
    @Test
    void overflowDroppedRowsReleaseTheirReceiptsAfterTheOutstandingBatch() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean down = new java.util.concurrent.atomic.AtomicBoolean(true);
        javax.sql.DataSource flaky = new org.springframework.jdbc.datasource.DelegatingDataSource(DbTestSupport.apiDataSource()) {
            @Override public java.sql.Connection getConnection() throws java.sql.SQLException {
                if (down.get()) throw new java.sql.SQLTransientConnectionException("db down");
                return super.getConnection();
            }
        };
        TrackWriter tw = new TrackWriter(new org.springframework.jdbc.core.JdbcTemplate(flaky), new AircraftRepository(JdbcClient.create(flaky), DbTestSupport.JSON), meters, 10, 20);
        tw.start();
        Instant seen = Instant.now().minusSeconds(20);
        java.util.concurrent.atomic.AtomicInteger acked = new java.util.concurrent.atomic.AtomicInteger();
        List<AircraftState> first = new ArrayList<>();
        for (int i = 0; i < TrackWriter.BATCH; i++) first.add(ac(String.format("e3%04x", i), 36, 127, seen, null));
        dev.wakeline.ingest.Receipt m1 = new dev.wakeline.ingest.Receipt(acked::incrementAndGet);
        tw.enqueue(first, m1);
        m1.release();
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline && tw.queued() > 0) Thread.sleep(10); // 첫 배치가 워커 손에(재시도 중)
        List<AircraftState> flood = new ArrayList<>();
        for (int i = 0; i < TrackWriter.QUEUE_MAX + 10; i++) flood.add(ac(String.format("%06x", 0x900000 + i), 36, 127, seen, null));
        dev.wakeline.ingest.Receipt m2 = new dev.wakeline.ingest.Receipt(acked::incrementAndGet);
        tw.enqueue(flood, m2); // 자기 행 10개가 넘쳐 버려진다
        m2.release();
        assertThat(meters.counter("wakeline_track_rows_total", "result", "dropped").count()).isEqualTo(10.0);
        assertThat(acked.get()).as("the outstanding batch is not durable yet").isZero();
        tw.stop(); // DB 장애 그대로 — 어느 것도 ACK 하지 않는다
        assertThat(acked.get()).isZero();
    }

    /** OrderedWriter: 영구 오류로 버린 작업은 영수증을 놓고(ACK), 종료 뒤 제출은 놓지 않는다(다음 기동에서 재처리). */
    @Test
    void orderedWriterReleasesReceiptsOnSuccessAndPermanentFailureButNotAfterShutdown() throws Exception {
        java.util.concurrent.atomic.AtomicInteger acked = new java.util.concurrent.atomic.AtomicInteger();
        dev.wakeline.ingest.Receipt ok = new dev.wakeline.ingest.Receipt(acked::incrementAndGet).hold();
        dev.wakeline.ingest.Receipt bad = new dev.wakeline.ingest.Receipt(acked::incrementAndGet).hold();
        writer.start();
        writer.submit(OrderedWriter.task("probe_ok", () -> { }, ok));
        writer.submit(OrderedWriter.task("probe_bad", () -> api.sql("SELECT 1/0").query(Integer.class).single(), bad)); // 22012 — 영구 오류
        ok.release(); bad.release();
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline && acked.get() < 2) Thread.sleep(10);
        assertThat(acked.get()).isEqualTo(2);
        assertThat(meters.counter("wakeline_persist_tasks_total", "kind", "probe_bad", "result", "failed").count()).isEqualTo(1.0);
        writer.stop();
        dev.wakeline.ingest.Receipt late = new dev.wakeline.ingest.Receipt(acked::incrementAndGet).hold();
        assertThat(writer.submit(OrderedWriter.task("probe_late", () -> { }, late))).isFalse();
        late.release();
        assertThat(acked.get()).isEqualTo(2);
        assertThat(late.holds()).isEqualTo(1); // 다음 기동에서 다시 처리되도록 ACK 하지 않는다
    }

    // ---------- 재생 · 공항 ----------

    @Test
    void replayReportsTheTableThatSuppliedRowsAndTheNearestRadarFrame() {
        TrackRepository tracks = new TrackRepository(api);
        Instant at = Instant.now().minusSeconds(1800).truncatedTo(ChronoUnit.SECONDS);
        Bbox b = new Bbox(120, 30, 135, 45);
        assertThat(tracks.replay(at, b).source()).isEqualTo("none");
        admin.sql("INSERT INTO track_point_1m (hex, ts_minute, geom, alt_ft, gs_kt, n) VALUES ('e00001', :t, ST_SetSRID(ST_MakePoint(127, 36), 4326), 30000, 400, 3)")
                .param("t", Sql.ts(at.minusSeconds(60).truncatedTo(ChronoUnit.MINUTES))).update();
        var fromSummary = tracks.replay(at, b);
        assertThat(fromSummary.source()).isEqualTo("track_point_1m");
        assertThat(fromSummary.aircraft().getFirst().get("on_ground")).isNull(); // 요약에는 지상 여부가 없다 — false 로 채우지 않는다
        assertThat(fromSummary.aircraft().getFirst().get("track_deg")).isNull();
        // DH-11: 1분 요약 행은 '평균 위치' 로 표시된다(기록된 한 점이 아니다) + 평균에 쓴 점 수
        assertThat(fromSummary.aircraft().getFirst()).containsEntry("averaged", true).containsEntry("samples", 3);
        trackPoint("e00002", at.minusSeconds(30), 36, 127);
        var raw = tracks.replay(at, b);
        assertThat(raw.source()).isEqualTo("track_point");
        assertThat(raw.aircraft().getFirst()).containsEntry("averaged", false).doesNotContainKey("samples");

        admin.sql("INSERT INTO radar_frame (frame_time, host, path, fetched_at) VALUES (:a, 'https://tilecache.rainviewer.com', '/v2/radar/a', now()), (:b, 'https://tilecache.rainviewer.com', '/v2/radar/b', now())")
                .param("a", Sql.ts(at.plusSeconds(240))).param("b", Sql.ts(at.minusSeconds(480))).update();
        Map<String, Object> radar = tracks.radarFrameNear(at, Instant.now());
        assertThat(radar).containsEntry("path", "/v2/radar/a").containsEntry("time", at.plusSeconds(240).getEpochSecond());
        assertThat(tracks.radarFrameNear(Instant.now().minusSeconds(3 * 3600), Instant.now())).isNull(); // RainViewer 는 2시간까지만
    }

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
