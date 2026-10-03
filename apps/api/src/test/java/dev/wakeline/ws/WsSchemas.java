package dev.wakeline.ws;

import com.networknt.schema.Error;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SchemaRegistryConfig;
import com.networknt.schema.SpecificationVersion;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * WS 메시지 스키마 검증기(시험 전용 — 계약 v5 §E1 · ADR-020). 저장소 루트의 schemas/ws/*.json 을 그대로 읽는다(운영 코드는 WS 스키마를 쓰지 않으므로
 * 클래스패스 복사본이 없다). WsSchemaContractTest(실제 빌더) · WsIT(전체 앱 · 실제 소켓)가 같이 쓴다. 날짜 형식(date-time)도 검사한다.
 */
public final class WsSchemas {
    public static final Path DIR = Path.of("../../schemas/ws").toAbsolutePath().normalize();
    static final String BASE = "https://wakeline.invalid/schemas/ws/";
    private static final JsonMapper READ = JsonMapper.builder().build();
    /** $id(https://wakeline.invalid/schemas/ws/…)를 저장소 파일 내용으로 푼다 — json-schema-validator 3.x 는 원격 · file: 가져오기를 기본으로 막는다. */
    private static final SchemaRegistry REGISTRY = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12, b -> b
            .resourceLoaders(r -> r.resources(WsSchemas::read))
            .schemaRegistryConfig(SchemaRegistryConfig.builder().formatAssertionsEnabled(true).build()));

    private static String read(String iri) {
        if (!iri.startsWith(BASE)) return null;
        try {
            return Files.readString(DIR.resolve(iri.substring(BASE.length())));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
    static final String SERVER_FILE = "server.v1.json";
    static final String CLIENT_FILE = "client.v1.json";
    private static final Schema SERVER = load(SERVER_FILE);
    private static final Schema CLIENT = load(CLIENT_FILE);
    /** 실패 설명용: type 이 가리키는 가지($defs/&lt;type&gt;)만 — oneOf 는 모든 가지의 위반을 늘어놓는다. */
    private static final Map<String, Schema> BRANCHES = new ConcurrentHashMap<>();

    private WsSchemas() {}

    static Schema load(String fileAndPointer) { return REGISTRY.getSchema(SchemaLocation.of(BASE + fileAndPointer)); }

    /** 서버 → 클라이언트 메시지의 위반(맞으면 빈 목록). */
    public static List<String> server(String message) { return violations(SERVER, SERVER_FILE, message); }

    /** 클라이언트 → 서버 메시지의 위반(맞으면 빈 목록). */
    public static List<String> client(String message) { return violations(CLIENT, CLIENT_FILE, message); }

    private static List<String> describe(List<Error> msgs) {
        List<String> out = new ArrayList<>();
        for (Error m : msgs) out.add(m.getInstanceLocation() + ": " + m.getMessage());
        return out;
    }

    /** 틀렸으면 그 type 의 가지만의 위반을(가지가 통과하면 — 예: 모르는 type — 전체 위반을) 돌려준다. */
    private static List<String> violations(Schema root, String file, String message) {
        List<Error> msgs;
        try {
            msgs = root.validate(message, InputFormat.JSON);
        } catch (RuntimeException e) {
            return List.of("not JSON: " + e.getClass().getSimpleName());
        }
        if (msgs.isEmpty()) return List.of();
        JsonNode n = READ.readTree(message);
        String t = n.path("type").asString("");
        if (t.matches("^[a-z_]{1,40}$")) {
            try {
                Schema branch = BRANCHES.computeIfAbsent(file + "#" + t, k -> load(file + "#/$defs/" + t));
                List<String> b = describe(branch.validate(message, InputFormat.JSON));
                if (!b.isEmpty()) return b;
            } catch (RuntimeException ignored) {
                // 모르는 type — 전체 위반을 그대로
            }
        }
        return describe(msgs);
    }
}
