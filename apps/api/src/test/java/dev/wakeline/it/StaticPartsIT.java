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
 * <p>재현(고치기 전): 24A · 24B 를 모두 받아 저장된 선박(호출부호 BX12 · 선종 37 · 크기)에 대해, ais 가 다시 시작한 뒤 24A(선명)만 담긴 정적 정보가 발행되면
 * (수집기 ShipBook 은 빈 레코드에서 시작 — 받지 않은 칸은 null) api 가 ship 행의 호출부호 · 선종 · 크기를 NULL 로 덮는다. 24B 가 오기 전에 선박이 사라지면
 * 영구히 잃고, 저장 정적 보고(계약 v5 §G17)와 REST /ships/{mmsi} 도 호출부호 없는 행을 보인다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class StaticPartsIT extends IntegrationTest {
    static final Duration WAIT = Duration.ofSeconds(20);
    static final String MMSI = "440700251";

    /** Class B 선박의 정적 정보(스키마 ship_static.v1 — 모든 키). 받지 않은 칸은 null. */
    static Map<String, Object> classB(String name, String callSign, Integer shipType, Integer dimA, Instant updatedAt) {
        Map<String, Object> s = new LinkedHashMap<>(Streams.shipStatic(MMSI, name, 37, updatedAt));
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

    Instant updatedAt() {
        return db.sql("SELECT updated_at FROM ship WHERE mmsi = :m").param("m", MMSI).query((rs, i) -> rs.getObject(1, OffsetDateTime.class).toInstant()).single();
    }

    Map<String, Object> row() {
        return db.sql("SELECT name, call_sign, ship_type, dim_a FROM ship WHERE mmsi = :m").param("m", MMSI).query().singleRow();
    }

    @Test
    void aClassB24aAloneAfterAnAisRestart_andTheStoredCallSign_reproduction() {
        Instant t1 = Instant.now().minus(2, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MILLIS);
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(), List.of(classB("BLUE HOLE", "BX12", 37, 10, t1))));
        await("24A+24B stored", WAIT, () -> db.sql("SELECT count(*) FROM ship WHERE mmsi = :m AND call_sign = 'BX12'").param("m", MMSI)
                .query(Long.class).single() == 1);
        // ais 재시작 뒤 첫 발행: 24A 만(나머지 칸 null)
        Instant t2 = Instant.now().minus(1, ChronoUnit.MINUTES).truncatedTo(ChronoUnit.MILLIS);
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(), List.of(classB("BLUE HOLE", null, null, null, t2))));
        await("the 24A-only record written", WAIT, () -> updatedAt().equals(t2));
        Map<String, Object> r = row();
        assertThat(r.get("name")).isEqualTo("BLUE HOLE");
        // 고치기 전(재현): 받지 않은 24B 부분이 NULL 로 덮였다
        assertThat(r.get("call_sign")).isNull();
        assertThat(r.get("ship_type")).isNull();
        assertThat(r.get("dim_a")).isNull();
    }
}
