package dev.wakeline.logs;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.regex.Pattern;

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

    /**
     * 계약 v5 §C2 · §C4 · §C6: userinfo · JWT 규칙이 되짚기로 글자 수의 제곱 시간이 들지 않는다 — 누구나 보낼 수 있는 브라우저 오류(§C6)에
     * 이런 글을 넣으면 앱 스레드(싣기 전 가림)와 운영 조회(읽을 때 다시 가림)가 CPU 를 몇 분씩 썼다(고치기 전 낱말 글자열 100,000자 29 s).
     * 모두 가릴 것이 없는 글이다 — 결과는 그대로여야 한다.
     */
    @Test
    void userinfoAndJwtRulesTakeLinearTimeOnAdversarialText() {
        int n = LogMasker.LOG_LIMIT;
        StringBuilder tiles = new StringBuilder("{\"tiles\":[");
        for (int i = 0; tiles.length() < n; i++) tiles.append(i == 0 ? "" : ",").append("\"https://m").append(i).append(".tiles.test:8443/z/").append(i).append(".png\"");
        List<String> cases = List.of(
                "A".repeat(n),                        // 낱말 글자열(base64 · 16진 덤프)
                "\uD835\uDC00".repeat(n / 2),         // 𝐀 — 보조 평면 글자열(서로게이트 쌍)
                "x" + "가".repeat(n / 2) + " done",
                "a://x:".repeat(n / 6),               // ':' 로 이어진 URL 모양, '@' 없음
                tiles.append("]}").toString(),        // 포트 달린 URL 목록(압축 JSON)
                "eyJ".repeat(n / 3),                  // 'eyJ' 반복
                "eyJ".repeat(n / 6) + "." + "b".repeat(n / 4) + ".c"); // 앞 두 칸은 맞고 셋째 칸이 짧다
        long t0 = System.nanoTime();
        for (String s : cases) assertThat(LogMasker.mask(s, n)).as(s.substring(0, 30)).isEqualTo(s.length() > n ? LogMasker.cut(s, n) : s);
        long ms = (System.nanoTime() - t0) / 1_000_000;
        // 선형이면 모두 합쳐 수십 ms 다. 부하가 큰 기계에서도 흔들리지 않게 넉넉히 — 제곱이면 한 건만으로 수십 초
        assertThat(ms).as("masking 7 adversarial texts of %d chars took %d ms", n, ms).isLessThan(2_000);
        // 가려야 할 것은 여전히 가린다
        assertThat(LogMasker.mask("a://x:".repeat(3) + "pw@h")).isEqualTo("a://x:***@h");
        assertThat(LogMasker.mask("eyJ".repeat(3) + "a".repeat(10) + ".b" + "b".repeat(10) + ".c" + "c".repeat(10))).isEqualTo("***jwt***");
        assertThat(LogMasker.mask("A".repeat(50_000) + " redis://u:pw9@h", n)).endsWith(" redis://u:***@h");
    }

    /** 바꾸기 전의 두 규칙(되짚기 정규식 — 같은 글자 집합). 새 규칙이 글자 하나까지 같은 결과를 내는지 무작위 글로 견준다(masking.py 의 시험과 같은 방식). */
    static final Pattern OLD_USERINFO = Pattern.compile("([" + LogMasker.WD + "]+://[^:/" + LogMasker.SP + "]+:)[^@" + LogMasker.SP + "]+(@)");
    static final Pattern OLD_JWT = Pattern.compile("eyJ[A-Za-z0-9\\-_]{10,}\\.[A-Za-z0-9\\-_]{10,}\\.[A-Za-z0-9\\-_]{10,}");

    @Test
    void linearUserinfoAndJwtRulesGiveTheSameOutputAsTheBacktrackingOnes() {
        Random rnd = new Random(20260929);
        String[] parts = {" ", "\n", "\u001c", "a", "b9", "x", "_", "-", "가", "é", "²", "\u0301", "\uD835\uDC00", "\uD83D\uDEA2", ":", "//", "://",
                "/", "@", ".", "=", "&", "$1", "\\", "eyJ", "abcdefghij", "0123456789", "redis://", "https://", "u:", "pw@", "h:6379",
                "eyJhbGciOiJIUzI1NiJ9.", "eyJ0eXAiOiJKV1Qi", "sig_-012345678.", "password=", "?key=", "redis://u:pw@h", "abcdefghijk.",
                "eyJabcdefghijk.abcdefghijk.", "u:pw@"};
        int masked = 0;
        for (int i = 0; i < 20_000; i++) {
            StringBuilder sb = new StringBuilder();
            for (int k = rnd.nextInt(14); k > 0; k--) sb.append(parts[rnd.nextInt(parts.length)]);
            String s = sb.toString();
            String old = OLD_JWT.matcher(OLD_USERINFO.matcher(s).replaceAll("$1***$2")).replaceAll("***jwt***");
            String now = LogMasker.maskJwt(LogMasker.maskUserinfo(s));
            assertThat(now).as("input %s", s).isEqualTo(old);
            if (!old.equals(s)) masked++;
        }
        assertThat(masked).as("cases where the rules masked something").isGreaterThan(1_000);
    }

    @Test
    void maskingIsIdempotent() {
        String once = LogMasker.mask("password=hunter2 Bearer abcdefghijklmnop redis://u:pw@h:1 {\"token\":\"t\"}");
        assertThat(LogMasker.mask(once)).isEqualTo(once);
    }
}
