package dev.wakeline.it;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Class B 부분 정적 정보와 저장 행 — 실제 Redis 스트림 → api 소비 → ShipWriter → PostgreSQL.
 * <p>재현(고치기 전 — 첫 판이 단언했다): 24A · 24B 를 모두 받아 저장된 선박(호출부호 BX12 · 선종 37 · 크기)에 대해, ais 가 다시 시작한 뒤 24A(선명)만 담긴
 * 정적 정보가 발행되면(수집기 ShipBook 은 빈 레코드에서 시작 — 받지 않은 칸은 null) api 가 ship 행의 호출부호 · 선종 · 크기를 NULL 로 덮었다. 24B 가 오기
 * 전에 선박이 사라지면 영구히 잃고, 저장 정적 보고(계약 v5 §G17)와 REST /ships/{mmsi} 도 호출부호 없는 행을 보였다.
 * <p>고침(계약 v5 §G19): 수집기가 payload static_received 로 받은 필드를 싣고, api 는 받은 필드만 덮는다. 그 키가 없는 이전 수집기의 메시지는 null 을 '받지
 * 않음' 으로 본다(배포 전환 중 저장값을 지우지 않는다). 메모리(ShipStore — 지도 · 선택의 live)는 받은 그대로 둔다(저장값을 섞지 않는다).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class StaticPartsIT extends IntegrationTest {
    @org.springframework.beans.factory.annotation.Autowired dev.wakeline.ingest.ShipStore ships;
    static final Duration WAIT = Duration.ofSeconds(20);
    static final String MMSI = "440700251", OLDER = "440700252";

    /** Class B 선박의 정적 정보(스키마 ship_static.v1 — 모든 키). 받지 않은 칸은 null. */
    static Map<String, Object> classB(String mmsi, String name, String callSign, Integer shipType, Integer dimA, Instant updatedAt) {
        Map<String, Object> s = new LinkedHashMap<>(Streams.shipStatic(mmsi, name, 37, updatedAt));
        s.put("call_sign", callSign);
        s.put("imo", null);
        s.put("ship_type", shipType);
        s.put("dim_a", dimA);
        s.put("dim_b", dimA == null ? null : 5);
        s.put("dim_c", dimA == null ? null : 2);
        s.put("dim_d", dimA == null ? null : 3);
        s.put("draught_m", null);
        s.put("destination", null);
        for (String k : List.of("eta_month", "eta_day", "eta_hour", "eta_minute")) s.put(k, null);
        return s;
    }

    Instant updatedAt(String mmsi) {
        return db.sql("SELECT updated_at FROM ship WHERE mmsi = :m").param("m", mmsi).query((rs, i) -> rs.getObject(1, OffsetDateTime.class).toInstant()).single();
    }

    Map<String, Object> row(String mmsi) {
        return db.sql("SELECT name, call_sign, ship_type, dim_a FROM ship WHERE mmsi = :m").param("m", mmsi).query().singleRow();
    }

    /** ships 메시지(발행 한 건 — 수집기 sink 와 같은 모양). received 가 null 이면 static_received 키가 없다(이전 수집기). */
    static Map<String, String> message(Map<String, Object> stat, List<String> received) {
        String mmsi = (String) stat.get("mmsi");
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("ships", List.of());
        p.put("static", List.of(stat));
        if (received != null) p.put("static_received", Map.of(mmsi, received));
        p.put("stats", Map.of("msgs", 10, "msgs_per_s", 1.0, "dropped", 0, "quarantined", 0, "connected", true));
        p.put("part", 1);
        p.put("parts", 1);
        Map<String, String> env = Streams.envelope("ships", "ships", "fixture", Streams.nextFetchedAt(), p, 0);
        env.put("raw_ref", "-");
        return env;
    }

    @Test
    void aClassB24aAloneAfterAnAisRestartKeepsTheStoredCallSign_andMemoryShowsOnlyWhatWasReceived() {
        List<String> ab = List.of("name", "call_sign", "ship_type", "dim_a", "dim_b", "dim_c", "dim_d");
        Instant t1 = Instant.now().minus(2, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MILLIS);
        Streams.xaddAis(message(classB(MMSI, "BLUE HOLE", "BX12", 37, 10, t1), ab));
        await("24A+24B stored", WAIT, () -> db.sql("SELECT count(*) FROM ship WHERE mmsi = :m AND call_sign = 'BX12'").param("m", MMSI)
                .query(Long.class).single() == 1);
        // ais 재시작 뒤 첫 발행: 24A 만(나머지 칸 null — 받지 않음)
        Instant t2 = Instant.now().minus(2, ChronoUnit.MINUTES).truncatedTo(ChronoUnit.MILLIS);
        Streams.xaddAis(message(classB(MMSI, "BLUE HOLE", null, null, null, t2), List.of("name")));
        await("the 24A-only record written", WAIT, () -> updatedAt(MMSI).equals(t2));
        Map<String, Object> r = row(MMSI);
        assertThat(r.get("name")).isEqualTo("BLUE HOLE");
        assertThat(r.get("call_sign")).as("not received since the restart — kept").isEqualTo("BX12");
        assertThat(((Number) r.get("ship_type")).intValue()).isEqualTo(37);
        assertThat(((Number) r.get("dim_a")).intValue()).isEqualTo(10);
        // 메모리(live)는 받은 것만 — 저장값을 섞지 않는다
        assertThat(ships.staticOf(MMSI).callSign()).isNull();
        assertThat(ships.staticOf(MMSI).received()).containsExactly("name");

        // 받은 부분 안의 빈 값(선박이 호출부호를 비워 보냄)은 덮는다
        Instant t3 = Instant.now().minus(1, ChronoUnit.MINUTES).truncatedTo(ChronoUnit.MILLIS);
        Streams.xaddAis(message(classB(MMSI, "BLUE HOLE", null, 37, 10, t3), ab));
        await("the emptied call sign written", WAIT, () -> updatedAt(MMSI).equals(t3));
        assertThat(row(MMSI).get("call_sign")).isNull();
    }

    /** 이전 수집기(static_received 없음)의 메시지 — 배포 전환 중: null 을 '받지 않음' 으로 보고 저장값을 지우지 않는다. */
    @Test
    void aMessageFromAnOlderCollectorWithoutReceivedFieldsNeverErasesStoredValues() {
        Instant t1 = Instant.now().minus(3, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MILLIS);
        Streams.xaddAis(message(classB(OLDER, "BLUE HOLE", "BX15", 37, 10, t1), null));
        await("stored", WAIT, () -> db.sql("SELECT count(*) FROM ship WHERE mmsi = :m AND call_sign = 'BX15'").param("m", OLDER)
                .query(Long.class).single() == 1);
        Instant t2 = Instant.now().minus(3, ChronoUnit.MINUTES).truncatedTo(ChronoUnit.MILLIS);
        Streams.xaddAis(message(classB(OLDER, "RENAMED", null, null, null, t2), null));
        await("written", WAIT, () -> updatedAt(OLDER).equals(t2));
        assertThat(row(OLDER).get("name")).isEqualTo("RENAMED");
        assertThat(row(OLDER).get("call_sign")).isEqualTo("BX15");
    }
}
