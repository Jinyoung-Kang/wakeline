package dev.skywx.ingest;

import com.networknt.schema.AbsoluteIri;
import com.networknt.schema.InputFormat;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SchemaId;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import com.networknt.schema.resource.SchemaMapper;
import org.springframework.stereotype.Component;

import java.util.Set;

/**
 * 스트림 메시지 계약 검증 — schemas/*.json(저장소 루트가 단일 원천, 빌드 시 클래스패스로 복사).
 * Python 이 만든 메시지가 이 검증을 못 넘으면 DLQ 로 보낸다(5.1절 스키마 불일치).
 */
@Component
public class SchemaValidator {
    private static final String PREFIX = "https://skywx.dev/schemas/";
    private final JsonSchema envelope;
    private final JsonSchema aircraftPayload;
    private final JsonSchema sigmetPayload;
    private final JsonSchema radarPayload;

    public SchemaValidator() {
        SchemaMapper mapper = iri -> {
            String s = iri.toString();
            if (s.startsWith(PREFIX)) return AbsoluteIri.of("classpath:schemas/" + s.substring(PREFIX.length()));
            return null;
        };
        JsonSchemaFactory factory = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012,
                b -> b.schemaMappers(m -> m.add(mapper)));
        var config = new com.networknt.schema.SchemaValidatorsConfig.Builder().build();
        envelope = factory.getSchema(SchemaLocation.of("classpath:schemas/stream_envelope.v1.json"), config);
        aircraftPayload = factory.getSchema(SchemaLocation.of("classpath:schemas/stream_envelope.v1.json#/$defs/aircraft_payload"), config);
        sigmetPayload = factory.getSchema(SchemaLocation.of("classpath:schemas/stream_envelope.v1.json#/$defs/sigmet_payload"), config);
        radarPayload = factory.getSchema(SchemaLocation.of("classpath:schemas/stream_envelope.v1.json#/$defs/radar_payload"), config);
    }

    public String validateEnvelope(String json) { return first(envelope.validate(json, InputFormat.JSON)); }

    public String validatePayload(String kind, String json) {
        return switch (kind) {
            case "aircraft" -> first(aircraftPayload.validate(json, InputFormat.JSON));
            case "sigmet" -> first(sigmetPayload.validate(json, InputFormat.JSON));
            case "radar" -> first(radarPayload.validate(json, InputFormat.JSON));
            default -> "unknown kind " + kind;
        };
    }

    private static String first(Set<ValidationMessage> msgs) {
        if (msgs.isEmpty()) return null;
        ValidationMessage m = msgs.iterator().next();
        return m.getInstanceLocation() + ": " + m.getMessage() + (msgs.size() > 1 ? " (+" + (msgs.size() - 1) + " more)" : "");
    }
}
