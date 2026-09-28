package dev.wakeline.logs;

import com.networknt.schema.InputFormat;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;

import java.util.Set;

/**
 * 로그 항목 계약 검증 — schemas/log_event.v1.json(저장소 루트가 단일 원천, 클래스패스 복사본은 contract_check 가 같은지 본다).
 * 형식(format: date-time)도 검사한다. 읽는 쪽(§C4)은 맞지 않는 항목을 건너뛰고 센다, 보내는 쪽 시험은 만든 항목이 통과하는지 본다.
 */
public final class LogEventSchema {
    private final JsonSchema schema;

    public LogEventSchema() {
        JsonSchemaFactory factory = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V202012);
        var config = new com.networknt.schema.SchemaValidatorsConfig.Builder().formatAssertionsEnabled(true).build();
        schema = factory.getSchema(SchemaLocation.of("classpath:schemas/log_event.v1.json"), config);
    }

    /** @return 첫 위반 설명, 맞으면 null. JSON 이 아니면 그 설명. */
    public String validate(String json) {
        Set<ValidationMessage> msgs;
        try {
            msgs = schema.validate(json, InputFormat.JSON);
        } catch (RuntimeException e) {
            return "not JSON: " + e.getClass().getSimpleName();
        }
        if (msgs.isEmpty()) return null;
        ValidationMessage m = msgs.iterator().next();
        return m.getInstanceLocation() + ": " + m.getMessage() + (msgs.size() > 1 ? " (+" + (msgs.size() - 1) + " more)" : "");
    }
}
