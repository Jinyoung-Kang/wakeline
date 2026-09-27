package dev.wakeline.it;

import dev.wakeline.domain.Alert;
import dev.wakeline.engine.EngineService;
import dev.wakeline.ingest.RadarStore;
import dev.wakeline.ingest.SchemaValidator;
import dev.wakeline.ingest.SigmetStore;
import dev.wakeline.ingest.SnapshotStore;
import dev.wakeline.ingest.StreamConsumer;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.connection.stream.StreamReadOptions;
import org.springframework.data.redis.core.StringRedisTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 수집 경로(5.3절·NFR-08)를 실제 Redis Streams·실제 DB 로: XADD(수집기 ACL 사용자) → 소비 → 스냅샷 → REST(meta 포함),
 * 잘못된 메시지 → wakeline:dlq(+ACK), 재시작 안전성(ACK 전 PEL 메시지는 소비자 재시작 뒤 재처리), 중복 처리(재전달·중복 발행)가
 * 항적 행·알림을 늘리지 않음.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class IngestIT extends IntegrationTest {
    static final Duration WAIT = Duration.ofSeconds(15);

    @Autowired SnapshotStore snapshots;
    @Autowired SigmetStore sigmets;
    @Autowired RadarStore radar;
    @Autowired EngineService engine;
    @Autowired StreamConsumer consumer;
    @Autowired SchemaValidator validator;
    @Autowired ApplicationEventPublisher publisher;
    @Autowired ObjectMapper mapper;
    @Autowired MeterRegistry meters;
    @Autowired @Qualifier("streamRedisTemplate") StringRedisTemplate streamRedis;

    long pending() {
        var p = ItStack.admin().opsForStream().pending(Streams.AIRCRAFT, StreamConsumer.GROUP);
        return p == null ? 0 : p.getTotalPendingMessages();
    }

    double counter(String name, String tag, String value) {
        var c = meters.find(name).tag(tag, value).counter();
        return c == null ? 0 : c.count();
    }

    long trackRows(String hex) { return count("SELECT count(*) FROM track_point WHERE hex = ?", hex); }

    // ---------- 정상 경로 ----------

    @Test
    void validEnvelopeReachesTheSnapshotAndRestWithMeta() {
        String hex = "a1b001";
        Instant fetched = Streams.nextFetchedAt();
        Instant seen = fetched.minusSeconds(2);
        Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("region", fetched, List.of(Streams.state(hex, 37.45, 126.44, 32000, seen, fetched))));
        await("snapshot has " + hex, WAIT, () -> snapshots.find(hex) != null);

        Res r = get("/api/v1/aircraft?bbox=126,37,127,38");
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.header("Content-Type")).startsWith("application/geo+json");
        assertThat(r.header("Cache-Control")).contains("public").contains("max-age=5");
        String etag = r.header("ETag");
        assertThat(etag).isNotBlank();
        JsonNode fc = r.json();
        assertThat(fc.path("type").asString()).isEqualTo("FeatureCollection");
        JsonNode feature = null;
        for (JsonNode f : fc.path("features")) if (hex.equals(f.path("id").asString())) feature = f;
        assertThat(feature).as("feature for " + hex).isNotNull();
        JsonNode p = feature.path("properties");
        assertThat(p.path("hex").asString()).isEqualTo(hex);
        assertThat(p.path("alt_ft").asInt()).isEqualTo(32000);
        assertThat(Instant.parse(p.path("seen_at").asString())).isEqualTo(seen);
        assertThat(p.path("provider").asString()).isEqualTo("fixture");
        assertThat(feature.path("geometry").path("coordinates").get(0).asDouble()).isEqualTo(126.44);
        JsonNode meta = fc.path("meta");
        JsonNode region = meta.path("sources").path("region");
        assertThat(region.path("provider").asString()).isEqualTo("fixture");
        assertThat(Instant.parse(region.path("fetched_at").asString())).isEqualTo(fetched);
        assertThat(region.path("stale").asBoolean()).isFalse();
        assertThat(region.path("lag_s").asDouble()).isGreaterThanOrEqualTo(0);
        assertThat(meta.path("sources").has("global")).isTrue();
        assertThat(meta.path("request_id").asString()).isEqualTo(r.header("X-Request-Id"));
        // 같은 버전이면 304
        assertThat(get("/api/v1/aircraft?bbox=126,37,127,38", headers("If-None-Match", etag)).status()).isEqualTo(304);

        // 상세: 실시간 상태(메모리) + 정적 정보(DB — 쓰기 스레드가 저장한 뒤)
        await("aircraft static row", WAIT, () -> count("SELECT count(*) FROM aircraft WHERE hex = ?", hex) == 1);
        JsonNode detail = get("/api/v1/aircraft/" + hex).json();
        assertThat(detail.path("state").path("hex").asString()).isEqualTo(hex);
        assertThat(detail.path("state").path("registration").asString()).isEqualTo("HL001");
        assertThat(detail.path("static").path("registration").asString()).isEqualTo("HL001");
        assertThat(detail.path("meta").has("db_unavailable")).isFalse();
        // 항적 저장 → 항적 API
        await("track row", WAIT, () -> trackRows(hex) == 1);
        JsonNode track = get("/api/v1/aircraft/" + hex + "/track").json();
        assertThat(track.path("properties").path("points").asInt()).isEqualTo(1);
        // 검색(병합 스냅샷, 호출부호 앞부분)
        JsonNode search = get("/api/v1/aircraft/search?q=ITB001").json();
        assertThat(search.path("items").get(0).path("hex").asString()).isEqualTo(hex);
        assertThat(search.path("items").get(0).path("live").asBoolean()).isTrue();
    }

    // ---------- 잘못된 메시지 → DLQ ----------

    @Test
    void invalidMessagesGoToTheDeadLetterStreamAndAreAcknowledged() {
        long dlqBefore = ItStack.admin().opsForStream().size(Streams.DLQ);
        double rejectedBefore = counter("wakeline_stream_messages_total", "result", "rejected");
        Instant fetched = Streams.nextFetchedAt();

        // 1) payload 스키마 위반(hex 형식)
        String badHex = Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("region", fetched,
                List.of(Streams.state("a1b0zz", 37.4, 126.5, 30000, fetched, fetched))));
        // 2) envelope 필수 필드 없음
        Map<String, String> noFetched = new HashMap<>(Streams.aircraft("region", Streams.nextFetchedAt(), List.of()));
        noFetched.remove("fetched_at");
        String badEnvelope = Streams.xadd(Streams.AIRCRAFT, noFetched);
        // 3) gzip 이 아닌 payload
        Map<String, String> notGzip = new HashMap<>(Streams.aircraft("region", Streams.nextFetchedAt(), List.of()));
        notGzip.put("payload", java.util.Base64.getEncoder().encodeToString("{\"states\":[]}".getBytes()));
        String badGzip = Streams.xadd(Streams.AIRCRAFT, notGzip);

        await("3 DLQ entries", WAIT, () -> ItStack.admin().opsForStream().size(Streams.DLQ) >= dlqBefore + 3);
        await("acknowledged", WAIT, () -> pending() == 0);
        List<MapRecord<String, Object, Object>> dlq = ItStack.admin().opsForStream().reverseRange(Streams.DLQ, Range.unbounded(),
                org.springframework.data.redis.connection.Limit.limit().count(3));
        Map<String, Map<Object, Object>> bySource = new HashMap<>();
        for (var e : dlq) bySource.put(String.valueOf(e.getValue().get("source_id")), e.getValue());
        assertThat(bySource).containsKeys(badHex, badEnvelope, badGzip);
        assertThat(String.valueOf(bySource.get(badHex).get("reason"))).startsWith("payload:");
        assertThat(String.valueOf(bySource.get(badEnvelope).get("reason"))).startsWith("envelope:");
        assertThat(String.valueOf(bySource.get(badGzip).get("reason"))).isNotBlank();
        for (var m : bySource.values()) {
            assertThat(m.get("source_stream")).isEqualTo(Streams.AIRCRAFT);
            assertThat(m).containsKey("at").doesNotContainKey("payload"); // 원문 전체는 싣지 않는다(앞 200자만)
            assertThat(String.valueOf(m.get("payload_head")).length()).isLessThanOrEqualTo(200);
        }
        assertThat(counter("wakeline_stream_messages_total", "result", "rejected")).isEqualTo(rejectedBefore + 3);
        assertThat(snapshots.find("a1b0zz")).isNull();
    }

    // ---------- NFR-08 재시작 안전성 ----------

    /** '이전 프로세스'가 읽고 ACK 전에 죽었다: api-1 의 PEL 에 남긴다. */
    List<MapRecord<String, Object, Object>> readWithoutAck() {
        return ItStack.apiUser().opsForStream().read(Consumer.from(StreamConsumer.GROUP, StreamConsumer.CONSUMER),
                StreamReadOptions.empty().count(10), StreamOffset.create(Streams.AIRCRAFT, ReadOffset.lastConsumed()));
    }

    @Test
    void pendingMessageIsReprocessedAfterAConsumerRestart() {
        String hex = "a1b002";
        consumer.stop();
        try {
            Instant fetched = Streams.nextFetchedAt();
            String id = Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("region", fetched, List.of(Streams.state(hex, 37.3, 126.5, 28000, fetched.minusSeconds(1), fetched))));
            var read = readWithoutAck();
            assertThat(read).extracting(r -> r.getId().getValue()).containsExactly(id);
            assertThat(pending()).isEqualTo(1);
            assertThat(snapshots.find(hex)).as("not applied before the crash").isNull();
        } finally {
            consumer.start();
        }
        await("pending message re-processed", WAIT, () -> snapshots.find(hex) != null);
        await("and acknowledged", WAIT, () -> pending() == 0);
        assertThat(get("/api/v1/aircraft/" + hex).status()).isEqualTo(200);
    }

    @Test
    void redeliveryAndDuplicatePublishDoNotDuplicateTrackRowsOrAlerts() {
        String hex = "a1b003";
        String sigmetId = "RKRR:IT-DUP:" + System.currentTimeMillis();
        Instant fs = Streams.nextFetchedAt();
        Streams.xadd(Streams.SIGMET, Streams.sigmets(fs, List.of(Streams.sigmet(sigmetId, 126.8, 37.0, 127.6, 37.8, 0, 45000, fs))));
        await("sigmet indexed", WAIT, () -> sigmets.get(sigmetId) != null);

        // 1번째 관측(안쪽) — 확정 전
        Instant f1 = Streams.nextFetchedAt();
        Instant t1 = f1.minusSeconds(4);
        Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("region", f1, List.of(Streams.state(hex, 37.40, 127.20, 30000, t1, f1))));
        await("first observation applied", WAIT, () -> snapshots.find(hex) != null && snapshots.find(hex).seenAt().equals(t1));
        assertThat(count("SELECT count(*) FROM alert_event WHERE hex = ? AND kind = 'OBSERVED'", hex)).isZero();

        // 2번째 관측을 '이전 프로세스'가 읽고(PEL) 죽었다
        consumer.stop();
        StreamConsumer restarted = null;
        Map<String, String> second;
        double writtenBefore = counter("wakeline_track_rows_total", "result", "written");
        double failedBefore = counter("wakeline_track_rows_total", "result", "failed");
        double staleBefore = counter("wakeline_stream_messages_total", "result", "stale_skipped");
        try {
            Instant f2 = Streams.nextFetchedAt();
            Instant t2 = f2.minusSeconds(2);
            second = Streams.aircraft("region", f2, List.of(Streams.state(hex, 37.42, 127.24, 30000, t2, f2)));
            String id2 = Streams.xadd(Streams.AIRCRAFT, second);
            assertThat(readWithoutAck()).extracting(r -> r.getId().getValue()).containsExactly(id2);

            // 새 프로세스: 부트스트랩이 마지막 엔트리(=그 메시지)를 적용하고, PEL 재처리가 같은 메시지를 한 번 더 처리한다
            restarted = new StreamConsumer(streamRedis, validator, snapshots, sigmets, radar, publisher, mapper, meters);
            restarted.start();
            await("PEL drained", WAIT, () -> pending() == 0);
            await("second observation applied", WAIT, () -> snapshots.find(hex).seenAt().equals(t2));
        } finally {
            if (restarted != null) restarted.stop();
            consumer.start();
        }
        assertThat(counter("wakeline_stream_messages_total", "result", "stale_skipped")).as("duplicate treated as backlog").isGreaterThan(staleBefore);
        await("ENTERED persisted", WAIT, () -> count("SELECT count(*) FROM alert_event WHERE hex = ? AND kind = 'OBSERVED'", hex) == 1);
        // 3행(1번째 + 2번째 + 재처리된 2번째)을 썼지만 (hex, ts) 충돌은 무시된다
        await("track batches written", WAIT, () -> counter("wakeline_track_rows_total", "result", "written") >= writtenBefore + 2);

        // 수집기 쪽 중복 발행(같은 필드를 한 번 더 XADD) — 새 스트림 id, 같은 내용
        long regionVersion = snapshots.region().version();
        double written2 = counter("wakeline_track_rows_total", "result", "written");
        String dupId = Streams.xadd(Streams.AIRCRAFT, second);
        await("duplicate consumed", WAIT, () -> pending() == 0 && compareIds(lastDelivered(), dupId) >= 0);
        await("duplicate rows attempted", WAIT, () -> counter("wakeline_track_rows_total", "result", "written") >= written2 + 1);

        assertThat(snapshots.region().version()).as("duplicate does not replace the snapshot").isEqualTo(regionVersion);
        assertThat(trackRows(hex)).as("one row per observation").isEqualTo(2);
        // 중복은 PK 오류로 배치를 버린 것이 아니라 ON CONFLICT DO NOTHING 으로 조용히 흡수됐다
        assertThat(counter("wakeline_track_rows_total", "result", "failed")).isEqualTo(failedBefore);
        List<Alert> open = engine.activeAlerts("OBSERVED").stream().filter(a -> a.hex().equals(hex)).toList();
        assertThat(open).hasSize(1);
        assertThat(open.getFirst().sigmetId()).isEqualTo(sigmetId);
        assertThat(open.getFirst().evidence().get("confirmations")).isEqualTo(2);
        assertThat(count("SELECT count(*) FROM alert_event WHERE hex = ? AND kind = 'OBSERVED'", hex)).isEqualTo(1);
        // REST 로도: 활성 알림 1건, 근거 포함
        JsonNode alerts = get("/api/v1/alerts?kind=OBSERVED").json();
        int n = 0;
        for (JsonNode a : alerts.path("items")) if (hex.equals(a.path("hex").asString())) {
            n++;
            assertThat(a.path("sigmet_id").asString()).isEqualTo(sigmetId);
            assertThat(a.path("evidence").path("method").asString()).isNotBlank();
            assertThat(a.path("estimated").asBoolean()).isFalse();
        }
        assertThat(n).isEqualTo(1);
    }

    /** 스트림 id(ms-seq) 비교 — 문자열 비교는 자릿수가 다르면 틀린다. */
    static int compareIds(String a, String b) {
        String[] x = a.split("-"), y = b.split("-");
        int c = Long.compare(Long.parseLong(x[0]), Long.parseLong(y[0]));
        return c != 0 ? c : Long.compare(Long.parseLong(x[1]), Long.parseLong(y[1]));
    }

    String lastDelivered() {
        var groups = ItStack.admin().opsForStream().groups(Streams.AIRCRAFT);
        for (var g : groups) if (StreamConsumer.GROUP.equals(g.groupName())) return g.lastDeliveredId();
        return "0-0";
    }

    // ---------- Redis ACL(계약 §6) ----------

    /** 예외 사슬 어딘가에 Redis 의 NOPERM 응답이 있다(Spring 이 바깥 메시지를 'Error in execution' 으로 감싼다). */
    static void assertNoPerm(org.assertj.core.api.ThrowableAssert.ThrowingCallable call) {
        assertThatThrownBy(call).satisfies(e -> {
            StringBuilder sb = new StringBuilder();
            for (Throwable t = e; t != null; t = t.getCause() == t ? null : t.getCause()) sb.append(t.getMessage()).append(" | ");
            assertThat(sb.toString()).contains("NOPERM");
        });
    }

    @Test
    void apiUsesItsOwnAclUserAndTheCollectorUserCannotTouchApiKeys() {
        assertThat(ItStack.whoami(ItStack.admin())).isEqualTo("default");
        assertThat(ItStack.whoami(ItStack.collector())).isEqualTo("wakeline_collector");
        assertThat(ItStack.whoami(streamRedis)).as("api stream connection").isEqualTo("wakeline_api");
        String clients = ItStack.admin().execute((org.springframework.data.redis.core.RedisCallback<String>) c -> {
            Object r = c.execute("CLIENT", "LIST".getBytes());
            return r instanceof byte[] b ? new String(b) : String.valueOf(r);
        });
        long apiConns = clients.lines().filter(l -> l.contains(" user=wakeline_api ")).count();
        assertThat(apiConns).as("api connections under ACL user wakeline_api").isGreaterThanOrEqualTo(2);
        // 수집기 사용자: 세션·요청 제한·DLQ 키와 소비자 그룹 명령은 거부(NOPERM)
        StringRedisTemplate col = ItStack.collector();
        assertNoPerm(() -> col.opsForValue().get("wakeline:session:sessions:x"));
        assertNoPerm(() -> col.opsForValue().get("rl:api:127.0.0.1:1"));
        assertNoPerm(() -> col.opsForStream().size(Streams.DLQ));
        assertNoPerm(() -> col.opsForStream().acknowledge(Streams.AIRCRAFT, StreamConsumer.GROUP, "0-1"));
        // api 사용자: 자기 이름공간 밖의 키·위험 명령 거부
        StringRedisTemplate api = ItStack.apiUser();
        assertNoPerm(() -> api.opsForValue().get("budget:adsb_lol"));
        assertNoPerm(() -> api.keys("*"));
    }
}
