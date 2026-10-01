package dev.wakeline.ingest;

import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.platform.support.Receipt;
import dev.wakeline.ships.core.ShipEvents;
import dev.wakeline.ships.core.ShipStore;
import dev.wakeline.weather.core.RadarStore;
import dev.wakeline.weather.core.SigmetStore;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.RecordId;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 선박 스트림(계약 v2 §B2·§B3): 스키마 검증 → ShipStore → ShipsUpdated/AisGapReceived(영수증 포함), 신뢰 경계(kind ↔ 스트림),
 * 의미 검사(공백 순서), 부트스트랩(최근 창을 순서대로 — 메모리만), 5,000 척 메시지 처리 시간 측정.
 */
class StreamConsumerShipsTest {
    static final Instant T = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS);

    final ShipStore ships = new ShipStore();
    final List<Object> events = new ArrayList<>();
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    final StreamConsumer consumer = new StreamConsumer(null, new SchemaValidator(), new SnapshotStore(), new SigmetStore(), new RadarStore(),
            ships, null, events::add, JsonMapper.builder().build(), meters);

    static String state(String mmsi, double lat, double lon, Instant seen) {
        return """
                {"mmsi":"%s","lat":%s,"lon":%s,"sog_kn":11.2,"cog_deg":181.5,"heading_deg":180,"nav_status":0,"rot":null,"position_source":"gnss",
                 "seen_at":"%s","provider":"aisstream","msg_type":"PositionReport","class":"A"}""".formatted(mmsi, lat, lon, seen);
    }

    static String stat(String mmsi, String name, Integer type, Instant updated) {
        return """
                {"mmsi":"%s","name":%s,"call_sign":"D7AB","imo":9321483,"ship_type":%s,"dim_a":150,"dim_b":30,"dim_c":14,"dim_d":16,"draught_m":9.8,
                 "destination":"KR PUS","eta_month":9,"eta_day":29,"eta_hour":6,"eta_minute":30,"updated_at":"%s","provider":"aisstream"}"""
                .formatted(mmsi, name == null ? "null" : "\"" + name + "\"", type, updated);
    }

    static String shipsPayload(List<String> states, List<String> statics) {
        return "{\"ships\":[" + String.join(",", states) + "],\"static\":[" + String.join(",", statics)
                + "],\"stats\":{\"msgs\":54,\"msgs_per_s\":5.4,\"dropped\":0,\"quarantined\":0,\"connected\":true,\"bbox\":\"18,105,46,150\"},\"part\":1,\"parts\":1}";
    }

    static MapRecord<String, String, String> rec(String stream, String kind, String scope, Instant fetchedAt, String payload, long seq) throws Exception {
        Map<String, String> f = new HashMap<>(Map.of("schema_version", "1", "kind", kind, "scope", scope, "provider", "aisstream",
                "fetched_at", fetchedAt.toString(), "raw_ref", "-", "encoding", "gzip+base64", "count", "1"));
        f.put("payload", SchemaContractTest.gz64(payload));
        return MapRecord.create(stream, f).withId(RecordId.of(fetchedAt.toEpochMilli() + "-" + seq));
    }

    static MapRecord<String, String, String> ships(Instant fetchedAt, String payload) throws Exception {
        return rec(StreamConsumer.S_SHIPS, "ships", "ships", fetchedAt, payload, 0);
    }

    static String gap(Instant s, Instant e) {
        return "{\"started_at\":\"" + s + "\",\"ended_at\":\"" + e + "\",\"reason\":\"server closed (1006)\"}";
    }

    @Test void shipsMessage_updatesTheStore_andCarriesEveryReportAndTheReceipt() throws Exception {
        String p = shipsPayload(List.of(state("440123456", 35.1, 129.05, T.minusSeconds(3)), state("431011305", 35.39, 139.83, T.minusSeconds(2))),
                List.of(stat("440123456", "HANJIN BUSAN", 70, T.minusSeconds(60)), stat("477000001", null, 30, T.minusSeconds(60))));
        consumer.handle(ships(T, p));
        assertThat(ships.view().size()).isEqualTo(2);
        assertThat(ships.view().get("440123456").stat().name()).isEqualTo("HANJIN BUSAN");
        assertThat(ships.view().get("440123456").state().rot()).isNull();
        assertThat(ships.staticOf("477000001").name()).isNull();
        ShipEvents.ShipsUpdated e = (ShipEvents.ShipsUpdated) events.getFirst();
        assertThat(e.states()).hasSize(2);
        assertThat(e.statics()).hasSize(2);
        assertThat(e.changed()).containsExactlyInAnyOrder("440123456", "431011305");
        assertThat(e.provider()).isEqualTo("aisstream");
        assertThat(e.fetchedAt()).isEqualTo(T);
        assertThat(e.receipt().tracked()).isTrue();
        assertThat(consumer.unacked()).as("released after the (synchronous) listeners — nobody held it").isZero();

        // 같은 메시지를 다시(재전달): 실시간 상태는 그대로, 저장 대상 보고는 그대로 넘긴다(저장기가 멱등으로 거른다)
        consumer.handle(ships(T, p));
        ShipEvents.ShipsUpdated again = (ShipEvents.ShipsUpdated) events.getLast();
        assertThat(again.changed()).isEmpty();
        assertThat(again.states()).hasSize(2);
    }

    /**
     * 계약 v5 §G19: payload static_received(MMSI → 수집기가 받은 정적 필드)가 정적 정보마다 received 로 붙는다. 목록에 빠진 MMSI · 키가 없는 이전 수집기의
     * 메시지는 모름(null — 저장은 null 을 '받지 않음' 으로 본다). 스키마가 필드 이름 · MMSI 키를 검사한다(틀리면 메시지 검증 실패 → DLQ).
     */
    @Test void staticReceived_isAttachedPerMmsi_absentMeansUnknown() throws Exception {
        String with = shipsPayload(List.of(), List.of(stat("416009981", "BLUE HOLE", null, T.minusSeconds(30)), stat("416009982", "OTHER", 37, T.minusSeconds(30))))
                .replace(",\"stats\":", ",\"static_received\":{\"416009981\":[\"name\"]},\"stats\":");
        consumer.handle(ships(T, with));
        ShipEvents.ShipsUpdated e = (ShipEvents.ShipsUpdated) events.getLast();
        assertThat(e.statics().get(0).received()).containsExactly("name");
        assertThat(e.statics().get(1).received()).as("missing from the map — unknown").isNull();
        assertThat(ships.staticOf("416009981").received()).as("memory keeps what was received live").containsExactly("name");
        consumer.handle(ships(T.plusSeconds(10), shipsPayload(List.of(), List.of(stat("416009983", "LEGACY", 70, T.minusSeconds(20))))));
        assertThat(((ShipEvents.ShipsUpdated) events.getLast()).statics().getFirst().received()).as("older collector").isNull();
        for (String bad : List.of("{\"416009981\":[\"vendor\"]}", "{\"41600998\":[\"name\"]}", "{\"416009981\":[\"name\",\"name\"]}"))
            assertThatThrownBy(() -> consumer.parse(ships(T, with.replace("{\"416009981\":[\"name\"]}", bad)))).as(bad)
                    .hasMessageContaining("payload");
    }

    /** 계약 v3 §B: 레거시 "gnss"(Timestamp 0~60·누락이 섞인 값)는 받자마자 null(모름) — 'epfs' 로 추정하지 않는다. 새 값과 null 은 그대로. */
    @Test void legacyGnssPositionSource_becomesUnknownAtIngest() throws Exception {
        consumer.handle(ships(T, shipsPayload(List.of(state("440123456", 35.1, 129.05, T.minusSeconds(3))), List.of())));
        assertThat(ships.view().get("440123456").state().positionSource()).isNull();
        ShipEvents.ShipsUpdated e = (ShipEvents.ShipsUpdated) events.getFirst();
        assertThat(e.states().getFirst().positionSource()).as("what the writer stores (V7 rejects 'gnss')").isNull();

        JsonMapper m = JsonMapper.builder().build();
        String s = state("440123456", 35.1, 129.05, T);
        for (String v : new String[]{"epfs", "manual", "estimated", "inoperative"})
            assertThat(ShipCodec.state(m.readTree(s.replace("\"gnss\"", "\"" + v + "\""))).positionSource()).isEqualTo(v);
        assertThat(ShipCodec.state(m.readTree(s.replace("\"gnss\"", "null"))).positionSource()).isNull();
        assertThat(ShipCodec.state(m.readTree(s.replace(",\"position_source\":\"gnss\"", ""))).positionSource()).isNull();
    }

    @Test void gapMessage_isRememberedAndPublished() throws Exception {
        consumer.handle(rec(StreamConsumer.S_SHIPS, "ais_gap", "ships", T, gap(T.minusSeconds(300), T.minusSeconds(60)), 0));
        assertThat(ships.gaps()).hasSize(1);
        ShipEvents.AisGapReceived g = (ShipEvents.AisGapReceived) events.getFirst();
        assertThat(g.gap().startedAt()).isEqualTo(T.minusSeconds(300));
        assertThat(g.gap().provider()).isEqualTo("aisstream");
        assertThat(g.gap().reason()).isEqualTo("server closed (1006)");
    }

    static String scopedGap(Instant s, Instant e, String scopeJson) {
        return "{\"started_at\":\"" + s + "\",\"ended_at\":\"" + e + "\",\"reason\":\"server closed (1006)\",\"scope\":" + scopeJson + "}";
    }

    /**
     * 계약 v4 §D: ais_gap 의 scope(선택) — 구역 규칙을 통과하면 AisGap.scope, 없거나 null·빈 값이면 구역 없음, 틀리면 공백은 받되 구역 없음(모든 곳에
     * 적용)으로 두고 센다(DLQ 로 보내지 않는다 — 공백 자체는 사실이다).
     */
    @Test void gapScope_parsedWhenValid_invalidBecomesNullAndIsCounted() throws Exception {
        consumer.handle(rec(StreamConsumer.S_SHIPS, "ais_gap", "ships", T, scopedGap(T.minusSeconds(300), T.minusSeconds(60), "\"-90,45,90,180\""), 0));
        ShipEvents.AisGapReceived g = (ShipEvents.AisGapReceived) events.getLast();
        assertThat(g.gap().scopeText()).isEqualTo("-90,45,90,180");
        assertThat(g.gap().appliesAt(35, 129)).isTrue();
        assertThat(g.gap().appliesAt(40, -70)).isFalse();
        assertThat(ships.gaps()).singleElement().extracting(x -> x.scopeText()).isEqualTo("-90,45,90,180");

        // 같은 시작 시각, 다른 구역 → 다른 공백
        consumer.handle(rec(StreamConsumer.S_SHIPS, "ais_gap", "ships", T, scopedGap(T.minusSeconds(300), T.minusSeconds(60), "\"-90,-180,90,0\""), 1));
        assertThat(ships.gaps()).hasSize(2);

        for (String none : new String[]{"null", "\"\"", "\"  \""}) {
            assertThat(consumer.parse(rec(StreamConsumer.S_SHIPS, "ais_gap", "ships", T, scopedGap(T.minusSeconds(9), T, none), 2)).gap().scope())
                    .as(none).isNull();
        }
        assertThat(meters.counter("wakeline_ais_gap_scope_invalid_total").count()).isZero();

        int seq = 3;
        for (String bad : new String[]{"\"91,0,1,1\"", "\"-90,-180,90,0|-90,45,90,180\"", "\"x\"", "\"" + "0,0,1,1;".repeat(17) + "\""}) {
            MapRecord<String, String, String> r = rec(StreamConsumer.S_SHIPS, "ais_gap", "ships", T, scopedGap(T.minusSeconds(9), T, bad), seq);
            StreamConsumer.Parsed p = consumer.parse(r);
            assertThat(p.gap().scope()).as(bad).isNull();
            assertThat(p.gap().reason()).isEqualTo("server closed (1006)");
            assertThat(p.gapScopeInvalid()).as(bad).isTrue();
            assertThat(meters.counter("wakeline_ais_gap_scope_invalid_total").count()).as("parsing alone does not count").isEqualTo(seq - 3);
            consumer.handle(r);
            seq++;
            assertThat(((ShipEvents.AisGapReceived) events.getLast()).gap().scope()).as("received without a scope, not dead-lettered").isNull();
        }
        assertThat(meters.counter("wakeline_ais_gap_scope_invalid_total").count()).isEqualTo(4);
        // 스키마: scope 는 문자열·null 만(다른 형은 검증 실패 → DLQ)
        assertThatThrownBy(() -> consumer.parse(rec(StreamConsumer.S_SHIPS, "ais_gap", "ships", T, scopedGap(T.minusSeconds(9), T, "5"), 4)))
                .hasMessageContaining("payload");
    }

    /**
     * 리뷰(api-ships-realtime #4): 기동 때 선박 부트스트랩이 최근 35분을 다시 읽어도 구역이 틀린 공백을 세지 않는다 — 이미 ACK 한 공백을 재시작마다,
     * 아직 PEL 에 있는 공백을 두 번(부트스트랩 + 소비) 세지 않게. 세는 것은 실시간 소비 한 번뿐.
     */
    @Test void gapScopeInvalid_isNotCountedByTheBootstrapReplay() throws Exception {
        MapRecord<String, String, String> bad = rec(StreamConsumer.S_SHIPS, "ais_gap", "ships", T, scopedGap(T.minusSeconds(300), T.minusSeconds(60), "\"x\""), 0);
        StreamConsumer.ForwardPageReader reader = (fromInclusive, count) ->
                StreamConsumer.compareIds(bad.getId().getValue(), fromInclusive) >= 0 ? List.of(bad) : List.of();
        assertThat(consumer.bootstrapShips(reader, T.toEpochMilli())).isEqualTo(1);
        assertThat(ships.gaps()).singleElement().satisfies(g -> assertThat(g.scope()).isNull());
        assertThat(meters.counter("wakeline_ais_gap_scope_invalid_total").count()).as("bootstrap replay").isZero();
        consumer.handle(bad); // 같은 엔트리가 소비로 다시 전달됨(PEL)
        assertThat(meters.counter("wakeline_ais_gap_scope_invalid_total").count()).as("counted once, by the live consumer").isEqualTo(1);
    }

    /** 신뢰 경계(ADR-014): ais 사용자가 쓰는 스트림에서 온 항공기 메시지, 다른 스트림에서 온 선박 메시지는 받지 않는다(검증 실패 → DLQ). */
    @Test void kindAndStreamMustMatch_scopeMustBeShips() throws Exception {
        String aircraft = StreamConsumerTest.aircraftPayload("a1b2c3", T);
        assertThatThrownBy(() -> consumer.parse(rec(StreamConsumer.S_SHIPS, "aircraft", "region", T, aircraft, 0)))
                .hasMessageContaining("not accepted on stream wakeline:ships");
        String p = shipsPayload(List.of(state("440123456", 35, 129, T)), List.of());
        assertThatThrownBy(() -> consumer.parse(rec(StreamConsumer.S_AIRCRAFT, "ships", "ships", T, p, 0)))
                .hasMessageContaining("not accepted on stream wakeline:aircraft");
        assertThatThrownBy(() -> consumer.parse(rec(StreamConsumer.S_SHIPS, "ships", "region", T, p, 0))).hasMessageContaining("scope must be ships");
        assertThatThrownBy(() -> consumer.parse(rec(StreamConsumer.S_SHIPS, "ais_gap", "-", T, gap(T.minusSeconds(9), T), 0)))
                .hasMessageContaining("scope must be ships");
        assertThat(ships.view().size()).isZero();
    }

    @Test void invalidPayloadsFailValidation() {
        // 공백 끝 ≤ 시작(스키마로 표현할 수 없는 의미 검사)
        assertThatThrownBy(() -> consumer.parse(rec(StreamConsumer.S_SHIPS, "ais_gap", "ships", T, gap(T, T), 0)))
                .hasMessageContaining("ended_at must be after started_at");
        // MMSI 8자리 · lat 91(AIS '값 없음' 을 그대로) · 선종 0(값 없음은 null 이어야 한다) · estimated 위치 출처 오타 · 필수 키 없음
        for (String bad : List.of(
                shipsPayload(List.of(state("44012345", 35, 129, T)), List.of()),
                shipsPayload(List.of(state("440123456", 91, 129, T)), List.of()),
                shipsPayload(List.of(), List.of(stat("440123456", "X", 0, T))),
                shipsPayload(List.of(state("440123456", 35, 129, T).replace("\"gnss\"", "\"dead_reckoning\"")), List.of()),
                "{\"ships\":[],\"static\":[]}")) {
            assertThatThrownBy(() -> consumer.parse(ships(T, bad))).as(bad).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test void bootstrap_readsTheRecentWindowInOrder_memoryOnly() throws Exception {
        long now = T.toEpochMilli();
        List<MapRecord<String, String, String>> stream = new ArrayList<>();
        for (int i = 0; i < 45; i++) {
            Instant f = T.minusSeconds(45L * 10 - i * 10L);
            String mmsi = String.format("%09d", 440_000_000 + (i % 30));
            stream.add(ships(f, shipsPayload(List.of(state(mmsi, 35 + i * 0.001, 129, f.minusSeconds(1))), List.of())));
        }
        stream.add(rec(StreamConsumer.S_SHIPS, "ais_gap", "ships", T, gap(T.minusSeconds(200), T.minusSeconds(100)), 1));
        stream.add(rec(StreamConsumer.S_SHIPS, "ships", "ships", T, "{\"ships\":[]}", 2)); // 잘못된 엔트리 — 건너뛴다(소비가 DLQ 로)
        AtomicInteger calls = new AtomicInteger();
        StreamConsumer.ForwardPageReader reader = (fromInclusive, count) -> {
            calls.incrementAndGet();
            List<MapRecord<String, String, String>> out = new ArrayList<>();
            for (var r : stream) {
                if (StreamConsumer.compareIds(r.getId().getValue(), fromInclusive) < 0) continue;
                out.add(r);
                if (out.size() == count) break;
            }
            return out;
        };
        int applied = consumer.bootstrapShips(reader, now);
        assertThat(applied).isEqualTo(46); // 45 ships + 1 gap
        assertThat(calls.get()).isGreaterThanOrEqualTo(3);
        assertThat(ships.view().size()).isEqualTo(30);
        assertThat(ships.view().get("440000014").state().lat()).as("the newest report of that MMSI").isEqualTo(35.044, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(ships.gaps()).hasSize(1);
        assertThat(events).hasSize(1);
        ShipEvents.ShipsUpdated e = (ShipEvents.ShipsUpdated) events.getFirst();
        assertThat(e.states()).as("bootstrap persists nothing").isEmpty();
        assertThat(e.changed()).hasSize(30);
        // 창 밖(35분 전보다 오래된) 엔트리만 있으면 아무것도 하지 않는다
        events.clear();
        assertThat(consumer.bootstrapShips((f, c) -> List.of(), now)).isZero();
        assertThat(events).isEmpty();
    }

    /**
     * 측정(성능 주장은 측정값만): 소비 스레드에서 ships 메시지 한 건(스키마 검증 + 해석 + ShipStore 반영)에 드는 시간.
     * 5,000 척(한 엔트리 상한 — 전세계 구독의 10 s 변경분 규모)과 300 척(동아시아 실측 규모). 결과는 표준 출력에 남긴다.
     */
    @Test void measure_consumerCostPerShipsMessage() throws Exception {
        for (int n : new int[]{300, 5_000}) {
            int warm = 3, runs = 5;
            List<MapRecord<String, String, String>> msgs = new ArrayList<>();
            int statics = 0;
            for (int r = 0; r < warm + runs; r++) { // 실행마다 더 새 보고(반영이 실제로 맵을 바꾸게)
                List<String> st = new ArrayList<>(n), sc = new ArrayList<>();
                for (int i = 0; i < n; i++) {
                    String mmsi = String.format("%09d", 200_000_000 + i);
                    st.add(state(mmsi, -60 + (i % 1200) * 0.1, -170 + (i / 1200) * 10.0, T.plusSeconds(r)));
                    if (i % 10 == 0) sc.add(stat(mmsi, "SHIP " + i, 70, T.plusSeconds(r)));
                }
                statics = sc.size();
                msgs.add(ships(T.plusSeconds(r), shipsPayload(st, sc)));
            }
            ShipStore store = new ShipStore();
            StreamConsumer c = new StreamConsumer(null, new SchemaValidator(), new SnapshotStore(), new SigmetStore(), new RadarStore(),
                    store, null, e -> { }, JsonMapper.builder().build(), new SimpleMeterRegistry());
            for (int w = 0; w < warm; w++) c.apply(c.parse(msgs.get(w)), Receipt.NONE, true); // JIT 예열
            long t0 = System.nanoTime();
            for (int r = warm; r < warm + runs; r++) c.apply(c.parse(msgs.get(r)), Receipt.NONE, true);
            double ms = (System.nanoTime() - t0) / 1e6 / runs;
            System.out.printf("MEASURE ships message: %d ships + %d statics -> %.1f ms per message (validate+parse+apply, avg of %d)%n", n, statics, ms, runs);
            assertThat(store.view().size()).isEqualTo(n);
            assertThat(ms).as("well under the 10 s publish interval").isLessThan(5_000);
        }
    }
}
