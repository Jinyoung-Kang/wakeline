package dev.wakeline.ws;

import com.networknt.schema.AbsoluteIri;
import com.networknt.schema.InputFormat;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaValidatorsConfig;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import com.networknt.schema.resource.SchemaMapper;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * WS 메시지 스키마 검증기(시험 전용 — 계약 v5 §E1 · ADR-020). 저장소 루트의 schemas/ws/*.json 을 그대로 읽는다(운영 코드는 WS 스키마를 쓰지 않으므로
 * 클래스패스 복사본이 없다). WsSchemaContractTest(실제 빌더) · WsIT(전체 앱 · 실제 소켓)가 같이 쓴다. 날짜 형식(date-time)도 검사한다.
 */
public final class WsSchemas {
    public static final Path DIR = Path.of("../../schemas/ws").toAbsolutePath().normalize();
    static final String BASE = "https://wakeline.invalid/schemas/ws/";
    private static final JsonMapper READ = JsonMapper.builder().build();
    private static final SchemaValidatorsConfig CONFIG = new SchemaValidatorsConfig.Builder().formatAssertionsEnabled(true).build();
    private static final JsonSchemaFactory FACTORY;
    static {
        String dir = DIR.toUri().toString().replaceAll("/?$", "/");
        SchemaMapper mapper = iri -> iri.toString().startsWith(BASE) ? AbsoluteIri.of(dir + iri.toString().substring(BASE.length())) : null;
        FACTORY = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012, b -> b.schemaMappers(m -> m.add(mapper)));
    }
    static final String SERVER_FILE = "server.v1.json";
    static final String CLIENT_FILE = "client.v1.json";
    private static final JsonSchema SERVER = load(SERVER_FILE);
    private static final JsonSchema CLIENT = load(CLIENT_FILE);
    /** 실패 설명용: type 이 가리키는 가지($defs/&lt;type&gt;)만 — oneOf 는 모든 가지의 위반을 늘어놓는다. */
    private static final Map<String, JsonSchema> BRANCHES = new ConcurrentHashMap<>();

    private WsSchemas() {}

    static JsonSchema load(String fileAndPointer) { return FACTORY.getSchema(SchemaLocation.of(BASE + fileAndPointer), CONFIG); }

    /** 서버 → 클라이언트 메시지의 위반(맞으면 빈 목록). */
    public static List<String> server(String message) { return violations(SERVER, SERVER_FILE, message); }

    /** 클라이언트 → 서버 메시지의 위반(맞으면 빈 목록). */
    public static List<String> client(String message) { return violations(CLIENT, CLIENT_FILE, message); }

    private static List<String> describe(Set<ValidationMessage> msgs) {
        List<String> out = new ArrayList<>();
        for (ValidationMessage m : msgs) out.add(m.getInstanceLocation() + ": " + m.getMessage());
        return out;
    }

    /** 틀렸으면 그 type 의 가지만의 위반을(가지가 통과하면 — 예: 모르는 type — 전체 위반을) 돌려준다. */
    private static List<String> violations(JsonSchema root, String file, String message) {
        Set<ValidationMessage> msgs;
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
                JsonSchema branch = BRANCHES.computeIfAbsent(file + "#" + t, k -> load(file + "#/$defs/" + t));
                List<String> b = describe(branch.validate(message, InputFormat.JSON));
                if (!b.isEmpty()) return b;
            } catch (RuntimeException ignored) {
                // 모르는 type — 전체 위반을 그대로
            }
        }
        return describe(msgs);
    }
}
