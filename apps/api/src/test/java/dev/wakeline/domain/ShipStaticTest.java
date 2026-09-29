package dev.wakeline.domain;

import dev.wakeline.ingest.ShipCodec;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 정적 정보의 받은 필드(계약 v5 §G19): 저장 때 덮어쓸 필드(written — 받은 필드, 모르면 값이 있는 필드), 같은 MMSI 의 더 새 것을 겹치기(overlay), 필드 이름 =
 * 스트림 스키마의 enum = ship_static.v1 의 정적 칸(수집기 STATIC_FIELDS 와 같은 순서 — contract_check 가 Python 쪽을 본다).
 */
class ShipStaticTest {
    static final Instant T = Instant.parse("2026-09-30T00:00:00Z");
    static final JsonMapper M = JsonMapper.builder().build();

    static ShipStatic s(String name, String callSign, Integer type, Integer dimA, Instant at, Set<String> received) {
        return new ShipStatic("416009981", name, callSign, null, type, dimA, null, null, null, null, null, null, null, null, null, at, "aisstream", received);
    }

    @Test void writtenIsTheReceivedSet_orTheNonNullFieldsWhenUnknown() {
        assertThat(s("BLUE HOLE", null, null, null, T, Set.of("name", "call_sign")).written()).containsExactlyInAnyOrder("name", "call_sign");
        assertThat(s("BLUE HOLE", null, 37, null, T, null).written()).as("older collector: null = not received").containsExactlyInAnyOrder("name", "ship_type");
        assertThat(s(null, null, null, null, T, Set.of()).written()).isEmpty();
        ShipStatic full = new ShipStatic("416009981", "A", "B", 9321483, 70, 1, 2, 3, 4, 5.5, "D", 1, 2, 3, 4, T, "aisstream");
        assertThat(full.written()).containsExactlyInAnyOrderElementsOf(ShipStatic.FIELDS);
        for (String f : ShipStatic.FIELDS) assertThat(full.value(f)).as(f).isNotNull();
        assertThat(full.received()).as("legacy constructor — unknown").isNull();
    }

    @Test void unknownFieldNamesAreRejected() {
        assertThatThrownBy(() -> s("X", null, null, null, T, Set.of("vendor"))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> s("X", null, null, null, T, null).value("vendor")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void overlayTakesTheNewerValueOnlyForTheFieldsItWrites() {
        ShipStatic b = s(null, "BX12", 37, 10, T, Set.of("call_sign", "ship_type", "dim_a"));
        ShipStatic a = s("BLUE HOLE", null, null, null, T.plusSeconds(5), Set.of("name"));
        ShipStatic m = b.overlay(a);
        assertThat(m.name()).isEqualTo("BLUE HOLE");
        assertThat(m.callSign()).isEqualTo("BX12");
        assertThat(m.shipType()).isEqualTo(37);
        assertThat(m.dimA()).isEqualTo(10);
        assertThat(m.updatedAt()).isEqualTo(T.plusSeconds(5));
        assertThat(m.received()).containsExactlyInAnyOrder("name", "call_sign", "ship_type", "dim_a");
        // 더 새 것이 받은 빈 값은 덮는다
        ShipStatic emptied = m.overlay(s("BLUE HOLE", null, null, null, T.plusSeconds(9), Set.of("name", "call_sign")));
        assertThat(emptied.callSign()).isNull();
        assertThat(emptied.shipType()).isEqualTo(37);
        // 받은 필드를 모르는 것끼리: 값이 있는 필드만 덮는다
        ShipStatic legacy = s("OLD", "OLD1", 30, null, T, null).overlay(s("NEW", null, null, 12, T.plusSeconds(1), null));
        assertThat(List.of(legacy.name(), legacy.callSign(), legacy.shipType(), legacy.dimA())).containsExactly("NEW", "OLD1", 30, 12);
    }

    /** 필드 이름 한 표: ShipStatic.FIELDS = 스트림 payload static_received 의 enum = ship_static.v1 의 정적 칸(순서까지). */
    @Test void fieldNamesMatchTheStreamSchemas() throws Exception {
        JsonNode env = M.readTree(Files.readString(Path.of("../../schemas/stream_envelope.v1.json")));
        List<String> enumNames = new ArrayList<>();
        env.path("$defs").path("ships_payload").path("properties").path("static_received").path("additionalProperties").path("items").path("enum")
                .forEach(n -> enumNames.add(n.asString()));
        assertThat(enumNames).isEqualTo(ShipStatic.FIELDS);
        JsonNode st = M.readTree(Files.readString(Path.of("../../schemas/ship_static.v1.json")));
        List<String> required = new ArrayList<>();
        st.path("required").forEach(n -> required.add(n.asString()));
        assertThat(required.subList(1, required.size() - 2)).isEqualTo(ShipStatic.FIELDS);
        assertThat(required).startsWith("mmsi").endsWith("updated_at", "provider");
    }

    /**
     * 메모리(리뷰 2026-09-30): api 메모리(ShipStore)는 정적 정보를 최대 100,000건 쥔다 — 받은 필드 집합을 정적 정보마다 새로 만들면(payload 에서 읽은 새 문자열)
     * 3만 건에 약 25 MB 였다. 같은 묶음은 같은 집합 하나를, 원소는 FIELDS 의 상수 문자열을 함께 쓴다. 겹치기(overlay)의 합집합 · 받은 필드를 모를 때의 written 도.
     */
    @Test void equalReceivedSetsShareOneCanonicalInstanceOfTheFieldConstants() throws Exception {
        List<ShipStatic> many = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            JsonNode map = M.readTree("{\"416009981\":[\"call_sign\",\"name\"]}"); // 매번 새로 읽은 문자열
            many.add(s("A", "B", null, null, T, ShipCodec.received(map, "416009981")));
        }
        assertThat(many.get(1).received()).isSameAs(many.get(0).received()).isSameAs(many.get(2).received());
        assertThat(many.get(0).received()).containsExactly("name", "call_sign"); // FIELDS 순서
        for (String f : many.get(0).received()) assertThat(f).isSameAs(ShipStatic.FIELDS.get(ShipStatic.FIELDS.indexOf(f)));
        assertThatThrownBy(() -> many.get(0).received().add("imo")).isInstanceOf(UnsupportedOperationException.class);
        ShipStatic other = s("A", "B", null, null, T, Set.of(new String("name"), new String("call_sign")));
        assertThat(other.received()).isSameAs(many.get(0).received());
        ShipStatic merged = s(null, null, 37, null, T, Set.of("ship_type")).overlay(many.get(0));
        assertThat(merged.received()).isSameAs(s(null, null, null, null, T, Set.of("ship_type", "name", "call_sign")).received());
        assertThat(s("X", null, 30, null, T, null).written()).isSameAs(s(null, null, null, null, T, Set.of("name", "ship_type")).received());
    }

    @Test void codecReadsTheReceivedMapPerMmsi() throws Exception {
        JsonNode map = M.readTree("{\"416009981\":[\"name\",\"call_sign\"],\"416009982\":\"name\"}");
        assertThat(ShipCodec.received(map, "416009981")).containsExactly("name", "call_sign");
        assertThat(ShipCodec.received(map, "416009982")).as("not a list").isNull();
        assertThat(ShipCodec.received(map, "416009983")).as("missing").isNull();
        assertThat(ShipCodec.received(null, "416009981")).as("older collector").isNull();
        assertThat(ShipCodec.received(M.readTree("[]"), "416009981")).isNull();
    }
}
