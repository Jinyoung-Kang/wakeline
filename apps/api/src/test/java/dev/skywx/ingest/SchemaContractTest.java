package dev.skywx.ingest;

import dev.skywx.domain.AircraftState;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Map;
import java.util.zip.GZIPOutputStream;

import static org.assertj.core.api.Assertions.assertThat;

/** 계약 테스트(14.1): Python 이 만드는 형태의 메시지를 Java 가 같은 스키마 파일로 검증한다. fixture 실응답 → 정규화 규칙 재현. */
class SchemaContractTest {
    static final JsonMapper M = JsonMapper.builder().build();
    static final SchemaValidator V = new SchemaValidator();

    static String gz64(String json) throws Exception {
        var bos = new ByteArrayOutputStream();
        try (var g = new GZIPOutputStream(bos)) { g.write(json.getBytes(StandardCharsets.UTF_8)); }
        return Base64.getEncoder().encodeToString(bos.toByteArray());
    }

    @Test void validEnvelopeAndPayloadPass_andDecode() throws Exception {
        String payload = """
                {"region":{"lat":36.5,"lon":127.8,"radius_nm":250},"states":[{"hex":"71c0a1","callsign":"KAL081","registration":"HL8001","type_code":"B77W",
                 "category":"A5","lat":37.4602,"lon":126.4407,"alt_ft":35000,"gs_kt":470.0,"track_deg":82.5,"vrate_fpm":0,"on_ground":false,"squawk":"1234",
                 "seen_at":"2026-09-27T05:10:03Z","provider":"adsb_lol","fetched_at":"2026-09-27T05:10:05Z","quality":0,"estimated":false}]}""";
        Map<String, String> env = Map.of("schema_version", "1", "kind", "aircraft", "scope", "region", "provider", "adsb_lol",
                "fetched_at", "2026-09-27T05:10:05Z", "raw_ref", "raw/adsb_lol/20260927/051005.json.gz", "encoding", "gzip+base64", "count", "1", "run_id", "1", "payload", gz64(payload));
        assertThat(V.validateEnvelope(M.writeValueAsString(env))).isNull();
        String decoded = StreamConsumer.decode(env.get("payload"));
        assertThat(V.validatePayload("aircraft", decoded)).isNull();
        JsonNode n = M.readTree(decoded).path("states").get(0);
        AircraftState a = Codec.aircraft(n);
        assertThat(a.hex()).isEqualTo("71c0a1");
        assertThat(a.altFt()).isEqualTo(35000);
        assertThat(a.estimated()).isFalse();
    }

    @Test void estimatedTrue_isRejected() {
        String payload = """
                {"states":[{"hex":"71c0a1","lat":37.4,"lon":126.4,"on_ground":false,"seen_at":"2026-09-27T05:10:03Z","provider":"adsb_lol",
                 "fetched_at":"2026-09-27T05:10:05Z","quality":0,"estimated":true}]}""";
        assertThat(V.validatePayload("aircraft", payload)).contains("estimated");
    }

    @Test void quarantinedQualityOrBadHex_isRejected() {
        String payload = """
                {"states":[{"hex":"ZZZZZZ","lat":37.4,"lon":126.4,"on_ground":false,"seen_at":"2026-09-27T05:10:03Z","provider":"adsb_lol",
                 "fetched_at":"2026-09-27T05:10:05Z","quality":2,"estimated":false}]}""";
        assertThat(V.validatePayload("aircraft", payload)).isNotNull();
    }

    @Test void sigmetPayloadWithNullGeometry_isAllowed() {
        String payload = """
                {"sigmets":[{"id":"RKRR:F02:1790481600","fir_id":"RKRR","series_id":"F02","hazard":"ICE","base_ft":14000,"top_ft":21000,
                 "valid_from":"2026-09-27T04:00:00Z","valid_to":"2026-09-27T08:00:00Z","geometry":null,"excluded_reason":"line_or_point_geometry",
                 "raw_text":"RAW","provider":"awc_isigmet","fetched_at":"2026-09-27T05:10:05Z"}]}""";
        assertThat(V.validatePayload("sigmet", payload)).isNull();
    }

    @Test void realFixtureThroughPythonRules_wouldPass() throws Exception {
        // Python 정규화 결과를 흉내 낸 최소 변환으로 실응답 필드 범위가 스키마 안에 있음을 확인한다(전체 계약은 tools/contract_check.py).
        Path fx = Path.of("../../fixtures/adsb_lol_region.json");
        if (!Files.exists(fx)) return;
        JsonNode root = M.readTree(Files.readString(fx));
        int ok = 0;
        for (JsonNode ac : root.path("ac")) {
            if (!ac.hasNonNull("lat") || !ac.hasNonNull("lon")) continue;
            var o = M.createObjectNode();
            o.put("hex", ac.path("hex").asString().toLowerCase());
            o.put("lat", ac.path("lat").asDouble()); o.put("lon", ac.path("lon").asDouble());
            boolean ground = "ground".equals(ac.path("alt_baro").asString(""));
            o.put("on_ground", ground);
            if (ground) o.put("alt_ft", 0); else if (ac.path("alt_baro").isNumber()) o.put("alt_ft", ac.path("alt_baro").asInt()); else o.putNull("alt_ft");
            o.put("seen_at", "2026-09-27T05:10:03Z"); o.put("provider", "adsb_lol"); o.put("fetched_at", "2026-09-27T05:10:05Z");
            o.put("quality", 0); o.put("estimated", false);
            assertThat(V.validatePayload("aircraft", "{\"states\":[" + M.writeValueAsString(o) + "]}")).isNull();
            ok++;
        }
        assertThat(ok).isGreaterThan(50);
    }
}
