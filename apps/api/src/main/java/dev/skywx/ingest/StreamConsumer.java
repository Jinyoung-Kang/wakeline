package dev.skywx.ingest;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.SigmetRecord;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.SmartLifecycle;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.Limit;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.connection.stream.StreamReadOptions;
import org.springframework.data.redis.core.StreamOperations;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/**
 * XREADGROUP 소비자(그룹 api, 소비자 1개). 처리 순서: 스키마 검증 → 스냅샷 교체(참조) → 이벤트 → XACK.
 * XACK 는 처리 후에만 하므로 api 가 죽어도 메시지는 PEL 에 남아 재처리된다(at-least-once, 5.3절).
 * 재시작 시 각 스트림의 마지막 엔트리로 상태를 먼저 복원한다(≤ 60 s 복귀).
 */
@org.springframework.context.annotation.Profile("!cli")  // --create-ops-user CLI 에서는 웹·소비자·잡을 띄우지 않는다
@Component
public class StreamConsumer implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(StreamConsumer.class);
    public static final String GROUP = "api";
    public static final String CONSUMER = "api-1";
    public static final String S_AIRCRAFT = "skywx:aircraft";
    public static final String S_SIGMET = "skywx:sigmet";
    public static final String S_RADAR = "skywx:radar";
    public static final String S_DLQ = "skywx:dlq";
    private static final List<String> STREAMS = List.of(S_AIRCRAFT, S_SIGMET, S_RADAR);

    private final StringRedisTemplate redis;
    private final SchemaValidator validator;
    private final SnapshotStore snapshots;
    private final SigmetStore sigmets;
    private final RadarStore radar;
    private final ApplicationEventPublisher events;
    private final ObjectMapper mapper;
    private final Counter processed;
    private final Counter rejected;
    private final Timer processTimer;
    private volatile boolean running;
    private Thread worker;

    public StreamConsumer(@Qualifier("streamRedisTemplate") StringRedisTemplate redis, SchemaValidator validator, SnapshotStore snapshots,
                          SigmetStore sigmets, RadarStore radar, ApplicationEventPublisher events, ObjectMapper mapper, MeterRegistry meters) {
        this.redis = redis;
        this.validator = validator;
        this.snapshots = snapshots;
        this.sigmets = sigmets;
        this.radar = radar;
        this.events = events;
        this.mapper = mapper;
        this.processed = Counter.builder("skywx_stream_messages_total").tag("result", "ok").register(meters);
        this.rejected = Counter.builder("skywx_stream_messages_total").tag("result", "rejected").register(meters);
        this.processTimer = Timer.builder("skywx_stream_process_seconds").publishPercentiles(0.5, 0.95).register(meters);
    }

    @Override
    public void start() {
        running = true;
        worker = Thread.ofVirtual().name("stream-consumer").start(this::loop);
    }

    @Override
    public void stop() {
        running = false;
        if (worker != null) worker.interrupt();
    }

    @Override
    public boolean isRunning() { return running; }

    @Override
    public int getPhase() { return Integer.MAX_VALUE - 10; }

    private StreamOperations<String, String, String> ops() { return redis.opsForStream(); }

    private void loop() {
        while (running) {
            try {
                ensureGroups();
                bootstrapFromLastEntries();
                drainPending();
                consume();
            } catch (Exception e) {
                if (!running) return;
                log.warn("stream consumer error: {} — retry in 3 s", e.toString());
                sleep(3000);
            }
        }
    }

    private void ensureGroups() {
        for (String s : STREAMS) {
            try {
                redis.execute((org.springframework.data.redis.core.RedisCallback<Object>) conn -> {
                    conn.streamCommands().xGroupCreate(s.getBytes(StandardCharsets.UTF_8), GROUP, ReadOffset.latest(), true);
                    return null;
                });
                log.info("created consumer group {} on {}", GROUP, s);
            } catch (Exception e) {
                if (!String.valueOf(e.getMessage()).contains("BUSYGROUP") && !String.valueOf(e.getCause()).contains("BUSYGROUP"))
                    throw e;
            }
        }
    }

    /** 재시작 복구: 스트림별 마지막 엔트리를 처리해 메모리 상태를 되살린다(ACK 대상 아님). */
    private void bootstrapFromLastEntries() {
        for (String s : STREAMS) {
            List<MapRecord<String, String, String>> last = ops().reverseRange(s, Range.unbounded(), Limit.limit().count(1));
            if (last != null) for (MapRecord<String, String, String> r : last) {
                try { process(r, false); } catch (Exception e) { log.warn("bootstrap {} failed: {}", s, e.toString()); }
            }
        }
        log.info("bootstrap done: region={} global={} sigmets={} radar={}", snapshots.region().states().size(),
                snapshots.global().states().size(), sigmets.state().byId().size(), radar.frames().past().size());
    }

    /** 직전 실행에서 ACK 하지 못한 PEL 메시지(at-least-once) 재처리. */
    private void drainPending() {
        StreamOffset<String>[] offsets = STREAMS.stream().map(s -> StreamOffset.create(s, ReadOffset.from("0"))).toArray(StreamOffset[]::new);
        List<MapRecord<String, String, String>> recs = ops().read(Consumer.from(GROUP, CONSUMER), StreamReadOptions.empty().count(50), offsets);
        if (recs != null && !recs.isEmpty()) {
            log.info("re-processing {} pending messages", recs.size());
            for (MapRecord<String, String, String> r : recs) handle(r);
        }
    }

    private void consume() {
        StreamOffset<String>[] offsets = STREAMS.stream().map(s -> StreamOffset.create(s, ReadOffset.lastConsumed())).toArray(StreamOffset[]::new);
        StreamReadOptions opts = StreamReadOptions.empty().block(Duration.ofSeconds(2)).count(10);
        Consumer consumer = Consumer.from(GROUP, CONSUMER);
        while (running) {
            List<MapRecord<String, String, String>> recs = ops().read(consumer, opts, offsets);
            if (recs == null) continue;
            for (MapRecord<String, String, String> r : recs) handle(r);
        }
    }

    private void handle(MapRecord<String, String, String> r) {
        try {
            process(r, true);
            processed.increment();
        } catch (Exception e) {
            rejected.increment();
            deadLetter(r, e.getMessage());
        } finally {
            ops().acknowledge(r.getStream(), GROUP, r.getId());
        }
    }

    void process(MapRecord<String, String, String> r, boolean live) throws IOException {
        long t0 = System.nanoTime();
        Map<String, String> f = r.getValue();
        String envelopeJson = mapper.writeValueAsString(f);
        String err = validator.validateEnvelope(envelopeJson);
        if (err != null) throw new IllegalArgumentException("envelope: " + err);
        String kind = f.get("kind");
        String payloadJson = decode(f.get("payload"));
        err = validator.validatePayload(kind, payloadJson);
        if (err != null) throw new IllegalArgumentException("payload: " + err);
        JsonNode payload = mapper.readTree(payloadJson);
        Instant fetchedAt = Instant.parse(f.get("fetched_at"));
        switch (kind) {
            case "aircraft" -> aircraft(f, payload, fetchedAt);
            case "sigmet" -> sigmet(f, payload, fetchedAt);
            case "radar" -> radar(f, payload, fetchedAt);
            default -> throw new IllegalArgumentException("unknown kind " + kind);
        }
        processTimer.record(Duration.ofNanos(System.nanoTime() - t0));
    }

    private void aircraft(Map<String, String> f, JsonNode payload, Instant fetchedAt) {
        String scope = f.get("scope");
        Map<String, AircraftState> states = new HashMap<>();
        for (JsonNode n : payload.path("states")) {
            AircraftState s = Codec.aircraft(n);
            states.put(s.hex(), s);
        }
        Snapshot snap = new Snapshot(snapshots.nextVersion(), scope, f.get("provider"), fetchedAt, Instant.now(), f.get("raw_ref"), Map.copyOf(states));
        Snapshot prev = snapshots.replace(snap);
        events.publishEvent(new IngestEvents.SnapshotUpdated(prev, snap));
    }

    private void sigmet(Map<String, String> f, JsonNode payload, Instant fetchedAt) {
        Map<String, SigmetRecord> byId = new LinkedHashMap<>();
        for (JsonNode n : payload.path("sigmets")) {
            SigmetRecord s = Codec.sigmet(n);
            byId.put(s.id(), s);
        }
        SigmetStore.State st = sigmets.replace(fetchedAt, f.get("provider"), Map.copyOf(byId));
        events.publishEvent(new IngestEvents.SigmetsUpdated(st));
    }

    private void radar(Map<String, String> f, JsonNode payload, Instant fetchedAt) {
        List<RadarStore.Frame> past = new java.util.ArrayList<>();
        for (JsonNode n : payload.path("past")) past.add(new RadarStore.Frame(n.path("time").asLong(), n.path("path").asString()));
        RadarStore.Frames fr = new RadarStore.Frames(payload.path("host").asString(), payload.path("generated").asLong(), List.copyOf(past), fetchedAt, f.get("provider"));
        radar.replace(fr);
        events.publishEvent(new IngestEvents.RadarUpdated(fr));
    }

    private void deadLetter(MapRecord<String, String, String> r, String reason) {
        try {
            Map<String, String> m = new HashMap<>(r.getValue());
            String payload = m.remove("payload");
            m.put("payload_head", payload == null ? "" : payload.substring(0, Math.min(200, payload.length())));
            m.put("source_stream", r.getStream());
            m.put("source_id", r.getId().getValue());
            m.put("reason", reason == null ? "unknown" : reason.substring(0, Math.min(500, reason.length())));
            m.put("at", Instant.now().toString());
            ops().add(MapRecord.create(S_DLQ, m));
            ops().trim(S_DLQ, 500, true);
            log.warn("message {} from {} moved to DLQ: {}", r.getId(), r.getStream(), reason);
        } catch (Exception e) {
            log.error("DLQ write failed: {}", e.toString());
        }
    }

    static String decode(String b64) throws IOException {
        byte[] gz = Base64.getDecoder().decode(b64);
        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(gz))) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
    }
}
