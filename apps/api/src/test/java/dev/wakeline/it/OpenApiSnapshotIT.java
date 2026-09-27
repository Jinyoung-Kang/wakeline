package dev.wakeline.it;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.SerializationFeature;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;

/**
 * OpenAPI 스냅샷(설계 9.4 — "springdoc 가 생성, 저장소에 스냅샷 커밋"): 실행 중인 앱의 /api/v1/openapi 를 정규화(키 정렬, 서버 URL 제거)해
 * 커밋된 apps/api/openapi/openapi-v1.json 과 비교한다. 다르면 실패 — REST 계약이 바뀐 변경은 스냅샷 갱신을 같은 커밋에 담아야 한다.
 * <p>갱신: {@code ./gradlew updateOpenApi} (또는 {@code ./gradlew test --tests dev.wakeline.it.OpenApiSnapshotIT -PupdateOpenApi}).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class OpenApiSnapshotIT extends IntegrationTest {
    static final Path SNAPSHOT = Path.of("openapi", "openapi-v1.json");
    static final Path ACTUAL = Path.of("build", "openapi", "openapi-v1.actual.json");
    static final ObjectMapper PRETTY = JsonMapper.builder().enable(SerializationFeature.INDENT_OUTPUT).build();

    static boolean updateRequested() {
        return Boolean.parseBoolean(System.getProperty("wakeline.openapi.update", "false"));
    }

    /** 객체 키를 재귀적으로 정렬한다(배열 순서는 의미가 있으므로 그대로). */
    static JsonNode sorted(JsonNode n) {
        if (n.isObject()) {
            TreeMap<String, JsonNode> m = new TreeMap<>();
            for (Map.Entry<String, JsonNode> e : n.properties()) m.put(e.getKey(), sorted(e.getValue()));
            ObjectNode o = JsonNodeFactory.instance.objectNode();
            m.forEach(o::set);
            return o;
        }
        if (n.isArray()) {
            ArrayNode a = JsonNodeFactory.instance.arrayNode();
            for (JsonNode x : n) a.add(sorted(x));
            return a;
        }
        return n;
    }

    static String normalize(String body) {
        JsonNode spec = Streams.JSON.readTree(body);
        ((ObjectNode) spec).remove("servers"); // http://localhost:{임의 포트}
        return PRETTY.writeValueAsString(sorted(spec)).replace("\r\n", "\n") + "\n";
    }

    @Test
    void liveSpecMatchesTheCommittedSnapshot() throws IOException {
        Res r = get("/api/v1/openapi");
        assertThat(r.status()).isEqualTo(200);
        String actual = normalize(r.body());
        // 결정적인가: 두 번 받아도 같다(스냅샷 비교가 흔들리지 않게)
        assertThat(normalize(get("/api/v1/openapi").body())).isEqualTo(actual);

        JsonNode spec = Streams.JSON.readTree(actual);
        assertThat(spec.path("openapi").asString()).startsWith("3.");
        for (String p : List.of("/api/v1/aircraft", "/api/v1/aircraft/{hex}", "/api/v1/aircraft/search", "/api/v1/sigmets", "/api/v1/alerts",
                "/api/v1/alerts/history", "/api/v1/status", "/api/v1/replay", "/api/v1/airports", "/api/v1/radar/frames"))
            assertThat(spec.path("paths").has(p)).as("path " + p).isTrue();

        if (updateRequested()) {
            Files.createDirectories(SNAPSHOT.getParent());
            Files.writeString(SNAPSHOT, actual, StandardCharsets.UTF_8);
            System.out.println("OpenAPI snapshot updated: " + SNAPSHOT.toAbsolutePath());
            return;
        }
        if (!Files.exists(SNAPSHOT))
            fail("no committed OpenAPI snapshot at " + SNAPSHOT.toAbsolutePath() + " — run ./gradlew updateOpenApi and commit it");
        String committed = Files.readString(SNAPSHOT, StandardCharsets.UTF_8);
        if (!committed.equals(actual)) {
            Files.createDirectories(ACTUAL.getParent());
            Files.writeString(ACTUAL, actual, StandardCharsets.UTF_8);
            fail("OpenAPI spec changed (" + firstDifference(committed, actual) + ").\n"
                    + "Live spec written to " + ACTUAL.toAbsolutePath() + ".\n"
                    + "If the REST change is intended, run ./gradlew updateOpenApi and commit openapi/openapi-v1.json with it.");
        }
    }

    static String firstDifference(String a, String b) {
        String[] x = a.split("\n", -1), y = b.split("\n", -1);
        for (int i = 0; i < Math.min(x.length, y.length); i++)
            if (!x[i].equals(y[i])) return "line " + (i + 1) + ": committed «" + x[i].strip() + "» vs live «" + y[i].strip() + "»";
        List<String> tail = new ArrayList<>();
        tail.add("committed " + x.length + " lines, live " + y.length + " lines");
        return String.join("; ", tail);
    }
}
