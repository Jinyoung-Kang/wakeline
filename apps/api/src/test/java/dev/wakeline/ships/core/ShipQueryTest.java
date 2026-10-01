package dev.wakeline.ships.core;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 선박 검색어(계약 v5 §B1): trim · 대문자, 2–40자 [A-Z0-9 .-/], 그 밖은 거부. 일치 규칙 — 9자리 숫자 MMSI 정확, 3–8자리 숫자 MMSI 앞부분,
 * IMO 접두 또는 7자리 숫자 IMO 정확(7자리 숫자는 MMSI 앞부분과 둘 다), 그 밖 선명·호출부호 앞부분.
 */
class ShipQueryTest {
    static ShipStatic stat(String mmsi, String name, String callSign, Integer imo) {
        return new ShipStatic(mmsi, name, callSign, imo, 70, null, null, null, null, null, null, null, null, null, null, Instant.EPOCH, "aisstream");
    }

    @Test void normalisesAndClassifies() {
        ShipQuery q = ShipQuery.parse("  ever given ");
        assertThat(q.text()).isEqualTo("EVER GIVEN");
        assertThat(q.kind()).isEqualTo(ShipQuery.Kind.NAME_OR_CALL_SIGN);
        assertThat(q.imo()).isNull();

        assertThat(ShipQuery.parse("440123456").kind()).isEqualTo(ShipQuery.Kind.MMSI);
        assertThat(ShipQuery.parse("440").kind()).isEqualTo(ShipQuery.Kind.MMSI_PREFIX);
        assertThat(ShipQuery.parse("44012345").kind()).isEqualTo(ShipQuery.Kind.MMSI_PREFIX);
        // 7자리 숫자: MMSI 앞부분이면서 IMO 번호 — 둘 다(계약의 두 규칙이 겹친다)
        ShipQuery seven = ShipQuery.parse("9321483");
        assertThat(seven.kind()).isEqualTo(ShipQuery.Kind.MMSI_PREFIX_OR_IMO);
        assertThat(seven.imo()).isEqualTo(9321483);
        ShipQuery imo = ShipQuery.parse("imo 9321483");
        assertThat(imo.kind()).isEqualTo(ShipQuery.Kind.IMO);
        assertThat(imo.text()).isEqualTo("IMO 9321483");
        assertThat(imo.imo()).isEqualTo(9321483);
        assertThat(ShipQuery.parse("IMO9321483").imo()).isEqualTo(9321483);
        // IMO 뒤가 7자리 숫자가 아니면 IMO 번호가 아니다 — 선명·호출부호로 찾는다(IMOGEN 같은 선명)
        assertThat(ShipQuery.parse("IMOGEN").kind()).isEqualTo(ShipQuery.Kind.NAME_OR_CALL_SIGN);
        assertThat(ShipQuery.parse("IMO 12345678").kind()).isEqualTo(ShipQuery.Kind.NAME_OR_CALL_SIGN);
        // 두 자리 숫자 · 열 자리 이상 숫자는 숫자 규칙 밖 — 선명·호출부호
        assertThat(ShipQuery.parse("12").kind()).isEqualTo(ShipQuery.Kind.NAME_OR_CALL_SIGN);
        assertThat(ShipQuery.parse("4401234567").kind()).isEqualTo(ShipQuery.Kind.NAME_OR_CALL_SIGN);
        assertThat(ShipQuery.parse("D5AB2").kind()).isEqualTo(ShipQuery.Kind.NAME_OR_CALL_SIGN);
        assertThat(ShipQuery.parse("M/V A.B-1").text()).isEqualTo("M/V A.B-1");
    }

