package dev.wakeline.ingest;

import com.networknt.schema.InputFormat;
import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.weather.core.RadarStore;
import dev.wakeline.weather.core.SigmetStore;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.RecordId;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 측정(리뷰 cto-2026-10 P1 · api-review §4 P1 — docs/PERF.md §13): 전세계 항공기 메시지 하나(10,000대 — 리뷰의 합성 고정본과 같은 모양)를 소비 스레드가
 * 해석하는 데 드는 시간과 그 나눔. 페이로드는 한 번 파싱한다(2026-10-03 — json-schema-validator 3.x 부터 검증기도 Jackson 3 트리를 받아 코덱이 읽은
 * 트리를 그대로 검증한다. 검증은 그대로 전부 — 결정 8). 비교 행: 예전 경로(검증이 문자열을 다시 읽음 + 코덱용 readTree).
 * 실행: {@code ./gradlew --offline perfTest --tests 'dev.wakeline.ingest.StreamParsePerfTest'} — 단계마다 데우기 10번 뒤 21번의 가운데 값.
 */
@Tag("perf")
class StreamParsePerfTest {
    static final ObjectMapper J3 = JsonMapper.builder().build();
    static final int N = 10_000;
    static final int RUNS = 21;

    @Test
    void measure() throws Exception {
        Instant now = Instant.now();
        String payloadJson = globalPayload(now);
        Map<String, String> f = new LinkedHashMap<>();
        f.put("schema_version", "1");
        f.put("kind", "aircraft");
        f.put("scope", "global");
        f.put("provider", "opensky");
        f.put("fetched_at", now.toString());
        f.put("raw_ref", "x");
        f.put("encoding", "gzip+base64");
        f.put("count", String.valueOf(N));
        f.put("run_id", "r");
        f.put("payload", SchemaContractTest.gz64(payloadJson));
        MapRecord<String, String, String> rec = MapRecord.create(StreamConsumer.S_AIRCRAFT, f).withId(RecordId.of("1-0"));
        SchemaValidator v = new SchemaValidator();
        StreamConsumer c = new StreamConsumer(null, v, new SnapshotStore(), new SigmetStore(), new RadarStore(), e -> { }, J3, new SimpleMeterRegistry());
        var fld = SchemaValidator.class.getDeclaredField("aircraftPayload"); // 운영 코드는 바꾸지 않는다 — 같은 스키마 객체를 읽는다
        fld.setAccessible(true);
        var aircraftSchema = (com.networknt.schema.Schema) fld.get(v);

        // 같은 결과인지 먼저: 검증 결과(문자열 · Jackson 3 트리) 같음
        JsonNode once = J3.readTree(payloadJson);
        assertThat(aircraftSchema.validate(once)).isEqualTo(aircraftSchema.validate(payloadJson, InputFormat.JSON)).isEmpty();
        assertThat(c.parse(rec).aircraft()).hasSize(N);

        List<String> out = new ArrayList<>();
        out.add(String.format("payload json %,d B · gzip+base64 %,d B", payloadJson.length(), f.get("payload").length()));
        double parse = median(() -> c.parse(rec));
        out.add(row("parse() 전체(지금 — 한 번 파싱)", parse));
        String env = J3.writeValueAsString(f);
        out.add(row("  봉투 직렬화 + 검증", median(() -> v.validateEnvelope(J3.writeValueAsString(f)))));
        out.add(row("  페이로드 풀기(base64 + gunzip)", median(() -> StreamConsumer.decode(f.get("payload")))));
        double validateString = median(() -> aircraftSchema.validate(payloadJson, InputFormat.JSON));
        out.add(row("  페이로드 스키마 검증(트리)", median(() -> aircraftSchema.validate(once))));
        out.add(row("  (예전) 페이로드 스키마 검증(문자열 — 파싱 포함)", validateString));
        double j3Parse = median(() -> J3.readTree(payloadJson));
        out.add(row("  Jackson 3 readTree(한 번)", j3Parse));
        JsonNode tree = J3.readTree(payloadJson);
        out.add(row("  코덱(10,000 상태)", median(() -> { int k = 0; for (JsonNode n : tree.path("states")) if (Codec.aircraft(n) != null) k++; return k; })));
        double single = median(() -> {
            JsonNode t = J3.readTree(payloadJson);
            if (!aircraftSchema.validate(t).isEmpty()) throw new AssertionError();
            return t;
        });
        double twice = median(() -> {
            if (!aircraftSchema.validate(payloadJson, InputFormat.JSON).isEmpty()) throw new AssertionError();
            return J3.readTree(payloadJson);
        });
        out.add(row("검증 + 코덱용 트리: 예전(문자열 검증 + J3 파싱)", twice));
        out.add(row("검증 + 코덱용 트리: 지금(J3 한 번 파싱 + 트리 검증)", single));
        out.add(String.format("차이(예전 − 지금) %.1f ms", twice - single));
        out.forEach(System.out::println);
        java.nio.file.Path p = java.nio.file.Path.of("build/perf/stream-parse.txt");
        java.nio.file.Files.createDirectories(p.getParent());
        java.nio.file.Files.write(p, out);
    }

    static String row(String label, double ms) { return String.format("%-60s %7.1f ms", label, ms); }

    interface Work { Object run() throws Exception; }

    static double median(Work w) throws Exception {
        for (int i = 0; i < 10; i++) w.run();
        double[] t = new double[RUNS];
        for (int i = 0; i < RUNS; i++) {
            long t0 = System.nanoTime();
            w.run();
            t[i] = (System.nanoTime() - t0) / 1e6;
        }
        Arrays.sort(t);
        return t[RUNS / 2];
    }

    /** 리뷰(api-review §4 P1)의 10,000대 전세계 고정본과 같은 모양 — 모든 필드가 찬 상태. */
    static String globalPayload(Instant now) {
        List<Map<String, Object>> states = new ArrayList<>(N);
        for (int i = 0; i < N; i++) {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("hex", String.format("%06x", 0x100000 + i));
            s.put("callsign", "TST" + i);
            s.put("registration", "HL" + i);
            s.put("type_code", "A21N");
            s.put("lat", -60 + (i % 1200) * 0.1);
            s.put("lon", -170 + (i / 30) * 1.0 % 340);
            s.put("alt_ft", 30000);
            s.put("gs_kt", 450.0);
            s.put("track_deg", 90.0);
            s.put("vrate_fpm", 0.0);
            s.put("on_ground", false);
            s.put("squawk", "1200");
            s.put("seen_at", now.toString());
            s.put("provider", "opensky");
            s.put("fetched_at", now.toString());
            s.put("quality", 0);
            s.put("estimated", false);
            states.add(s);
        }
        return J3.writeValueAsString(Map.of("region", Map.of("lat", 36.5, "lon", 127.8, "radius_nm", 250), "states", states));
    }
}
