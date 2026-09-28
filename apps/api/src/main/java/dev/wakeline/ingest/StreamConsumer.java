package dev.wakeline.ingest;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.HotCell;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.domain.SigmetRecord;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.SmartLifecycle;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.Limit;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.PendingMessage;
import org.springframework.data.redis.connection.stream.PendingMessages;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.connection.stream.StreamInfo;
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
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.zip.GZIPInputStream;

/**
 * XREADGROUP 소비자(그룹 api, 소비자 1개). 처리 순서: 스키마 검증 → 스냅샷 교체(참조) → 이벤트(동기 리스너) → durable 해지면 XACK.
 * <ul>
 *   <li>at-least-once(5.3절·NFR-08, API-CONC-8): XACK 는 메시지의 결과가 DB 에 커밋된 뒤에만 한다. 메시지마다 {@link Receipt} 를 만들어
 *       이벤트에 싣고, 비동기로 저장하는 리스너(항적 TrackWriter · SIGMET 이력 SigmetRepository)가 커밋 뒤 놓으면 그때 ACK 대기열에 들어간다.
 *       ACK 는 이 소비 스레드가 모아 보낸다(스트림 전용 연결을 이 스레드만 쓴다). 그 전에 api 가 죽으면 메시지는 PEL 에 남고 재시작 때
 *       다시 처리된다 — 항적 (hex, ts)·SIGMET 자연키 쓰기가 멱등이라 중복은 흡수된다.
 *       한계(지표로 센다): 메모리 큐가 넘쳐 버린 행(wakeline_track_rows_total{result=dropped})과 스트림 MAXLEN 으로 이미 잘려 다시 읽을 수
 *       없는 PEL 엔트리(wakeline_stream_messages_total{result=trimmed})는 되살리지 못한다.</li>
 *   <li>보존 창 손실(R-14): api 가 스트림 보존 창보다 오래 멈추면 읽기 전에 지워진 엔트리는 재처리할 수 없다(재처리 가능 창 = 스트림 보존).
 *       소비를 (다시) 시작할 때 — 첫 읽기 전에 — 그룹이 읽지 않은 엔트리 수(entries-added − entries-read)와 남은 엔트리 수를 비교해, 읽지 않은
 *       엔트리가 지워졌으면 손실로 센다(wakeline_stream_trim_loss_events_total{stream, kind=unread}) · 구간(마지막으로 읽은 엔트리 시각 →
 *       남은 첫 엔트리 시각)을 기억한다({@link #lastTrimLoss()}). 잘린 PEL 엔트리도 같은 방식으로 센다(kind=pending). 조용히 건너뛰지 않는다.</li>
 *   <li>DLQ 는 봉투·페이로드 검증(스키마·gzip·JSON·코덱) 실패만 받는다. 리스너 예외는 멀티캐스터가 리스너별로 가두고(PipelineEventMulticaster),
 *       소비자 자신의 반영 오류는 result=apply_error 로 센다 — 유효한 메시지를 DLQ 로 보내지 않는다(API-CONC-2).</li>
 *   <li>항공기 스코프(계약 v2 §A3): region·global 은 스코프 스냅샷을, hot 은 셀(payload.cell)별 스냅샷을, focus 는 hex 별 관측을
 *       바꾼다(모두 fetched_at 단조). 받아들인 메시지는 SnapshotUpdated(엔진·WS·항적), 오래된 것은 AircraftBacklog(항적만).
 *       focus 의 requested 에 없는 hex 는 버린다(수집기가 묻지 않은 항공기를 실시간 상태에 넣지 않는다). hot 인데 셀 키가 없거나
 *       범위 밖이면 검증 실패(DLQ). 항공기 메시지의 scope 가 이 넷이 아니면 검증 실패.</li>
 *   <li>선박(계약 v2 §B3): wakeline:ships 의 ships(바뀐 선박만, 10 s) → ShipStore(MMSI 별 단조) → ShipsUpdated(저장·WS),
 *       ais_gap → ShipStore 공백 기록 → AisGapReceived(저장). ais_gap 의 scope(계약 v4 §D, 구역)는 틀리면 null(모든 곳에 적용)로 받고 센다.
 *       신뢰 경계(ADR-014): wakeline:ships 는 ais 컨테이너(외부 WebSocket 을 파싱하는
 *       별도 ACL 사용자)만 쓴다 — 그 스트림에서는 ships·ais_gap 만, ships·ais_gap 은 그 스트림에서만 받는다(다른 조합은 검증 실패 → DLQ).
 *       선박 부트스트랩은 한 엔트리가 아니라 최근 35분(실시간 목록 30분을 덮는 창)을 순서대로 읽어 메모리 상태만 되살린다(저장·ACK 없음) —
 *       항공기 소비를 막지 않게 별도 가상 스레드에서, 스트림 전용 연결(BLOCK)이 아닌 기본 연결로 읽는다.</li>
 *   <li>재시작 시 각 스트림의 마지막 엔트리(항공기는 스코프별 마지막 엔트리)로 상태를 먼저 복원한다(≤ 60 s 복귀).
 *       hot·focus 는 복원하지 않는다 — 5~30 s 안에 새로 오고, 재시작 전의 수요가 지금도 있는지 모른다.
 *       스냅샷·SIGMET·레이더는 '최신만 의미' — fetched_at 이 현재보다 새 것만 실시간 상태에 반영한다(백로그 재생이 화면·엔진을 과거로 되돌리지 않게).
 *       SIGMET 이력은 반대로 스트림 순서대로 모든 세트를 저장한다(SigmetSetReceived, API-CONC-1) — 부트스트랩이 적용한 최신 세트는 소비로
 *       다시 전달될 예정이면 그때(순서대로) 저장한다.</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 웹·소비자·잡을 띄우지 않는다
@Component
public class StreamConsumer implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(StreamConsumer.class);
    public static final String GROUP = "api";
    /**
     * 소비자 이름이 상수다 — api 는 단일 인스턴스로만 돈다(R-79). 두 번째 인스턴스는 {@link SingleInstanceGuard} 가 기동을 막고,
     * 그룹에 다른 이름의 소비자가 활동하면 경고한다.
     */
    public static final String CONSUMER = "api-1";
    public static final String S_AIRCRAFT = "wakeline:aircraft";
    public static final String S_SIGMET = "wakeline:sigmet";
    public static final String S_RADAR = "wakeline:radar";
    public static final String S_SHIPS = "wakeline:ships";
    public static final String S_DLQ = "wakeline:dlq";
    private static final List<String> STREAMS = List.of(S_AIRCRAFT, S_SIGMET, S_RADAR, S_SHIPS);
    /** wakeline:ships 에서만 받는 kind(ADR-014 신뢰 경계). */
    static final Set<String> SHIP_KINDS = Set.of("ships", "ais_gap");
    /** 선박 부트스트랩: 최근 이 창의 엔트리를 순서대로 읽는다(실시간 목록 30분 + 여유). 상한 엔트리 수·페이지 크기. */
    static final long SHIPS_BOOTSTRAP_WINDOW_MS = 35 * 60_000L;
    static final int SHIPS_BOOTSTRAP_MAX = 400;
    static final int SHIPS_BOOTSTRAP_PAGE = 20;
    /** 부트스트랩: 항공기 스트림에서 스코프별 최신 엔트리를 찾을 때 한 번에 읽는 수·최대 스캔 수(MAXLEN ~200). */
    static final int BOOTSTRAP_PAGE = 50;
    static final int BOOTSTRAP_SCAN_MAX = 1_000;
    /** 부트스트랩 대상 스코프(global → region 순서로 적용). hot·focus 는 복원하지 않는다. */
    static final List<String> AIRCRAFT_SCOPES = List.of("global", "region");
    /** 항공기 메시지가 가질 수 있는 scope(계약 v2 §A3). */
    static final Set<String> AIRCRAFT_ALL_SCOPES = Set.of(SnapshotStore.REGION, SnapshotStore.GLOBAL, SnapshotStore.HOT, SnapshotStore.FOCUS);
    /** PEL 재처리: 한 번에 읽는 대기 id 수·스트림당 최대 페이지 수(무한 반복 방지 — 남으면 다음 재시도 루프가 이어서 한다). */
    static final int PENDING_PAGE = 100;
    static final int PENDING_MAX_PAGES = 100;
    /** ACK 한 번에 모으는 최대 수. */
    static final int ACK_BATCH = 1_000;

    private final StringRedisTemplate redis;
    private final SchemaValidator validator;
    private final SnapshotStore snapshots;
    private final SigmetStore sigmets;
    private final RadarStore radar;
    private final ShipStore shipStore;
    /** 선박 부트스트랩용(기본 연결 — 스트림 전용 연결은 소비 스레드의 BLOCK 이 쓴다). null 이면 부트스트랩하지 않는다. */
    private final StringRedisTemplate bootstrapRedis;
    private final ApplicationEventPublisher events;
    private final ObjectMapper mapper;
    private final Counter processed;
    private final Counter rejected;
    private final Counter staleSkipped;
    private final Counter trimmed;
    private final Counter applyErrors;
    private final Counter focusUnrequested;
    private final Counter shipsRejectedCap;
    private final Counter shipsRejectedFuture;
    private final Counter gapScopeInvalid;
    private final Timer processTimer;
    /** durable 해진 메시지 — 소비 스레드가 모아 XACK 한다. */
    private final ConcurrentLinkedQueue<Ack> acks = new ConcurrentLinkedQueue<>();
    /** 영수증이 아직 풀리지 않은 메시지(stream/id) — 같은 프로세스 안에서 PEL 재처리가 진행 중인 메시지를 다시 처리하지 않게. */
    private final Set<String> inFlight = ConcurrentHashMap.newKeySet();
    /** 마지막으로 XREADGROUP 이 돌아온 시각(빈 응답 포함) — 소비 루프가 멈췄는지(헬스). 0 = 아직 없음. */
    private volatile long lastReadAtMs;
    private volatile boolean running;
    /** 부트스트랩은 프로세스 시작마다 한 번(재시도 루프마다 다시 하면 복원한 최신 상태 뒤로 밀린 엔트리가 이어진다). */
    private volatile boolean bootstrapped;
    private Thread worker;
    private final MeterRegistry meters;
    /** 보존 창 손실(R-14): 이 프로세스가 센 손실 수 · 마지막 손실 구간 · 스트림별로 이미 센 max-deleted-entry-id(같은 손실을 두 번 세지 않는다). */
    private final java.util.concurrent.atomic.AtomicLong trimLossEvents = new java.util.concurrent.atomic.AtomicLong();
    private final java.util.concurrent.atomic.AtomicReference<TrimLoss> lastTrimLoss = new java.util.concurrent.atomic.AtomicReference<>();
    private final Map<String, String> reportedUnreadTrim = new ConcurrentHashMap<>();

    /**
     * 스트림 보존 창을 넘어 잃은 구간(R-14). 잃은 엔트리는 from 과 to 사이에 있었다.
     * kind = unread(읽기 전에 지워짐): from = api 가 마지막으로 전달받은 엔트리의 시각(그룹이 아무것도 읽은 적 없으면 null — 모른다),
     * to = 스트림에 남은 첫 엔트리의 시각(남은 것이 없으면 마지막으로 발행된 엔트리의 시각).
     * kind = pending(읽었지만 저장 전에 지워짐 — PEL): from·to = 잘린 PEL 엔트리 중 가장 오래된 것·가장 새 것의 시각.
     */
    public record TrimLoss(String stream, Instant from, Instant to, String kind) {}

    /** 선박 없이(테스트·이전 호출자): 빈 ShipStore, 선박 부트스트랩 없음. */
    public StreamConsumer(StringRedisTemplate redis, SchemaValidator validator, SnapshotStore snapshots,
                          SigmetStore sigmets, RadarStore radar, ApplicationEventPublisher events, ObjectMapper mapper, MeterRegistry meters) {
        this(redis, validator, snapshots, sigmets, radar, new ShipStore(), null, events, mapper, meters);
    }

    @Autowired
    public StreamConsumer(@Qualifier("streamRedisTemplate") StringRedisTemplate redis, SchemaValidator validator, SnapshotStore snapshots,
                          SigmetStore sigmets, RadarStore radar, ShipStore ships, StringRedisTemplate bootstrapRedis,
                          ApplicationEventPublisher events, ObjectMapper mapper, MeterRegistry meters) {
        this.redis = redis;
        this.validator = validator;
        this.snapshots = snapshots;
        this.sigmets = sigmets;
        this.radar = radar;
        this.shipStore = ships;
        this.bootstrapRedis = bootstrapRedis;
        this.events = events;
        this.mapper = mapper;
        this.meters = meters;
        this.processed = Counter.builder("wakeline_stream_messages_total").tag("result", "ok").register(meters);
        this.rejected = Counter.builder("wakeline_stream_messages_total").tag("result", "rejected").register(meters);
        this.staleSkipped = Counter.builder("wakeline_stream_messages_total").tag("result", "stale_skipped").register(meters);
        this.trimmed = Counter.builder("wakeline_stream_messages_total").tag("result", "trimmed")
                .description("PEL 에 남았지만 MAXLEN 으로 이미 잘려 다시 처리할 수 없는 메시지").register(meters);
        this.applyErrors = Counter.builder("wakeline_stream_messages_total").tag("result", "apply_error")
                .description("검증은 통과했지만 반영 중 오류(DLQ 로 보내지 않는다)").register(meters);
        this.focusUnrequested = Counter.builder("wakeline_focus_unrequested_total")
                .description("focus 메시지에 들었지만 requested 에 없어 버린 항공기 상태").register(meters);
        this.shipsRejectedCap = Counter.builder("wakeline_ships_rejected_total").tag("reason", "cap")
                .description("메모리 상한(선박·정적 정보)으로 받지 않은 새 MMSI").register(meters);
        this.shipsRejectedFuture = Counter.builder("wakeline_ships_rejected_total").tag("reason", "future")
                .description("seen_at 이 5분 넘게 미래라 받지 않은 보고").register(meters);
        this.gapScopeInvalid = Counter.builder("wakeline_ais_gap_scope_invalid_total")
                .description("ais_gap 의 scope 가 구역 규칙(AisBboxes)에 맞지 않아 구역 없음(모든 곳에 적용)으로 받은 공백").register(meters);
        this.processTimer = Timer.builder("wakeline_stream_process_seconds").publishPercentiles(0.5, 0.95).register(meters);
        meters.gauge("wakeline_stream_unacked", inFlight, Set::size);
    }

    /** ACK 대기열 항목. */
    record Ack(String stream, String id) {}

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
                Set<String> existing = ensureGroups();
                detectUnreadTrim(existing); // 첫 읽기 전에 — 읽고 나면 그룹 위치가 잘린 구간을 지나 손실이 보이지 않는다
                if (!bootstrapped) {
                    bootstrapFromLastEntries();
                    bootstrapped = true;
                    if (bootstrapRedis != null) Thread.ofVirtual().name("ships-bootstrap").start(this::bootstrapShipsSafe);
                }
                drainPending();
                consume();
            } catch (Exception e) {
                if (!running) break;
                log.warn("stream consumer error: {} — retry in 3 s", e.toString());
                sleep(3000);
            }
        }
        flushAcksQuietly(); // 멈추기 전에 durable 해진 것까지 ACK(남은 것은 종료 뒤 StreamAckFinalizer 가 한 번 더)
    }

    /** @return 그룹이 이미 있던 스트림(이번에 만든 그룹은 이전 위치가 없어 손실을 판단하지 않는다) */
    private Set<String> ensureGroups() {
        Set<String> existing = new java.util.HashSet<>();
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
                existing.add(s);
            }
        }
        return existing;
    }

    /**
     * 보존 창 손실 감지(R-14): 그룹 api 가 아직 읽지 않은 엔트리 수(entries-added − 그룹 entries-read)가 스트림에 남은 엔트리 수(length)보다
     * 많으면, 그 차이만큼은 읽기 전에 지워졌다(MAXLEN 트림) — 다시 읽을 수 없으니 손실로 센다. 평상시 트림은 이미 읽은 엔트리만 지우므로 차이 ≤ 0.
     * 구간 = 마지막으로 전달받은 엔트리(last-delivered-id)의 시각 → 스트림에 남은 첫 엔트리의 시각(잃은 엔트리는 그 사이에 있었다).
     * Redis 가 그룹의 entries-read 를 셀 수 없으면(nil) 판단하지 않는다 — 소비는 막지 않는다. XINFO 는 트림 구간을 알려 주지 않는다
     * (max-deleted-entry-id 는 XDEL 만 기록한다).
     */
    private void detectUnreadTrim(Set<String> streams) {
        for (String s : streams) {
            try {
                StreamInfo.XInfoGroup group = null;
                StreamInfo.XInfoGroups groups = ops().groups(s);
                if (groups != null) for (StreamInfo.XInfoGroup g : groups) if (GROUP.equals(g.groupName())) group = g;
                StreamInfo.XInfoStream info = ops().info(s);
                if (group == null || info == null) continue;
                double added = StreamMetrics.num(info.getRaw(), "entries-added"), length = StreamMetrics.num(info.getRaw(), "length");
                double read = StreamMetrics.num(group.getRaw(), "entries-read");
                if (Double.isNaN(added) || Double.isNaN(length) || Double.isNaN(read) || added - read - length <= 0) continue;
                String first = length > 0 ? info.firstEntryId() : null;
                String key = first == null ? "empty@" + (long) added : first;
                if (key.equals(reportedUnreadTrim.put(s, key))) continue; // 이미 센 손실(읽기 전에 재시도됨)
                String last = group.lastDeliveredId();
                Instant to = first != null ? idTime(first) : idTime(rawIdOr(info.getRaw().get("last-generated-id"), "0-0"));
                log.warn("stream {}: {} entries were trimmed before the api read them", s, (long) (added - read - length));
                recordTrimLoss(new TrimLoss(s, last == null || "0-0".equals(last) ? null : idTime(last), to, "unread"));
            } catch (RuntimeException e) {
                log.warn("stream {}: could not check for entries trimmed before they were read: {}", s, e.toString());
            }
        }
    }

    private void recordTrimLoss(TrimLoss loss) {
        trimLossEvents.incrementAndGet();
        lastTrimLoss.set(loss);
        meters.counter("wakeline_stream_trim_loss_events_total", "stream", loss.stream(), "kind", loss.kind()).increment();
        log.warn("stream {}: entries were trimmed before the api could {} them — data loss window {} → {} (the stream retention is the re-processing window)",
                loss.stream(), "unread".equals(loss.kind()) ? "read" : "persist", loss.from() == null ? "unknown" : loss.from(), loss.to());
    }

    /** 이 프로세스가 센 보존 창 손실 수(읽기 전 · PEL). */
    public long trimLossEvents() { return trimLossEvents.get(); }

    /** 마지막 보존 창 손실 구간. 없으면 null. */
    public TrimLoss lastTrimLoss() { return lastTrimLoss.get(); }

    static Instant idTime(String id) { return Instant.ofEpochMilli(Long.parseLong(id.split("-")[0])); }

    private static String rawIdOr(Object v, String fallback) {
        if (v == null) return fallback;
        String s = v instanceof byte[] b ? new String(b, StandardCharsets.UTF_8) : String.valueOf(v);
        return s.matches("^\\d+-\\d+$") ? s : fallback;
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
            try { apply(parse(r), Receipt.NONE, true); } catch (Exception e) { log.warn("bootstrap {}/{} failed: {}", S_AIRCRAFT, scope, e.toString()); }
        }
        for (String s : List.of(S_SIGMET, S_RADAR)) {
            List<MapRecord<String, String, String>> last = ops().reverseRange(s, Range.unbounded(), Limit.limit().count(1));
            if (last != null) for (MapRecord<String, String, String> r : last) {
                // SIGMET 이력은 스트림 순서대로만 저장한다: 이 엔트리가 소비로 다시 전달될 예정이면(그룹이 아직 안 읽었거나 PEL 에 있음)
                // 여기서 저장하지 않는다 — 그보다 오래된 백로그 세트가 뒤에 저장되며 이력을 과거로 되돌리지 않게(API-CONC-1)
                boolean persistHistory = !(S_SIGMET.equals(s) && willBeRedelivered(s, r.getId().getValue()));
                try { apply(parse(r), Receipt.NONE, persistHistory); } catch (Exception e) { log.warn("bootstrap {} failed: {}", s, e.toString()); }
            }
        }
        log.info("bootstrap done: region={} global={} sigmets={} radar={}", snapshots.region().states().size(),
                snapshots.global().states().size(), sigmets.state().byId().size(), radar.frames().past().size());
    }

    private void bootstrapShipsSafe() {
        try {
            bootstrapShips(this::shipsPage, System.currentTimeMillis());
        } catch (RuntimeException e) {
            log.warn("ships bootstrap failed (live ships rebuild from new messages within minutes): {}", e.toString());
        }
    }

    private List<MapRecord<String, String, String>> shipsPage(String fromInclusive, int count) {
        StreamOperations<String, String, String> o = bootstrapRedis.opsForStream();
        return o.range(S_SHIPS, Range.of(Range.Bound.inclusive(fromInclusive), Range.Bound.unbounded()), Limit.limit().count(count));
    }

    /** 과거 → 최신 순 한 페이지(fromInclusive 포함). */
    @FunctionalInterface
    interface ForwardPageReader {
        List<MapRecord<String, String, String>> page(String fromInclusive, int count);
    }

    /**
     * 선박 부트스트랩: 최근 {@link #SHIPS_BOOTSTRAP_WINDOW_MS} 의 wakeline:ships 엔트리를 순서대로 검증·반영한다(메모리만 — 저장·ACK·DLQ 없음:
     * 아직 전달되지 않은 엔트리는 소비가 곧 다시 처리해 저장하고, 잘못된 엔트리는 소비가 DLQ 로 보낸다). 반영은 MMSI 별 단조라 소비와 동시에
     * 돌아도 최신을 되돌리지 않는다. 끝나면 WS 가 새 목록을 보내도록 한 번 알린다.
     * @return 반영한 엔트리 수
     */
    int bootstrapShips(ForwardPageReader reader, long nowMs) {
        String from = (nowMs - SHIPS_BOOTSTRAP_WINDOW_MS) + "-0";
        String boundary = null;
        int scanned = 0, applied = 0, invalid = 0;
        Set<String> changed = new java.util.HashSet<>();
        while (scanned < SHIPS_BOOTSTRAP_MAX) {
            List<MapRecord<String, String, String>> page = reader.page(from, SHIPS_BOOTSTRAP_PAGE);
            if (page == null || page.isEmpty()) break;
            boolean progressed = false;
            for (MapRecord<String, String, String> r : page) {
                if (r.getId().getValue().equals(boundary)) continue; // 경계(포함)로 다시 읽은 것
                progressed = true;
                if (++scanned > SHIPS_BOOTSTRAP_MAX) break;
                try {
                    Parsed p = parse(r);
                    if ("ships".equals(p.kind())) {
                        changed.addAll(shipStore.apply(p.ships().states(), p.ships().statics(), p.fetchedAt(), p.fields().get("provider"), nowMs).changed());
                    } else if ("ais_gap".equals(p.kind())) {
                        shipStore.addGap(p.gap());
                    }
                    applied++;
                } catch (Exception e) {
                    invalid++;
                }
            }
            if (!progressed) break;
            boundary = page.getLast().getId().getValue();
            from = boundary;
            if (page.size() < SHIPS_BOOTSTRAP_PAGE) break;
        }
        if (applied > 0) events.publishEvent(IngestEvents.ShipsUpdated.liveOnly(changed, Set.of()));
        log.info("ships bootstrap: {} entries applied ({} invalid skipped), {} live ships, {} gaps", applied, invalid,
                shipStore.view().size(), shipStore.gaps().size());
        return applied;
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

    /**
     * 부트스트랩: 이 엔트리가 그룹 소비로 다시 전달될 예정인가 — 그룹이 아직 읽지 않았거나(id > last-delivered-id) PEL 에 남아 있다.
     * 그룹이 방금 만들어졌으면($) 마지막 엔트리까지 읽은 것으로 되어 있어 false.
     */
    boolean willBeRedelivered(String stream, String id) {
        String lastDelivered = null;
        StreamInfo.XInfoGroups groups = ops().groups(stream);
        if (groups != null) for (StreamInfo.XInfoGroup g : groups) if (GROUP.equals(g.groupName())) lastDelivered = g.lastDeliveredId();
        if (lastDelivered == null) return false;                // 그룹 없음 — 소비가 $ 로 만든다(다시 전달되지 않는다)
        if (compareIds(id, lastDelivered) > 0) return true;     // 아직 읽지 않음
        PendingMessages p = ops().pending(stream, GROUP, Range.closed(id, id), 1);
        return p != null && !p.isEmpty();                       // 읽었지만 ACK 전(PEL)
    }

    /**
     * PEL(이전 실행 또는 이 실행의 재시도 전)에 남은 메시지 재처리 — 끝까지 페이지를 넘긴다(at-least-once). 이 프로세스에서 아직 처리 중인
     * (영수증이 풀리지 않은) 메시지는 건너뛴다. MAXLEN 으로 이미 잘린 엔트리는 되살릴 수 없으므로 ACK 하고 trimmed 로 센다.
     */
    private void drainPending() {
        flushAcks(); // 이미 durable 해진 것을 먼저 ACK — PEL 에서 빠져 다시 처리되지 않게
        for (String s : STREAMS) drainPending(s);
        flushAcks();
    }

    private void drainPending(String stream) {
        String after = null;
        int total = 0;
        String firstTrimmed = null, lastTrimmed = null;
        for (int page = 0; page < PENDING_MAX_PAGES && running; page++) {
            Range<String> range = after == null ? Range.unbounded() : Range.of(Range.Bound.inclusive(after), Range.Bound.unbounded());
            PendingMessages pm = ops().pending(stream, Consumer.from(GROUP, CONSUMER), range, PENDING_PAGE);
            if (pm == null || pm.isEmpty()) break;
            boolean progressed = false;
            for (PendingMessage m : pm) {
                String id = m.getIdAsString();
                if (id.equals(after)) continue; // 경계(포함)로 다시 읽은 것
                progressed = true;
                after = id;
                if (inFlight.contains(stream + "/" + id)) continue;
                List<MapRecord<String, String, String>> rec = ops().range(stream, Range.closed(id, id));
                if (rec == null || rec.isEmpty()) {
                    trimmed.increment();
                    log.warn("pending message {} on {} was trimmed from the stream before it could be re-processed — acknowledged", id, stream);
                    acks.add(new Ack(stream, id));
                    if (firstTrimmed == null) firstTrimmed = id;
                    lastTrimmed = id;
                    continue;
                }
                handle(rec.getFirst());
                total++;
            }
            if (!progressed) break;
        }
        if (total > 0) log.info("re-processed {} pending messages on {}", total, stream);
        // 읽었지만 저장 전에 잘린 엔트리(PEL)도 보존 창 손실이다 — 이번 재처리에서 만난 구간을 하나로 센다(R-14)
        if (firstTrimmed != null) recordTrimLoss(new TrimLoss(stream, idTime(firstTrimmed), idTime(lastTrimmed), "pending"));
    }

    private void consume() {
        StreamOffset<String>[] offsets = STREAMS.stream().map(s -> StreamOffset.create(s, ReadOffset.lastConsumed())).toArray(StreamOffset[]::new);
        StreamReadOptions opts = StreamReadOptions.empty().block(Duration.ofSeconds(2)).count(10);
        Consumer consumer = Consumer.from(GROUP, CONSUMER);
        while (running) {
            flushAcks();
            List<MapRecord<String, String, String>> recs = ops().read(consumer, opts, offsets);
            lastReadAtMs = System.currentTimeMillis();
            if (recs == null) continue;
            for (MapRecord<String, String, String> r : recs) handle(r);
        }
    }

    /**
     * 메시지 한 건: 검증 실패만 DLQ(+ 바로 ACK). 검증을 통과한 메시지는 영수증을 달아 반영하고, 영수증이 풀리면(결과가 durable) ACK 한다.
     * 반영 중 소비자 자신의 오류는 센다 — 유효한 메시지를 DLQ 로 보내지 않는다(리스너 예외는 멀티캐스터가 따로 가둔다).
     */
    void handle(MapRecord<String, String, String> r) {
        String stream = r.getStream();
        String id = r.getId().getValue();
        long t0 = System.nanoTime();
        Parsed p;
        try {
            p = parse(r);
        } catch (Exception e) {
            rejected.increment();
            deadLetter(r, e.getMessage());
            acks.add(new Ack(stream, id));
            return;
        }
        String key = stream + "/" + id;
        inFlight.add(key);
        Receipt receipt = new Receipt(() -> {
            inFlight.remove(key);
            acks.add(new Ack(stream, id));
        });
        try {
            apply(p, receipt, true);
            processed.increment();
            processTimer.record(Duration.ofNanos(System.nanoTime() - t0));
        } catch (RuntimeException e) {
            applyErrors.increment();
            log.error("message {} from {} passed validation but could not be applied (not dead-lettered): {}", id, stream, e.toString(), e);
        } finally {
            receipt.release(); // 소비자 자신의 보유 — 비동기 저장이 없으면 여기서 바로 ACK 대기열로
        }
    }

    /** durable 해진 메시지를 스트림별로 모아 XACK(소비 스레드 전용). 실패하면 되돌려 두고 예외를 올린다(루프가 재시도). */
    void flushAcks() {
        Map<String, List<String>> byStream = new LinkedHashMap<>();
        Ack a;
        int n = 0;
        while (n < ACK_BATCH && (a = acks.poll()) != null) {
            byStream.computeIfAbsent(a.stream(), k -> new java.util.ArrayList<>()).add(a.id());
            n++;
        }
        for (var e : byStream.entrySet()) {
            try {
                acknowledge(e.getKey(), e.getValue());
            } catch (RuntimeException ex) {
                for (String id : e.getValue()) acks.add(new Ack(e.getKey(), id));
                throw ex;
            }
        }
        if (acks.size() >= ACK_BATCH) flushAcks();
    }

    void acknowledge(String stream, List<String> ids) {
        ops().acknowledge(stream, GROUP, ids.toArray(String[]::new));
    }

    /** 종료 경로: 남은 ACK 를 한 번 보낸다. 실패해도 조용히(메시지는 PEL 에 남아 다음 기동 때 재처리 — 멱등). */
    public void flushAcksQuietly() {
        try {
            flushAcks();
        } catch (RuntimeException e) {
            log.warn("final ack flush failed ({} left pending, will be re-processed on restart): {}", acks.size(), e.toString());
        }
    }

    /**
     * 검증·해석을 마친 메시지(종류별로 하나만 채운다 — 반영 단계에서 다시 해석하지 않는다).
     * cell: scope hot 의 셀 키(검증됨), 그 밖은 null. gapScopeInvalid: ais_gap 의 scope 가 구역 규칙에 맞지 않아 구역 없음으로 받았다 —
     * 해석은 부트스트랩도 하므로 여기서 세지 않고 실시간 반영({@link #apply})에서 한 번만 센다.
     */
    record Parsed(String kind, Map<String, String> fields, Instant fetchedAt, Map<String, AircraftState> aircraft, String cell,
                  Map<String, SigmetRecord> sigmets, RadarStore.Frames radar, ShipsBatch ships, AisGap gap, boolean gapScopeInvalid) {
        Parsed(String kind, Map<String, String> fields, Instant fetchedAt, Map<String, AircraftState> aircraft, String cell,
               Map<String, SigmetRecord> sigmets, RadarStore.Frames radar) {
            this(kind, fields, fetchedAt, aircraft, cell, sigmets, radar, null, null, false);
        }
    }

    /** ships 메시지 한 건(한 발행의 part 하나): 위치 보고·정적 정보. */
    record ShipsBatch(List<ShipState> states, List<ShipStatic> statics) {}

    /** 봉투·페이로드 검증 + 디코드 + 코덱 해석(잘못된 값도 검증 실패로 → DLQ). 실패는 예외. */
    Parsed parse(MapRecord<String, String, String> r) throws IOException {
        Map<String, String> f = r.getValue();
        if (f == null || f.isEmpty()) throw new IllegalArgumentException("envelope: empty entry");
        String envelopeJson = mapper.writeValueAsString(f);
        String err = validator.validateEnvelope(envelopeJson);
        if (err != null) throw new IllegalArgumentException("envelope: " + err);
        String kind = f.get("kind");
        // 신뢰 경계(ADR-014): 선박 스트림은 ais 사용자만 쓴다 — 거기서 온 항공기·SIGMET 을, 다른 스트림에서 온 선박을 받지 않는다
        if (S_SHIPS.equals(r.getStream()) != SHIP_KINDS.contains(kind))
            throw new IllegalArgumentException("envelope: kind " + kind + " is not accepted on stream " + r.getStream());
        String payloadJson = decode(f.get("payload"));
        err = validator.validatePayload(kind, payloadJson);
        if (err != null) throw new IllegalArgumentException("payload: " + err);
        JsonNode payload = mapper.readTree(payloadJson);
        Instant fetchedAt = Instant.parse(f.get("fetched_at"));
        return switch (kind) {
            case "aircraft" -> {
                String scope = f.get("scope");
                if (!AIRCRAFT_ALL_SCOPES.contains(scope)) throw new IllegalArgumentException("aircraft scope must be region|global|hot|focus, got " + scope);
                String cell = null;
                if (SnapshotStore.HOT.equals(scope)) {
                    JsonNode c = payload.get("cell");
                    HotCell hc = c != null && c.isString() ? HotCell.parse(c.asString()) : null;
                    if (hc == null) throw new IllegalArgumentException("payload: scope hot needs a valid cell key");
                    cell = hc.key();
                }
                Set<String> requested = null;
                if (SnapshotStore.FOCUS.equals(scope) && payload.get("requested") instanceof JsonNode req && req.isArray()) {
                    requested = new java.util.HashSet<>();
                    for (JsonNode h : req) requested.add(h.asString());
                }
                Map<String, AircraftState> states = new HashMap<>();
                int unrequested = 0;
                for (JsonNode n : payload.path("states")) {
                    AircraftState s = Codec.aircraft(n);
                    if (requested != null && !requested.contains(s.hex())) { unrequested++; continue; }
                    states.put(s.hex(), s);
                }
                if (unrequested > 0) focusUnrequested.increment(unrequested);
                yield new Parsed(kind, f, fetchedAt, states, cell, null, null);
            }
            case "sigmet" -> {
                Map<String, SigmetRecord> byId = new LinkedHashMap<>();
                for (JsonNode n : payload.path("sigmets")) {
                    SigmetRecord s = Codec.sigmet(n);
                    byId.put(s.id(), s);
                }
                yield new Parsed(kind, f, fetchedAt, null, null, Map.copyOf(byId), null);
            }
            case "ships" -> {
                requireScope(f, "ships");
                List<ShipState> st = new java.util.ArrayList<>();
                for (JsonNode n : payload.path("ships")) st.add(ShipCodec.state(n));
                List<ShipStatic> sc = new java.util.ArrayList<>();
                for (JsonNode n : payload.path("static")) sc.add(ShipCodec.stat(n));
                yield new Parsed(kind, f, fetchedAt, null, null, null, null, new ShipsBatch(List.copyOf(st), List.copyOf(sc)), null, false);
            }
            case "ais_gap" -> {
                requireScope(f, "ships");
                boolean[] invalidScope = {false};
                AisGap gap = ShipCodec.gap(payload, f.get("provider"), () -> invalidScope[0] = true);
                yield new Parsed(kind, f, fetchedAt, null, null, null, null, null, gap, invalidScope[0]);
            }
            case "radar" -> {
                List<RadarStore.Frame> past = new java.util.ArrayList<>();
                for (JsonNode n : payload.path("past")) past.add(new RadarStore.Frame(n.path("time").asLong(), n.path("path").asString()));
                yield new Parsed(kind, f, fetchedAt, null, null, null, new RadarStore.Frames(payload.path("host").asString(), payload.path("generated").asLong(),
                        List.copyOf(past), fetchedAt, f.get("provider")));
            }
            default -> throw new IllegalArgumentException("unknown kind " + kind);
        };
    }

    private static void requireScope(Map<String, String> f, String scope) {
        if (!scope.equals(f.get("scope"))) throw new IllegalArgumentException(f.get("kind") + " scope must be " + scope + ", got " + f.get("scope"));
    }

    /** 테스트·부트스트랩용: 검증 + 반영(영수증 없음, SIGMET 이력 저장 포함). */
    void process(MapRecord<String, String, String> r, boolean live) throws IOException {
        apply(parse(r), Receipt.NONE, true);
    }

    /**
     * 검증된 메시지 반영.
     * @param persistHistory SIGMET 세트를 이력(DB)에 저장하라는 이벤트를 낼지(부트스트랩이 다시 전달될 엔트리를 적용할 때만 false)
     */
    void apply(Parsed p, Receipt receipt, boolean persistHistory) {
        switch (p.kind()) {
            case "aircraft" -> aircraft(p.fields(), p.aircraft(), p.cell(), p.fetchedAt(), receipt);
            case "sigmet" -> sigmet(p.fields(), p.sigmets(), p.fetchedAt(), receipt, persistHistory);
            case "radar" -> radar(p.radar());
            case "ships" -> ships(p, receipt);
            case "ais_gap" -> aisGap(p, receipt);
            default -> throw new IllegalArgumentException("unknown kind " + p.kind());
        }
    }

    /** ships: 실시간 상태(MMSI 별 단조)에 반영하고, 메시지의 모든 보고를 저장·WS 로 넘긴다(저장기가 60 s 창으로 줄인다). */
    private void ships(Parsed p, Receipt receipt) {
        ShipStore.Change c = shipStore.apply(p.ships().states(), p.ships().statics(), p.fetchedAt(), p.fields().get("provider"), System.currentTimeMillis());
        if (c.rejectedCap() > 0) shipsRejectedCap.increment(c.rejectedCap());
        if (c.rejectedFuture() > 0) shipsRejectedFuture.increment(c.rejectedFuture());
        events.publishEvent(new IngestEvents.ShipsUpdated(p.fetchedAt(), p.fields().get("provider"), p.ships().states(), p.ships().statics(),
                c.changed(), Set.of(), receipt));
    }

    private void aisGap(Parsed p, Receipt receipt) {
        if (p.gapScopeInvalid()) gapScopeInvalid.increment(); // 부트스트랩(다시 읽기)은 여기를 거치지 않는다 — 같은 공백을 두 번 세지 않는다
        shipStore.addGap(p.gap());
        events.publishEvent(new IngestEvents.AisGapReceived(p.gap(), receipt));
    }

    private void aircraft(Map<String, String> f, Map<String, AircraftState> states, String cell, Instant fetchedAt, Receipt receipt) {
        String scope = f.get("scope");
        if (SnapshotStore.HOT.equals(scope)) { hot(f, states, cell, fetchedAt, receipt); return; }
        if (SnapshotStore.FOCUS.equals(scope)) { focus(f, states, fetchedAt, receipt); return; }
        // fetched_at 단조 가드(REL-8): 같은 스코프의 현재 스냅샷보다 새 것이 아니면 백로그 — 실시간 상태·엔진·WS 는 그대로 두고
        // 항적 기록만 이어서 한다(at-least-once). 버전 번호도 쓰지 않는다.
        if (!fetchedAt.isAfter(snapshots.current(scope).fetchedAt())) {
            backlog(scope, fetchedAt, states, receipt);
            return;
        }
        Snapshot snap = new Snapshot(snapshots.nextVersion(), scope, f.get("provider"), fetchedAt, Instant.now(), f.get("raw_ref"), Map.copyOf(states));
        Snapshot prev = snapshots.replaceIfNewer(snap);
        if (prev == null) {
            backlog(scope, fetchedAt, states, receipt);
            return;
        }
        events.publishEvent(new IngestEvents.SnapshotUpdated(prev, snap, receipt));
    }

    /** hot: 셀별 fetched_at 단조. 받아들이면 SnapshotUpdated(이전 = 그 셀의 이전 메시지), 아니면 백로그(항적만). */
    private void hot(Map<String, String> f, Map<String, AircraftState> states, String cell, Instant fetchedAt, Receipt receipt) {
        Snapshot snap = new Snapshot(snapshots.nextVersion(), SnapshotStore.HOT, f.get("provider"), fetchedAt, Instant.now(), f.get("raw_ref"), Map.copyOf(states));
        Snapshot prev = snapshots.replaceHotIfNewer(cell, snap);
        if (prev == null) {
            backlog(SnapshotStore.HOT, fetchedAt, states, receipt);
            return;
        }
        events.publishEvent(new IngestEvents.SnapshotUpdated(prev, snap, receipt));
    }

    /**
     * focus: hex 별로 반영(임대에 있고 더 새 관측만). 하나라도 받아들이면 SnapshotUpdated — current 는 메시지의 모든 상태(항적에는
     * 임대 여부와 무관하게 실제 관측을 남긴다), previous 는 받아들인 hex 의 이전 관측. 하나도 없으면 백로그(항적만).
     */
    private void focus(Map<String, String> f, Map<String, AircraftState> states, Instant fetchedAt, Receipt receipt) {
        if (states.isEmpty()) return; // 요청한 hex 가 모두 missing — 반영할 관측이 없다(상태는 수집기가 wakeline:demand:status 에 not_found 로)
        Snapshot snap = new Snapshot(snapshots.nextVersion(), SnapshotStore.FOCUS, f.get("provider"), fetchedAt, Instant.now(), f.get("raw_ref"), Map.copyOf(states));
        Snapshot prev = snapshots.applyFocus(snap);
        if (prev == null) {
            backlog(SnapshotStore.FOCUS, fetchedAt, states, receipt);
            return;
        }
        events.publishEvent(new IngestEvents.SnapshotUpdated(prev, snap, receipt));
    }

    private void backlog(String scope, Instant fetchedAt, Map<String, AircraftState> states, Receipt receipt) {
        staleSkipped.increment();
        log.debug("aircraft/{} entry fetched_at={} is not newer than the current snapshot — history only", scope, fetchedAt);
        events.publishEvent(new IngestEvents.AircraftBacklog(scope, fetchedAt, List.copyOf(states.values()), receipt));
    }

    private void sigmet(Map<String, String> f, Map<String, SigmetRecord> set, Instant fetchedAt, Receipt receipt, boolean persistHistory) {
        // 이력: 새 세트든 백로그든 스트림 순서대로(실시간 반영보다 먼저 — 이 세트의 SIGMET 행이 이 세트로 만든 알림보다 먼저 저장된다)
        if (persistHistory) events.publishEvent(new IngestEvents.SigmetSetReceived(fetchedAt, f.get("provider"), set, receipt));
        if (!fetchedAt.isAfter(sigmets.state().fetchedAt())) { staleSkipped.increment(); return; } // 백로그: 더 새 목록이 이미 있다
        SigmetStore.State st = sigmets.replaceIfNewer(fetchedAt, f.get("provider"), set);
        if (st == null) { staleSkipped.increment(); return; }
        events.publishEvent(new IngestEvents.SigmetsUpdated(st));
    }

    private void radar(RadarStore.Frames fr) {
        if (!radar.replaceIfNewer(fr)) { staleSkipped.increment(); return; } // 백로그: 더 새 목록이 이미 있다
        events.publishEvent(new IngestEvents.RadarUpdated(fr));
    }

    /** 마지막 XREADGROUP 응답 뒤 지난 시간(ms). 아직 한 번도 읽지 않았으면 -1. */
    public long lastReadAgeMs() {
        long t = lastReadAtMs;
        return t == 0 ? -1 : System.currentTimeMillis() - t;
    }

    /** 아직 ACK 하지 못한(결과가 durable 하지 않은) 메시지 수. */
    public int unacked() { return inFlight.size(); }

    /** 스트림 id(ms-seq) 비교 — 문자열 비교는 자릿수가 다르면 틀린다. */
    static int compareIds(String a, String b) {
        String[] x = a.split("-"), y = b.split("-");
        int c = Long.compare(Long.parseLong(x[0]), Long.parseLong(y[0]));
        if (c != 0) return c;
        return Long.compare(x.length > 1 ? Long.parseLong(x[1]) : 0, y.length > 1 ? Long.parseLong(y[1]) : 0);
    }

    void deadLetter(MapRecord<String, String, String> r, String reason) {
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

    /** 풀린 페이로드 상한 — 가장 큰 메시지(전세계 스냅샷 ~9,000대)의 10배 여유. 넘으면 DLQ(압축 폭탄으로 힙을 채우지 못하게). */
    static final int MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

    static String decode(String b64) throws IOException {
        if (b64 == null) throw new IOException("payload missing");
        byte[] gz = Base64.getDecoder().decode(b64);
        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(gz))) {
            byte[] out = in.readNBytes(MAX_PAYLOAD_BYTES + 1);
            if (out.length > MAX_PAYLOAD_BYTES) throw new IOException("payload exceeds " + MAX_PAYLOAD_BYTES + " bytes after gunzip");
            return new String(out, StandardCharsets.UTF_8);
        }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
    }
}