    @ParameterizedTest
    @ValueSource(strings = {"", " ", "a", " x ", "HANJIN%", "HAN_JIN", "선박", "A\tB", "ÉCLAIR", "ı1"})
    void rejectsOutsideTheAlphabetOrTooShort(String raw) {
        assertThatThrownBy(() -> ShipQuery.parse(raw)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void lengthBounds() {
        assertThat(ShipQuery.parse("AB").text()).isEqualTo("AB");
        assertThat(ShipQuery.parse("A".repeat(40)).text()).hasSize(40);
        assertThatThrownBy(() -> ShipQuery.parse("A".repeat(41))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ShipQuery.parse(null)).isInstanceOf(IllegalArgumentException.class);
        // 앞뒤 공백은 길이에 들지 않는다
        assertThat(ShipQuery.parse("   " + "A".repeat(40) + "   ").text()).hasSize(40);
    }

    @Test void matchesByKind() {
        ShipStatic hanjin = stat("440123456", "HANJIN BUSAN", "D7AB", 9321483);
        assertThat(ShipQuery.parse("440123456").matches("440123456", hanjin)).isTrue();
        assertThat(ShipQuery.parse("440123457").matches("440123456", hanjin)).isFalse();
        assertThat(ShipQuery.parse("4401").matches("440123456", hanjin)).isTrue();
        assertThat(ShipQuery.parse("4402").matches("440123456", hanjin)).isFalse();
        assertThat(ShipQuery.parse("9321483").matches("440123456", hanjin)).as("7 digits: IMO exact").isTrue();
        assertThat(ShipQuery.parse("4401234").matches("440123456", hanjin)).as("7 digits: MMSI prefix").isTrue();
        assertThat(ShipQuery.parse("9321484").matches("440123456", hanjin)).isFalse();
        assertThat(ShipQuery.parse("IMO 9321483").matches("440123456", hanjin)).isTrue();
        assertThat(ShipQuery.parse("IMO 9321483").matches("440123456", null)).as("no static → no IMO").isFalse();
        assertThat(ShipQuery.parse("hanjin").matches("440123456", hanjin)).isTrue();
        assertThat(ShipQuery.parse("HANJIN BUSAN").matches("440123456", hanjin)).isTrue();
        assertThat(ShipQuery.parse("BUSAN").matches("440123456", hanjin)).as("prefix only, not substring").isFalse();
        assertThat(ShipQuery.parse("D7").matches("440123456", hanjin)).as("call sign prefix").isTrue();
        assertThat(ShipQuery.parse("44").matches("440123456", hanjin)).as("2 digits: text rule, not MMSI").isFalse();
        assertThat(ShipQuery.parse("HANJIN").matches("440123456", null)).isFalse();
        assertThat(ShipQuery.parse("HANJIN").matches("440123456", stat("440123456", "hanjin busan", null, null))).as("case-insensitive").isTrue();
    }

    @Test void exactMatchesRankFirst() {
        ShipStatic a = stat("440123456", "HANJIN", "D7AB", 9321483);
        assertThat(ShipQuery.parse("HANJIN").exact("440123456", a)).isTrue();
        assertThat(ShipQuery.parse("HANJ").exact("440123456", a)).isFalse();
        assertThat(ShipQuery.parse("D7AB").exact("440123456", a)).isTrue();
        assertThat(ShipQuery.parse("440123456").exact("440123456", a)).isTrue();
        assertThat(ShipQuery.parse("4401").exact("440123456", a)).isFalse();
        assertThat(ShipQuery.parse("9321483").exact("440123456", a)).as("7 digits equal to the IMO").isTrue();
        assertThat(ShipQuery.parse("4401234").exact("440123456", a)).as("7-digit MMSI prefix is not exact").isFalse();
    }

    /** 저장소의 MMSI 앞부분 범위: 9자리로 채운 [앞부분 000…, 앞부분 999…] — 같은 길이 숫자열이라 정렬 규칙(collation)과 무관하다. */
    @Test void mmsiPrefixRange() {
        assertThat(ShipQuery.parse("440").mmsiLow()).isEqualTo("440000000");
        assertThat(ShipQuery.parse("440").mmsiHigh()).isEqualTo("440999999");
        assertThat(ShipQuery.parse("4401234").mmsiLow()).isEqualTo("440123400");
        assertThat(ShipQuery.parse("4401234").mmsiHigh()).isEqualTo("440123499");
    }

    /** 선명·호출부호 앞부분 범위의 위 끝: 마지막 글자 + 1(바이트 순서 — 허용 글자는 모두 ASCII). */
    @Test void textPrefixUpperBound() {
        assertThat(ShipQuery.parse("HAN").textHigh()).isEqualTo("HAO");
        assertThat(ShipQuery.parse("HANZ").textHigh()).isEqualTo("HAN[");
        assertThat(ShipQuery.parse("M/V 9").textHigh()).isEqualTo("M/V :");
    }
}
