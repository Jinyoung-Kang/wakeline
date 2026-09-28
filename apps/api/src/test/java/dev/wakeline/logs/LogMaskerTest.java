package dev.wakeline.logs;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 계약 v5 §C5: Java 가림이 collector masking.py 와 같은 규칙이다 — 언어 간 시험 벡터(schemas/vectors/masking-cases.v1.json)의 input → expected 가
 * 글자 하나까지 같아야 한다(pytest 도 같은 파일을 읽는다). 설정 비밀값은 값으로도 가린다(6자 이상).
 */
class LogMaskerTest {
    static final Path VECTORS = Path.of("../../schemas/vectors/masking-cases.v1.json");

    @AfterEach
    void clearSecrets() { LogMasker.clearSecrets(); }

    @Test
    void crossLanguageVectorsMatchExactly() throws Exception {
        JsonNode doc = JsonMapper.builder().build().readTree(Files.readString(VECTORS));
        assertThat(doc.path("version").asInt()).isEqualTo(1);
        int limit = doc.path("limit").asInt();
        List<String> mismatches = new ArrayList<>();
        int n = 0;
        for (JsonNode c : doc.path("cases")) {
            n++;
            String in = c.path("input").asString(), expected = c.path("expected").asString();
            String out = LogMasker.mask(in, limit);
            if (!expected.equals(out)) mismatches.add(in + "\n   expected " + expected + "\n   actual   " + out);
        }
        assertThat(n).as("vector count").isGreaterThanOrEqualTo(20);
        assertThat(mismatches).as("vectors whose Java output differs").isEmpty();
    }

    @Test
    void newQueryKeyRuleOnlyAfterQuestionMarkOrAmpersand() {
        assertThat(LogMasker.mask("GET /v?mmsi=1&key=ABC&x=2")).isEqualTo("GET /v?mmsi=1&key=***&x=2");
        assertThat(LogMasker.mask("GET /v?key=ABC")).isEqualTo("GET /v?key=***");
        assertThat(LogMasker.mask("GET /v?access_key=ABC&y=1")).isEqualTo("GET /v?access_key=***&y=1");
        assertThat(LogMasker.mask("GET /v?ApiKey=ABC")).isEqualTo("GET /v?ApiKey=***");
        // '?'·'&' 뒤가 아닌 key= 는 이 규칙의 대상이 아니다(일반 문장의 "primary key=..." 를 망치지 않게)
        assertThat(LogMasker.mask("duplicate primary key=42")).isEqualTo("duplicate primary key=42");
    }

    @Test
    void nullAndLimitByCodePoints() {
        assertThat(LogMasker.mask(null)).isNull();
        assertThat(LogMasker.mask("x".repeat(10_000))).hasSize(4000);
        // 한계는 코드 포인트로 센다(Python 문자열 자르기와 같게) — 서로게이트 쌍을 반으로 자르지 않는다
        String astral = "🚢".repeat(5); // 🚢 × 5
        String cut = LogMasker.mask(astral, 3);
        assertThat(cut.codePointCount(0, cut.length())).isEqualTo(3);
        assertThat(cut).isEqualTo("🚢".repeat(3));
    }

    @Test
    void registeredSecretValuesAreReplacedAnywhere_longestFirst_shortOnesIgnored() {
        LogMasker.registerSecrets("Zq9-db-real-password", "", null, "ab", "Zq9-db");
        String out = LogMasker.mask("jdbc said Zq9-db-real-password was wrong (ab) near Zq9-db");
        assertThat(out).isEqualTo("jdbc said *** was wrong (ab) near ***");
        assertThat(LogMasker.secretCount()).isEqualTo(2);
    }

    @Test
    void maskingIsIdempotent() {
        String once = LogMasker.mask("password=hunter2 Bearer abcdefghijklmnop redis://u:pw@h:1 {\"token\":\"t\"}");
        assertThat(LogMasker.mask(once)).isEqualTo(once);
    }
}
