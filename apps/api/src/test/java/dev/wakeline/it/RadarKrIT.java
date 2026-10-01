package dev.wakeline.it;

import dev.wakeline.rest.StatusService;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-72: 수집기가 쓰는 wakeline:radar_kr:meta 해시 — 공개 /status 는 검증한 필드만 싣고(원본 해시를 통째로 내보내지 않는다), /radar/kr 는
 * 형식이 틀린 값에 500 대신 '쓸 수 없음'(모르는 값은 null)으로 답하고 센다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class RadarKrIT extends IntegrationTest {
    static final String PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    @Autowired StatusService status;
    @Autowired MeterRegistry meters;

    static Map<String, String> meta(String now, String live) {
        return Map.ofEntries(Map.entry("available", "1"), Map.entry("status", "200"), Map.entry("note", "internal note"), Map.entry("latest_tm", live),
                Map.entry("product", "HSR"), Map.entry("cmp", "HSR"), Map.entry("coordinates", "[[121.8,39.9],[132.9,39.9],[132.9,31.6],[121.8,31.6]]"),
                Map.entry("width", "640"), Map.entry("height", "480"), Map.entry("projection", "EPSG:3857"), Map.entry("grid", "{\"nx\":2305,\"ny\":2881}"),
                Map.entry("legend", "[{\"dbz\":10,\"color\":\"#00c8ff\"}]"), Map.entry("min_dbz", "0.5"), Map.entry("stations", "2"),
                Map.entry("station_ids", "KSN,GDK"), Map.entry("stations_ref", "15"), Map.entry("partial", "1"), Map.entry("observed_cells", "1234"), Map.entry("fetched_at", now), Map.entry("checked_at", now), Map.entry("secret_like", "should-not-leak"));
    }

    @Test
    void publicStatusCarriesOnlyValidatedRadarFields() {
        String now = Instant.now().toString(), live = "202609281210";
        try {
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", meta(now, live));
            await("status cache refreshed", Duration.ofSeconds(10), () -> status.cachedPublicStatus().get("radar_kr") instanceof Map<?, ?> m && live.equals(m.get("latest_tm")));
            JsonNode kr = get("/api/v1/status").json().path("radar_kr");
            List<String> keys = new ArrayList<>();
            kr.propertyNames().forEach(keys::add);
            assertThat(keys).containsExactlyInAnyOrder("available", "status", "latest_tm", "fetched_at", "checked_at", "stations", "stations_ref", "partial");
            assertThat(kr.path("stations").asInt()).isEqualTo(2); // ADR-021: 최신 프레임의 합성 지점 수 · 기준 · 부분 합성(검증한 값)
            assertThat(kr.path("stations_ref").asInt()).isEqualTo(15);
            assertThat(kr.path("partial").isBoolean() && kr.path("partial").asBoolean()).isTrue();
            assertThat(kr.has("station_ids")).as("station codes are served by /radar/kr only").isFalse();
            assertThat(kr.path("available").isBoolean() && kr.path("available").asBoolean()).isTrue();
            assertThat(kr.path("status").asString()).isEqualTo("200");
            assertThat(kr.toString()).doesNotContain("should-not-leak").doesNotContain("internal note").doesNotContain("observed_cells");

            // 틀린 값은 모름(키 없음)
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", Map.of("available", "yes", "latest_tm", "12:10", "fetched_at", "yesterday", "status", "OK!"));
            await("status cache refreshed", Duration.ofSeconds(10), () -> status.cachedPublicStatus().get("radar_kr") instanceof Map<?, ?> m && !m.containsKey("latest_tm"));
            JsonNode bad = get("/api/v1/status").json().path("radar_kr");
            assertThat(bad.has("available")).isFalse();
            assertThat(bad.has("fetched_at")).isFalse();
            assertThat(bad.has("status")).isFalse();
        } finally {
            ItStack.deleteKeys("wakeline:radar_kr:*");
        }
    }

    double parseErrors() {
        return meters.find("wakeline_radar_kr_parse_errors_total").counters().stream().mapToDouble(io.micrometer.core.instrument.Counter::count).sum();
    }

    @Test
    void malformedCollectorValuesMakeTheKmaRadarUnavailableInsteadOf500() {
        String now = Instant.now().toString(), live = "202609281220";
        double before = parseErrors();
        try {
            ItStack.collector().opsForValue().set("wakeline:radar_kr:frame:" + live, PNG_1X1);
            ItStack.collector().opsForValue().set("wakeline:radar_kr:frames",
                    "[{\"tm\":\"%s\",\"obs_tm\":\"%s\",\"fetched_at\":\"%s\",\"echo_cells\":12}]".formatted(live, live, now));
            Map<String, String> m = new java.util.HashMap<>(meta(now, live));
            m.put("width", "six-hundred");         // Integer.parseInt 이 던졌다
            m.put("coordinates", "[[121.8,39.9],"); // readTree 가 던졌다
            m.put("fetched_at", "yesterday");       // Instant.parse 가 던졌다
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", m);
            Res r = get("/api/v1/radar/kr");
            assertThat(r.status()).as(r.body()).isEqualTo(200);
            JsonNode body = r.json();
            assertThat(body.path("available").asBoolean(true)).as("cannot be placed on the map without coordinates and size").isFalse();
            assertThat(body.path("georeferenced").asBoolean(true)).isFalse();
            assertThat(body.has("image_size")).isFalse();
            assertThat(body.has("coordinates")).isFalse();
            assertThat(body.path("meta").has("fetched_at")).isFalse();
            assertThat(parseErrors()).isGreaterThanOrEqualTo(before + 3);

            // 목록 자체가 JSON 이 아니어도 500 이 아니다
            ItStack.collector().opsForValue().set("wakeline:radar_kr:frames", "{not json");
            Res broken = get("/api/v1/radar/kr");
            assertThat(broken.status()).isEqualTo(200);
            assertThat(broken.json().path("frames").size()).isZero();
            assertThat(broken.json().path("available").asBoolean(true)).isFalse();
        } finally {
            ItStack.deleteKeys("wakeline:radar_kr:*");
        }
    }

    /**
     * 기상청 내려받기 '파일 없음' 연속(운영 로그 2026-09-30 — 목록은 EXT 로 싣는데 내려받기가 RDR_CMP_HSR_PUB_&lt;tm&gt;.bin.gz 없음으로 답함):
     * /radar/kr 와 /status 의 radar_kr 가 수집기 missing_* 를 검증해 missing 으로 싣는다. 연속이 갱신되면(마지막 확인 · tm 수) 프레임이 그대로여도
     * ETag 가 바뀐다 — 304 로 옛 까닭을 붙잡지 않는다. 연속이 닫히면(빈 값) 키가 없다.
     */
    @Test
    void theMissingFileStreakIsServedAndChangesTheEtag() {
        String live = "202609300810";
        Instant f = Instant.parse("2026-09-29T23:13:40Z");
        try {
            ItStack.collector().opsForValue().set("wakeline:radar_kr:frame:" + live, PNG_1X1);
            ItStack.collector().opsForValue().set("wakeline:radar_kr:frames",
                    "[{\"tm\":\"%s\",\"obs_tm\":\"%s\",\"fetched_at\":\"%s\",\"echo_cells\":12}]".formatted(live, live, f));
            Map<String, String> m = new java.util.HashMap<>(meta(f.toString(), live));
            m.putAll(Map.of("missing_since_tm", "202609300815", "missing_last_tm", "202609300945", "missing_tms", "19",
                    "missing_checked_at", "2026-09-30T00:45:31Z", "missing_file", "RDR_CMP_HSR_PUB_202609300945.bin.gz", "missing_listed", "EXT"));
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", m);
            Res r = get("/api/v1/radar/kr");
            JsonNode miss = r.json().path("missing");
            assertThat(miss.path("since_tm").asString()).isEqualTo("202609300815");
            assertThat(miss.path("last_tm").asString()).isEqualTo("202609300945");
            assertThat(miss.path("tms").asInt()).isEqualTo(19);
            assertThat(miss.path("checked_at").asString()).isEqualTo("2026-09-30T00:45:31Z");
            assertThat(miss.path("file").asString()).isEqualTo("RDR_CMP_HSR_PUB_202609300945.bin.gz");
            assertThat(miss.path("listed").toString()).isEqualTo("[\"EXT\"]");
            assertThat(r.json().path("available").asBoolean()).as("the stored frame is still served").isTrue();

            // 다음 확인(09:50) — 프레임 · 목록은 그대로
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", Map.of("missing_last_tm", "202609300950", "missing_tms", "20",
                    "missing_checked_at", "2026-09-30T00:50:31Z", "missing_file", "RDR_CMP_HSR_PUB_202609300950.bin.gz"));
            Res after = get("/api/v1/radar/kr", headers("If-None-Match", r.header("ETag")));
            assertThat(after.status()).as("same frames, newer streak — not 304").isEqualTo(200);
            assertThat(after.json().path("missing").path("tms").asInt()).isEqualTo(20);
            await("status cache refreshed", Duration.ofSeconds(10), () -> status.cachedPublicStatus().get("radar_kr") instanceof Map<?, ?> k
                    && k.get("missing") instanceof Map<?, ?> mm && Integer.valueOf(20).equals(mm.get("tms")));
            JsonNode st = get("/api/v1/status").json().path("radar_kr").path("missing");
            assertThat(st.path("since_tm").asString()).isEqualTo("202609300815");
            assertThat(st.path("last_tm").asString()).isEqualTo("202609300950");

            // 연속이 닫힘(수집기가 빈 값으로 지운다) → 키 없음
            Map<String, String> cleared = new java.util.HashMap<>();
            for (String k : List.of("missing_since_tm", "missing_last_tm", "missing_tms", "missing_checked_at", "missing_file", "missing_listed")) cleared.put(k, "");
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", cleared);
            assertThat(get("/api/v1/radar/kr").json().has("missing")).isFalse();
        } finally {
            ItStack.deleteKeys("wakeline:radar_kr:*");
        }
    }

    /**
     * 수집기 meta note(까닭 한 줄 — 연속 밖의 목록 멈춤 '기상청 목록에 tm … 뒤 새 tm 없음'(2026-10-01 · 레인 kma 8차) · 403 활용신청 · 목록 실패의 종류)만 바뀌어도
     * ETag 가 바뀐다. 전에는 note 가 ETag 에 없어 프레임이 만료된 '사용 불가' 동안 다른 필드가 그대로면 웹이 304 로 옛 까닭('아직 수집되지 않음')을 붙잡았다
     * (웹은 fetch 기본 캐시 — 브라우저가 If-None-Match 로 다시 확인한다).
     */
    @Test
    void aChangedNoteAloneChangesTheEtag() {
        String live = "202609301950", note = "기상청 목록에 tm 202609301950(KST) 뒤 새 tm 없음";
        try {
            Map<String, String> m = new java.util.HashMap<>(meta("2026-09-30T10:50:02Z", live));
            m.put("available", "0"); // 프레임은 모두 만료됐다
            m.put("note", "");
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", m);
            Res r = get("/api/v1/radar/kr");
            assertThat(r.json().path("available").asBoolean(true)).isFalse();
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", Map.of("note", note));
            Res after = get("/api/v1/radar/kr", headers("If-None-Match", r.header("ETag")));
            assertThat(after.status()).as("same frames and fields, new note — not 304").isEqualTo(200);
            assertThat(after.json().path("note").asString()).isEqualTo(note);
            assertThat(get("/api/v1/radar/kr", headers("If-None-Match", after.header("ETag"))).status()).isEqualTo(304);
        } finally {
            ItStack.deleteKeys("wakeline:radar_kr:*");
        }
    }

    /**
     * ADR-021: 프레임마다 합성 지점 수 · 코드 · 기준 · partial · 다시 받기 기록을 /radar/kr 가 옮기고, 최상위는 최신 프레임의 값을 싣는다.
     * 같은 tm 을 다시 받아 바꾸면(지점이 늘었다) 영상 URL 과 ETag 가 바뀐다 — 목록의 tm 이 같아도 304 로 옛 판정을 붙잡지 않는다.
     */
    @Test
    void framesCarryTheCompositeSizeAndAnUpgradedFrameChangesUrlAndEtag() {
        String t1 = "202609291440", t2 = "202609291445";
        Instant f1 = Instant.parse("2026-09-29T05:43:44Z"), f2 = Instant.parse("2026-09-29T05:48:40Z"), again = Instant.parse("2026-09-29T05:53:41Z");
        String partial = ("[{\"tm\":\"%s\",\"obs_tm\":\"%s\",\"fetched_at\":\"%s\",\"echo_cells\":8587,\"stations\":2,\"station_ids\":[\"KSN\",\"GDK\"],"
                + "\"stations_ref\":3,\"partial\":true,\"refetches\":0,\"upgrades\":0,\"refetch_until\":\"2026-09-29T06:10:00Z\"},"
                + "{\"tm\":\"%s\",\"obs_tm\":\"%s\",\"fetched_at\":\"%s\",\"echo_cells\":38000,\"stations\":3,\"station_ids\":[\"KSN\",\"GDK\",\"JNI\"],"
                + "\"stations_ref\":3,\"partial\":false,\"refetches\":0,\"upgrades\":0}]").formatted(t1, t1, f1, t2, t2, f2);
        String upgraded = partial.replace("\"fetched_at\":\"" + f1 + "\",\"echo_cells\":8587,\"stations\":2,\"station_ids\":[\"KSN\",\"GDK\"]",
                        "\"fetched_at\":\"" + again + "\",\"echo_cells\":42275,\"stations\":3,\"station_ids\":[\"KSN\",\"GDK\",\"BRI\"]")
                .replace("\"partial\":true,\"refetches\":0,\"upgrades\":0", "\"partial\":false,\"refetches\":1,\"upgrades\":1,\"refetched_at\":\"" + again + "\"");
        try {
            for (String tm : List.of(t1, t2)) ItStack.collector().opsForValue().set("wakeline:radar_kr:frame:" + tm, PNG_1X1);
            ItStack.hset(ItStack.collector(), "wakeline:radar_kr:meta", meta(f2.toString(), t2));
            ItStack.collector().opsForValue().set("wakeline:radar_kr:frames", partial);
            Res r = get("/api/v1/radar/kr");
            JsonNode body = r.json();
            JsonNode first = body.path("frames").get(0);
            assertThat(first.path("stations").asInt()).isEqualTo(2);
            assertThat(first.path("station_ids").toString()).isEqualTo("[\"KSN\",\"GDK\"]");
            assertThat(first.path("stations_ref").asInt()).isEqualTo(3);
            assertThat(first.path("partial").asBoolean()).isTrue();
            assertThat(first.path("refetch_until").asString()).isEqualTo("2026-09-29T06:10:00Z");
            assertThat(first.path("url").asString()).isEqualTo("/api/v1/radar/kr/" + t1 + ".png?v=" + f1.toEpochMilli());
            // 최상위 = 최신 프레임(목록의 마지막)
            assertThat(body.path("stations").asInt()).isEqualTo(3);
            assertThat(body.path("partial").asBoolean(true)).isFalse();
            assertThat(body.path("station_ids").size()).isEqualTo(3);

            ItStack.collector().opsForValue().set("wakeline:radar_kr:frames", upgraded); // 14:40 을 다시 받아 3곳 — tm 목록은 같다
            Res after = get("/api/v1/radar/kr", headers("If-None-Match", r.header("ETag")));
            assertThat(after.status()).as("same tm list, different frames — not 304").isEqualTo(200);
            JsonNode up = after.json().path("frames").get(0);
            assertThat(up.path("stations").asInt()).isEqualTo(3);
            assertThat(up.path("partial").asBoolean(true)).isFalse();
            assertThat(up.path("upgrades").asInt()).isEqualTo(1);
            assertThat(up.path("url").asString()).isEqualTo("/api/v1/radar/kr/" + t1 + ".png?v=" + again.toEpochMilli());
            assertThat(get(up.path("url").asString()).header("Content-Type")).isEqualTo("image/png"); // 버전 쿼리는 영상 응답을 바꾸지 않는다
        } finally {
            ItStack.deleteKeys("wakeline:radar_kr:*");
        }
    }
}
