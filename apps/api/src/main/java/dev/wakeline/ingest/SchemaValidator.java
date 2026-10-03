package dev.wakeline.ingest;

import com.networknt.schema.Error;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 스트림 메시지 계약 검증 — schemas/*.json(저장소 루트가 단일 원천, 빌드 시 클래스패스로 복사).
 * Python 이 만든 메시지가 이 검증을 못 넘으면 DLQ 로 보낸다(5.1절 스키마 불일치).
 */
@Component
public class SchemaValidator {
    private static final String PREFIX = "https://wakeline.invalid/schemas/";
    private final Schema envelope;
    private final Schema aircraftPayload;
    private final Schema sigmetPayload;
    private final Schema radarPayload;
    private final Schema shipsPayload;
    private final Schema aisGapPayload;

    public SchemaValidator() {
        // 스키마의 $id(https://wakeline.invalid/schemas/…)는 클래스패스 사본으로 푼다 — 네트워크에 묻지 않는다
        SchemaRegistry registry = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12,
                b -> b.schemaIdResolvers(r -> r.mapPrefix(PREFIX, "classpath:schemas/")));
        envelope = registry.getSchema(SchemaLocation.of("classpath:schemas/stream_envelope.v1.json"));
        aircraftPayload = registry.getSchema(SchemaLocation.of("classpath:schemas/stream_envelope.v1.json#/$defs/aircraft_payload"));
        sigmetPayload = registry.getSchema(SchemaLocation.of("classpath:schemas/stream_envelope.v1.json#/$defs/sigmet_payload"));
        radarPayload = registry.getSchema(SchemaLocation.of("classpath:schemas/stream_envelope.v1.json#/$defs/radar_payload"));
        shipsPayload = registry.getSchema(SchemaLocation.of("classpath:schemas/stream_envelope.v1.json#/$defs/ships_payload"));
        aisGapPayload = registry.getSchema(SchemaLocation.of("classpath:schemas/stream_envelope.v1.json#/$defs/ais_gap_payload"));
    }

    public String validateEnvelope(String json) { return first(envelope.validate(json, InputFormat.JSON)); }

    public String validatePayload(String kind, String json) {
        return switch (kind) {
            case "aircraft" -> first(aircraftPayload.validate(json, InputFormat.JSON));
            case "sigmet" -> first(sigmetPayload.validate(json, InputFormat.JSON));
            case "radar" -> first(radarPayload.validate(json, InputFormat.JSON));
            case "ships" -> first(shipsPayload.validate(json, InputFormat.JSON));
            case "ais_gap" -> first(aisGapPayload.validate(json, InputFormat.JSON));
            default -> "unknown kind " + kind;
        };
    }

    private static String first(List<Error> msgs) {
        if (msgs.isEmpty()) return null;
        Error m = msgs.getFirst();
        return m.getInstanceLocation() + ": " + m.getMessage() + (msgs.size() > 1 ? " (+" + (msgs.size() - 1) + " more)" : "");
    }
}
