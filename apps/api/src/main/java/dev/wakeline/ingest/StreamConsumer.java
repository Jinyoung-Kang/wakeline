package dev.wakeline.ingest;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.SigmetRecord;
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
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/**
 * XREADGROUP 소비자(그룹 api, 소비자 1개). 처리 순서: 스키마 검증 → 스냅샷 교체(참조) → 이벤트 → XACK.
 * XACK 는 처리 후에만 하므로 api 가 죽어도 메시지는 PEL 에 남아 재처리된다(at-least-once, 5.3절).
 * 재시작 시 각 스트림의 마지막 엔트리(항공기는 스코프별 마지막 엔트리)로 상태를 먼저 복원한다(≤ 60 s 복귀).
 * 스냅샷·SIGMET·레이더는 '최신만 의미' — fetched_at 이 현재보다 새 것만 반영한다(백로그 재생이 화면·엔진을 과거로 되돌리지 않게).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 웹·소비자·잡을 띄우지 않는다
@Component
public class StreamConsumer implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(StreamConsumer.class);
    public static final String GROUP = "api";
    public static final String CONSUMER = "api-1";
    public static final String S_AIRCRAFT = "wakeline:aircraft";
    public static final String S_SIGMET = "wakeline:sigmet";
    public static final String S_RADAR = "wakeline:radar";
    public static final String S_DLQ = "wakeline:dlq";
    private static final List<String> STREAMS = List.of(S_AIRCRAFT, S_SIGMET, S_RADAR);
    /** 부트스트랩: 항공기 스트림에서 스코프별 최신 엔트리를 찾을 때 한 번에 읽는 수·최대 스캔 수(MAXLEN ~200). */
    static final int BOOTSTRAP_PAGE = 50;
    static final int BOOTSTRAP_SCAN_MAX = 1_000;
    /** global 을 먼저 적용하고 region 을 나중에(병합 뷰에서 관심 지역이 우선). */
    static final List<String> AIRCRAFT_SCOPES = List.of("global", "region");

    private final StringRedisTemplate redis;
    private final SchemaValidator validator;
    private final SnapshotStore snapshots;
    private final SigmetStore sigmets;
    private final RadarStore radar;
    private final ApplicationEventPublisher events;
    private final ObjectMapper mapper;
    private final Counter processed;
    private final Counter rejected;
    private final Counter staleSkipped;
    private final Timer processTimer;
    private volatile boolean running;
    /** 부트스트랩은 프로세스 시작마다 한 번(재시도 루프마다 다시 하면 복원한 최신 상태 뒤로 밀린 엔트리가 이어진다). */
    private volatile boolean bootstrapped;
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
        this.processed = Counter.builder("wakeline_stream_messages_total").tag("result", "ok").register(meters);
        this.rejected = Counter.builder("wakeline_stream_messages_total").tag("result", "rejected").register(meters);
        this.staleSkipped = Counter.builder("wakeline_stream_messages_total").tag("result", "stale_skipped").register(meters);
        this.processTimer = Timer.builder("wakeline_stream_process_seconds").publishPercentiles(0.5, 0.95).register(meters);
    }

    @Override
    public void start() {
        running = true;
        worker = Thread.ofVirtual().name("stream-consumer").start(this::loop);
    }

    /**
     * 종료 1단계(가장 높은 phase): 새 메시지를 더 받지 않는다. 처리 중인 메시지는 끝내게 두고(XREADGROUP BLOCK 2 s) 스레드가 끝날 때까지
     * 기다린다 — 그 뒤 단계(WS going_away → 항적·알림 flush)가 '더 들어올 것이 없는' 상태에서 돈다(REL-15).
     * 처리 중에 끊지 않으므로 ACK 된 메시지의 항적은 flush 대상에 이미 들어가 있다.
     */
    @Override
    public void stop() {
        running = false;
        Thread w = worker;
        if (w == null) return;
        try {
            w.join(Duration.ofSeconds(3));
            if (w.isAlive()) {
                w.interrupt(); // BLOCK 대기가 길어진 경우(Redis 지연)만 깨운다
                w.join(Duration.ofSeconds(2));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (w.isAlive()) log.warn("stream consumer did not stop within 5 s");
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
                if (!bootstrapped) {
                    bootstrapFromLastEntries();
                    bootstrapped = true;
                }
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

    /**
     * 재시작 복구: 메모리 상태를 되살린다(ACK 대상 아님).
     * region·global 은 한 스트림(wakeline:aircraft)을 공유하므로(global 1건당 region ~12건) 끝에서부터 거꾸로 훑어
     * 스코프마다 가장 최근 엔트리를 찾아 global → region 순으로 적용한다(REL-7). SIGMET·레이더는 마지막 1건.
     */
    private void bootstrapFromLastEntries() {
        Map<String, MapRecord<String, String, String>> newest = newestPerScope(this::aircraftPage, AIRCRAFT_SCOPES, BOOTSTRAP_SCAN_MAX);
        for (String scope : AIRCRAFT_SCOPES) {
            MapRecord<String, String, String> r = newest.get(scope);
            if (r == null) continue;
            try { process(r, false); } catch (Exception e) { log.warn("bootstrap {}/{} failed: {}", S_AIRCRAFT, scope, e.toString()); }
        }
        for (String s : List.of(S_SIGMET, S_RADAR)) {
            List<MapRecord<String, String, String>> last = ops().reverseRange(s, Range.unbounded(), Limit.limit().count(1));
            if (last != null) for (MapRecord<String, String, String> r : last) {
                try { process(r, false); } catch (Exception e) { log.warn("bootstrap {} failed: {}", s, e.toString()); }
            }
        }
        log.info("bootstrap done: region={} global={} sigmets={} radar={}", snapshots.region().states().size(),
                snapshots.global().states().size(), sigmets.state().byId().size(), radar.frames().past().size());
    }

    /** 최신 → 과거 순 한 페이지. upperInclusive 가 null 이면 스트림 끝에서부터. */
    @FunctionalInterface
    interface PageReader {
        List<MapRecord<String, String, String>> page(String upperInclusive, int count);
    }

    private List<MapRecord<String, String, String>> aircraftPage(String upperInclusive, int count) {
        Range<String> range = upperInclusive == null ? Range.unbounded()
                : Range.of(Range.Bound.unbounded(), Range.Bound.inclusive(upperInclusive));
        return ops().reverseRange(S_AIRCRAFT, range, Limit.limit().count(count));
    }

    /**
     * 최신 → 과거로 페이지를 넘기며 scope 필드마다 처음 만난(= 가장 최근) 엔트리를 고른다. 모든 스코프를 찾거나
     * 스트림 끝·maxScan 에 닿으면 멈춘다. 경계 id 는 포함(inclusive)으로 다시 읽으므로 이미 본 엔트리는 건너뛴다.
     */
    static Map<String, MapRecord<String, String, String>> newestPerScope(PageReader reader, Collection<String> scopes, int maxScan) {
        Map<String, MapRecord<String, String, String>> found = new HashMap<>();
        String upper = null;
        int scanned = 0;
        while (found.size() < scopes.size() && scanned < maxScan) {
            List<MapRecord<String, String, String>> page = reader.page(upper, BOOTSTRAP_PAGE);
            if (page == null || page.isEmpty()) break;
            boolean progressed = false;
            for (MapRecord<String, String, String> r : page) {
                if (upper != null && upper.equals(r.getId().getValue())) continue;
                progressed = true;
                scanned++;
                String scope = r.getValue().get("scope");
                if (scope != null && scopes.contains(scope)) found.putIfAbsent(scope, r);
            }
            if (!progressed) break;
            upper = page.getLast().getId().getValue();
        }
        return found;
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
        // fetched_at 단조 가드(REL-8): 같은 스코프의 현재 스냅샷보다 새 것이 아니면 백로그 — 실시간 상태·엔진·WS 는 그대로 두고
        // 항적 기록만 이어서 한다(at-least-once). 버전 번호도 쓰지 않는다.
        if (!fetchedAt.isAfter(snapshots.current(scope).fetchedAt())) {
            backlog(scope, fetchedAt, states);
            return;
        }
        Snapshot snap = new Snapshot(snapshots.nextVersion(), scope, f.get("provider"), fetchedAt, Instant.now(), f.get("raw_ref"), Map.copyOf(states));
        Snapshot prev = snapshots.replaceIfNewer(snap);
        if (prev == null) {
            backlog(scope, fetchedAt, states);
            return;
        }
        events.publishEvent(new IngestEvents.SnapshotUpdated(prev, snap));
    }

    private void backlog(String scope, Instant fetchedAt, Map<String, AircraftState> states) {
        staleSkipped.increment();
        log.debug("aircraft/{} entry fetched_at={} is not newer than the current snapshot — history only", scope, fetchedAt);
        events.publishEvent(new IngestEvents.AircraftBacklog(scope, fetchedAt, List.copyOf(states.values())));
    }

    private void sigmet(Map<String, String> f, JsonNode payload, Instant fetchedAt) {
        if (!fetchedAt.isAfter(sigmets.state().fetchedAt())) { staleSkipped.increment(); return; } // 백로그: 더 새 목록이 이미 있다
        Map<String, SigmetRecord> byId = new LinkedHashMap<>();
        for (JsonNode n : payload.path("sigmets")) {
            SigmetRecord s = Codec.sigmet(n);
            byId.put(s.id(), s);
        }
        SigmetStore.State st = sigmets.replaceIfNewer(fetchedAt, f.get("provider"), Map.copyOf(byId));
        if (st == null) { staleSkipped.increment(); return; }
        events.publishEvent(new IngestEvents.SigmetsUpdated(st));
    }

    private void radar(Map<String, String> f, JsonNode payload, Instant fetchedAt) {
        List<RadarStore.Frame> past = new java.util.ArrayList<>();
        for (JsonNode n : payload.path("past")) past.add(new RadarStore.Frame(n.path("time").asLong(), n.path("path").asString()));
        RadarStore.Frames fr = new RadarStore.Frames(payload.path("host").asString(), payload.path("generated").asLong(), List.copyOf(past), fetchedAt, f.get("provider"));
        if (!radar.replaceIfNewer(fr)) { staleSkipped.increment(); return; } // 백로그: 더 새 목록이 이미 있다
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
